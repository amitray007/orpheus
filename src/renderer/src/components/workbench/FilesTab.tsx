// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/FilesTab.tsx
//
// U10 (Stage B) — the Workbench Files tab: a toggleable file TREE (left) +
// a read-only VIEWER (right), wired to Stage A's `window.api.files.*` IPCs
// (docs/plans/2026-07-02-001-feat-workbench-panes-plan.md;
// docs/brainstorms/2026-07-02-workbench-panes-requirements.md §5.3).
//
// Data flow (originally prototyped against a throwaway Pierre smoke test,
// since deleted now that this tab and GitTab.tsx are the real thing — see
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
//   - VIEWER: image extensions → `files:readImage(workspaceId, path)` (base64
//     data URL → `<img>`); everything else → `files:readFile(workspaceId,
//     path)`, routed by result: binary → placeholder; text → Pierre's `<File>`
//     with the bundled `pierre-dark` theme; `truncated` → a subtle note.
//
// Gating: this whole component is only MOUNTED when the Files tab is the
// active Workbench tab and the Workbench is open (see WorkbenchPanel — the
// tabpanel is `hidden` + this branch only renders for `id === activeTab &&
// !dormant`), so listDir is never fetched while the tab isn't shown.
//
// Theming: both Pierre components render inside shadow roots (§4) — Tailwind
// can't reach in. The tree is themed via `themeToTreeStyles(theme)` applied to
// a host wrapper div (CSS-var bridge); the viewer via `options.theme`
// (Pierre's bundled dark/light).
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { FileTree, useFileTree, useFileTreeSearch, useFileTreeSelection } from '@pierre/trees/react'
import {
  type ContextMenuItem as FileTreeContextMenuItem,
  type ContextMenuOpenContext as FileTreeContextMenuOpenContext,
  type FileTreeRenameEvent,
  type FileTreeSortComparator
} from '@pierre/trees'
import { File as PierreFile, Virtualizer } from '@pierre/diffs/react'
import { List, MagnifyingGlass, FolderPlus, FilePlus } from '@phosphor-icons/react'
import type { FileEntry, FileContents, FileImage, GitStatusEntry } from '@shared/types'
import { UI_STATE_DEFAULTS } from '@shared/uiStateDefaults'
import { useUiState, updateUiState } from '../../lib/uiStateStore'
import {
  useFilesTabEntry,
  getFilesTabEntry,
  setFilesTabEntry,
  type FilesViewMode
} from '../../lib/filesTabStore'
import { CodeEditor } from './editor/CodeEditor'
import {
  treeHostStyle,
  TREE_ICONS,
  TREE_DENSITY,
  TREE_RENDER_OPTIONS,
  TREE_DIR_GIT_CHANGE_CSS
} from './treeConfig'
import { PIERRE_VIEWER_BG } from './editor/chromeTheme'
import { PreviewPane } from './PreviewPane'
import { isRenderablePath } from './previewRender'
import { TreeOptionsPopover, type TreeOptionsState } from './TreeOptionsPopover'
import { useTreeWidthDrag, TREE_WIDTH_CSS_VAR } from './useTreeWidthDrag'
import { useImageZoomPan } from './useImageZoomPan'
import { ImageZoomBar } from './ImageZoomBar'
import { FilesTreeContextMenu } from './FilesTreeContextMenu'
import { useFilesTreeMutations, type TreeModel } from './useFilesTreeMutations'
import { showConfirmModalReact } from '../../lib/overlayClient'
import { useTokenHoverPopover } from './git/useTokenHoverPopover'
import { TokenHoverPopover } from './git/TokenHoverPopover'

// TREE_THEME + the host git-status/focus-ring CSS-var overrides now live in
// ./treeConfig.ts (shared with GitTab.tsx — both trees are the same dark
// theme; see that module's doc comment for the full override-chain writeup
// this used to carry inline here).

// Raw CSS injected into the tree's shadow root (§5 escape hatch) so a whole
// ROW carrying git-status `ignored` dims — the tree's own bundled CSS only
// dims the ignored row's ICON (opacity .5), not the full row. We tag
// gitignored/denylisted paths with status:'ignored' (see ignoredStatus →
// setGitStatus) and this rule dims the row. 0.62 keeps the row text clearly
// readable while still reading as de-emphasized (0.5 was too faint). When "Dim
// gitignored" is OFF we simply don't tag those paths, so this rule matches
// nothing and they render at full opacity — dim is a pure style toggle, never
// a presence one (§11).
//
// SEARCH BOX VISIBILITY (§ Fix 4 — investigated against
// node_modules/@pierre/trees/dist/render/FileTreeView.js + dist/style.js):
// `search: true` (passed to useFileTree below) makes FileTreeView ALWAYS
// mount a `[data-file-tree-search-container]` div with a `data-open`
// attribute reflecting `controller.isSearchOpen()` — but the library's own
// bundled CSS sets `[data-file-tree-search-container] { display: flex; }`
// UNCONDITIONALLY, never gating on `data-open`. So with `search: true` the
// box is a permanently-visible fixture; `useFileTreeSearch`'s isOpen/open()/
// close() only drive the MODEL's search state (value/matching paths/focus),
// not the box's visibility. There is no third "persistent input, but only
// mount when open" config value — `search` is a plain boolean
// (publicTypes.d.ts). So: keep `search: true` (required for the controller's
// search state/keyboard handling/auto-focus-on-open to exist at all) and
// override the container's display ourselves, keyed off the SAME `data-open`
// attribute the library already stamps on it — hidden when closed, flex when
// open. This makes our toolbar icon (which calls search.open()/close()) the
// single control over visibility.
// Appends TREE_DIR_GIT_CHANGE_CSS (treeConfig.ts) — the directory-level
// git-status-rollup theming (roadmap item 3): a collapsed folder whose
// subtree contains a change gets a subtle accent dot + tint, computed
// automatically by @pierre/trees from the same setGitStatus payload this
// pane already sends (see treeConfig.ts's doc comment for the verified
// `data-item-contains-git-change` attribute).
const TREE_IGNORED_DIM_CSS = `
  [data-item-git-status="ignored"] {
    opacity: 0.62;
  }
  [data-file-tree-search-container][data-open="false"] {
    display: none;
  }
  ${TREE_DIR_GIT_CHANGE_CSS}
`

// Pierre's bundled dark/light themes for the <File> viewer (§8) — the same
// pair the smoke test's <PatchDiff> used. `themeType: 'dark'` picks dark.
const VIEWER_THEME = { dark: 'pierre-dark', light: 'pierre-light' } as const

// ── Crash fix #2 — plain-text render threshold ──────────────────────────────
// Pierre adoption batch 2a: <PierreFile> now renders inside a <Virtualizer>
// (see ContentBody below), so it windows to VirtualizedFile instead of
// materializing every line into shadow-DOM — a 30k+ line file now costs a
// few hundred DOM rows, not tens of thousands. That's why this cap was
// raised substantially (6x) rather than removed: virtualization windows the
// DOM, but Shiki still tokenizes the WHOLE file text synchronously on the
// render thread on first mount (the not-yet-landed worker-pool batch would
// move that off-thread) — so a merely large-but-under-3MB file can still
// jank the UI for a noticeable stretch even though the DOM stays small.
// Independent of the 3MB read cap (files.ts's MAX_READ_BYTES). Above either
// threshold, default to a plain <pre> (no highlighting) with a "Load with
// highlighting anyway" affordance — the ultimate safety net above the new
// (much higher) cap. Line count is checked FIRST since it's the common case
// (a big generated/data file); max line length catches the
// minified-single-line case a line-count check alone would miss (files.ts's
// FileContents.maxLineLength, from the same bounded scan as lineCount — no
// extra client-side re-scan of the file text).
const PLAIN_TEXT_LINE_THRESHOLD = 30_000
const PLAIN_TEXT_LINE_LENGTH_THRESHOLD = 5000

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

/** The single `setGitStatus` payload the tree consumes: REAL git status
 *  (added/modified/deleted/renamed/untracked → colored label + a dot in the
 *  `git` lane) COMPOSED with the synthetic `ignored` dim entries above (a row
 *  can carry only ONE `data-item-git-status`, so these are two disjoint sets
 *  in practice — git status never reports gitignored files, and denylisted
 *  paths like node_modules aren't tracked).
 *
 *  Rules:
 *   - Only real entries for paths VISIBLE under the current toggles are kept —
 *     setting status on a hidden path is harmless but pointless.
 *   - On the rare collision where a path appears in BOTH lists, REAL git status
 *     WINS (a tracked-but-modified file shows its 'modified' dot at full
 *     opacity, not the dimmed 'ignored' slot). Dedupe by path, real first. */
function mergedStatus(
  entries: readonly FileEntry[],
  gitStatus: readonly GitStatusEntry[],
  options: TreeOptionsState
): GitStatusEntry[] {
  const visible = new Set(visiblePaths(entries, options.showHidden))
  const real = gitStatus.filter((g) => visible.has(g.path))
  const claimed = new Set(real.map((g) => g.path))
  const dim = ignoredStatus(entries, options).filter((g) => !claimed.has(g.path))
  return [...real, ...dim]
}

// --- Sort order (§11 "Sort order") ------------------------------------------
// `sort` is a CONSTRUCTION-ONLY option on `useFileTree`/`FileTreeController` —
// verified against node_modules/@pierre/trees/dist/model/FileTreeController.js:
// the controller captures `#baseOptions` (which includes `sort` AND
// `flattenEmptyDirectories`) once in its constructor, and `resetPaths` always
// rebuilds its store by re-spreading that SAME captured `#baseOptions` — there
// is no reconfigure path for either option post-construction. So both are
// passed only at `useFileTree(...)` call time in TreePane, and changing either
// one remounts TreePane (see FilesTab's `treeKey`) rather than going through
// `applyOptions`/`resetPaths` like showHidden/dimGitignored do.

/** Pure alphabetical A→Z comparator (case-insensitive, ignoring directory-vs-
 *  file type) for `sortOrder: 'name'` — Pierre's own `'default'` string picks
 *  its built-in dirs-first/alpha ordering, so this is the only comparator we
 *  need to hand-write. Ties (identical basename, e.g. same name different
 *  case) fall back to full path so the order is still stable/deterministic. */
const nameSortComparator: FileTreeSortComparator = (left, right) => {
  const byName = left.basename.localeCompare(right.basename, undefined, { sensitivity: 'base' })
  return byName !== 0 ? byName : left.path.localeCompare(right.path)
}

/** Resolves a `TreeOptionsState.sortOrder` to the `sort` value `useFileTree`
 *  accepts (`'default'` string vs. a comparator function). */
function resolveSort(sortOrder: TreeOptionsState['sortOrder']): 'default' | FileTreeSortComparator {
  return sortOrder === 'name' ? nameSortComparator : 'default'
}

// Image extensions we recognize for the ImageBody branch — these route to
// files:readImage (base64 data URL → <img>) instead of the text readFile path.
// Kept in sync with IMAGE_MIME_BY_EXT in src/main/ipc/files.ts, MINUS 'svg':
// SVG is XML/text source (not a raster format), so it's deliberately excluded
// here and instead routed through the normal text path (readFile → Viewer's
// highlighted source / Editor's CodeMirror) with a rendered Preview segment
// (see RENDERABLE_EXTENSIONS in previewRender.ts). PNG/JPG/GIF/WebP/AVIF have
// no meaningful source view and stay image-only via ImageBody.
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'])

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

/** The toolbar create-target path for the CURRENT tree selection, passed as
 *  `targetPath` to `mutations.createAtRoot` (see useFilesTreeMutations.ts's
 *  `targetDir`, which does the actual dir-vs-file branching once handed an
 *  item). A single selected DIRECTORY (trailing slash) creates INSIDE it —
 *  its own path is the target. A single selected FILE creates in its PARENT
 *  dir. Anything else (nothing selected, or a multi-select) returns
 *  `undefined` so `createAtRoot` falls back to the tree root, matching the
 *  prior toolbar behavior when there's no unambiguous target. */
function toolbarCreateTarget(selection: readonly string[]): string | undefined {
  if (selection.length !== 1) return undefined
  const [only] = selection
  if (only.endsWith('/')) return only
  const slash = only.lastIndexOf('/')
  return slash === -1 ? undefined : only.slice(0, slash + 1)
}

/** Imperatively selects EXACTLY `path` in the tree, clearing every other
 *  currently-selected path first.
 *
 *  BUG FIX (stale-selection, this pass) — root cause: `FileTreeItemHandle`'s
 *  `.select()` (the only imperative selection entry point `useFileTree`'s
 *  model exposes) calls the controller's `selectPath`, which is ADDITIVE
 *  (`[...this.#selectedPaths, resolvedPath]` — see
 *  node_modules/@pierre/trees/dist/model/FileTreeController.js). There IS a
 *  true single-select replace (`selectOnlyPath`) on the controller, but it is
 *  NOT exposed on the `FileTree` render-model `useFileTree` returns (only
 *  `getItem`/`getSelectedPaths`/`scrollToPath`/etc. are proxied — see
 *  dist/render/FileTree.d.ts) — so callers reaching for "select just this
 *  path" via `model.getItem(path)?.select()` were unknowingly ADDING to the
 *  selection, not replacing it. Compounding this: `resetPaths` (called on
 *  every toggle-flip/live-refresh refetch) explicitly PRESERVES the prior
 *  selection across the reset rather than clearing it (same file, `resetPaths`
 *  remaps `previousSelectedPaths` onto the fresh store) — so a stale
 *  previously-selected path can survive indefinitely once additively selected
 *  once. A plain user click doesn't hit this path (FileTreeView's own
 *  `handleRowClick` calls the controller's `selectOnlyMountedPathFromInput`,
 *  a genuine replace) — only the restore-on-mount/auto-select IMPERATIVE push
 *  did, which is exactly the bug: the restored path could end up co-selected
 *  alongside a path the user already picked.
 *
 *  Fix: deselect every OTHER currently-selected path (via `getSelectedPaths()`
 *  + each stale path's own `.deselect()`) before selecting the target, so the
 *  imperative push always leaves EXACTLY one path selected — the same
 *  single-select invariant a native click already gets for free. */
interface SingleSelectableTreeModel {
  getSelectedPaths: () => readonly string[]
  getItem: (path: string) => { select: () => void; deselect: () => void } | null
}
function selectOnlyPath(model: SingleSelectableTreeModel, path: string): void {
  for (const stale of model.getSelectedPaths()) {
    if (stale !== path) model.getItem(stale)?.deselect()
  }
  model.getItem(path)?.select()
}

/** The ancestor DIRECTORY paths of a repo-relative path, in the tree's
 *  canonical trailing-slash form (`"a/b/c.ts"` → `["a/", "a/b/"]`). Used both
 *  to seed `initialExpandedPaths` so a restored selection's parent folders are
 *  open (@pierre/trees has no public "current expansion set" API to persist
 *  directly — see the SELECTION-POINTER NOTE in filesTabStore.ts) and to
 *  recompute the persisted `expandedPaths` snapshot whenever the selection
 *  changes. A bare top-level file yields `[]`. */
function ancestorDirPaths(path: string): string[] {
  const segments = path.split('/').filter((s) => s.length > 0)
  // Drop the final segment (the file/dir's own basename) — only PARENT
  // directories are ancestors. A single-segment path (top-level file) has none.
  segments.pop()
  const ancestors: string[] = []
  let prefix = ''
  for (const segment of segments) {
    prefix += `${segment}/`
    ancestors.push(prefix)
  }
  return ancestors
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
  /** Bumped by FilesTab when the editor saves a file — a change here refetches
   *  the listing + git status so the tree's dots reflect the save immediately. */
  refreshNonce: number
  /** The persisted selection from filesTabStore at the moment this TreePane
   *  mounted — read ONCE (via a ref, not reactively) to restore the tree's own
   *  selection highlight + scroll position after the first successful listDir,
   *  since the content pane already restores independently via `selectedFile`
   *  but nothing previously pushed that back into the tree (see the module
   *  header + filesTabStore.ts's SELECTION-POINTER NOTE). Null when there was
   *  nothing selected (fresh workspace, or the user never opened a file). */
  initialSelectedFile: string | null
  /** The persisted ancestors-of-selection from filesTabStore, read ONCE the
   *  same way, so the restored selection's parent folders are open instead of
   *  collapsed. Empty when there's nothing to restore. */
  initialExpandedPaths: readonly string[]
  /** Fired with the ancestor directories of the CURRENT selection whenever it
   *  changes, so FilesTab can persist an up-to-date expansion snapshot (see
   *  ancestorDirPaths — @pierre/trees has no expansion-change event/getter to
   *  observe the user's actual manual expand/collapse state). */
  onExpandedPathsChange: (paths: string[]) => void
}

// --- Tree toolbar ------------------------------------------------------

interface TreeToolbarProps {
  /** Whether the tree's built-in search input is currently open. */
  searchOpen: boolean
  /** Toggle the built-in search input open/closed (useFileTreeSearch). */
  onToggleSearch: () => void
  /** Create a new folder / file at the tree root (mutations.createAtRoot). */
  onCreate: (isFolder: boolean) => void
}

// Shared icon-button classes — matches the outer FilesTab header's hamburger
// button (~L864 below) exactly, so the toolbar reads as the same chrome
// family even though it lives in a different slot (FileTree's `header`).
const TOOLBAR_BUTTON_CLASS =
  'p-1 rounded text-text-muted hover:bg-surface-raised hover:text-text-primary'

/** Compact header rendered into `<FileTree header={...} />`: a search-toggle
 *  icon on the left, New Folder / New File on the right. Extracted to its own
 *  component (rather than inlined in TreePane) to keep TreePane's cognitive
 *  complexity down and because it's pure presentation over three callbacks. */
function TreeToolbar({
  searchOpen,
  onToggleSearch,
  onCreate
}: TreeToolbarProps): React.JSX.Element {
  return (
    <div className="flex items-center h-7 px-1">
      <button
        type="button"
        // Re-click-to-close fix: @pierre/trees' search `<input>` closes
        // search on its OWN blur (searchBlurBehavior defaults to "close" —
        // see FileTreeView.js). A normal button click first fires
        // mousedown (which shifts DOM focus to this button, blurring the
        // still-focused search input and closing search SYNCHRONOUSLY)
        // and only then fires click/onToggleSearch — which then reads
        // `searchOpen` as already-false and REOPENS it, so a re-click while
        // the input has focus visually does nothing. Blocking the default
        // mousedown action keeps focus on the input, so no blur-close fires
        // before onToggleSearch runs, and it observes the TRUE open state.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onToggleSearch}
        aria-pressed={searchOpen}
        title="Search files"
        className={TOOLBAR_BUTTON_CLASS}
      >
        <MagnifyingGlass size={14} />
      </button>
      <div className="ml-auto flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => onCreate(true)}
          title="New folder"
          className={TOOLBAR_BUTTON_CLASS}
        >
          <FolderPlus size={14} />
        </button>
        <button
          type="button"
          onClick={() => onCreate(false)}
          title="New file"
          className={TOOLBAR_BUTTON_CLASS}
        >
          <FilePlus size={14} />
        </button>
      </div>
    </div>
  )
}

/** Left pane: fetches the tier-tagged dir listing ONCE per workspace, seeds/
 *  updates the Pierre tree, applies the tree-options toggles client-side, and
 *  reports the single selected file path up to FilesTab. Extracted so the
 *  fetch + imperative resetPaths + selection wiring stays out of FilesTab's
 *  body (cognitive-complexity ceiling). */
function TreePane({
  workspaceId,
  options,
  onSelectFile,
  refreshNonce,
  initialSelectedFile,
  initialExpandedPaths,
  onExpandedPathsChange
}: TreePaneProps): React.JSX.Element {
  const [truncated, setTruncated] = useState(false)
  const [pathCount, setPathCount] = useState(0)
  // Transient inline error banner for a failed create/rename/delete (§ "surface
  // errors, don't swallow"). Cleared on the next successful action / re-fetch.
  const [error, setError] = useState<string | null>(null)
  // The already-fetched, tier-tagged entries for the current workspace. Kept in
  // a ref so a toggle change re-filters WITHOUT re-fetching listDir (§11).
  const entriesRef = useRef<FileEntry[]>([])
  // The already-fetched REAL git status for the current workspace (added/
  // modified/deleted/…), cached alongside entriesRef so a toggle flip re-merges
  // the dots WITHOUT re-fetching. Refreshed together with entries in
  // fetchEntries (so post-mutation refetches also refresh the dots).
  const gitStatusRef = useRef<GitStatusEntry[]>([])

  // The persisted selection/expansion to restore, captured ONCE at mount (a
  // ref, not read reactively) — this pane only ever restores the snapshot that
  // was current when it (re)mounted, not a moving target as FilesTab's store
  // subscription updates during normal use (that would fight the tree→store
  // effect below and could re-select a stale path mid-session).
  const initialSelectedFileRef = useRef(initialSelectedFile)
  const initialExpandedPathsRef = useRef(initialExpandedPaths)
  // Sentinel: the store→tree restore (select + scroll + seed expansion) runs at
  // most ONCE per mount, on the first successful (non-empty) resetPaths — see
  // the `isFirstRestore` branch inside applyOptions below. This is what
  // prevents a ping-pong with the tree→store selection effect (below) and with
  // later resetPaths calls (toggle flips, refreshNonce refetches) that must
  // NOT stomp the user's in-session selection/expansion back to the stale
  // snapshot.
  const didRestoreRef = useRef(false)

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
  // enables the right-click trigger for renderContextMenu (§10.3). `sort` and
  // `flattenEmptyDirectories` are read ONCE here (construction-only — see the
  // "Sort order" section above): FilesTab remounts this whole pane (via a
  // `key` on `sortOrder:flattenEmptyDirs`) whenever either changes, since
  // there's no post-construction reconfigure path for them.
  const { model } = useFileTree({
    paths: [],
    // Tree starts COLLAPSED by default (Fix 1) — only root entries are
    // visible; folders are closed until the user expands them. The
    // STORE→TREE RESTORE below (isFirstRestore branch in applyOptions) still
    // seeds `initialExpandedPaths` from the persisted ancestors-of-selection
    // snapshot on the very first successful resetPaths, so a returning user's
    // open file has its ancestor folders opened despite this default.
    initialExpansion: 'closed',
    search: true,
    sort: resolveSort(options.sortOrder),
    flattenEmptyDirectories: options.flattenEmptyDirs,
    unsafeCSS: TREE_IGNORED_DIM_CSS,
    composition: { contextMenu: { enabled: true } },
    renaming: {
      onRename: (e: FileTreeRenameEvent) => renameHandlersRef.current.onRename(e),
      onError: (m: string) => renameHandlersRef.current.onError(m)
    },
    // Batch 1b (treeConfig.ts): per-filetype icons, compact density, sticky
    // folders — all plain construction-time fields on FileTreeOptionSurface,
    // verified against the installed 1.0.0-beta.5 .d.ts (see treeConfig.ts's
    // doc comment). Never change after mount, so passing them here (rather
    // than an imperative `model.setIcons(...)` call) is correct.
    icons: TREE_ICONS,
    density: TREE_DENSITY,
    ...TREE_RENDER_OPTIONS
  })
  const selection = useFileTreeSelection(model)
  // Drives the tree's own built-in search input's OPEN/CLOSED model state
  // (isOpen/value/matchingPaths) — the input itself always exists in the DOM
  // once `search: true` (see the SEARCH BOX VISIBILITY comment above
  // TREE_IGNORED_DIM_CSS); its actual show/hide is a CSS override keyed off
  // the same `data-open` attribute this hook's `isOpen` drives. The toolbar's
  // search icon just toggles open()/close(); library auto-focuses the input
  // on the isOpen:false→true transition (FileTreeView.js's layout effect).
  const search = useFileTreeSearch(model)
  const toggleSearch = useCallback(() => {
    if (search.isOpen) search.close()
    else search.open()
  }, [search])

  // Report the derived file-to-view up whenever the selection changes.
  //
  // GUARD (CodeRabbit finding, fixed): `useFileTree` always constructs with
  // `paths: []` (see below), so on EVERY (re)mount — including the sort/
  // flatten `key` remount above, not just a fresh workspace — `selection`
  // starts empty and `derived` is `null` for the brief window before
  // `fetchEntries` resolves and the store→tree restore effect (below) re-
  // selects the persisted file. Reporting that transient `null` up
  // unconditionally would have `setSelectedFile(null)` (FilesTab) clobber the
  // PERSISTED selection before restore ever runs — not just a visual flash,
  // a real loss of the open file. So: while there's a persisted file still
  // waiting to be restored (`didRestoreRef` not yet true) and this is that
  // exact restore target's absence (`derived === null`), withhold the report.
  // Once restore has run (or there was nothing to restore), every `derived`
  // change — including a genuine user-driven deselect — reports normally.
  const derived = useMemo(() => fileToView(selection), [selection])
  useEffect(() => {
    if (derived === null && !didRestoreRef.current && initialSelectedFileRef.current !== null) {
      return
    }
    onSelectFile(derived)
  }, [derived, onSelectFile])

  // Recompute + report the ancestors-of-selection whenever the selected FILE
  // changes (not on every raw selection tick — a directory-only or multi-path
  // selection yields `derived === null` and intentionally leaves the last
  // persisted snapshot alone rather than clobbering it with `[]`; ancestors
  // are only ever recorded for an actual open file, matching filesTabStore's
  // "ancestors of the selected file" contract). This is the ONLY writer of
  // expansion state — see the module header on why there's no true expansion-
  // change observation available from @pierre/trees.
  useEffect(() => {
    if (derived != null) onExpandedPathsChange(ancestorDirPaths(derived))
  }, [derived, onExpandedPathsChange])

  // Apply the current toggles to the cached entries + git status: reset the
  // visible paths and set the merged git-status payload (real added/modified/…
  // dots COMPOSED with the synthetic `ignored` dim entries). Imperative (§7).
  //
  // SKIPPED (Batch 1b, roadmap item 4 — prepared tree input): considered
  // routing this `resetPaths(paths, …)` call through
  // `preparePresortedFileTreeInput`/`prepareFileTreeInput` (@pierre/trees) for
  // cheaper rebuilds on this refresh loop. Verified against
  // dist/model/inputResolution.js: when a `preparedInput` is supplied WITHOUT
  // a parallel `paths` array, `resolveFileTreeInput` trusts its `.paths`
  // AS-IS and never re-validates them against the controller's own `sort`
  // baked in at construction (`useFileTree`'s `sort: resolveSort(...)` above,
  // which can be `nameSortComparator`, a function — not just `'default'`).
  // A prepared input built with a mismatched/forgotten sort option would
  // silently misorder the tree with no error. Given `MAX_ENTRIES = 5000`
  // (src/main/ipc/files.ts) already bounds this tree's size — the perf case
  // this API targets ("large or frequently reloaded path lists") isn't
  // actually a bottleneck here — and the recently-fixed selection/flatten/
  // resetPaths wiring this callback owns is explicitly not to be
  // destabilized, this is skipped for Batch 1b. Revisit only if profiling
  // ever shows resetPaths cost matters at this scale.
  //
  // STORE→TREE RESTORE (the other half of the selection-pointer bug): the
  // FIRST time this resolves a non-empty path set after mount, seed
  // `resetPaths`'s `initialExpandedPaths` from the persisted snapshot (so the
  // restored selection's parent folders are open) and imperatively select +
  // scroll to the persisted `selectedFile`, if it's still present. This can
  // ONLY happen here (not at useFileTree's own `initialSelectedPaths`/
  // `initialExpandedPaths` construction options) because construction always
  // starts from `paths: []` — the persisted path can't resolve against an
  // empty store (verified against FileTreeController's constructor: it
  // resolves `initialSelectedPaths` against `#store` synchronously, and
  // `#store` is built from the SAME `paths` array passed in). Runs at most
  // once per mount (`didRestoreRef`), which is what keeps this from ping-
  // ponging with the tree→store selection effect below and from re-stomping
  // the user's live selection/expansion on every later toggle-flip or
  // refreshNonce-triggered resetPaths within the same mount.
  const applyOptions = useCallback(
    (
      entries: readonly FileEntry[],
      gitStatus: readonly GitStatusEntry[],
      opts: TreeOptionsState
    ): void => {
      const paths = visiblePaths(entries, opts.showHidden)
      const isFirstRestore = !didRestoreRef.current && paths.length > 0
      model.resetPaths(
        paths,
        isFirstRestore ? { initialExpandedPaths: initialExpandedPathsRef.current } : undefined
      )
      model.setGitStatus(mergedStatus(entries, gitStatus, opts))
      setPathCount(paths.length)
      if (isFirstRestore) {
        didRestoreRef.current = true
        const restorePath = initialSelectedFileRef.current
        if (restorePath != null && paths.includes(restorePath)) {
          selectOnlyPath(model, restorePath)
          model.scrollToPath(restorePath)
        }
      }
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

  // Fetch listDir + git status, then re-apply the current toggles. Reused for
  // the initial load, workspace changes, AND post-mutation re-tag (create/
  // rename/delete) so both the tier/dim map AND the real git dots always
  // reflect disk. Git status is fetched in parallel and self-catches to [] so
  // a git failure (or a non-repo, which already returns []) never blanks the
  // tree — it just means no dots. resetPaths/setGitStatus are imperative (§7).
  const fetchEntries = useCallback(() => {
    let cancelled = false
    Promise.all([
      window.api.files.listDir(workspaceId),
      window.api.files.gitStatus(workspaceId).catch((e) => {
        console.error('[FilesTab] gitStatus failed:', e)
        return [] as GitStatusEntry[]
      })
    ])
      .then(([listing, gitStatus]) => {
        if (cancelled) return
        entriesRef.current = listing.entries
        gitStatusRef.current = gitStatus
        applyOptions(listing.entries, gitStatus, optionsRef.current)
        setTruncated(listing.truncated)
      })
      .catch((e) => {
        if (cancelled) return
        console.error('[FilesTab] listDir failed:', e)
        entriesRef.current = []
        gitStatusRef.current = []
        applyOptions([], [], optionsRef.current)
        setTruncated(false)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, applyOptions])

  useEffect(() => fetchEntries(), [fetchEntries])

  // Re-filter the ALREADY-FETCHED entries + git status whenever a toggle flips
  // — instant, no IPC round-trip (§11).
  useEffect(() => {
    applyOptions(entriesRef.current, gitStatusRef.current, options)
  }, [options, applyOptions])

  // A post-mutation refetch that also clears any stale error banner.
  const refetch = useCallback(() => {
    setError(null)
    fetchEntries()
  }, [fetchEntries])

  // Keep a live ref to refetch so the watcher subscription effect below (keyed
  // only on workspaceId) always calls the CURRENT refetch closure without
  // needing to re-subscribe every time fetchEntries/refetch is recreated.
  const refetchRef = useRef(refetch)
  useLayoutEffect(() => {
    refetchRef.current = refetch
  })

  // Working-tree watcher (src/main/filesWatcher.ts): live while this pane is
  // mounted for `workspaceId` — which, per WorkbenchPanel, is exactly while
  // the Files tab is the active, non-dormant tab (see the FilesTab module
  // header). Starts the main-process watch on mount, subscribes to the
  // debounced files:changed push and refetches on a match, and stops the
  // watch on unmount / workspaceId change so at most one watcher is ever
  // active app-wide (main enforces the single-active invariant; this effect
  // just drives start/stop from the tab's own lifecycle).
  useEffect(() => {
    window.api.files
      .watchStart(workspaceId)
      .catch((e) => console.error('[FilesTab] watchStart failed:', e))
    const unsubscribe = window.api.files.onFilesChanged((e) => {
      if (e.workspaceId === workspaceId) refetchRef.current()
    })
    return () => {
      unsubscribe()
      window.api.files
        .watchStop(workspaceId)
        .catch((e) => console.error('[FilesTab] watchStop failed:', e))
    }
  }, [workspaceId])

  // Re-fetch when the editor saves (refreshNonce bumped by FilesTab) so the
  // tree's git-status dots reflect the just-saved change. Skips the initial
  // mount (nonce 0) — the fetchEntries effect above already loaded then.
  const didMountRef = useRef(false)
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true
      return
    }
    fetchEntries()
  }, [refreshNonce, fetchEntries])

  const getKnownPaths = useCallback(() => new Set(entriesRef.current.map((e) => e.path)), [])

  // Directory-delete confirm: `del` (in the mutations hook) awaits
  // confirmDirDelete(item), which shows the CENTERED confirm modal via the
  // native overlay layer (overlayClient.showConfirmModalReact) instead of an
  // in-window React modal. A centered modal spans the whole window — including
  // the claude column's rect — so an in-window DOM version would render BEHIND
  // the live libghostty terminal surface (see
  // docs/learnings/overlay-child-window-macos.md). The overlay layer's own
  // child BrowserWindow genuinely paints above it.
  const confirmDirDelete = useCallback((item: FileTreeContextMenuItem): Promise<boolean> => {
    return showConfirmModalReact({
      title: 'Move folder to Trash?',
      body: `${item.name} and all of its contents will be moved to the Trash. You can recover it from Finder.`,
      buttons: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'confirm', label: 'Move to Trash', style: 'danger' }
      ]
    }).then((result) => result.buttonId === 'confirm')
  }, [])

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

  // Toolbar's New Folder / New File buttons — no right-clicked row to derive a
  // target dir from, so they target the CURRENT tree selection instead: a
  // single selected directory creates inside it, a single selected file
  // creates in its parent dir, and no selection (or a multi-select) falls
  // back to the tree root (see toolbarCreateTarget). `createAtRoot` is async
  // (create → startRenaming); errors are already surfaced via `onError`
  // inside the mutations hook, so this handler just needs to not leave a
  // floating promise.
  const handleToolbarCreate = useCallback(
    (isFolder: boolean): void => {
      void mutations.createAtRoot(isFolder, toolbarCreateTarget(selection))
    },
    [mutations, selection]
  )

  const toolbar = useMemo(
    () => (
      <TreeToolbar
        searchOpen={search.isOpen}
        onToggleSearch={toggleSearch}
        onCreate={handleToolbarCreate}
      />
    ),
    [search.isOpen, toggleSearch, handleToolbarCreate]
  )

  // Theme + git-status/focus-ring host CSS vars — shared with GitTab.tsx via
  // treeConfig.ts's `treeHostStyle()` (see that module for the full
  // override-chain writeup this used to carry inline here).
  const hostStyle = useMemo(() => {
    return { height: '100%', ...treeHostStyle() } as React.CSSProperties
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
        <FileTree
          model={model}
          header={toolbar}
          renderContextMenu={renderContextMenu}
          style={{ height: '100%' }}
        />
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

// A settled readImage result, tagged with the path it belongs to — the same
// stale-guard shape as LoadedFile, but for the image-bytes IPC (files:readImage)
// rather than files:readFile. Kept as a SEPARATE fetch/state (not folded into
// LoadedFile) because images route around the text read entirely: fetching
// readFile for a multi-MB PNG would burn the 3MB text cap + UTF-8 decode for
// bytes the viewer never uses.
interface LoadedImage {
  path: string
  image: FileImage
}

interface ContentPaneProps {
  workspaceId: string
  path: string | null
  mode: FilesViewMode
  autoSave: boolean
  /** Word-wrap toggle (§11's "Wrap lines") — drives BOTH the viewer's Pierre
   *  <File> `overflow` option and the editor's CodeMirror line-wrapping
   *  Compartment. Threaded down to ContentBody unchanged. */
  wrapLines: boolean
  onDirtyChange: (dirty: boolean) => void
  /** Fired after the editor saves the file to disk — FilesTab uses this to
   *  refresh the tree's git-status dots. */
  onSaved: () => void
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
  wrapLines,
  onDirtyChange,
  onSaved
}: ContentPaneProps): React.JSX.Element {
  // Holds only SETTLED results — the effect never sets state synchronously
  // (no "loading" write on entry). "Loading" is derived: whenever the selected
  // `path` differs from `result.path`, the fetch for `path` hasn't landed yet.
  const [result, setResult] = useState<LoadedFile | null>(null)
  const [image, setImage] = useState<LoadedImage | null>(null)
  // Crash fix #2 — per-path "load with highlighting anyway" override for a
  // file over the plain-text threshold. Lives here (not in ContentBody, which
  // is pure presentation) so switching files and back within the same Files-
  // tab session doesn't re-ask for a path already force-shown.
  const [highlightAnyway, setHighlightAnyway] = useState<ReadonlySet<string>>(() => new Set())
  // Guards a stale readFile resolving after the selection moved on — only the
  // most-recent requested path may commit its result. Shared between the two
  // fetch effects below since only one of them is ever active for a given path.
  const requestedPathRef = useRef<string | null>(null)

  // Images route to files:readImage (base64 data URL) instead of readFile —
  // fetching readFile for a multi-MB image would burn the text size cap +
  // UTF-8 decode for bytes the viewer never uses. isImagePath is a pure
  // extension check, so this and the text-read effect below are mutually
  // exclusive per path (never both in flight for the same selection).
  useEffect(() => {
    if (path === null || !isImagePath(path)) return
    requestedPathRef.current = path
    let cancelled = false
    window.api.files
      .readImage(workspaceId, path)
      .then((img) => {
        if (cancelled || requestedPathRef.current !== path) return
        setImage({ path, image: img })
      })
      .catch((e) => {
        if (cancelled || requestedPathRef.current !== path) return
        console.error('[FilesTab] readImage failed:', e)
        setImage({ path, image: { ok: false, error: 'denied' } })
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, path])

  useEffect(() => {
    if (path !== null && isImagePath(path)) return
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
  const currentImage = image && image.path === path ? image : null
  return (
    <ContentBody
      workspaceId={workspaceId}
      path={path}
      result={current}
      image={currentImage}
      mode={mode}
      autoSave={autoSave}
      wrapLines={wrapLines}
      onDirtyChange={onDirtyChange}
      onSaved={onSaved}
      highlightAnyway={path !== null && highlightAnyway.has(path)}
      onHighlightAnyway={() =>
        path !== null &&
        setHighlightAnyway((prev) => {
          const next = new Set(prev)
          next.add(path)
          return next
        })
      }
    />
  )
}

interface ContentBodyProps {
  workspaceId: string
  path: string | null
  result: LoadedFile | null
  image: LoadedImage | null
  mode: FilesViewMode
  autoSave: boolean
  wrapLines: boolean
  onDirtyChange: (dirty: boolean) => void
  onSaved: () => void
  /** Crash fix #2 — true when the CURRENT path has been force-shown past the
   *  plain-text threshold via "Load with highlighting anyway". */
  highlightAnyway: boolean
  onHighlightAnyway: () => void
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
  image,
  mode,
  autoSave,
  wrapLines,
  onDirtyChange,
  onSaved,
  highlightAnyway,
  onHighlightAnyway
}: ContentBodyProps): React.JSX.Element {
  // Pierre adoption Batch 3 — token hover popover, shared controller with
  // GitTab.tsx's own wiring (see TokenHoverPopover.tsx's header). Called
  // unconditionally here (rules-of-hooks) even though its output is only
  // actually used by the highlighted-viewer branch below — ContentBody
  // itself is always mounted (never conditionally) whenever ContentPane
  // renders, so this satisfies the same "hooks run every render" invariant
  // GitTab's DiffContentPaneImpl documents for its own hoisted hooks.
  const tokenHover = useTokenHoverPopover()

  if (path === null) {
    return <ViewerMessage text="Select a file to view" />
  }
  // Images short-circuit before the text-read branches below — they never go
  // through `result` (ContentPane's readFile effect skips image paths
  // entirely) and are never editable, regardless of the viewer/editor mode
  // toggle (there is no "edit an image" concept here).
  if (isImagePath(path)) {
    return <ImageBody image={image} path={path} />
  }
  if (result === null) {
    return <ViewerMessage text="Loading…" />
  }
  const { contents } = result
  if (result.error || contents === null) {
    return <ViewerMessage text="Could not read this file." />
  }
  if (contents.binary) {
    return <ViewerMessage text={`Binary file (${formatKB(contents.size)}) — no preview`} />
  }
  // Preview mode: rendered md/html, read-only. Gated on isRenderablePath so a
  // stale 'preview' mode can never reach here for a non-renderable file — the
  // ModeToggle disables the segment and FilesTab's own effect falls back to
  // 'viewer' when the selection changes to a non-renderable file, but this
  // check is the actual safety net (belt-and-suspenders, cheap to keep).
  if (mode === 'preview' && isRenderablePath(path)) {
    return <PreviewPane contents={contents.contents} path={path} />
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
            whole viewer region reads as one dark surface (matches the editor).
            Pierre adoption batch 2a — line-level virtualization: <Virtualizer>
            IS the scroll root (it renders the fixed-height `overflow` div +
            calls `.setup(root)` on mount, see node_modules/@pierre/diffs/dist/
            components/Virtualizer.js). <PierreFile>'s internal useFileInstance
            hook calls useVirtualizer() and, when it finds this ancestor,
            mounts VirtualizedFile instead of File — same <PierreFile> JSX, no
            extra prop. Only wrapped on the highlighted-viewer branch (not the
            plain-text <pre> branch below, which has no Pierre instance to
            virtualize — an unused <Virtualizer> would just be a no-op
            ResizeObserver, so it's simpler to gate it on the branch that
            needs it). See buildDiffOptions'/OversizedDiffPlaceholder's GitTab
            counterparts for the identical mechanism + annotation-compat
            verification (this viewer has no annotations to worry about). */}
        {isPlainTextEligible(contents) && !highlightAnyway ? (
          <div
            className="flex-1 min-h-0 overflow-auto"
            style={{ backgroundColor: PIERRE_VIEWER_BG }}
          >
            <PlainTextViewer contents={contents.contents} onHighlightAnyway={onHighlightAnyway} />
          </div>
        ) : (
          <Virtualizer
            className="flex-1 min-h-0 overflow-auto"
            style={{ backgroundColor: PIERRE_VIEWER_BG }}
          >
            <PierreFile
              file={{ name: contents.name, contents: contents.contents }}
              options={{
                theme: VIEWER_THEME,
                themeType: 'dark',
                overflow: wrapLines ? 'wrap' : 'scroll',
                // Pierre adoption Batch 3 — token hover. Both handlers are
                // stable (empty-deps useCallback, see TokenHoverPopover.tsx),
                // so spreading them here doesn't destabilize anything —
                // FilesTab's `options` object isn't memoized to begin with
                // (unlike GitTab's PatchDiff options), so there's no
                // reapply-avoidance discipline to preserve here.
                onTokenEnter: tokenHover.onTokenEnter,
                onTokenLeave: tokenHover.onTokenLeave
              }}
            />
          </Virtualizer>
        )}
        <TokenHoverPopover
          state={tokenHover.state}
          onMouseEnter={tokenHover.cancelHide}
          onMouseLeave={tokenHover.scheduleHide}
        />
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
            wrap={wrapLines}
            onDirtyChange={onDirtyChange}
            onSaved={onSaved}
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

/** Crash fix #2 — true when `contents` is over the plain-text render
 *  threshold (line count OR max line length — see the consts' doc comment).
 *  `lineCount`/`maxLineLength` come from files.ts's bounded scan, already
 *  computed server-side, so this is a plain comparison with no client-side
 *  re-scan of the file text. */
function isPlainTextEligible(contents: FileContents): boolean {
  return (
    contents.lineCount > PLAIN_TEXT_LINE_THRESHOLD ||
    contents.maxLineLength > PLAIN_TEXT_LINE_LENGTH_THRESHOLD
  )
}

/** Crash fix #2 — the default view for a file over the plain-text threshold:
 *  an unhighlighted `<pre>` (a single text node, no Shiki tokenize pass, no
 *  shadow-DOM-per-line) plus a "Load with highlighting anyway" affordance for
 *  users who want the full <PierreFile> experience despite the cost. */
function PlainTextViewer({
  contents,
  onHighlightAnyway
}: {
  contents: string
  onHighlightAnyway: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-shrink-0 px-3 py-1 flex items-center justify-between border-b border-border-default">
        <span className="text-[10px] text-text-muted select-none">
          Large file — showing plain text
        </span>
        <button
          type="button"
          onClick={onHighlightAnyway}
          className="text-[10px] text-accent hover:underline select-none"
        >
          Load with highlighting anyway
        </button>
      </div>
      <pre className="flex-1 min-h-0 overflow-auto m-0 px-3 py-2 text-xs text-text-primary whitespace-pre font-mono">
        {contents}
      </pre>
    </div>
  )
}

/** Renders the selected RASTER image (a data URL fetched via files:readImage)
 *  centered on the same dark viewer background as the text viewer, or a
 *  graceful loading/error message. `image === null` means the fetch for the
 *  current path hasn't settled yet (mirrors ContentPane's `result === null`
 *  loading convention). SVG is NOT routed here — see IMAGE_EXTENSIONS above —
 *  it goes through the text Viewer/Editor path with a rendered Preview
 *  instead, since it's XML source, not a raster format. */
function ImageBody({
  image,
  path
}: {
  image: LoadedImage | null
  path: string
}): React.JSX.Element {
  // Zoom/pan state resets whenever the viewed path changes (see
  // useImageZoomPan's resetKey contract) — keyed on `path`, not `image`, so it
  // resets the instant the SELECTION changes rather than waiting for the new
  // image's fetch to settle.
  const zoom = useImageZoomPan(path)
  if (image === null) {
    return <ViewerMessage text="Loading…" />
  }
  const { image: result } = image
  if (!result.ok) {
    if (result.error === 'too-large') {
      return <ViewerMessage text="Image too large to preview (over 5 MB)" />
    }
    return <ViewerMessage text="Could not load image" />
  }
  return (
    <div
      className={`relative flex-1 min-h-0 flex items-center justify-center overflow-hidden ${zoom.cursorClassName}`}
      style={{ backgroundColor: PIERRE_VIEWER_BG }}
      onWheel={zoom.onWheel}
      onPointerDown={zoom.onPointerDown}
      onPointerMove={zoom.onPointerMove}
      onPointerUp={zoom.onPointerUp}
      onPointerCancel={zoom.onPointerUp}
    >
      <img
        src={result.dataUrl}
        alt=""
        draggable={false}
        className="max-w-full max-h-full object-contain"
        style={zoom.style}
      />
      <ImageZoomBar zoom={zoom} />
    </div>
  )
}

// --- Mode toggle -----------------------------------------------------------

interface ModeToggleProps {
  mode: FilesViewMode
  onChange: (mode: FilesViewMode) => void
  /** A dirty dot on the Editor segment when there are unsaved edits. */
  dirty: boolean
  /** Whether the currently-selected file can render in Preview mode (md/html
   *  text files — see isRenderablePath in PreviewPane.tsx). The Preview
   *  segment is disabled/greyed and non-interactive when false. */
  previewEnabled: boolean
}

/** Compact [Viewer | Editor | Preview] segmented control. Viewer is the
 *  default. The Preview segment is disabled (greyed, non-clickable,
 *  aria-disabled) unless the selected file is renderable (md/markdown/
 *  html/htm) — rendering is meaningless for e.g. a .js or .py file. */
function ModeToggle({ mode, onChange, dirty, previewEnabled }: ModeToggleProps): React.JSX.Element {
  const seg = (value: FilesViewMode, label: string, disabled = false): React.JSX.Element => {
    const active = mode === value && !disabled
    return (
      <button
        type="button"
        onClick={() => {
          if (!disabled) onChange(value)
        }}
        disabled={disabled}
        aria-pressed={active}
        aria-disabled={disabled}
        title={disabled ? 'Only available for Markdown/HTML files' : undefined}
        className={[
          'relative px-2 py-0.5 rounded text-[11px] font-medium transition-colors duration-100',
          disabled
            ? 'text-text-muted/40 cursor-not-allowed'
            : active
              ? // Warm accent-tinted fill for the active segment — matches
                // GitTab's SubTabStrip so [Viewer|Editor|Preview] and
                // [Diff|Commits|Details|Checks] read as the same segmented-
                // control family instead of one warm, one gray.
                'bg-accent/20 text-text-primary'
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
      {seg('preview', 'Preview', !previewEnabled)}
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
  // Per-workspace Files-tab SESSION state (selectedFile / mode / treeOpen /
  // expandedPaths) is lifted into a module-level keyed store so it SURVIVES
  // this component's unmount/remount — `MainContent` tears down the whole
  // Workbench subtree when you navigate to a project/workspaces page, and
  // plain `useState` here would re-initialize to defaults on return (losing
  // the open file + mode + tree expansion). Reads subscribe to just this
  // workspace's entry; every setter writes the full entry back. See
  // src/renderer/src/lib/filesTabStore.ts.
  const entry = useFilesTabEntry(workspaceId)
  const { selectedFile, mode, treeOpen, expandedPaths } = entry

  // `dirty` stays component-local: it's transient editor UI (the unsaved dot),
  // re-reported by the freshly-mounted editor from disk on remount, and never
  // persisted (see the dirty-buffer note in filesTabStore.ts).
  const [dirty, setDirty] = useState(false)

  // Bumped when the editor SAVES a file — TreePane watches this nonce and
  // refetches the listing + git status so the tree's dots reflect the just-saved
  // change immediately (the two panes are siblings, so the save→refresh signal
  // routes through this shared parent). External changes (Claude/terminal/git
  // editing files while the tab is open) are handled separately by TreePane's
  // own files:changed subscription, which drives the SAME refetch via the
  // main-process working-tree watcher (src/main/filesWatcher.ts).
  const [refreshNonce, setRefreshNonce] = useState(0)
  const bumpRefresh = useCallback(() => setRefreshNonce((n) => n + 1), [])

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
  // Written by TreePane whenever the selected FILE changes (see
  // onExpandedPathsChange in TreePane) — the persisted ancestors-of-selection
  // snapshot that seeds `initialExpandedPaths` the next time this workspace's
  // tree (re)mounts. createPerKeyStore's array-shallow `equals` (added in
  // filesTabStore.ts) no-ops a value-identical write, so re-selecting the same
  // file doesn't spuriously notify.
  const setExpandedPaths = useCallback(
    (next: string[]) => {
      const cur = getFilesTabEntry(workspaceId)
      setFilesTabEntry(workspaceId, { ...cur, expandedPaths: next })
    },
    [workspaceId]
  )

  // The persisted save-mode setting (default false = manual save). Read from
  // the app-wide ui-state store; the editor uses it to decide manual vs
  // debounced auto-save.
  const uiState = useUiState()
  const autoSave = uiState?.filesAutoSave ?? false

  // The ⚙ tree-options (Fix 2): APP-WIDE view preferences, not per-workspace
  // session state — moved out of filesTabStore into the DB-backed AppUiState
  // (filesShowHidden/filesDimGitignored/filesWrapLines/filesSortOrder/
  // filesFlattenEmptyDirs) so they survive an app restart, the same mechanism
  // `filesAutoSave` already uses. Falls back to UI_STATE_DEFAULTS while the
  // initial `uiState.get()` hasn't resolved yet (uiState === null) — same
  // fallback values the main-process rowToRecord uses, so there's no visible
  // flash of different defaults before the real value loads.
  const treeOptions: TreeOptionsState = useMemo(
    () => ({
      showHidden: uiState?.filesShowHidden ?? UI_STATE_DEFAULTS.filesShowHidden,
      dimGitignored: uiState?.filesDimGitignored ?? UI_STATE_DEFAULTS.filesDimGitignored,
      wrapLines: uiState?.filesWrapLines ?? UI_STATE_DEFAULTS.filesWrapLines,
      sortOrder: uiState?.filesSortOrder ?? UI_STATE_DEFAULTS.filesSortOrder,
      flattenEmptyDirs: uiState?.filesFlattenEmptyDirs ?? UI_STATE_DEFAULTS.filesFlattenEmptyDirs
    }),
    [uiState]
  )
  const setTreeOptions = useCallback((next: TreeOptionsState) => {
    updateUiState({
      filesShowHidden: next.showHidden,
      filesDimGitignored: next.dimGitignored,
      filesWrapLines: next.wrapLines,
      filesSortOrder: next.sortOrder,
      filesFlattenEmptyDirs: next.flattenEmptyDirs
    })
  }, [])

  // Draggable tree/code split (live QA finding: the fixed `w-60` truncated
  // long filenames). SHARED width with the Git tab's DiffTreePane — both
  // read/write the same `AppUiState.workbenchTreeWidth` (see
  // useTreeWidthDrag.ts's module header). Falls back to
  // UI_STATE_DEFAULTS.workbenchTreeWidth while the initial uiState.get()
  // hasn't resolved yet, same fallback idiom as treeOptions above.
  const persistedTreeWidth = uiState?.workbenchTreeWidth ?? UI_STATE_DEFAULTS.workbenchTreeWidth
  const commitTreeWidth = useCallback((width: number) => {
    updateUiState({ workbenchTreeWidth: width })
  }, [])
  // Destructured immediately at the call site (rather than kept as one
  // `treeWidthDrag` object and accessed via `.width`/`.beginDrag` etc. below)
  // — react-hooks' static ref-safety analysis conservatively taints EVERY
  // property read off a variable holding a custom hook's return value once
  // any one of that return object's properties is ref-derived
  // (`treeWidthVarRef` is a callback ref); destructuring at the call site
  // (this exact pattern) is what it recognizes as safe.
  const {
    width: treeWidth,
    isDragging: treeIsDragging,
    beginDrag: treeBeginDrag,
    treeWidthVarRef
  } = useTreeWidthDrag(persistedTreeWidth, commitTreeWidth)

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

  // If the selection moves to a non-renderable file (e.g. from a README to a
  // .js) while Preview is active, fall back to Viewer rather than leaving the
  // user on a dead Preview pane. `mode` intentionally excluded from the deps —
  // this only reacts to the SELECTION changing under an already-active Preview,
  // not to every mode change (switching Editor->Preview on a renderable file is
  // the normal path and must not be undone by this effect).
  const previewEnabled = selectedFile !== null && isRenderablePath(selectedFile)
  useEffect(() => {
    if (mode === 'preview' && !previewEnabled) {
      setMode('viewer')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately keyed on selectedFile (via previewEnabled), not `mode`; see comment above.
  }, [selectedFile, previewEnabled])

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col">
      {
        // bg-surface-overlay gives this toolbar row a distinct header band
        // over the panel's own surface-raised background — mirrors the same
        // fix on GitTab's equivalent row so both tabs' chrome reads as one
        // cohesive layered system (middle-ground chrome-warmth pass).
      }
      <div className="h-8 flex-shrink-0 border-b border-border-default bg-surface-overlay flex items-center px-1 gap-1">
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
          <ModeToggle
            mode={mode}
            onChange={setMode}
            dirty={dirty}
            previewEnabled={previewEnabled}
          />
        </div>
      </div>
      <div className="flex-1 min-h-0 flex">
        {/* Kept MOUNTED and hidden via `display` (not conditionally rendered)
            so toggling the tree closed doesn't tear down its useFileTree model
            — that would reset expansion + selection and re-fetch the listing on
            every reopen. Hidden with `hidden` (display:none) which also drops
            it from layout so the viewer takes the full width. */}
        <div
          ref={treeWidthVarRef}
          hidden={!treeOpen}
          style={{ width: `var(${TREE_WIDTH_CSS_VAR}, ${treeWidth}px)` }}
          className="flex-shrink-0 min-h-0"
        >
          <TreePane
            // Sort order + flatten-empty-dirs are construction-only options on
            // useFileTree (see the "Sort order" comment block above
            // nameSortComparator) — there's no post-construction reconfigure
            // path, so changing either REMOUNTS this pane via this key. That
            // drops the old useFileTree model and creates a fresh one, but
            // selection/expansion still survive: `initialSelectedFile`/
            // `initialExpandedPaths` below read the LIVE persisted entry (not
            // a stale snapshot), and TreePane's own store→tree restore effect
            // (didRestoreRef) re-selects + re-expands from those on the very
            // first successful resetPaths after (re)mount — the same path
            // that already restores selection across a full nav-away/back.
            key={`${treeOptions.sortOrder}:${treeOptions.flattenEmptyDirs}`}
            workspaceId={workspaceId}
            options={treeOptions}
            onSelectFile={setSelectedFile}
            refreshNonce={refreshNonce}
            initialSelectedFile={selectedFile}
            initialExpandedPaths={expandedPaths}
            onExpandedPathsChange={setExpandedPaths}
          />
        </div>
        {treeOpen && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize file tree"
            onMouseDown={treeBeginDrag}
            className={[
              'w-1 flex-shrink-0 cursor-col-resize hover:bg-accent/40 transition-colors duration-150 border-r border-border-default',
              treeIsDragging ? 'bg-accent/40' : 'bg-transparent'
            ].join(' ')}
          />
        )}
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          <ContentPane
            workspaceId={workspaceId}
            path={selectedFile}
            mode={mode}
            autoSave={autoSave}
            wrapLines={treeOptions.wrapLines}
            onDirtyChange={setDirty}
            onSaved={bumpRefresh}
          />
        </div>
      </div>
    </div>
  )
}
