// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/FilesTab.tsx
//
// U10 (Stage B) — the Workbench Files tab: a toggleable file TREE (left) +
// a read-only VIEWER (right), wired to Stage A's `window.api.files.*` IPCs
// (docs/plans/2026-07-02-001-feat-workbench-panes-plan.md;
// docs/brainstorms/2026-07-02-workbench-panes-requirements.md §5.3).
//
// Data flow (mirrors the Pierre smoke test — see __pierre_smoke__.tsx and
// docs/learnings/pierre-libraries.md §7/§8):
//   - TREE: `files:listDir(workspaceId)` → flat repo-relative POSIX paths
//     (dirs trailing-slash, files not) → seeded into `useFileTree({ paths })`.
//     The tree consumes paths IMPERATIVELY (§7): the initial set goes through
//     the hook once; a workspace change re-fetches and calls
//     `model.resetPaths(paths)` rather than swapping a prop.
//   - SELECTION → VIEWER: there is NO onActivate/onOpen event (§7). We read
//     the reactive `useFileTreeSelection(model)` and derive the single
//     selected path that is NOT a directory (no trailing slash); that becomes
//     the file to view. Directories toggle-expand natively on click and never
//     open anything in the viewer.
//   - VIEWER: `files:readFile(workspaceId, path)` → routed by result: binary
//     (or image extension) → placeholder; text → Pierre's `<File>` with the
//     bundled `pierre-dark` theme; `truncated` → a subtle note.
//
// Gating: this whole component is only MOUNTED when the Files tab is the
// active Workbench tab and the Workbench is open (see WorkbenchPanel — the
// tabpanel is `hidden` + this branch only renders for `id === activeTab &&
// !dormant`), so listDir is never fetched while the tab isn't shown.
//
// Theming: both Pierre components render inside shadow roots (§4) — Tailwind
// can't reach in. The tree is themed via `themeToTreeStyles(theme)` applied to
// a host wrapper div (CSS-var bridge); the viewer via `options.theme`
// (Pierre's bundled dark/light). Same theme shape as __pierre_smoke__.tsx.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { FileTree, useFileTree, useFileTreeSelection } from '@pierre/trees/react'
import {
  themeToTreeStyles,
  type TreeThemeInput,
  type ContextMenuItem as FileTreeContextMenuItem,
  type ContextMenuOpenContext as FileTreeContextMenuOpenContext,
  type FileTreeRenameEvent
} from '@pierre/trees'
import { File as PierreFile } from '@pierre/diffs/react'
import { List } from '@phosphor-icons/react'
import type { FileEntry, FileContents, GitStatusEntry } from '@shared/types'
import { useUiState } from '../../lib/uiStateStore'
import {
  useFilesTabEntry,
  getFilesTabEntry,
  setFilesTabEntry,
  type FilesViewMode
} from '../../lib/filesTabStore'
import { CodeEditor } from './editor/CodeEditor'
import { PIERRE_VIEWER_BG } from './editor/chromeTheme'
import { TreeOptionsPopover, type TreeOptionsState } from './TreeOptionsPopover'
import { FilesTreeContextMenu } from './FilesTreeContextMenu'
import { useFilesTreeMutations, type TreeModel } from './useFilesTreeMutations'
import { ConfirmModal } from '../ConfirmModal'

// Dark theme for the tree's shadow DOM — same minimal ThemeLike shape the
// smoke test proved (docs/learnings/pierre-libraries.md §5.1). Anchored on
// Orpheus's dark palette + the #7c8cff accent for selection/focus.
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

// Raw CSS injected into the tree's shadow root (§5 escape hatch) so a whole
// ROW carrying git-status `ignored` dims — the tree's own bundled CSS only
// dims the ignored row's ICON (opacity .5), not the full row. We tag
// gitignored/denylisted paths with status:'ignored' (see ignoredStatus →
// setGitStatus) and this rule dims the row. 0.62 keeps the row text clearly
// readable while still reading as de-emphasized (0.5 was too faint). When "Dim
// gitignored" is OFF we simply don't tag those paths, so this rule matches
// nothing and they render at full opacity — dim is a pure style toggle, never
// a presence one (§11).
const TREE_IGNORED_DIM_CSS = `
  [data-item-git-status="ignored"] {
    opacity: 0.62;
  }
`

// Pierre's bundled dark/light themes for the <File> viewer (§8) — the same
// pair the smoke test's <PatchDiff> used. `themeType: 'dark'` picks dark.
const VIEWER_THEME = { dark: 'pierre-dark', light: 'pierre-light' } as const

// --- Tier → visible-paths + dim wiring (§11) -------------------------------
// From the tagged listDir entries + the two popover toggles, compute (a) the
// flat path list fed to the tree via resetPaths and (b) which of those paths
// carry the `ignored` git-status that drives the row dim. Pure functions so
// toggling recomputes instantly from the ALREADY-FETCHED entries (no re-fetch).

/** Paths visible under the current toggles: always `normal` + `gitignored`;
 *  `denylisted` only when Show hidden is on. */
function visiblePaths(entries: readonly FileEntry[], showHidden: boolean): string[] {
  return entries.flatMap((e) => (e.tier === 'denylisted' && !showHidden ? [] : [e.path]))
}

/** The `ignored` git-status entries that dim rows. Gitignored rows dim only
 *  when Dim gitignored is on; a revealed denylisted row is ALSO dimmed (it's
 *  noise the user opted to peek at). A path present in this list matches the
 *  injected `[data-item-git-status="ignored"]` dim rule. */
function ignoredStatus(entries: readonly FileEntry[], options: TreeOptionsState): GitStatusEntry[] {
  return entries.flatMap((e) => {
    if (e.tier === 'denylisted') {
      return options.showHidden ? [{ path: e.path, status: 'ignored' as const }] : []
    }
    if (e.tier === 'gitignored' && options.dimGitignored) {
      return [{ path: e.path, status: 'ignored' as const }]
    }
    return []
  })
}

// Image extensions we recognize for the "image file" placeholder branch. For
// Stage B images get a calm placeholder (not real rendering) — see the note
// in the report / imageExtensions block below.
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'])

function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return false
  return IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase())
}

function formatKB(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** The single non-directory path in a selection, or null. Directories carry a
 *  trailing slash (Stage A / §7); selecting one expands it and opens nothing.
 *  A multi-select or a directory-only selection yields null (no file to view). */
function fileToView(selection: readonly string[]): string | null {
  const files = selection.filter((p) => !p.endsWith('/'))
  return files.length === 1 ? files[0] : null
}

export interface FilesTabProps {
  /** The owning claude workspace's id — resolves to the workspace cwd in the
   *  main process (see src/main/ipc/files.ts). */
  workspaceId: string
}

// --- Tree pane -------------------------------------------------------------

interface TreePaneProps {
  workspaceId: string
  options: TreeOptionsState
  onSelectFile: (path: string | null) => void
}

/** Left pane: fetches the tier-tagged dir listing ONCE per workspace, seeds/
 *  updates the Pierre tree, applies the tree-options toggles client-side, and
 *  reports the single selected file path up to FilesTab. Extracted so the
 *  fetch + imperative resetPaths + selection wiring stays out of FilesTab's
 *  body (cognitive-complexity ceiling). */
function TreePane({ workspaceId, options, onSelectFile }: TreePaneProps): React.JSX.Element {
  const [truncated, setTruncated] = useState(false)
  const [pathCount, setPathCount] = useState(0)
  // Transient inline error banner for a failed create/rename/delete (§ "surface
  // errors, don't swallow"). Cleared on the next successful action / re-fetch.
  const [error, setError] = useState<string | null>(null)
  // The already-fetched, tier-tagged entries for the current workspace. Kept in
  // a ref so a toggle change re-filters WITHOUT re-fetching listDir (§11).
  const entriesRef = useRef<FileEntry[]>([])

  // The rename onRename/onError handlers live in a ref so they can be given to
  // useFileTree's `renaming` config once (stable) while still calling the
  // latest mutations hook closures (which depend on model/workspaceId).
  const renameHandlersRef = useRef<{
    onRename: (e: FileTreeRenameEvent) => void
    onError: (m: string) => void
  }>({ onRename: () => {}, onError: () => {} })

  // Seeded empty; the first workspace's paths arrive via resetPaths in the
  // fetch effect below (keeps a single imperative code path for both the
  // initial load and subsequent workspace changes — §7). unsafeCSS dims full
  // rows tagged git-status `ignored` (see TREE_IGNORED_DIM_CSS). `renaming`
  // enables the built-in inline rename input (§10.2); `composition.contextMenu`
  // enables the right-click trigger for renderContextMenu (§10.3).
  const { model } = useFileTree({
    paths: [],
    initialExpansion: 'open',
    search: true,
    unsafeCSS: TREE_IGNORED_DIM_CSS,
    composition: { contextMenu: { enabled: true } },
    renaming: {
      onRename: (e: FileTreeRenameEvent) => renameHandlersRef.current.onRename(e),
      onError: (m: string) => renameHandlersRef.current.onError(m)
    }
  })
  const selection = useFileTreeSelection(model)

  // Report the derived file-to-view up whenever the selection changes.
  const derived = useMemo(() => fileToView(selection), [selection])
  useEffect(() => {
    onSelectFile(derived)
  }, [derived, onSelectFile])

  // Apply the current toggles to the cached entries: reset the visible paths
  // and (re)set the `ignored` git-status that drives dimming. Imperative (§7).
  const applyOptions = useCallback(
    (entries: readonly FileEntry[], opts: TreeOptionsState): void => {
      const paths = visiblePaths(entries, opts.showHidden)
      model.resetPaths(paths)
      model.setGitStatus(ignoredStatus(entries, opts))
      setPathCount(paths.length)
    },
    [model]
  )

  // Latest-options ref (written in a layout effect, per useEscapeKey's pattern)
  // so the fetch effect can read current options WITHOUT depending on them —
  // toggling must NOT re-fetch (the toggle effect below re-filters instead).
  const optionsRef = useRef(options)
  useLayoutEffect(() => {
    optionsRef.current = options
  })

  // Fetch listDir + re-apply the current toggles. Reused for the initial load,
  // workspace changes, AND post-mutation re-tag (create/rename/delete) so the
  // tier/dim map always reflects disk. resetPaths is imperative (§7).
  const fetchEntries = useCallback(() => {
    let cancelled = false
    window.api.files
      .listDir(workspaceId)
      .then((listing) => {
        if (cancelled) return
        entriesRef.current = listing.entries
        applyOptions(listing.entries, optionsRef.current)
        setTruncated(listing.truncated)
      })
      .catch((e) => {
        if (cancelled) return
        console.error('[FilesTab] listDir failed:', e)
        entriesRef.current = []
        applyOptions([], optionsRef.current)
        setTruncated(false)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, applyOptions])

  useEffect(() => fetchEntries(), [fetchEntries])

  // Re-filter the ALREADY-FETCHED entries whenever a toggle flips — instant,
  // no IPC round-trip (§11).
  useEffect(() => {
    applyOptions(entriesRef.current, options)
  }, [options, applyOptions])

  // A post-mutation refetch that also clears any stale error banner.
  const refetch = useCallback(() => {
    setError(null)
    fetchEntries()
  }, [fetchEntries])

  const getKnownPaths = useCallback(() => new Set(entriesRef.current.map((e) => e.path)), [])

  // Directory-delete confirm: `del` (in the mutations hook) awaits
  // confirmDirDelete(item), which opens a ConfirmModal and resolves the pending
  // promise from the modal's confirm/cancel handlers.
  const [pendingDelete, setPendingDelete] = useState<{
    item: FileTreeContextMenuItem
    resolve: (ok: boolean) => void
  } | null>(null)
  const confirmDirDelete = useCallback(
    (item: FileTreeContextMenuItem): Promise<boolean> =>
      new Promise<boolean>((resolve) => setPendingDelete({ item, resolve })),
    []
  )

  const mutations = useFilesTreeMutations({
    workspaceId,
    model: model as unknown as TreeModel,
    getKnownPaths,
    refetch,
    onError: setError,
    confirmDirDelete
  })

  // Keep the renaming handlers ref pointed at the latest hook closures.
  useLayoutEffect(() => {
    renameHandlersRef.current = {
      onRename: mutations.handleRename,
      onError: mutations.handleRenamingError
    }
  }, [mutations])

  const renderContextMenu = useCallback(
    (item: FileTreeContextMenuItem, ctx: FileTreeContextMenuOpenContext): React.ReactNode => (
      <FilesTreeContextMenu
        item={item}
        context={ctx}
        actions={mutations.buildActions(item, () => ctx.close())}
      />
    ),
    [mutations]
  )

  const hostStyle = useMemo(() => {
    const vars = themeToTreeStyles(TREE_THEME)
    return {
      height: '100%',
      ...vars,
      // The tree's default 16px inline inset (--trees-padding-inline-override,
      // 16px) boxes the search field + indents every row from the panel edges,
      // wasting horizontal space in our narrow sidebar. Zero it so the search
      // box and tree rows use the full panel width (row content still has its
      // own small item padding).
      '--trees-padding-inline-override': '0px'
    } as React.CSSProperties
  }, [])

  return (
    <div className="flex flex-col h-full min-h-0">
      {error && (
        <button
          type="button"
          onClick={() => setError(null)}
          title="Dismiss"
          className="flex-shrink-0 w-full text-left px-2 py-1 text-[11px] text-red-300 bg-red-500/10 border-b border-red-500/20 hover:bg-red-500/15"
        >
          {error}
        </button>
      )}
      <div style={hostStyle} className="flex-1 min-h-0">
        <FileTree model={model} renderContextMenu={renderContextMenu} style={{ height: '100%' }} />
      </div>
      {truncated && (
        <div className="flex-shrink-0 px-2 py-1 text-[10px] text-text-muted border-t border-border-default select-none">
          showing first {pathCount} — tree truncated
        </div>
      )}
      {pendingDelete && (
        <ConfirmModal
          title="Move folder to Trash?"
          body={
            <>
              <span className="font-mono text-text-primary">{pendingDelete.item.name}</span> and all
              of its contents will be moved to the Trash. You can recover it from Finder.
            </>
          }
          confirmLabel="Move to Trash"
          destructive
          onConfirm={() => {
            pendingDelete.resolve(true)
            setPendingDelete(null)
          }}
          onCancel={() => {
            pendingDelete.resolve(false)
            setPendingDelete(null)
          }}
        />
      )}
    </div>
  )
}

// --- Viewer pane -----------------------------------------------------------

// A settled readFile result, tagged with the path it belongs to. `error` is
// true when the readFile IPC itself rejected. `loading` is NOT stored here —
// it's derived in ViewerBody by comparing the selected `path` against
// `result.path` (see below), which keeps the effect free of a synchronous
// setState (react-hooks/set-state-in-effect).
interface LoadedFile {
  path: string
  contents: FileContents | null
  error: boolean
}

interface ContentPaneProps {
  workspaceId: string
  path: string | null
  mode: FilesViewMode
  autoSave: boolean
  onDirtyChange: (dirty: boolean) => void
}

/** Right pane: loads the selected file and routes the result to the correct
 *  presentation. In `viewer` mode, text renders via Pierre's read-only <File>;
 *  in `editor` mode, editable text renders via <CodeEditor>. Binary/image/empty/
 *  error states are identical in both modes (never editable). Extracted
 *  alongside TreePane to keep FilesTab's own complexity low. */
function ContentPane({
  workspaceId,
  path,
  mode,
  autoSave,
  onDirtyChange
}: ContentPaneProps): React.JSX.Element {
  // Holds only SETTLED results — the effect never sets state synchronously
  // (no "loading" write on entry). "Loading" is derived: whenever the selected
  // `path` differs from `result.path`, the fetch for `path` hasn't landed yet.
  const [result, setResult] = useState<LoadedFile | null>(null)
  // Guards a stale readFile resolving after the selection moved on — only the
  // most-recent requested path may commit its result.
  const requestedPathRef = useRef<string | null>(null)

  useEffect(() => {
    requestedPathRef.current = path
    if (path === null) return
    let cancelled = false
    window.api.files
      .readFile(workspaceId, path)
      .then((contents) => {
        if (cancelled || requestedPathRef.current !== path) return
        setResult({ path, contents, error: false })
      })
      .catch((e) => {
        if (cancelled || requestedPathRef.current !== path) return
        console.error('[FilesTab] readFile failed:', e)
        setResult({ path, contents: null, error: true })
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, path])

  // The result is only current when it matches the selected path; otherwise
  // we're still loading the newly-selected file.
  const current = result && result.path === path ? result : null
  return (
    <ContentBody
      workspaceId={workspaceId}
      path={path}
      result={current}
      mode={mode}
      autoSave={autoSave}
      onDirtyChange={onDirtyChange}
    />
  )
}

interface ContentBodyProps {
  workspaceId: string
  path: string | null
  result: LoadedFile | null
  mode: FilesViewMode
  autoSave: boolean
  onDirtyChange: (dirty: boolean) => void
}

/** Pure presentation split out of ContentPane so the routing branches (empty /
 *  loading / error / image / binary / text) don't push ContentPane's effect
 *  logic over the complexity ceiling. `result === null` while a path is selected
 *  means the fetch for it hasn't settled yet → loading. Text files route to the
 *  editor or the viewer per `mode`; every non-text state is mode-independent. */
function ContentBody({
  workspaceId,
  path,
  result,
  mode,
  autoSave,
  onDirtyChange
}: ContentBodyProps): React.JSX.Element {
  if (path === null) {
    return <ViewerMessage text="Select a file to view" />
  }
  if (result === null) {
    return <ViewerMessage text="Loading…" />
  }
  const { contents } = result
  if (result.error || contents === null) {
    return <ViewerMessage text="Could not read this file." />
  }
  if (isImagePath(path)) {
    return <ViewerMessage text={`Image file (${formatKB(contents.size)}) — preview coming soon`} />
  }
  if (contents.binary) {
    return <ViewerMessage text={`Binary file (${formatKB(contents.size)}) — no preview`} />
  }
  // Truncated files are read-only-safe in the viewer, but editing a partial
  // buffer then saving would DESTROY the un-read tail — so editing is refused
  // for them (only the viewer branch runs below).
  const editable = mode === 'editor' && !contents.truncated
  if (mode === 'editor' && contents.truncated) {
    return (
      <ViewerMessage text={`File too large to edit (${formatKB(contents.size)}) — view only`} />
    )
  }

  // Editable text mounts BOTH the editor and the viewer, toggling visibility
  // with `hidden` rather than conditionally rendering, so switching Editor →
  // Viewer keeps the editor's unsaved buffer + dirty state in memory (no
  // silent data loss). The editor keys on (workspaceId, path) so a genuinely
  // new file resets its baseline.
  return (
    <div className="flex flex-col h-full min-h-0">
      <div hidden={editable} className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {/* The <File> renders in a shadow root and only paints the pierre-dark
            background behind its actual text extent — empty space below the
            last line / right of short lines would show the PANEL background as a
            seam. Paint the scroll container the SAME editor.background so the
            whole viewer region reads as one dark surface (matches the editor). */}
        <div className="flex-1 min-h-0 overflow-auto" style={{ backgroundColor: PIERRE_VIEWER_BG }}>
          <PierreFile
            file={{ name: contents.name, contents: contents.contents }}
            options={{ theme: VIEWER_THEME, themeType: 'dark' }}
          />
        </div>
        {contents.truncated && (
          <div className="flex-shrink-0 px-3 py-1 text-[10px] text-text-muted border-t border-border-default select-none">
            file truncated at 3MB
          </div>
        )}
      </div>
      {!contents.truncated && (
        <div hidden={!editable} className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <CodeEditor
            key={`${workspaceId}:${path}`}
            workspaceId={workspaceId}
            path={path}
            name={contents.name}
            initialContents={contents.contents}
            autoSave={autoSave}
            onDirtyChange={onDirtyChange}
          />
        </div>
      )}
    </div>
  )
}

function ViewerMessage({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex-1 flex items-center justify-center min-h-0">
      <span className="text-xs text-text-muted select-none">{text}</span>
    </div>
  )
}

// --- Mode toggle -----------------------------------------------------------

interface ModeToggleProps {
  mode: FilesViewMode
  onChange: (mode: FilesViewMode) => void
  /** A dirty dot on the Editor segment when there are unsaved edits. */
  dirty: boolean
}

/** Compact [Viewer | Editor] segmented control. Viewer is the default. */
function ModeToggle({ mode, onChange, dirty }: ModeToggleProps): React.JSX.Element {
  const seg = (value: FilesViewMode, label: string): React.JSX.Element => {
    const active = mode === value
    return (
      <button
        type="button"
        onClick={() => onChange(value)}
        aria-pressed={active}
        className={[
          'relative px-2 py-0.5 rounded text-[11px] font-medium transition-colors duration-100',
          active
            ? 'bg-surface-raised text-text-primary'
            : 'text-text-muted hover:text-text-secondary'
        ].join(' ')}
      >
        {label}
        {value === 'editor' && dirty && (
          <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-accent" />
        )}
      </button>
    )
  }
  return (
    <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-surface-overlay/60 border border-border-default/60">
      {seg('viewer', 'Viewer')}
      {seg('editor', 'Editor')}
    </div>
  )
}

// --- Root ------------------------------------------------------------------

/**
 * Two-pane Files tab body: a collapsible file tree (left, ~240px) and a
 * read-only viewer (right). Mounted only while the Files tab is the active,
 * non-dormant Workbench tab (see WorkbenchPanel), so the dir listing is never
 * fetched when the tab isn't visible.
 */
export function FilesTab({ workspaceId }: FilesTabProps): React.JSX.Element {
  // Per-workspace Files-tab state (selectedFile / mode / treeOpen / treeOptions)
  // is lifted into a module-level keyed store so it SURVIVES this component's
  // unmount/remount — `MainContent` tears down the whole Workbench subtree when
  // you navigate to a project/workspaces page, and plain `useState` here would
  // re-initialize to defaults on return (losing the open file + mode + toggles).
  // Reads subscribe to just this workspace's entry; every setter writes the
  // full entry back. See src/renderer/src/lib/filesTabStore.ts.
  const entry = useFilesTabEntry(workspaceId)
  const { selectedFile, mode, treeOpen, treeOptions } = entry

  // `dirty` stays component-local: it's transient editor UI (the unsaved dot),
  // re-reported by the freshly-mounted editor from disk on remount, and never
  // persisted (see the dirty-buffer note in filesTabStore.ts).
  const [dirty, setDirty] = useState(false)

  const setSelectedFile = useCallback(
    (next: string | null) => {
      const cur = getFilesTabEntry(workspaceId)
      setFilesTabEntry(workspaceId, { ...cur, selectedFile: next })
    },
    [workspaceId]
  )
  const setMode = useCallback(
    (next: FilesViewMode) => {
      const cur = getFilesTabEntry(workspaceId)
      setFilesTabEntry(workspaceId, { ...cur, mode: next })
    },
    [workspaceId]
  )
  const setTreeOptions = useCallback(
    (next: TreeOptionsState) => {
      const cur = getFilesTabEntry(workspaceId)
      setFilesTabEntry(workspaceId, { ...cur, treeOptions: next })
    },
    [workspaceId]
  )

  // The persisted save-mode setting (default false = manual save). Read from
  // the app-wide ui-state store; the editor uses it to decide manual vs
  // debounced auto-save.
  const uiState = useUiState()
  const autoSave = uiState?.filesAutoSave ?? false

  const toggleTree = useCallback(() => {
    const cur = getFilesTabEntry(workspaceId)
    setFilesTabEntry(workspaceId, { ...cur, treeOpen: !cur.treeOpen })
  }, [workspaceId])

  // A newly-selected file starts clean; the freshly-mounted editor reports its
  // own dirty state from there. (An unmounting editor can't report false.)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: selecting a different file resets the dirty indicator; the incoming editor re-reports its own state on mount.
    setDirty(false)
  }, [selectedFile])

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col">
      <div className="h-8 flex-shrink-0 border-b border-border-default flex items-center px-1 gap-1">
        <button
          type="button"
          onClick={toggleTree}
          aria-pressed={treeOpen}
          aria-label={treeOpen ? 'Hide file tree' : 'Show file tree'}
          title={treeOpen ? 'Hide file tree' : 'Show file tree'}
          className="p-1 rounded text-text-muted hover:bg-surface-raised hover:text-text-primary"
        >
          <List size={16} />
        </button>
        <TreeOptionsPopover options={treeOptions} onChange={setTreeOptions} />
        <div className="ml-auto pr-1">
          <ModeToggle mode={mode} onChange={setMode} dirty={dirty} />
        </div>
      </div>
      <div className="flex-1 min-h-0 flex">
        {/* Kept MOUNTED and hidden via `display` (not conditionally rendered)
            so toggling the tree closed doesn't tear down its useFileTree model
            — that would reset expansion + selection and re-fetch the listing on
            every reopen. Hidden with `hidden` (display:none) which also drops
            it from layout so the viewer takes the full width. */}
        <div
          hidden={!treeOpen}
          className="w-60 flex-shrink-0 min-h-0 border-r border-border-default"
        >
          <TreePane
            workspaceId={workspaceId}
            options={treeOptions}
            onSelectFile={setSelectedFile}
          />
        </div>
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          <ContentPane
            workspaceId={workspaceId}
            path={selectedFile}
            mode={mode}
            autoSave={autoSave}
            onDirtyChange={setDirty}
          />
        </div>
      </div>
    </div>
  )
}
