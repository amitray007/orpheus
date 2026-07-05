// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/GitTab.tsx
//
// Workbench Git tab — Phase 1: the working-tree DIFF VIEWER foundation
// (docs/brainstorms/2026-07-06-git-tab-requirements.md states 3 "uncommitted
// changes, no PR" + 4 "ahead of base, no PR"). NO PR chrome, comments, or
// Details/Checks tabs — those are later phases; the [Diff | Commits] strip
// below only builds Diff, Commits is a stub.
//
// Layout mirrors FilesTab.tsx (see its module header): a changed-files TREE
// (left, @pierre/trees, git-status-decorated) + a diff PANE (right,
// @pierre/diffs' <PatchDiff>) fed by the new `git:diff` IPC's per-file patch
// strings (src/main/gitDiff.ts). Reuses FilesTab's dark-theme idioms
// (TREE_THEME/themeToTreeStyles, the git-status dot color overrides,
// PIERRE_VIEWER_BG) rather than re-deriving a second palette — see
// docs/learnings/pierre-libraries.md §5/§13.
//
// Header row (h-8, like FilesTab's): a hide-tree icon, a unified/split icon
// toggle (diffStyle), a worktree/local chip, and a [Diff | Commits] sub-tab
// strip (Commits is a Phase-3 stub).
//
// Live refresh: subscribes to the EXISTING `git:statusChanged` and
// `files:changed` pushes (already fired by src/main/git.ts's .git watcher —
// started unconditionally on terminal:mount — and filesWatcher.ts) rather
// than starting its own watcher. filesWatcher.ts enforces "at most one
// active watcher app-wide", which is already owned by whichever Files tab is
// open — GitTab must NOT call files:watchStart itself, or it would fight
// that single-slot invariant.
//
// Gating: mounted only while the Git tab is the active, non-dormant
// Workbench tab (see WorkbenchPanel) — git:diff is never fetched while the
// tab isn't visible.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { FileTree, useFileTree, useFileTreeSelection } from '@pierre/trees/react'
import { themeToTreeStyles, type TreeThemeInput } from '@pierre/trees'
import { PatchDiff } from '@pierre/diffs/react'
import { List, Rows, Columns } from '@phosphor-icons/react'
import type { GitDiffFile, GitStatusEntry } from '@shared/types'
import { PIERRE_VIEWER_BG } from './editor/chromeTheme'

// Same minimal dark ThemeLike shape FilesTab uses for its tree — kept as its
// own const (rather than importing FilesTab's) so this component doesn't
// couple to FilesTab's module for a plain data literal; the visual result is
// identical (§5.1 recommends one shared theme, but a duplicated small object
// is cheap and keeps the two tabs independently editable).
const TREE_THEME: TreeThemeInput = {
  name: 'orpheus-dark',
  type: 'dark',
  bg: '#15161a',
  fg: '#e6e6ea',
  colors: {
    'list.activeSelectionBackground': '#2a2c3a',
    'list.focusBackground': '#2a2c3a',
    'list.hoverBackground': '#1f2028',
    focusBorder: '#7c8cff',
    'textLink.foreground': '#7c8cff'
  }
}

// Git-status dot colors for the changed-files tree's shadow DOM — same
// GitHub-dark diff palette FilesTab uses (see its TREE_THEME hostStyle
// comment for the override-chain rationale).
const TREE_GIT_STATUS_VARS = {
  '--trees-padding-inline-override': '0px',
  '--trees-git-added-color-override': '#3fb950',
  '--trees-git-modified-color-override': '#d29922',
  '--trees-git-deleted-color-override': '#f85149',
  '--trees-git-renamed-color-override': '#58a6ff',
  '--trees-git-untracked-color-override': '#6e7681'
} as const

const VIEWER_THEME = { dark: 'pierre-dark', light: 'pierre-light' } as const

// Live-refresh debounce — coalesces bursts from either push source (a save
// touching several files, a `git add -A`) into one git:diff refetch. Matches
// the spirit of git.ts's own GIT_WATCH_DEBOUNCE_MS (350ms) and
// filesWatcher.ts's FILES_WATCH_DEBOUNCE_MS (200ms); this sits between the
// two since it's reacting to either.
const REFRESH_DEBOUNCE_MS = 200

export type DiffStyle = 'unified' | 'split'

export interface GitTabProps {
  /** The owning claude workspace's id — resolves to the workspace cwd in the
   *  main process (see src/main/gitDiff.ts via src/main/ipc/git.ts). */
  workspaceId: string
  /** Worktree metadata passed through from WorkspaceView/WorkbenchPanel (the
   *  app already tracks this per workspace) — drives the worktree/local chip
   *  below. Null worktreeParentCwd means this is a main-checkout workspace. */
  worktreeParentCwd: string | null
  worktreeBranch: string | null
}

/** Maps GitDiffFile[] into the GitStatusEntry[] shape @pierre/trees'
 *  `setGitStatus` expects (same enum FilesTab already feeds it — 'ignored' is
 *  simply never used here, every entry in a diff result is a real change). */
function toTreeGitStatus(files: readonly GitDiffFile[]): GitStatusEntry[] {
  return files.map((f) => ({ path: f.path, status: f.status }))
}

// --- Sub-tab strip -----------------------------------------------------------

type GitSubTab = 'diff' | 'commits'

interface SubTabStripProps {
  active: GitSubTab
  onChange: (tab: GitSubTab) => void
}

/** [Diff | Commits] segmented control — matches FilesTab's ModeToggle visual
 *  language (compact pill segments) but only two segments, no disabled state
 *  needed. Commits renders a stub in this phase (Phase 3 builds it out); no
 *  Details/Checks segments — those are PR-only, later phases. */
function SubTabStrip({ active, onChange }: SubTabStripProps): React.JSX.Element {
  const seg = (value: GitSubTab, label: string): React.JSX.Element => (
    <button
      type="button"
      onClick={() => onChange(value)}
      aria-pressed={active === value}
      className={[
        'px-2 py-0.5 rounded text-[11px] font-medium transition-colors duration-100',
        active === value
          ? 'bg-surface-raised text-text-primary'
          : 'text-text-muted hover:text-text-secondary'
      ].join(' ')}
    >
      {label}
    </button>
  )
  return (
    <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-surface-overlay/60 border border-border-default/60">
      {seg('diff', 'Diff')}
      {seg('commits', 'Commits')}
    </div>
  )
}

// --- Diff-style icon toggle ---------------------------------------------------

interface DiffStyleToggleProps {
  value: DiffStyle
  onChange: (style: DiffStyle) => void
}

/** Unified/split icon toggle — Rows (stacked horizontal lines) for unified,
 *  Columns (two vertical columns) for split, matching the requirements doc's
 *  "SVG icon toggle, not text" cross-cutting rule. */
function DiffStyleToggle({ value, onChange }: DiffStyleToggleProps): React.JSX.Element {
  const btnClass = (active: boolean): string =>
    [
      'p-1 rounded',
      active
        ? 'bg-surface-raised text-text-primary'
        : 'text-text-muted hover:bg-surface-raised hover:text-text-primary'
    ].join(' ')
  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={() => onChange('unified')}
        aria-pressed={value === 'unified'}
        title="Unified diff"
        className={btnClass(value === 'unified')}
      >
        <Rows size={14} />
      </button>
      <button
        type="button"
        onClick={() => onChange('split')}
        aria-pressed={value === 'split'}
        title="Split diff"
        className={btnClass(value === 'split')}
      >
        <Columns size={14} />
      </button>
    </div>
  )
}

// --- Worktree/local chip ------------------------------------------------------

/** "worktree · <branch>" vs "local" — the app already tracks
 *  worktreeParentCwd/worktreeBranch per workspace (see WorkspaceTitleBar's
 *  own worktree chip), so this is pure presentation over props passed down
 *  from WorkspaceView, no new IPC needed. */
function WorktreeChip({
  worktreeParentCwd,
  worktreeBranch
}: {
  worktreeParentCwd: string | null
  worktreeBranch: string | null
}): React.JSX.Element {
  const isWorktree = worktreeParentCwd != null
  return (
    <span
      title={
        isWorktree
          ? `Worktree branch: ${worktreeBranch ?? 'unknown'}\nParent repo: ${worktreeParentCwd}`
          : 'Main checkout'
      }
      className="px-1.5 py-0.5 rounded text-[10px] font-medium text-text-muted bg-surface-overlay/60 border border-border-default/60 select-none whitespace-nowrap"
    >
      {isWorktree ? `worktree · ${worktreeBranch ?? '?'}` : 'local'}
    </span>
  )
}

// --- Changed-files tree pane ---------------------------------------------------

interface DiffTreePaneProps {
  files: readonly GitDiffFile[]
  selected: string | null
  onSelectFile: (path: string | null) => void
}

/** Left pane: a flat @pierre/trees fed the changed files' paths + git-status
 *  decorations. Selecting a file reports it up to GitTab, which looks up its
 *  patch for the diff pane. No directories in this list beyond what the
 *  paths themselves imply — @pierre/trees derives the folder structure from
 *  the path separators, same as FilesTab. */
function DiffTreePane({ files, selected, onSelectFile }: DiffTreePaneProps): React.JSX.Element {
  const paths = useMemo(() => files.map((f) => f.path), [files])
  const { model } = useFileTree({
    paths,
    initialExpansion: 'open',
    search: true
  })
  const selection = useFileTreeSelection(model)

  // Push the fresh path list + git-status decorations into the tree whenever
  // the diff result changes — imperative, matching FilesTab's §7 pattern
  // (useFileTree only consumes its `paths` option at construction time).
  useEffect(() => {
    model.resetPaths(paths)
    model.setGitStatus(toTreeGitStatus(files))
  }, [model, paths, files])

  // Report the single selected (non-directory) file up. Every path here is a
  // file already (git:diff never returns directories), so any single
  // selection is a valid target.
  useEffect(() => {
    const single = selection.length === 1 ? selection[0] : null
    if (single !== selected) onSelectFile(single)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `selected`/`onSelectFile` intentionally excluded: this effect only reacts to the tree's OWN selection changing, not to GitTab re-deriving `selected` from a fresh files[] after a refetch.
  }, [selection])

  const hostStyle = useMemo(() => {
    const vars = themeToTreeStyles(TREE_THEME)
    return { height: '100%', ...vars, ...TREE_GIT_STATUS_VARS } as React.CSSProperties
  }, [])

  return (
    <div style={hostStyle} className="h-full">
      <FileTree model={model} style={{ height: '100%' }} />
    </div>
  )
}

// --- Diff content pane ---------------------------------------------------------

interface DiffContentPaneProps {
  file: GitDiffFile | null
  diffStyle: DiffStyle
  loading: boolean
}

function DiffMessage({ text }: { text: string }): React.JSX.Element {
  return (
    <div
      className="flex-1 flex items-center justify-center min-h-0"
      style={{ backgroundColor: PIERRE_VIEWER_BG }}
    >
      <span className="text-xs text-text-muted select-none">{text}</span>
    </div>
  )
}

/** Right pane: the selected file's patch rendered via @pierre/diffs'
 *  <PatchDiff>, themed pierre-dark to match the Files-tab viewer, styled
 *  unified or split per the header toggle. Empty/loading/no-selection states
 *  mirror FilesTab's ViewerMessage convention. */
function DiffContentPane({ file, diffStyle, loading }: DiffContentPaneProps): React.JSX.Element {
  if (loading) return <DiffMessage text="Loading…" />
  if (file === null) return <DiffMessage text="Select a changed file to view its diff" />
  return (
    <div className="flex-1 min-h-0 overflow-auto" style={{ backgroundColor: PIERRE_VIEWER_BG }}>
      <PatchDiff
        key={file.path}
        patch={file.patch}
        options={{
          theme: VIEWER_THEME,
          themeType: 'dark',
          diffStyle
        }}
      />
    </div>
  )
}

// --- Root ------------------------------------------------------------------

/** Fetch the working-tree diff for `workspaceId`. Extracted so the debounced
 *  refetch effect below and the initial-load effect share one code path,
 *  keeping GitTab's own body under the cognitive-complexity ceiling. */
function fetchDiff(workspaceId: string, onSettled: (files: GitDiffFile[]) => void): () => void {
  let cancelled = false
  window.api.git
    .diff(workspaceId)
    .then((result) => {
      if (!cancelled) onSettled(result.files)
    })
    .catch((e) => {
      console.error('[GitTab] git:diff failed:', e)
      if (!cancelled) onSettled([])
    })
  return () => {
    cancelled = true
  }
}

/**
 * Workbench Git tab — Phase 1 body: a changed-files tree (left, collapsible)
 * and a per-file diff viewer (right). Mounted only while the Git tab is the
 * active, non-dormant Workbench tab (see WorkbenchPanel).
 */
export function GitTab({
  workspaceId,
  worktreeParentCwd,
  worktreeBranch
}: GitTabProps): React.JSX.Element {
  const [files, setFiles] = useState<GitDiffFile[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [treeOpen, setTreeOpen] = useState(true)
  const [diffStyle, setDiffStyle] = useState<DiffStyle>('unified')
  const [subTab, setSubTab] = useState<GitSubTab>('diff')

  // Initial load + workspace change. Resets files/selectedPath alongside
  // loading — otherwise DiffTreePane/DiffContentPane would briefly render the
  // PREVIOUS workspace's changed files/diff (loading=true but stale `files`)
  // until the new workspace's git:diff settles (CodeRabbit finding, fixed).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: a workspace switch must show "Loading…" (with no stale prior-workspace data) immediately rather than waiting; the settled result arrives asynchronously via fetchDiff's callback below.
    setLoading(true)
    setFiles([])
    setSelectedPath(null)
    return fetchDiff(workspaceId, (f) => {
      setFiles(f)
      setLoading(false)
    })
  }, [workspaceId])

  // Live refresh: git:statusChanged (branch/index change — src/main/git.ts's
  // .git watcher, already running unconditionally since terminal:mount) and
  // files:changed (working-tree edits — filesWatcher.ts, active only while a
  // Files tab is open elsewhere) both indicate the working tree may have
  // moved; refetch git:diff, debounced so a burst of either collapses into
  // one round-trip. Deliberately does NOT call files:watchStart — that would
  // fight filesWatcher.ts's single-active-watcher invariant, which whichever
  // Files tab is open already owns.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    const scheduleRefetch = (): void => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null
        cleanupRef.current?.()
        cleanupRef.current = fetchDiff(workspaceId, setFiles)
      }, REFRESH_DEBOUNCE_MS)
    }
    const unsubStatus = window.api.git.onStatusChanged((e) => {
      if (e.workspaceId === workspaceId) scheduleRefetch()
    })
    const unsubFiles = window.api.files.onFilesChanged((e) => {
      if (e.workspaceId === workspaceId) scheduleRefetch()
    })
    return () => {
      unsubStatus()
      unsubFiles()
      if (debounceRef.current !== null) clearTimeout(debounceRef.current)
      cleanupRef.current?.()
      cleanupRef.current = null
    }
  }, [workspaceId])

  // If the currently-selected file drops out of the diff (e.g. the user
  // committed/discarded it externally), `selectedFile` below simply derives
  // to null — no separate effect needed to "clear" `selectedPath` itself;
  // DiffContentPane already renders the no-selection message for a null
  // file, and if the same path reappears later selection re-resolves
  // naturally from the same derivation.
  const selectedFile = useMemo(
    () => files.find((f) => f.path === selectedPath) ?? null,
    [files, selectedPath]
  )

  const toggleTree = useCallback(() => setTreeOpen((v) => !v), [])

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col">
      <div className="h-8 flex-shrink-0 border-b border-border-default flex items-center px-1 gap-1">
        <button
          type="button"
          onClick={toggleTree}
          aria-pressed={treeOpen}
          aria-label={treeOpen ? 'Hide changed-files tree' : 'Show changed-files tree'}
          title={treeOpen ? 'Hide changed-files tree' : 'Show changed-files tree'}
          className="p-1 rounded text-text-muted hover:bg-surface-raised hover:text-text-primary"
        >
          <List size={16} />
        </button>
        <DiffStyleToggle value={diffStyle} onChange={setDiffStyle} />
        <div className="ml-auto flex items-center gap-2">
          <WorktreeChip worktreeParentCwd={worktreeParentCwd} worktreeBranch={worktreeBranch} />
          <SubTabStrip active={subTab} onChange={setSubTab} />
        </div>
      </div>
      {subTab === 'commits' ? (
        <DiffMessage text="Commits — coming soon" />
      ) : (
        <div className="flex-1 min-h-0 flex">
          <div
            hidden={!treeOpen}
            className="w-60 flex-shrink-0 min-h-0 border-r border-border-default"
          >
            <DiffTreePane files={files} selected={selectedPath} onSelectFile={setSelectedPath} />
          </div>
          <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            <DiffContentPane file={selectedFile} diffStyle={diffStyle} loading={loading} />
          </div>
        </div>
      )}
    </div>
  )
}
