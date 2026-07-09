// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/GitTab.tsx
//
// Workbench Git tab — a changed-files tree (left, @pierre/trees) + a per-file
// diff viewer (right, @pierre/diffs' <PatchDiff>), fed by `git:diff`/
// `git:prDiff` (src/main/gitDiff.ts).
//
// Phase B extraction (see docs/learnings/gittab-state-machine.md, the
// baseline spec this pass was verified against): the diff-data state machine
// (files/selection/diffMode/diffStyle/conflictedPaths/branch/git-init) now
// lives in `./git/diff/useGitDiffData.ts`, and the PR-data state machine
// (pr/prDetail/reviewThreads/localReviews + the submit/refetch callbacks)
// lives in `./git/diff/usePrState.ts`. GitTab itself still owns the
// INTERWOVEN shared orchestration that spans both — the workspace-change
// effect (resets both hooks' state + composers in one exact order, then
// fires the initial fetch), the single combined onStatusChanged/
// onFilesChanged subscription, the onPrChanged PR-loss cascade, the shared
// `cleanupRef`, and composer state (`useReviewComposers`) — see each hook's
// own module header for the extraction boundary and the "MUST stay in
// GitTab" rationale. The presentational pieces (PrSlimHeader, DiffControls,
// the review-annotation routing layer, DiffContentPane, the empty states, and
// the pure fetch/signature helpers) live under ./git/diff/ — see that folder
// for their own doc comments. GitTab.tsx is the only externally-imported
// symbol (see WorkbenchPanel.tsx).
//
// Sticky-surface invariant: this tab is mounted/unmounted by WorkbenchPanel
// as the user switches Workbench tabs (Git isn't a persistent libghostty
// surface like a workspace terminal — it fully remounts). It DRIVES
// filesWatcher.ts itself (watchStart on mount / watchStop on unmount, mirror
// of FilesTab.tsx) — safe because Git and Files are mutually exclusive tabs,
// so at most one of them ever holds the single-active-watcher slot.
//
// Live refresh: `git:statusChanged` (src/main/git.ts's .git watcher, running
// unconditionally since terminal:mount) covers branch/index changes;
// `files:changed` (filesWatcher.ts, driven by this tab) covers working-tree
// edits neither alone would catch. Both are debounced into one git:diff
// refetch. The idempotent `diffSignature` no-op (applyDiff) is what keeps
// this fast at rest: an unchanged result skips every setState, so a
// never-settling `.git/index` rewrite (or main's own dedup racing a real
// edit) can never flicker the tree/diff.
//
// PR-diff vs working-tree distinction: `diffMode` picks between the
// uncommitted working tree (`git:diff`) and the full PR diff (`git:prDiff`,
// base...head via `gh pr diff`) — both resolve to the identical
// `GitDiffResult` shape. PR review comments (GhReviewCommentThread) anchor to
// the PR diff, not the live working tree, so `reviewThreads`/GitHub-comment
// posting are PR-diff-mode-only; LOCAL (Orpheus-owned) review comments have
// no PR requirement and work in both modes (see DiffContentPaneProps'
// `allowGithubComments` in git/diff/DiffContentPane.tsx for how the composer
// itself gates on this).
//
// Annotation model: one merged per-file list — GitHub threads + pending
// composers + local comments — feeds <PatchDiff>'s `renderAnnotation` slot
// (see git/diff/reviewAnnotations.ts + renderReviewCommentAnnotation.tsx).
// Pending composers reset on file/mode/PR change since an in-progress draft
// anchored to a since-navigated-away-from file/line/PR has nothing left to
// anchor to.
//
// Merge-conflict display: `conflictedPaths` (from the read-only
// `git:conflicts` IPC) is working-tree-only — a PR diff is against committed
// history and can't itself be "conflicted" the way a live working tree can.
// A conflicted file renders via @pierre/diffs' read-only `<UnresolvedFile>`
// (ConflictDiffPane) instead of the normal <PatchDiff>; nothing here writes
// a resolution back (no accept/reject, no git mutation) — that's deferred.
// ---------------------------------------------------------------------------

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { FileTree, useFileTree, useFileTreeSearch, useFileTreeSelection } from '@pierre/trees/react'
import { List, MagnifyingGlass } from '@phosphor-icons/react'
import type {
  GhReviewCommentThread,
  GitDiffFile,
  GitStatusEntry,
  LocalReviewComment
} from '@shared/types'
import { UI_STATE_DEFAULTS } from '@shared/uiStateDefaults'
import { useUiState, updateUiState } from '../../lib/uiStateStore'
import { GitDiffOptionsPopover } from './GitDiffOptionsPopover'
import { useTreeWidthDrag, TREE_WIDTH_CSS_VAR } from './useTreeWidthDrag'
import { useReviewComposers } from './git/useReviewComposers'
import { useTokenHoverPopover } from './git/useTokenHoverPopover'
import { TokenHoverPopover } from './git/TokenHoverPopover'
import type { CommentDraft, GhSubmitResult, CommentSource } from './git/CommentComposer'
import { preloadDiffHighlighter } from './diffHighlighterPreload'
import {
  treeHostStyle,
  TREE_ICONS,
  TREE_DENSITY,
  TREE_RENDER_OPTIONS,
  TREE_DIR_GIT_CHANGE_CSS,
  TREE_SCROLL_CONTAINMENT_CSS
} from './treeConfig'
import { CommitsTab } from './git/CommitsTab'
import { DetailsTab } from './git/DetailsTab'
import { ChecksTab } from './git/ChecksTab'
import { PrSlimHeader, WorktreeChip } from './git/diff/PrSlimHeader'
import { DiffStyleToggle, DiffModeToggle } from './git/diff/DiffControls'
import type { LocalCommentWiring } from './git/diff/reviewAnnotations'
import { DiffContentPane, DiffMessage, type ReviewComposerWiring } from './git/diff/DiffContentPane'
import { NotARepoState, CleanState, PrDiffEmptyState } from './git/diff/diffEmptyStates'
import { fetchDiff, fetchPrDiff, fetchReviewComments } from './git/diff/diffFetch'
import { useGitDiffData } from './git/diff/useGitDiffData'
import { usePrState } from './git/diff/usePrState'

// TREE_THEME + the host git-status/focus-ring CSS-var overrides now live in
// ./treeConfig.ts (shared with FilesTab.tsx — see that module's doc comment
// for the full override-chain writeup this used to carry inline here).
//
// VIEWER_THEME + the diff-options builder/tokenize caps now live in
// ./git/diff/DiffContentPane.tsx (Wave 3 Phase A extraction) alongside the
// rest of the diff-content-pane presentational surface.

// Live-refresh debounce (REFRESH_DEBOUNCE_MS, 130ms) — coalesces bursts from
// either push source (a save touching several files, a `git add -A`) into
// one git:diff refetch. Now lives in ./git/diff/useGitDiffData.ts alongside
// the `scheduleRefetch` function it tunes (Phase B extraction) — see that
// module's own copy of this comment for the full perf-history writeup.

// Exported — the git/diff/ presentational modules (DiffControls.tsx,
// DiffContentPane.tsx, diffFetch.ts) import these two types from here rather
// than re-declaring them, since GitTab is the sole owner of the `diffStyle`/
// `diffMode` state itself.
export type DiffStyle = 'unified' | 'split'

/** The Diff sub-tab's data-source mode: the uncommitted working-tree diff
 *  (default) vs the full PR diff (base...head, via `gh pr diff`) — see the
 *  module header's "PR-diff vs working-tree distinction" note. */
export type DiffMode = 'working' | 'pr'

interface GitTabProps {
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

/** Imperatively selects EXACTLY `path` in the tree, clearing every other
 *  currently-selected path first — same helper FilesTab.tsx defines (see its
 *  own doc comment for the full root-cause writeup): `FileTreeItemHandle`'s
 *  `.select()` is the controller's ADDITIVE `selectPath`, not the single-
 *  select-replace `selectOnlyPath` (which isn't exposed on the `FileTree`
 *  render-model at all), and `resetPaths` (fired on every diff refetch below)
 *  explicitly PRESERVES the prior selection across the reset rather than
 *  clearing it — so a stale previously-selected path could survive
 *  indefinitely once additively (re-)selected by this pane's imperative push,
 *  co-selected alongside whatever the user actually clicked next. Deselecting
 *  every other selected path before selecting the target restores the
 *  single-select invariant a plain user click already gets for free (native
 *  clicks go through the controller's `selectOnlyMountedPathFromInput`, a
 *  genuine replace — only this imperative push needed the fix). */
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

// PR review-comment inline annotations: ReviewAnnotationMeta/
// annotationsForFile/LocalCommentWiring live in ./git/diff/reviewAnnotations.ts;
// renderReviewCommentAnnotation and GutterAddCommentButton (their own
// files, split for react-refresh/only-export-components) live alongside
// it under ./git/diff/. The binary-image extension check (IMAGE_EXTENSIONS/
// isImagePath) now lives alongside DiffContentPane in
// ./git/diff/DiffContentPane.tsx, which is the only consumer.

// --- Sub-tab strip -----------------------------------------------------------

type GitSubTab = 'diff' | 'commits' | 'details' | 'checks'

interface SubTabStripProps {
  active: GitSubTab
  onChange: (tab: GitSubTab) => void
  /** Phase 3a: the strip grows from [Diff|Commits] to [Diff|Commits|Details|
   *  Checks] once a PR is detected for the current branch — Details/Checks
   *  are PR-only surfaces (requirements doc's "Full-PR experience" tabs). */
  hasPr: boolean
}

/** [Diff | Commits] (or, with a PR, [Diff | Commits | Details | Checks])
 *  segmented control — matches FilesTab's ModeToggle visual language (compact
 *  pill segments) but no disabled state needed. Commits/Details/Checks all
 *  render stubs today (Phase 3b/3c/3d build them out). */
function SubTabStrip({ active, onChange, hasPr }: SubTabStripProps): React.JSX.Element {
  const seg = (value: GitSubTab, label: string): React.JSX.Element => (
    <button
      key={value}
      type="button"
      onClick={() => onChange(value)}
      aria-pressed={active === value}
      className={[
        'px-2 py-0.5 rounded text-[11px] font-medium transition-colors duration-100',
        // Active segment: a warm accent-tinted fill (was a flat
        // bg-surface-raised with no accent participation at all) so the
        // active [Diff|Commits|Details|Checks] segment reads consistently
        // with the rest of the warmed-up chrome, not as a gray pill.
        active === value
          ? 'bg-accent/20 text-text-primary'
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
      {hasPr && seg('details', 'Details')}
      {hasPr && seg('checks', 'Checks')}
    </div>
  )
}

// DiffStyleToggle/DiffModeToggle now live in ./git/diff/DiffControls.tsx.
// WorktreeChip/PrSlimHeader (+ their BranchCopyButton/PR-badge helpers) now
// live in ./git/diff/PrSlimHeader.tsx.

// --- Changed-files tree pane ---------------------------------------------------

// Git-status letter: `setGitStatus(toTreeGitStatus(files))` below is the
// ENTIRE mechanism for the native "U"/"M"/"A"/"D"/"R" status letter —
// @pierre/trees renders that letter + a `data-item-git-status`-colored icon/
// row on its own (dist/render/FileTreeView.js's `getBuiltInGitStatusDecoration`
// / `GIT_STATUS_LABEL`), no custom row content needed for it. A SEPARATE
// per-row "+N -M" line-change badge IS injected via `renderRowDecoration`
// (below, in the `useFileTree` options) — that's roadmap item 5, added in
// Batch 1b; see its own doc comment for why it can't clobber the git-status
// letter lane.
//
// The unsafeCSS rule below is unrelated to either of those: it's Fix 2's
// search-icon-toggle visibility fix (see DiffTreeToolbar below) — @pierre/
// trees always mounts its `[data-file-tree-search-container]` box once
// `search: true` is passed, regardless of the controller's own isOpen state
// (same quirk FilesTab's TreePane works around), so this override keys the
// box's actual show/hide off the SAME `data-open` attribute the library
// stamps on it. Appends TREE_DIR_GIT_CHANGE_CSS (treeConfig.ts) — the
// directory-level git-status-rollup theming (roadmap item 3), especially
// relevant here since this IS the changed-files tree: a collapsed folder
// containing changed files gets a subtle accent dot + tint, computed
// automatically by @pierre/trees from the same setGitStatus payload this
// pane already sends. Also appends TREE_SCROLL_CONTAINMENT_CSS (treeConfig.ts)
// — the scroll-flicker fix; see that constant's doc comment for the
// CDP-confirmed root cause writeup (shared with FilesTab's tree, same
// underlying @pierre/trees virtualizer).
const SEARCH_BOX_VISIBILITY_CSS = `
  [data-file-tree-search-container][data-open="false"] {
    display: none;
  }
  ${TREE_DIR_GIT_CHANGE_CSS}
  ${TREE_SCROLL_CONTAINMENT_CSS}
`

interface DiffTreePaneProps {
  files: readonly GitDiffFile[]
  selected: string | null
  onSelectFile: (path: string | null) => void
  /** Collapse single-child directory chains into one flattened row — the
   *  SHARED Files+Git setting (AppUiState.filesFlattenEmptyDirs). CONSTRUCTION-
   *  ONLY on `useFileTree` (see TreeOptionsPopover.tsx's doc comment on
   *  `flattenEmptyDirectories` — no post-construction reconfigure path), so
   *  GitTab remounts this pane via a `key` when it changes, exactly like
   *  FilesTab's TreePane does for the same option. */
  flattenEmptyDirs: boolean
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
        // Re-click-to-close fix (mirrors FilesTab's TreeToolbar — see its
        // comment): @pierre/trees' search `<input>` closes search on its own
        // blur by default, and a plain button click's mousedown fires BEFORE
        // its click, stealing focus from the still-open search input and
        // closing search synchronously — so onToggleSearch then reads a
        // stale "already closed" state and reopens it instead of leaving it
        // closed. Blocking the default mousedown action keeps focus on the
        // input so no blur-close race precedes onToggleSearch.
        onMouseDown={(e) => e.preventDefault()}
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
 *  the path separators, same as FilesTab.
 *
 *  FIX 1: `selected` (GitTab's own selectedPath — seeded by auto-select via
 *  nextSelection, or carried over from a prior render) is now pushed INTO the
 *  widget imperatively, mirroring FilesTab's store→tree restore (see its
 *  applyOptions comment + `selectOnlyPath` below) — previously nothing ever
 *  called the model's own select(), so the widget's internal selection
 *  stayed empty and the selection-report effect below would fire with `[]`,
 *  reporting `null` up and clobbering GitTab's `selectedPath` back to null
 *  (the "Select a changed file" placeholder showing despite a populated
 *  auto-selection).
 *
 *  GUARD against the push/report ping-pong: the report effect below only
 *  ever propagates a NON-NULL widget selection upward (the same asymmetry
 *  FilesTab's restore-guard uses — withhold a clobbering `null` while a
 *  known-good selection hasn't been reflected into the widget yet). So an
 *  empty widget selection during (re)mount or a resetPaths() churn can never
 *  null out `selectedPath`; it can only be advanced by a genuine new
 *  non-null pick (a user click) or by this push effect explicitly selecting
 *  the auto-selected path once its path is actually present in the tree.
 *
 *  STALE-SELECTION BUG FIX (this pass): the push effect below now goes
 *  through `selectOnlyPath` (see its own doc comment) instead of the item
 *  handle's raw `.select()` — that handle's `.select()` is the controller's
 *  ADDITIVE `selectPath`, and `resetPaths` (in the effect above) explicitly
 *  PRESERVES the prior selection across a reset rather than clearing it, so a
 *  stale previously-pushed path could survive additively selected forever,
 *  visually co-selected alongside whatever the user clicked next. */
function DiffTreePane({
  files,
  selected,
  onSelectFile,
  flattenEmptyDirs
}: DiffTreePaneProps): React.JSX.Element {
  const paths = useMemo(() => files.map((f) => f.path), [files])

  // Roadmap item 5 (OPTIONAL — per-row +N/-M line-change badge). `files` is
  // keyed by path already, so a plain Map is the cheapest lookup for the
  // decoration renderer below (recomputed only when `files` itself changes).
  const changeCountsByPath = useMemo(
    () => new Map(files.map((f) => [f.path, { additions: f.additions, deletions: f.deletions }])),
    [files]
  )
  // `renderRowDecoration` is a CONSTRUCTION-ONLY option (verified against
  // node_modules/@pierre/trees/dist/react/useFileTree.js: `new FileTree(options)`
  // runs inside `useState(() => ...)`, so every option including this one is
  // captured exactly once and later renders' fresh `options` are ignored
  // entirely — same reason FilesTab.tsx routes its `renaming.onRename`/
  // `onError` through a ref instead of passing them directly). So this reads
  // through a ref kept current every render, and the function identity handed
  // to `useFileTree` below never changes.
  const changeCountsRef = useRef(changeCountsByPath)
  useLayoutEffect(() => {
    changeCountsRef.current = changeCountsByPath
  })

  const { model } = useFileTree({
    paths,
    initialExpansion: 'open',
    search: true,
    flattenEmptyDirectories: flattenEmptyDirs,
    unsafeCSS: SEARCH_BOX_VISIBILITY_CSS,
    // Batch 1b (treeConfig.ts): per-filetype icons, compact density, sticky
    // folders — same construction-time fields FilesTab.tsx's TreePane passes.
    icons: TREE_ICONS,
    density: TREE_DENSITY,
    ...TREE_RENDER_OPTIONS,
    // Roadmap item 5 (OPTIONAL): a subtle +N/-M badge in trees' own
    // renderRowDecoration lane — CONFIRMED (dist/render/FileTreeView.js) this
    // composes in a SEPARATE `decorationLaneEnabled` slot alongside the
    // built-in git-status letter/dot lane (`gitLaneActive`), so it can never
    // clobber or crowd the git-status letter this pane's own header comment
    // (above) cares about preserving. Directories get no badge (only files
    // carry line counts); a file with a zero/zero count (e.g. a pure rename)
    // also gets no badge rather than a pointless "+0 -0".
    renderRowDecoration: ({ item }) => {
      if (item.kind !== 'file') return null
      const counts = changeCountsRef.current.get(item.path)
      if (counts == null || (counts.additions === 0 && counts.deletions === 0)) return null
      const parts: string[] = []
      if (counts.additions > 0) parts.push(`+${counts.additions}`)
      if (counts.deletions > 0) parts.push(`-${counts.deletions}`)
      return {
        text: parts.join(' '),
        title: `${counts.additions} added, ${counts.deletions} deleted`
      }
    }
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
  //
  // SKIPPED (Batch 1b, roadmap item 4 — prepared tree input): see
  // FilesTab.tsx's `applyOptions` doc comment for the full writeup on why
  // `preparePresortedFileTreeInput`/`prepareFileTreeInput` isn't adopted for
  // this resetPaths call — same silent-misorder risk, and this tree's path
  // count (bounded by a single git diff's changed-file count) is nowhere
  // near the "large path list" case that API targets.
  useEffect(() => {
    model.resetPaths(paths)
    model.setGitStatus(toTreeGitStatus(files))
  }, [model, paths, files])

  // FIX 1 (push half): whenever GitTab's `selected` path changes (or the
  // path set changes shape, e.g. after resetPaths above) AND the widget's
  // own current selection doesn't already match it, imperatively select it
  // in the widget — same call FilesTab's restore path uses
  // (`model.getItem(path)?.select()` + `scrollToPath`). Guarded so this
  // never fights the report effect below: it only acts when `selected` is
  // non-null and actually present in `paths` (nothing to select otherwise).
  //
  // INFINITE-LOOP FIX (this pass, found via live CDP QA of the stale-
  // selection fix above): this effect and the report effect below run in the
  // SAME commit, in declaration order, both reacting to `selection`
  // changing. Right after a genuine user click, the sequence within one
  // commit is: (1) the native click already replaced the widget's own
  // selection (`selectOnlyMountedPathFromInput`, synchronous); (2) the
  // report effect sees the NEW `selection` and calls `onSelectFile`, which
  // schedules a `setSelectedPath` in GitTab — but that hasn't re-rendered
  // yet, so THIS effect still reads the OLD `selected` prop from before the
  // click in the SAME pass. The old guard compared that stale `selected`
  // against the new `selection` (unequal — different file), concluded the
  // widget "disagreed" with `selected`, and pushed the STALE path back via
  // `selectOnlyPath` — undoing the user's click. That push changes
  // `selection` again, re-firing the report effect with the reverted
  // selection, which flips `selectedPath` back the OTHER way, forever
  // (`Maximum update depth exceeded`, caught live via CDP-driven QA clicking
  // a second file with the additive-`.select()` bug already fixed above —
  // the old ADDITIVE bug had accidentally been masking this exact race: an
  // additive push just left BOTH paths selected, `selection.length !== 1`,
  // and the report effect's own `single = null` guard silently stopped the
  // ping-pong instead of looping, which is what read as "stale selection
  // never clears" rather than a crash).
  //
  // Fix: only push when the widget's OWN selection can't already resolve to
  // a valid single file — i.e. it's empty, or a directory-only/multi
  // selection (never happens here in practice, but stay defensive) — NOT
  // merely "differs from the stale `selected` prop". A widget that already
  // holds a valid single selection is never wrong; it's simply not reported
  // upward yet (the report effect owns that, in the same commit), so pushing
  // here would only ever be UNDOING a real, more-recent tree-side change.
  useEffect(() => {
    if (selected === null) return
    if (!paths.includes(selected)) return
    if (selection.length === 1) return
    selectOnlyPath(model, selected)
    model.scrollToPath(selected)
  }, [model, selected, paths, selection])

  // Report the single selected (non-directory) file up. Every path here is a
  // file already (git:diff never returns directories), so any single
  // selection is a valid target.
  //
  // FIX 1 (clobber guard): only ever propagate a NON-NULL widget selection.
  // Withholding a `null` report means an empty/transient widget selection —
  // during (re)mount, a resetPaths() churn, or the brief window before the
  // push effect above has run — can never stomp GitTab's already-populated
  // `selectedPath` back to null. A genuine user deselect never happens in
  // this single-select tree (there's no empty-space click target that
  // clears selection without picking another row), so this asymmetry costs
  // nothing real; it only removes the spurious clobber this fix addresses.
  useEffect(() => {
    const single = selection.length === 1 ? selection[0] : null
    if (single !== null && single !== selected) onSelectFile(single)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `selected`/`onSelectFile` intentionally excluded: this effect only reacts to the tree's OWN selection changing, not to GitTab re-deriving `selected` from a fresh files[] after a refetch.
  }, [selection])

  const toolbar = useMemo(
    () => <DiffTreeToolbar searchOpen={search.isOpen} onToggleSearch={toggleSearch} />,
    [search.isOpen, toggleSearch]
  )

  // Theme + git-status/focus-ring host CSS vars — shared with FilesTab.tsx
  // via treeConfig.ts's `treeHostStyle()` (see that module for the full
  // override-chain writeup this used to carry inline here).
  const hostStyle = useMemo(() => {
    return { height: '100%', ...treeHostStyle() } as React.CSSProperties
  }, [])

  return (
    <div style={hostStyle} className="h-full">
      <FileTree model={model} header={toolbar} style={{ height: '100%' }} />
    </div>
  )
}

// DiffContentPane (+ DiffMessage, OversizedDiffPlaceholder, BinaryImageBody,
// anchorFromRange, buildDiffOptions, ConflictDiffPane, ReviewComposerWiring)
// now lives in ./git/diff/DiffContentPane.tsx — see that module's own header.
// Empty states (EmptyStateShell, NotARepoState, CleanState, PrDiffEmptyState)
// now live in ./git/diff/diffEmptyStates.tsx.

// --- Root ------------------------------------------------------------------

// The pure diff-fetch/signature helpers (nextSelection, diffSignature,
// isUnchangedDiffResult, fetchDiff, fetchPrDiff, fetchForMode,
// fetchReviewComments, fetchLocalReviews, fetchConflicts, EMPTY_CONFLICTS,
// sameSetContents/setConflictedPathsIfChanged) now live in
// ./git/diff/diffFetch.ts — see that module's own header. `DiffSettleResult`
// is imported from there too.

/**
 * Workbench Git tab root — a changed-files tree (left, collapsible) and a
 * per-file diff viewer (right), plus the PR chrome (slim header, sub-tab
 * strip, Details/Checks/Commits) once a PR is detected. Mounted only while
 * the Git tab is the active, non-dormant Workbench tab (see WorkbenchPanel).
 */
export function GitTab({
  workspaceId,
  worktreeParentCwd,
  worktreeBranch
}: GitTabProps): React.JSX.Element {
  // Pierre-adoption Batch 1a, quick-win #4 — warm @pierre/diffs' shared Shiki
  // highlighter once per app lifetime so the first <PatchDiff> mount below
  // doesn't pay Shiki's cold-resolve cost on the user's first paint. Cheap to
  // call on every GitTab mount (tab switch, workspace change): the module's
  // own guard makes every call after the very first a no-op. See
  // diffHighlighterPreload.ts's own header for the full rationale + why no
  // `preferredHighlighter` is passed.
  useEffect(() => {
    preloadDiffHighlighter()
  }, [])

  const [treeOpen, setTreeOpen] = useState(true)
  const [subTab, setSubTab] = useState<GitSubTab>('diff')

  // Phase 4b: open "start a comment" composers (gutter "+"/select-to-comment)
  // — see useReviewComposers.ts's own header. Reset alongside reviewThreads
  // at every point below that clears it (workspace switch, PR loss, leaving
  // PR-diff mode) PLUS on file/mode change specifically (the task's "Reset
  // pending composers on file/mode/PR change") since an open composer
  // anchored to file A's line 12 has no meaning once the user has navigated
  // to file B — see the file-change effect below. Composer state is a THIRD
  // concern neither useGitDiffData nor usePrState owns outright (both need
  // write-access to reset it) — kept here in GitTab and threaded into both
  // hooks as a plain `reset`/`close` parameter, per the spec's §6 point 6.
  // Destructured (rather than kept as one `reviewComposers` object) so every
  // effect/callback below can depend on the STABLE individual function
  // identities (`open`/`close`/`reset` are each memoized with empty deps in
  // useReviewComposers.ts) instead of the wrapping object, which changes
  // identity on every composer open/close — depending on the whole object
  // would make e.g. the workspace-switch effect re-run on every keystroke's
  // worth of composer churn, not just on an actual workspace change.
  const {
    composers: openComposers,
    open: openComposer,
    close: closeComposer,
    reset: resetComposers
  } = useReviewComposers()

  // Phase B extraction — see docs/learnings/gittab-state-machine.md §5/§6 for
  // the full boundary writeup. useGitDiffData owns files/repo/loading/
  // selectedPath/diffStyle/diffMode/conflictedPaths/branch/git-init plus every
  // effect that's diff-only (mode-switch, file watcher, diffModeRef sync).
  // usePrState owns pr/prDetail/reviewThreads/localReviews plus every
  // effect/callback that's PR-only (fetch-on-mount fallback, reviewThreads-
  // fetch, prDetail-fetch, the submit/refetch callbacks). Declared in THIS
  // order (diff hook before PR hook) so their internal effects run in the
  // SAME relative order the pre-extraction single-component version had
  // (React's per-component effect-ordering guarantee is by DECLARATION
  // order) — see useGitDiffData.ts's header for why this matters.
  //
  // What stays HERE (not inside either hook) — the interwoven shared bits
  // the spec's §6 calls out by name:
  //   1. The workspace-change effect below — resets BOTH hooks' state (via
  //      their exposed `resetForWorkspaceChange`) AND composers, in the
  //      exact original step order, synchronously, BEFORE firing the initial
  //      forceFresh fetch (the stuck-loading fix's ordering).
  //   2. The single combined onStatusChanged/onFilesChanged subscription
  //      below — calls BOTH hooks' `scheduleRefetch`/`scheduleRefreshPrDetail`
  //      from ONE listener (LAG-LAYER #9's perf fix), and owns clearing BOTH
  //      hooks' debounce refs + the shared cleanupRef in its own teardown.
  //   3. The onPrChanged subscription below — its PR-loss cascade writes to
  //      usePrState's setters AND useGitDiffData's setDiffMode AND composer
  //      state, all in ONE synchronous callback (never split across hooks).
  //   4. `cleanupRef` (from useGitDiffData) — shared across the diff-side
  //      debounced refetch, runGitInit, AND onPrChanged's PR-diff refetch.
  //   5. `submitComment`/`reviewComposerWiring`/`localCommentWiring` below —
  //      cross-concern glue combining `diffModeRef` (diff hook) with the
  //      submit callbacks (PR hook) and composer state (here).
  const {
    files,
    repo,
    loading,
    setLoading,
    selectedPath,
    setSelectedPath,
    diffStyle,
    setDiffStyle,
    diffMode,
    setDiffMode,
    diffModeRef,
    conflictedPaths,
    branch,
    setBranch,
    gitInitRunning,
    gitInitError,
    runGitInit,
    applyDiff,
    cleanupRef,
    debounceRef,
    scheduleRefetch,
    resetForWorkspaceChange: resetDiffForWorkspaceChange
  } = useGitDiffData(workspaceId, resetComposers)

  const {
    pr,
    setPr,
    prDetail,
    setPrDetail,
    reviewThreads,
    setReviewThreads,
    localReviews,
    refetchReviewThreads,
    refetchPrDetail,
    submitGithubReviewComment,
    submitLocalComment,
    toggleLocalResolved,
    deleteLocalComment,
    scheduleRefreshPrDetail,
    prDetailDebounceRef,
    resetForWorkspaceChange: resetPrForWorkspaceChange
  } = usePrState(workspaceId, diffMode, closeComposer)

  // Initial load + workspace change (spec §3.2) — THE most important effect
  // for ordering (see docs/learnings/gittab-state-machine.md §3.2/§6 point 1
  // for the full writeup this comment summarizes). Resets BOTH hooks' state
  // (via their exposed reset functions) AND composers/subTab, synchronously,
  // in the SAME order the pre-extraction single-effect version used, THEN
  // fires the initial forceFresh diff fetch — this ordering IS the
  // stuck-loading fix. Kept as ONE block here (not split into each hook's own
  // mount effect) precisely because the spec calls out that a naive split
  // risks the two hooks' resets running in a different relative order than
  // before, or racing a fast/cached fetch response.
  useEffect(() => {
    // Intentional: a workspace switch must show "Loading…" (with no stale
    // prior-workspace data) immediately rather than waiting; the settled
    // result arrives asynchronously via fetchDiff's callback below.
    // resetDiffForWorkspaceChange sets loading=true as its own first step —
    // no eslint-disable needed here since the direct setState calls it makes
    // are inside a plain function call the rule doesn't see through (only
    // the setSubTab call below, the first RAW setState the rule can see in
    // this effect body, needs the disable).
    resetDiffForWorkspaceChange()
    // Phase 3a/3b/4a/4d: PR-side reset (pr/prDetail/reviewThreads/
    // localReviews -> null/[]) + the unconditional fetchLocalReviews call —
    // no PR dependency for localReviews, so it fires regardless of whether
    // this workspace has one.
    resetPrForWorkspaceChange(workspaceId)
    // Phase 4b: same reset for open pending composers — a composer anchored
    // to the PREVIOUS workspace's file/line has no meaning in the new one.
    resetComposers()
    // A PR-only sub-tab (Details/Checks) carried over from the PREVIOUS
    // workspace has no backing strip segment here (hasPr is about to be
    // false until/unless this workspace's own PR push says otherwise) —
    // fall back to Diff. Mirrors the same fallback the onPrChanged(null)
    // path below applies for an in-place PR-loss on the SAME workspace;
    // this covers the workspace-switch case that push wouldn't necessarily
    // fire for (CodeRabbit finding, fixed).
    // eslint-disable-next-line react-hooks/set-state-in-effect -- same intentional-reset rationale as resetDiffForWorkspaceChange above; the lint rule can't see through that function call to know loading/etc. were already reset there, so it flags this next direct setState call as if it were the first in the effect body.
    setSubTab((prev) => (prev === 'details' || prev === 'checks' ? 'diff' : prev))
    // BUG FIX (stuck-loading) — `forceFresh: true`: this is the first fetch
    // after the full state reset just above (files=[], lastAppliedSigRef =
    // null, both inside resetDiffForWorkspaceChange). Main's own signature
    // cache (gitDiff.ts) is keyed by workspaceId and OUTLIVES this
    // component's mount/unmount, so without forceFresh a reopened tab (or a
    // workspace switched back to) could replay the SAME `{ unchanged: true }`
    // sentinel main last emitted to a PREVIOUS mount of this tab — which this
    // fresh instance has no data to fall back on. See gitDiff.ts's
    // getWorkingTreeDiff + diffFetch.ts's fetchDiff for the full writeup.
    // `setLoading(false)` runs unconditionally here (not inside applyDiff,
    // which no-ops on `result.unchanged`) so loading always clears even on
    // that belt-and-suspenders path.
    return fetchDiff(
      workspaceId,
      (result) => {
        applyDiff(result)
        setLoading(false)
      },
      { forceFresh: true }
    )
  }, [
    workspaceId,
    applyDiff,
    setLoading,
    resetDiffForWorkspaceChange,
    resetPrForWorkspaceChange,
    resetComposers
  ])

  // Live refresh: git:statusChanged (branch/index change — src/main/git.ts's
  // .git watcher, already running unconditionally since terminal:mount) and
  // files:changed (working-tree edits — filesWatcher.ts, driven by
  // useGitDiffData's own watchStart/watchStop effect) both indicate the
  // working TREE may have moved. PERF FIX (LAG-LAYER #9): kept as ONE
  // combined onStatusChanged listener (not two, one per hook) — two
  // independent listeners on the same event previously meant every real
  // status change did double dispatch work; splitting this across
  // useGitDiffData/usePrState would resurrect that regression, so both
  // hooks expose a plain callback (`scheduleRefetch`/`scheduleRefreshPrDetail`)
  // this ONE subscription calls instead of subscribing themselves. `branch`
  // is diff-hook state (feeds PrSlimHeader) but is only ever SET from this
  // shared listener, so its setter is threaded through from useGitDiffData.
  useEffect(() => {
    const unsubStatus = window.api.git.onStatusChanged((e) => {
      if (e.workspaceId !== workspaceId) return
      setBranch(e.status.branch)
      scheduleRefetch()
      scheduleRefreshPrDetail()
    })
    const unsubFiles = window.api.files.onFilesChanged((e) => {
      if (e.workspaceId === workspaceId) scheduleRefetch()
    })
    return () => {
      unsubStatus()
      unsubFiles()
      /* eslint-disable react-hooks/exhaustive-deps -- `debounceRef`/
         `prDetailDebounceRef`/`cleanupRef` are mutable timer-handle/cancel-fn
         BOXES (from useGitDiffData / usePrState), not DOM refs — this cleanup
         deliberately reads whatever is CURRENTLY pending at teardown time (the
         latest scheduled timer / in-flight fetch), not a value snapshotted when
         this effect ran; that's the entire point of a ref here, matching the
         pre-extraction single-effect version's identical `.current` reads in
         its own cleanup. Clearing BOTH debounce timers (diff + prDetail) on
         teardown is required: a stale workspace's pending prDetail refresh must
         not survive a workspace switch and clobber the new workspace's data. */
      if (debounceRef.current !== null) clearTimeout(debounceRef.current)
      if (prDetailDebounceRef.current !== null) clearTimeout(prDetailDebounceRef.current)
      cleanupRef.current?.()
      cleanupRef.current = null
      /* eslint-enable react-hooks/exhaustive-deps */
    }
  }, [
    workspaceId,
    scheduleRefetch,
    scheduleRefreshPrDetail,
    setBranch,
    debounceRef,
    prDetailDebounceRef,
    cleanupRef
  ])

  // Phase 3a: PR detection — the onPrChanged subscription (unchanged, kept
  // in GitTab per spec §6 point 2: its PR-loss cascade writes to BOTH hooks'
  // state AND composer state in one synchronous callback, which must not
  // split across effects/hooks — see the doc comment on `e.pr === null`
  // below for the full "why here, not an effect keyed on pr" rationale).
  useEffect(() => {
    return window.api.github.onPrChanged((e) => {
      if (e.workspaceId !== workspaceId) return
      setPr(e.pr)
      // If the PR just disappeared (branch switched to one with no PR, or
      // the PR was closed/deleted) while a PR-only sub-tab (Details/Checks)
      // was active, the strip segment backing it is about to unmount out
      // from under the user — fall back to Diff rather than leaving
      // `subTab` pointed at a segment that no longer exists in the strip.
      // Done here (inside the external-event callback) rather than a
      // separate effect keyed on `pr`/`subTab`, since setState directly in
      // an effect body — as opposed to an event-driven callback like this
      // one — is a lint error (cascading-render risk).
      if (e.pr === null) {
        setSubTab((prev) => (prev === 'details' || prev === 'checks' ? 'diff' : prev))
        // Same "clear immediately rather than wait on a round-trip" reset
        // for the rich PR-detail payload (Phase 3b foundation) — done here
        // (inside this event callback) rather than in usePrState's own
        // prDetail-fetch effect, for the same cascading-render reason noted
        // above.
        setPrDetail(null)
        // Phase 4-pre: the PR-diff toggle is about to unmount out from under
        // the user for the same reason the Details/Checks tabs are above —
        // fall back to the working-tree view rather than leaving `diffMode`
        // pointed at 'pr' with no PR left to diff against. useGitDiffData's
        // own mode-switch effect (which owns fetching) reacts to this state
        // change on its own; no fetch call needed here.
        setDiffMode((prev) => (prev === 'pr' ? 'working' : prev))
        // Phase 4a: the review-comment threads belonged to the PR that just
        // disappeared — clear them alongside the diffMode/prDetail resets
        // above rather than leaving stale threads around for whatever the
        // (possibly PR-less) working-tree view renders next.
        setReviewThreads(null)
        // Phase 4b: same for any open pending composers — they belonged to
        // the PR that just disappeared.
        resetComposers()
      } else if (diffModeRef.current === 'pr') {
        // Phase 4-pre: the PR changed (branch switch to a DIFFERENT PR'd
        // branch, or the same PR updated) while already viewing PR-diff mode
        // — refetch so the pane reflects the new/updated PR rather than the
        // previous one's stale diff. useGitDiffData's own mode-switch
        // effect's `diffMode` dependency won't re-fire here (the mode itself
        // didn't change), so this is the one place that needs an explicit
        // refetch call for this case. `cleanupRef` is the SAME shared ref
        // useGitDiffData's debounced live-refresh + runGitInit use — only
        // the latest in-flight fetch's callback may ever apply.
        cleanupRef.current?.()
        cleanupRef.current = fetchPrDiff(workspaceId, applyDiff)
        // Phase 4a: same "PR changed while already in PR-diff mode" case —
        // the review-comment threads belong to the OLD PR, refetch for the
        // new/updated one. Mirrors the diff refetch just above.
        fetchReviewComments(workspaceId, setReviewThreads)
      }
    })
  }, [
    workspaceId,
    applyDiff,
    resetComposers,
    diffModeRef,
    cleanupRef,
    setPr,
    setPrDetail,
    setDiffMode,
    setReviewThreads
  ])

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

  // Phase 4b: reset open pending composers whenever the selected FILE changes
  // — an in-progress composer anchored to the previously-viewed file's line
  // has no visible home once DiffContentPane swaps to a different file's
  // <PatchDiff> (per the task's "Reset pending composers on file/mode/PR
  // change"). A no-op (via useReviewComposers' own length-0 guard) whenever
  // there's nothing open, so this is cheap on every ordinary file click too.
  useEffect(() => {
    resetComposers()
  }, [selectedPath, resetComposers])

  // Phase 5 (3-button composer redesign): the NEW-comment composer's submit
  // dispatcher — routes on the `source` the CLICKED button carried (see
  // CommentComposer.tsx's module header), replacing the old design where a
  // separate toggle's LAST-SET value was read back out of a ref at submit
  // time. That ref-based design could drift from what the user actually saw
  // on screen (submit reading a stale toggle value); an explicit source
  // argument threaded straight from the click cannot drift.
  //
  // `diffModeRef.current !== 'pr'` still forces the local path even if
  // `source === 'github'` somehow reached here — working-tree mode's
  // composer never renders the GitHub button at all (see
  // renderReviewCommentAnnotation's `allowGithub` gating, itself sourced from
  // `allowGithubComments` which is false outside PR-diff mode), so this is
  // belt-and-suspenders against a stale button reference rather than a path
  // expected to trigger in practice. Cross-concern glue (diffModeRef from the
  // diff hook + submit callbacks from the PR hook) — stays in GitTab per the
  // spec's §6 point 9.
  const submitComment = useCallback(
    (draft: CommentDraft, source: CommentSource): Promise<GhSubmitResult> =>
      diffModeRef.current !== 'pr' || source === 'local'
        ? submitLocalComment(draft)
        : submitGithubReviewComment(draft),
    [submitLocalComment, submitGithubReviewComment, diffModeRef]
  )

  // Phase 4b/5: the wiring DiffContentPane needs to drive the gutter "+"/
  // select-to-comment affordance — meaningful in BOTH modes as of Phase 5
  // FIX 1 (see DiffContentPaneProps' `composers` doc comment); `submitComment`
  // itself is what routes a working-tree submit to the local store only
  // (see its own doc comment on the `diffModeRef` check).
  const reviewComposerWiring: ReviewComposerWiring = useMemo(
    () => ({
      composers: openComposers,
      open: openComposer,
      close: closeComposer,
      onSubmit: submitComment
    }),
    [openComposers, openComposer, closeComposer, submitComment]
  )

  // Phase 4d: the wiring DiffContentPane needs for LOCAL comment cards
  // (resolve/delete) — see LocalCommentWiring's own doc comment. Phase 5:
  // no longer carries the [GitHub | Local] source-toggle state (removed
  // entirely — see CommentComposer.tsx's module header for the 3-button
  // redesign that replaced it).
  const localCommentWiring: LocalCommentWiring = useMemo(
    () => ({
      onToggleResolved: toggleLocalResolved,
      onDelete: deleteLocalComment
    }),
    [toggleLocalResolved, deleteLocalComment]
  )

  const toggleTree = useCallback(() => setTreeOpen((v) => !v), [])

  // Fix 2: the ⚙ diff-options popover's Wrap-lines toggle — APP-WIDE view
  // preference, persisted via AppUiState.gitDiffWrapLines (same
  // files_wrap_lines pattern FilesTab's TreeOptionsPopover uses). Falls back
  // to UI_STATE_DEFAULTS while the initial uiState.get() hasn't resolved yet.
  //
  // "Flatten empty folders" is a SEPARATE toggle in the same popover, reading/
  // writing the SHARED AppUiState.filesFlattenEmptyDirs value the Files tab's
  // TreeOptionsPopover already owns — toggling it here follows in the Files
  // tab too (and vice versa), see GitDiffOptionsPopover.tsx's doc comment.
  const uiState = useUiState()
  const wrapLines = uiState?.gitDiffWrapLines ?? UI_STATE_DEFAULTS.gitDiffWrapLines
  const flattenEmptyDirs = uiState?.filesFlattenEmptyDirs ?? UI_STATE_DEFAULTS.filesFlattenEmptyDirs
  // Token-hover popover toggle (default OFF — see AppUiState.tokenHoverEnabled's
  // doc comment). SHARED with the Files tab's own TreeOptionsPopover toggle.
  const tokenHoverEnabled = uiState?.tokenHoverEnabled ?? UI_STATE_DEFAULTS.tokenHoverEnabled
  const diffOptions = useMemo(
    () => ({ wrapLines, flattenEmptyDirs, tokenHoverEnabled }),
    [wrapLines, flattenEmptyDirs, tokenHoverEnabled]
  )
  const setDiffOptions = useCallback(
    (next: { wrapLines: boolean; flattenEmptyDirs: boolean; tokenHoverEnabled: boolean }) => {
      updateUiState({
        gitDiffWrapLines: next.wrapLines,
        filesFlattenEmptyDirs: next.flattenEmptyDirs,
        tokenHoverEnabled: next.tokenHoverEnabled
      })
    },
    []
  )

  // Draggable tree/code split — SHARED width with FilesTab's tree (see
  // useTreeWidthDrag.ts's module header).
  const persistedTreeWidth = uiState?.workbenchTreeWidth ?? UI_STATE_DEFAULTS.workbenchTreeWidth
  const commitTreeWidth = useCallback((width: number) => {
    updateUiState({ workbenchTreeWidth: width })
  }, [])
  // Destructured immediately at the call site — see FilesTab.tsx's identical
  // comment on why: react-hooks' ref-safety analysis taints EVERY property
  // read off a variable holding a custom hook's return object once any ONE
  // of its properties is ref-derived (`treeWidthVarRef`); destructuring here
  // is what it recognizes as safe.
  const {
    width: treeWidth,
    isDragging: treeIsDragging,
    beginDrag: treeBeginDrag,
    treeWidthVarRef
  } = useTreeWidthDrag(persistedTreeWidth, commitTreeWidth)

  // Phase 2: the hide-tree icon + unified/split toggle + ⚙ wrap popover only
  // make sense once there's an actual diff to view — while loading, or in
  // either edge state (not-a-repo / clean), there's no tree/diff pane to
  // control. The worktree chip (PR case only — see PrSlimHeader; the
  // no-PR row below carries it directly) + [Diff|Commits] strip stay visible
  // in every state (matching the mockup's edge-states panel, which keeps its
  // own harness chrome up top regardless of body state).
  const showDiffControls = !loading && repo && files.length > 0

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col">
      {pr !== null && (
        <PrSlimHeader
          pr={pr}
          branch={branch}
          worktreeParentCwd={worktreeParentCwd}
          worktreeBranch={worktreeBranch}
        />
      )}
      {
        // bg-surface-overlay (one step up from the panel's own surface-raised
        // background) gives this control row a distinct header BAND instead
        // of blending flat into the panel — cohesive with PrSlimHeader's own
        // surface-raised band above it and the diff content below, so the
        // chrome reads as layered bands rather than one flat gray field
        // (middle-ground chrome-warmth pass).
      }
      <div className="h-8 flex-shrink-0 border-b border-border-default bg-surface-overlay flex items-center px-1 gap-1">
        {showDiffControls && (
          <>
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
          </>
        )}
        {
          // Phase 4-pre: the [Working tree | PR diff] toggle — shown only
          // while the Diff sub-tab is active AND a PR exists for this branch
          // (see the module header's Phase 4-pre note: PR-diff mode has
          // nothing to show without a PR to diff against, so no PR means no
          // toggle and the tab stays working-tree-only, unchanged from
          // Phase 1/2/3). Independent of `showDiffControls` (loading/edge
          // states) so the toggle doesn't pop in/out as the working tree's
          // OWN load state flickers — it only tracks PR existence.
          pr !== null && subTab === 'diff' && (
            <DiffModeToggle value={diffMode} onChange={setDiffMode} />
          )
        }
        <div className="ml-auto flex items-center gap-2">
          {
            // The worktree chip already renders inside PrSlimHeader once a PR
            // exists (Fix 2 places it in that full-width row) — only show it
            // here, next to the strip, for the no-PR case where there's no PR
            // header row for it to live in. WorktreeChip itself is a no-op
            // (renders null) for a main-checkout workspace either way, so
            // this can render unconditionally without reintroducing the
            // removed "local" pill (see WorktreeChip's own doc comment).
            pr === null && (
              <WorktreeChip worktreeParentCwd={worktreeParentCwd} worktreeBranch={worktreeBranch} />
            )
          }
          <SubTabStrip active={subTab} onChange={setSubTab} hasPr={pr !== null} />
        </div>
      </div>
      {subTab === 'commits' && (
        <CommitsTab prDetail={prDetail} workspaceId={workspaceId} branch={branch} />
      )}
      {subTab === 'details' && (
        <DetailsTab
          prDetail={prDetail}
          workspaceId={workspaceId}
          branch={branch}
          onCommentPosted={refetchPrDetail}
        />
      )}
      {subTab === 'checks' && (
        <ChecksTab prDetail={prDetail} workspaceId={workspaceId} branch={branch} />
      )}
      {subTab === 'diff' && (
        <GitTabBody
          loading={loading}
          repo={repo}
          files={files}
          selectedPath={selectedPath}
          selectedFile={selectedFile}
          treeOpen={treeOpen}
          treeWidth={treeWidth}
          treeWidthVarRef={treeWidthVarRef}
          isTreeWidthDragging={treeIsDragging}
          onBeginTreeWidthDrag={treeBeginDrag}
          flattenEmptyDirs={flattenEmptyDirs}
          diffStyle={diffStyle}
          wrapLines={wrapLines}
          tokenHoverEnabled={tokenHoverEnabled}
          workspaceId={workspaceId}
          branch={branch}
          gitInitRunning={gitInitRunning}
          gitInitError={gitInitError}
          diffMode={diffMode}
          reviewThreads={reviewThreads}
          // Phase 5 FIX 1: unconditional in both modes now — a local comment
          // needs no PR, so the gutter "+"/select-to-comment affordance and
          // the local-comment cards work on the working-tree diff too. See
          // DiffContentPaneProps' own doc comment.
          composers={reviewComposerWiring}
          onRefetchThreads={refetchReviewThreads}
          localComments={localReviews}
          localWiring={localCommentWiring}
          allowGithubComments={diffMode === 'pr'}
          conflictedPaths={conflictedPaths}
          onSelectFile={setSelectedPath}
          onGitInit={runGitInit}
        />
      )}
    </div>
  )
}

interface GitTabBodyProps {
  loading: boolean
  repo: boolean
  files: GitDiffFile[]
  selectedPath: string | null
  selectedFile: GitDiffFile | null
  treeOpen: boolean
  /** Draggable tree/code split — SHARED width with FilesTab (see
   *  useTreeWidthDrag.ts's module header). */
  treeWidth: number
  /** Imperative ref for the tree-pane wrapper — the live drag writes a CSS
   *  var directly onto this node (bypassing React state) rather than
   *  flowing `treeWidth` through a prop update every mousemove frame. See
   *  useTreeWidthDrag.ts's PERF FIX note. */
  treeWidthVarRef: React.RefCallback<HTMLElement>
  isTreeWidthDragging: boolean
  onBeginTreeWidthDrag: (e: React.MouseEvent) => void
  /** SHARED Files+Git tree setting (AppUiState.filesFlattenEmptyDirs) — see
   *  DiffTreePaneProps' own doc comment. */
  flattenEmptyDirs: boolean
  diffStyle: DiffStyle
  wrapLines: boolean
  /** Token-hover popover toggle (AppUiState.tokenHoverEnabled, default OFF)
   *  — gates whether onTokenEnter/onTokenLeave get wired into DiffContentPane
   *  at all and whether <TokenHoverPopover> mounts. See its own doc comment
   *  in shared/types.ts. */
  tokenHoverEnabled: boolean
  workspaceId: string
  branch: string | null
  gitInitRunning: boolean
  gitInitError: string | null
  /** Phase 4-pre — which empty state to render for `files.length === 0`:
   *  'working' keeps the existing not-a-repo/clean-tree branches; 'pr' shows
   *  PrDiffEmptyState instead (a PR-diff fetch has no "not a repo"/"clean
   *  tree" concept of its own — see that component's doc comment). */
  diffMode: DiffMode
  /** Phase 4a — see DiffContentPaneProps' own doc comment; threaded straight
   *  through to DiffContentPane. */
  reviewThreads: readonly GhReviewCommentThread[] | null
  /** Phase 4b/5 — see DiffContentPaneProps' own doc comment; threaded
   *  straight through to DiffContentPane. Non-null in BOTH modes as of
   *  Phase 5 FIX 1 (a local comment needs no PR). */
  composers: ReviewComposerWiring | null
  /** Phase 4c — see DiffContentPaneProps' own doc comment; threaded straight
   *  through to DiffContentPane. */
  onRefetchThreads: () => void
  /** Phase 4d — see DiffContentPaneProps' own doc comment; threaded straight
   *  through to DiffContentPane (the full per-workspace list, unfiltered —
   *  DiffContentPane/annotationsForFile filter by the selected file's path). */
  localComments: readonly LocalReviewComment[]
  /** Phase 4d/5 — see DiffContentPaneProps' own doc comment; threaded
   *  straight through to DiffContentPane. Non-null in BOTH modes as of
   *  Phase 5 FIX 1. */
  localWiring: LocalCommentWiring | null
  /** Phase 5 FIX 1 — see DiffContentPaneProps' own doc comment; threaded
   *  straight through to DiffContentPane. */
  allowGithubComments: boolean
  /** Pierre adoption batch 4 — see DiffContentPaneProps' own doc comment;
   *  threaded straight through to DiffContentPane. */
  conflictedPaths: ReadonlySet<string>
  onSelectFile: (path: string | null) => void
  onGitInit: () => void
}

/** The Diff sub-tab's body — extracted from GitTab's own render so the
 *  three-way branch (loading / not-a-repo / clean / has-changes) reads as a
 *  flat set of early returns instead of nested ternaries inline in GitTab's
 *  JSX, keeping GitTab's own cognitive complexity down. `loading` intentionally
 *  takes priority over `repo`/`files` — see GitTab's `repo` state comment on
 *  why it defaults optimistic. */
function GitTabBodyImpl({
  loading,
  repo,
  files,
  selectedPath,
  selectedFile,
  treeOpen,
  treeWidth,
  treeWidthVarRef,
  isTreeWidthDragging,
  onBeginTreeWidthDrag,
  flattenEmptyDirs,
  diffStyle,
  wrapLines,
  tokenHoverEnabled,
  workspaceId,
  branch,
  gitInitRunning,
  gitInitError,
  diffMode,
  reviewThreads,
  composers,
  onRefetchThreads,
  localComments,
  localWiring,
  allowGithubComments,
  conflictedPaths,
  onSelectFile,
  onGitInit
}: GitTabBodyProps): React.JSX.Element {
  // PERF FIX (token-hover lift) — the controller hook now lives HERE, one
  // level up from DiffContentPane, instead of inside DiffContentPaneImpl.
  // Called unconditionally (rules-of-hooks) before every early return below
  // so hook order never varies with `loading`/`diffMode`/`files.length`. A
  // hovered token's setState now re-renders only THIS component (cheap: a
  // handful of memoized/prop-stable children plus the tiny popover below) —
  // DiffContentPane is wrapped in React.memo and receives onTokenEnter/
  // onTokenLeave as the hook's own stable (empty-deps useCallback)
  // identities, so its shallow prop comparison short-circuits and <PatchDiff>
  // never re-renders on hover. See useTokenHoverPopover.ts's own doc comment.
  //
  // Always called unconditionally regardless of `tokenHoverEnabled` (rules-
  // of-hooks) — only the WIRING below is gated: when the setting is OFF,
  // DiffContentPane gets these stable no-op handlers instead (its own
  // onTokenEnter/onTokenLeave props are non-optional), so @pierre/diffs never
  // attaches a hover listener at all, and <TokenHoverPopover> doesn't mount.
  const tokenHover = useTokenHoverPopover()
  const noopTokenEnter = useCallback(() => {}, [])
  const noopTokenLeave = useCallback(() => {}, [])

  if (loading) return <DiffMessage text="Loading…" />
  if (diffMode === 'pr') {
    if (files.length === 0) return <PrDiffEmptyState />
  } else {
    if (!repo) {
      return <NotARepoState onInit={onGitInit} running={gitInitRunning} error={gitInitError} />
    }
    if (files.length === 0) return <CleanState branch={branch} />
  }

  return (
    <div className="flex-1 min-h-0 flex">
      <div
        ref={treeWidthVarRef}
        hidden={!treeOpen}
        style={{ width: `var(${TREE_WIDTH_CSS_VAR}, ${treeWidth}px)` }}
        className="flex-shrink-0 min-h-0"
      >
        <DiffTreePane
          // See DiffTreePaneProps' flattenEmptyDirs doc comment: construction-
          // only option on useFileTree, so changing it remounts via this key
          // (mirrors FilesTab's treeKey).
          key={String(flattenEmptyDirs)}
          files={files}
          selected={selectedPath}
          onSelectFile={onSelectFile}
          flattenEmptyDirs={flattenEmptyDirs}
        />
      </div>
      {treeOpen && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize changed-files tree"
          onMouseDown={onBeginTreeWidthDrag}
          className={[
            'w-1 flex-shrink-0 cursor-col-resize hover:bg-accent/40 transition-colors duration-150 border-r border-border-default',
            isTreeWidthDragging ? 'bg-accent/40' : 'bg-transparent'
          ].join(' ')}
        />
      )}
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        <DiffContentPane
          workspaceId={workspaceId}
          file={selectedFile}
          diffStyle={diffStyle}
          wrapLines={wrapLines}
          loading={false}
          reviewThreads={diffMode === 'pr' ? reviewThreads : null}
          composers={composers}
          onRefetchThreads={onRefetchThreads}
          localComments={localComments}
          localWiring={localWiring}
          allowGithubComments={allowGithubComments}
          conflictedPaths={conflictedPaths}
          onTokenEnter={tokenHoverEnabled ? tokenHover.onTokenEnter : noopTokenEnter}
          onTokenLeave={tokenHoverEnabled ? tokenHover.onTokenLeave : noopTokenLeave}
        />
      </div>
      {/* PERF FIX (token-hover lift): lives here now (a GitTabBody sibling of
          DiffContentPane), not inside DiffContentPaneImpl — see the hook call
          above + DiffContentPaneProps' onTokenEnter/onTokenLeave doc
          comment. Setting-gated (default OFF): when disabled, DiffContentPane
          gets no-op handlers above and this popover doesn't mount at all. */}
      {tokenHoverEnabled && (
        <TokenHoverPopover
          state={tokenHover.state}
          onMouseEnter={tokenHover.cancelHide}
          onMouseLeave={tokenHover.scheduleHide}
        />
      )}
    </div>
  )
}

/** PERF FIX (LAG-LAYER #4): memoized — see DiffContentPane's own doc comment
 *  on why this firewalls unrelated parent re-renders (prDetail tick, PR/
 *  branch churn) from reaching the diff pane, on top of the tree-drag width
 *  no longer flowing through React state at all during an active drag. */
const GitTabBody = memo(GitTabBodyImpl)
