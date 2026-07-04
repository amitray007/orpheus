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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { FileTree, useFileTree, useFileTreeSelection } from '@pierre/trees/react'
import { themeToTreeStyles, type TreeThemeInput } from '@pierre/trees'
import { File as PierreFile } from '@pierre/diffs/react'
import { List } from '@phosphor-icons/react'
import type { FileContents } from '@shared/types'

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

// Pierre's bundled dark/light themes for the <File> viewer (§8) — the same
// pair the smoke test's <PatchDiff> used. `themeType: 'dark'` picks dark.
const VIEWER_THEME = { dark: 'pierre-dark', light: 'pierre-light' } as const

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
  onSelectFile: (path: string | null) => void
}

/** Left pane: fetches the dir listing, seeds/updates the Pierre tree, and
 *  reports the single selected file path up to FilesTab. Extracted so the
 *  fetch + imperative resetPaths + selection wiring stays out of FilesTab's
 *  body (cognitive-complexity ceiling). */
function TreePane({ workspaceId, onSelectFile }: TreePaneProps): React.JSX.Element {
  const [truncated, setTruncated] = useState(false)
  const [pathCount, setPathCount] = useState(0)
  // Seeded empty; the first workspace's paths arrive via resetPaths in the
  // fetch effect below (keeps a single imperative code path for both the
  // initial load and subsequent workspace changes — §7).
  const { model } = useFileTree({ paths: [], initialExpansion: 'open', search: true })
  const selection = useFileTreeSelection(model)

  // Report the derived file-to-view up whenever the selection changes.
  const derived = useMemo(() => fileToView(selection), [selection])
  useEffect(() => {
    onSelectFile(derived)
  }, [derived, onSelectFile])

  // Fetch + (re)seed on workspace change. resetPaths is imperative (§7): the
  // tree does NOT react to a changed `paths` prop, so every update — including
  // the initial load — flows through model.resetPaths(...).
  useEffect(() => {
    let cancelled = false
    window.api.files
      .listDir(workspaceId)
      .then((listing) => {
        if (cancelled) return
        model.resetPaths(listing.paths)
        setTruncated(listing.truncated)
        setPathCount(listing.paths.length)
      })
      .catch((e) => {
        if (cancelled) return
        console.error('[FilesTab] listDir failed:', e)
        model.resetPaths([])
        setTruncated(false)
        setPathCount(0)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, model])

  const hostStyle = useMemo(() => {
    const vars = themeToTreeStyles(TREE_THEME)
    return { height: '100%', ...vars } as React.CSSProperties
  }, [])

  return (
    <div className="flex flex-col h-full min-h-0">
      <div style={hostStyle} className="flex-1 min-h-0">
        <FileTree model={model} style={{ height: '100%' }} />
      </div>
      {truncated && (
        <div className="flex-shrink-0 px-2 py-1 text-[10px] text-text-muted border-t border-border-default select-none">
          showing first {pathCount} — tree truncated
        </div>
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

interface ViewerPaneProps {
  workspaceId: string
  path: string | null
}

/** Right pane: loads the selected file and routes the result to the correct
 *  presentation (text via <File>, binary/image placeholder, empty state).
 *  Extracted alongside TreePane to keep FilesTab's own complexity low. */
function ViewerPane({ workspaceId, path }: ViewerPaneProps): React.JSX.Element {
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
  return <ViewerBody path={path} result={current} />
}

interface ViewerBodyProps {
  path: string | null
  result: LoadedFile | null
}

/** Pure presentation split out of ViewerPane so the routing branches (empty /
 *  loading / error / image / binary / truncated+text) don't push ViewerPane's
 *  effect logic over the complexity ceiling. `result === null` while a path is
 *  selected means the fetch for it hasn't settled yet → loading. */
function ViewerBody({ path, result }: ViewerBodyProps): React.JSX.Element {
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
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0 overflow-auto">
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
  )
}

function ViewerMessage({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex-1 flex items-center justify-center min-h-0">
      <span className="text-xs text-text-muted select-none">{text}</span>
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
  const [treeOpen, setTreeOpen] = useState(true)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)

  const toggleTree = useCallback(() => setTreeOpen((v) => !v), [])

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
          <TreePane workspaceId={workspaceId} onSelectFile={setSelectedFile} />
        </div>
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          <ViewerPane workspaceId={workspaceId} path={selectedFile} />
        </div>
      </div>
    </div>
  )
}
