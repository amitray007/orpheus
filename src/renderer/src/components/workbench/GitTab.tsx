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
//
// Phase 1 refinements (this pass):
//   FIX 1 — auto-select the first changed file when the diff loads/refreshes
//     and nothing is selected (or the prior selection dropped out), so the
//     tab shows a diff immediately instead of an empty "Select a file" state.
//   FIX 2 — a ⚙ GitDiffOptionsPopover (mirrors FilesTab's TreeOptionsPopover)
//     holding a "Wrap lines" toggle for the diff viewer, persisted app-wide
//     via AppUiState.gitDiffWrapLines (same files_wrap_lines pattern), plus a
//     search-icon toggle for the changed-files tree (mirrors FilesTab's
//     TreeToolbar search-icon-toggle fix). NOTE: "search in git commits" is a
//     separate ask — the Commits sub-tab is a Phase-3 stub today, so
//     commit-search lands there, not here; this only searches changed FILES.
//   FIX 3 — the per-row +/- counts are right-aligned with tabular-nums so
//     they line up column-wise regardless of digit count.
//   FIX 4 — binary files (gitDiff.ts now flags `binary: boolean`) show
//     "Binary" instead of a meaningless "-0 +0", and the diff pane renders the
//     current image (via files:readImage) for image extensions or a "no
//     preview" placeholder for other binary files, instead of a blank PatchDiff.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { FileTree, useFileTree, useFileTreeSearch, useFileTreeSelection } from '@pierre/trees/react'
import {
  themeToTreeStyles,
  type TreeThemeInput,
  type FileTreeRowDecorationContext,
  type FileTreeRowDecorationRenderer
} from '@pierre/trees'
import { PatchDiff } from '@pierre/diffs/react'
import { List, Rows, Columns, MagnifyingGlass } from '@phosphor-icons/react'
import type { FileImage, GitDiffFile, GitStatusEntry } from '@shared/types'
import { UI_STATE_DEFAULTS } from '@shared/uiStateDefaults'
import { useUiState, updateUiState } from '../../lib/uiStateStore'
import { PIERRE_VIEWER_BG } from './editor/chromeTheme'
import { GitDiffOptionsPopover } from './GitDiffOptionsPopover'

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

// Raster image extensions (Fix 4) — a changed binary file with one of these
// extensions renders as an <img> (via files:readImage) instead of a "no
// preview" placeholder. Kept as its own small const (not imported from
// FilesTab, which doesn't export its equivalent IMAGE_EXTENSIONS/isImagePath)
// — same "duplicated small literal, independently editable" rationale the
// module header already applies to TREE_THEME. SVG is deliberately excluded:
// it's XML/text source, so a changed .svg with actual hunks still renders as
// a normal text PatchDiff (only a truly binary .svg — rare — would fall
// through to the generic "Binary file" placeholder below).
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'])

function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return false
  return IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase())
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

// Fix 3: the per-row +/- decoration text is right-aligned by the library's
// own `[data-item-section="decoration"]` CSS (text-align: end; flex: 1 1 0;
// justify-content: flex-end) already, but plain decimal text of varying
// digit-width still visually "wiggles" against that shared right edge (e.g.
// "-0 +0" vs "-128 +34" don't line up column-wise) since the flex lane has no
// fixed width and each row's text is only as wide as its own content, and
// proportional-width digit glyphs don't align even when they ARE the same
// character count. Two fixes, both via unsafeCSS (the tree's shadow-DOM
// escape hatch — same one FilesTab uses for TREE_IGNORED_DIM_CSS):
//   (a) `font-variant-numeric: tabular-nums` on the decoration span so every
//       digit glyph has the same advance width;
//   (b) a fixed `min-width` on the decoration LANE itself so all rows share
//       the same lane boundary regardless of how many digits their own count
//       has (rather than each row's flex box just hugging its own text).
// The decoration API (@pierre/trees' FileTreeRowDecorationRenderer) only
// supports ONE plain-text (or icon) span per row — no per-token color
// spans — so true two-color "-D +A" (red minus, green plus) isn't reachable
// through this slot; the text itself is colored by git-status via the
// SAME override-chain FilesTab's ignored-dim rule already relies on
// (data-item-git-status), giving deletions-heavy rows a red-leaning tint and
// additions a green-leaning one where the underlying status makes that
// meaningful (added/untracked → green, deleted → red, modified/renamed →
// neutral) — see the `data-item-git-status` rules below. Binary files
// (Fix 4) render "Binary" here instead of a "-0 +0" that would otherwise be
// meaningless.
const DECORATION_LANE_CSS = `
  [data-item-section="decoration"] {
    min-width: 72px;
  }
  [data-item-section="decoration"] > span {
    font-variant-numeric: tabular-nums;
    font-feature-settings: 'tnum' 1;
  }
  [data-item-git-status="added"] [data-item-section="decoration"] > span,
  [data-item-git-status="untracked"] [data-item-section="decoration"] > span {
    color: var(--trees-git-added-color-override, #3fb950);
  }
  [data-item-git-status="deleted"] [data-item-section="decoration"] > span {
    color: var(--trees-git-deleted-color-override, #f85149);
  }
  [data-file-tree-search-container][data-open="false"] {
    display: none;
  }
`

/** Fixed-width-padded "-D +A" decoration text for one changed file — pads
 *  each number to 3 characters (right-aligned, non-breaking spaces so the
 *  browser doesn't collapse them) so the tabular-nums glyphs line up at a
 *  consistent column even before the lane's own min-width kicks in. Binary
 *  files show "Binary" instead — their additions/deletions are always 0,
 *  which would otherwise render the exact "-0 +0" the user reported as
 *  meaningless. */
function decorationText(file: GitDiffFile): string {
  if (file.binary) return 'Binary'
  const pad = (n: number): string => n.toString().padStart(3, ' ')
  return `-${pad(file.deletions)} +${pad(file.additions)}`
}

interface DiffTreePaneProps {
  files: readonly GitDiffFile[]
  selected: string | null
  onSelectFile: (path: string | null) => void
}

// Shared icon-button class for the changed-files tree's own header toolbar —
// matches FilesTab's TOOLBAR_BUTTON_CLASS exactly so it reads as the same
// chrome family.
const SEARCH_TOGGLE_BUTTON_CLASS =
  'p-1 rounded text-text-muted hover:bg-surface-raised hover:text-text-primary'

/** Compact header rendered into `<FileTree header={...} />`: just a
 *  search-toggle icon (Fix 2's changed-files search) — mirrors FilesTab's
 *  TreeToolbar, minus the New Folder/New File actions (a git diff's changed
 *  files aren't user-creatable). NOTE: this is CHANGED-FILES search only —
 *  the user also asked for "search in git commits", which belongs to the
 *  Commits sub-tab (a Phase-3 stub today, see SubTabStrip); commit search
 *  lands there, not here. */
function DiffTreeToolbar({
  searchOpen,
  onToggleSearch
}: {
  searchOpen: boolean
  onToggleSearch: () => void
}): React.JSX.Element {
  return (
    <div className="flex items-center h-7 px-1">
      <button
        type="button"
        onClick={onToggleSearch}
        aria-pressed={searchOpen}
        title="Search changed files"
        className={SEARCH_TOGGLE_BUTTON_CLASS}
      >
        <MagnifyingGlass size={14} />
      </button>
    </div>
  )
}

/** Left pane: a flat @pierre/trees fed the changed files' paths + git-status
 *  decorations. Selecting a file reports it up to GitTab, which looks up its
 *  patch for the diff pane. No directories in this list beyond what the
 *  paths themselves imply — @pierre/trees derives the folder structure from
 *  the path separators, same as FilesTab. */
function DiffTreePane({ files, selected, onSelectFile }: DiffTreePaneProps): React.JSX.Element {
  const paths = useMemo(() => files.map((f) => f.path), [files])
  // Keyed by path so the decoration renderer (an imperative callback, not a
  // reactive prop — @pierre/trees calls it per-row at render time) always
  // reads the CURRENT diff result rather than a stale closure over `files`
  // from construction time.
  const filesByPathRef = useRef<Map<string, GitDiffFile>>(new Map())
  useEffect(() => {
    filesByPathRef.current = new Map(files.map((f) => [f.path, f]))
  }, [files])

  const renderRowDecoration = useCallback<FileTreeRowDecorationRenderer>(
    (ctx: FileTreeRowDecorationContext) => {
      if (ctx.item.kind !== 'file') return null
      const file = filesByPathRef.current.get(ctx.item.path)
      if (!file) return null
      return {
        text: decorationText(file),
        title: `${file.deletions} deleted, ${file.additions} added`
      }
    },
    []
  )

  const { model } = useFileTree({
    paths,
    initialExpansion: 'open',
    search: true,
    unsafeCSS: DECORATION_LANE_CSS,
    renderRowDecoration
  })
  const selection = useFileTreeSelection(model)
  // Search-icon-toggle (Fix 2) — same visibility pattern FilesTab's TreePane
  // uses: `search: true` is required for the controller's search state to
  // exist at all, but the library always mounts the search box regardless of
  // `isOpen` (see FilesTab's SEARCH BOX VISIBILITY comment) — so `data-open`
  // is overridden via unsafeCSS below to actually hide/show it.
  const search = useFileTreeSearch(model)
  const toggleSearch = useCallback(() => {
    if (search.isOpen) search.close()
    else search.open()
  }, [search])

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

  const toolbar = useMemo(
    () => <DiffTreeToolbar searchOpen={search.isOpen} onToggleSearch={toggleSearch} />,
    [search.isOpen, toggleSearch]
  )

  const hostStyle = useMemo(() => {
    const vars = themeToTreeStyles(TREE_THEME)
    return { height: '100%', ...vars, ...TREE_GIT_STATUS_VARS } as React.CSSProperties
  }, [])

  return (
    <div style={hostStyle} className="h-full">
      <FileTree model={model} header={toolbar} style={{ height: '100%' }} />
    </div>
  )
}

// --- Diff content pane ---------------------------------------------------------

interface DiffContentPaneProps {
  workspaceId: string
  file: GitDiffFile | null
  diffStyle: DiffStyle
  wrapLines: boolean
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

// A settled files:readImage result, tagged with the path it belongs to —
// the same stale-guard shape FilesTab's LoadedImage uses, so a fast
// re-selection while a fetch is in flight can't commit a mismatched image.
interface LoadedGitImage {
  path: string
  image: FileImage
}

/** Fix 4 (image branch): fetches + renders the CURRENT on-disk image for a
 *  changed binary file whose extension is a recognized raster format, via
 *  the existing files:readImage IPC — the same one FilesTab's ImageBody
 *  uses. Showing the current/new version is the documented minimum (a
 *  before/after diff is a nice-to-have the task explicitly says to skip if
 *  non-trivial — it would need a second read of the file at HEAD, which
 *  files:readImage has no revision parameter for). */
function BinaryImageBody({
  workspaceId,
  path
}: {
  workspaceId: string
  path: string
}): React.JSX.Element {
  const [loaded, setLoaded] = useState<LoadedGitImage | null>(null)
  useEffect(() => {
    let cancelled = false
    window.api.files
      .readImage(workspaceId, path)
      .then((image) => {
        if (!cancelled) setLoaded({ path, image })
      })
      .catch((e) => {
        console.error('[GitTab] readImage failed:', e)
        if (!cancelled) setLoaded({ path, image: { ok: false, error: 'denied' } })
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, path])

  const current = loaded && loaded.path === path ? loaded.image : null
  if (current === null) return <DiffMessage text="Loading…" />
  if (!current.ok) {
    if (current.error === 'too-large') {
      return <DiffMessage text="Image too large to preview (over 5 MB)" />
    }
    return <DiffMessage text="Could not load image" />
  }
  return (
    <div
      className="flex-1 min-h-0 flex items-center justify-center overflow-hidden"
      style={{ backgroundColor: PIERRE_VIEWER_BG }}
    >
      <img
        src={current.dataUrl}
        alt=""
        draggable={false}
        className="max-w-full max-h-full object-contain"
      />
    </div>
  )
}

/** Right pane: the selected file's patch rendered via @pierre/diffs'
 *  <PatchDiff>, themed pierre-dark to match the Files-tab viewer, styled
 *  unified or split per the header toggle, word-wrapped per the ⚙ popover's
 *  Wrap-lines toggle. Empty/loading/no-selection states mirror FilesTab's
 *  ViewerMessage convention.
 *
 *  Fix 4: a `binary` file never reaches <PatchDiff> — its patch chunk is a
 *  `Binary files … differ` marker with no real hunks, which PatchDiff would
 *  render as a blank pane. Image extensions route to BinaryImageBody
 *  (current on-disk image via files:readImage); every other binary file
 *  gets a plain "no preview" placeholder. */
function DiffContentPane({
  workspaceId,
  file,
  diffStyle,
  wrapLines,
  loading
}: DiffContentPaneProps): React.JSX.Element {
  if (loading) return <DiffMessage text="Loading…" />
  if (file === null) return <DiffMessage text="Select a changed file to view its diff" />
  if (file.binary) {
    if (isImagePath(file.path)) {
      return <BinaryImageBody workspaceId={workspaceId} path={file.path} />
    }
    return <DiffMessage text="Binary file — no preview" />
  }
  return (
    <div className="flex-1 min-h-0 overflow-auto" style={{ backgroundColor: PIERRE_VIEWER_BG }}>
      <PatchDiff
        key={file.path}
        patch={file.patch}
        options={{
          theme: VIEWER_THEME,
          themeType: 'dark',
          diffStyle,
          overflow: wrapLines ? 'wrap' : 'scroll'
        }}
      />
    </div>
  )
}

// --- Root ------------------------------------------------------------------

/** Fix 1 — the auto-select rule applied every time a fresh `files[]` result
 *  settles (initial load, live-refresh refetch): keep the current selection
 *  if that path is STILL present in the new result (a refresh must not yank
 *  the user off the file they're looking at); otherwise fall back to the
 *  first changed file so the tab always shows a diff by default instead of
 *  the empty "Select a file" state. Returns null only when `files` itself is
 *  empty (a clean tree — nothing to select). Pure so it's trivially testable
 *  and keeps the effects below declarative. */
function nextSelection(files: readonly GitDiffFile[], current: string | null): string | null {
  if (current !== null && files.some((f) => f.path === current)) return current
  return files[0]?.path ?? null
}

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

  // Fix 1: every settled `files[]` (initial load AND live-refresh refetch)
  // runs through nextSelection so the tab auto-selects the first changed
  // file when nothing is selected (or the prior selection dropped out),
  // while preserving an existing selection that's still present. Wraps
  // `setFiles` so every call site below gets this for free, rather than
  // repeating the selection-derivation at each of the two settle points.
  const applyFiles = useCallback((f: GitDiffFile[]) => {
    setFiles(f)
    setSelectedPath((prev) => nextSelection(f, prev))
  }, [])

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
      applyFiles(f)
      setLoading(false)
    })
  }, [workspaceId, applyFiles])

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
        cleanupRef.current = fetchDiff(workspaceId, applyFiles)
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
  }, [workspaceId, applyFiles])

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

  // Fix 2: the ⚙ diff-options popover's Wrap-lines toggle — APP-WIDE view
  // preference, persisted via AppUiState.gitDiffWrapLines (same
  // files_wrap_lines pattern FilesTab's TreeOptionsPopover uses). Falls back
  // to UI_STATE_DEFAULTS while the initial uiState.get() hasn't resolved yet.
  const uiState = useUiState()
  const wrapLines = uiState?.gitDiffWrapLines ?? UI_STATE_DEFAULTS.gitDiffWrapLines
  const diffOptions = useMemo(() => ({ wrapLines }), [wrapLines])
  const setDiffOptions = useCallback((next: { wrapLines: boolean }) => {
    updateUiState({ gitDiffWrapLines: next.wrapLines })
  }, [])

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
        <GitDiffOptionsPopover options={diffOptions} onChange={setDiffOptions} />
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
            <DiffContentPane
              workspaceId={workspaceId}
              file={selectedFile}
              diffStyle={diffStyle}
              wrapLines={wrapLines}
              loading={loading}
            />
          </div>
        </div>
      )}
    </div>
  )
}
