// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/GitTab.tsx
//
// Workbench Git tab — a changed-files tree (left, @pierre/trees) + a per-file
// diff viewer (right, @pierre/diffs' <PatchDiff>), fed by `git:diff`/
// `git:prDiff` (src/main/gitDiff.ts). This root owns the diff-data state
// machine (files/selection/diffMode) and the PR-data state machine (pr/
// prDetail/reviewThreads/localReviews) plus every effect that fetches for
// them; the presentational pieces (PrSlimHeader, DiffControls, the review-
// annotation routing layer, DiffContentPane, the empty states, and the pure
// fetch/signature helpers) live under ./git/diff/ — see that folder for their
// own doc comments. GitTab.tsx is the only externally-imported symbol (see
// WorkbenchPanel.tsx).
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
  GhPullRequest,
  GhPullRequestDetail,
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
  TREE_DIR_GIT_CHANGE_CSS
} from './treeConfig'
import { CommitsTab } from './git/CommitsTab'
import { DetailsTab } from './git/DetailsTab'
import { ChecksTab } from './git/ChecksTab'
import { PrSlimHeader, WorktreeChip } from './git/diff/PrSlimHeader'
import { DiffStyleToggle, DiffModeToggle } from './git/diff/DiffControls'
import type { LocalCommentWiring } from './git/diff/reviewAnnotations'
import { DiffContentPane, DiffMessage, type ReviewComposerWiring } from './git/diff/DiffContentPane'
import { NotARepoState, CleanState, PrDiffEmptyState } from './git/diff/diffEmptyStates'
import {
  fetchConflicts,
  fetchDiff,
  fetchForMode,
  fetchLocalReviews,
  fetchPrDiff,
  fetchReviewComments,
  diffSignature,
  nextSelection,
  EMPTY_CONFLICTS,
  type DiffSettleResult
} from './git/diff/diffFetch'

// TREE_THEME + the host git-status/focus-ring CSS-var overrides now live in
// ./treeConfig.ts (shared with FilesTab.tsx — see that module's doc comment
// for the full override-chain writeup this used to carry inline here).
//
// VIEWER_THEME + the diff-options builder/tokenize caps now live in
// ./git/diff/DiffContentPane.tsx (Wave 3 Phase A extraction) alongside the
// rest of the diff-content-pane presentational surface.

// Live-refresh debounce — coalesces bursts from either push source (a save
// touching several files, a `git add -A`) into one git:diff refetch.
//
// Perf fix (this pass): GitTab now drives filesWatcher.ts itself (see the
// watchStart/watchStop effect below), so a working-tree create/edit fires
// `files:changed` immediately instead of waiting on git.ts's much coarser
// `.git/HEAD`+`.git/index` watch. Tuned down from the original 200ms to
// 130ms now that the fast path is wired — still enough to coalesce a burst
// of files:changed events from a multi-file save/`git add -A` into one
// git:diff round-trip, without feeling laggy. The idempotent applyDiff
// no-op (see diffSignature below) is what keeps this safe at rest — a
// shorter debounce just means a REAL change reaches the screen sooner, it
// doesn't reintroduce the flicker loop that fix addressed.
const REFRESH_DEBOUNCE_MS = 130

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
// pane already sends.
const SEARCH_BOX_VISIBILITY_CSS = `
  [data-file-tree-search-container][data-open="false"] {
    display: none;
  }
  ${TREE_DIR_GIT_CHANGE_CSS}
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

  const [files, setFiles] = useState<GitDiffFile[]>([])
  // Pierre adoption batch 4 (safe/read-only slice) — repo-relative paths
  // currently reported as merge-conflicted, from the new read-only
  // `git:conflicts` IPC (see src/main/git.ts's getConflictedPaths). Fetched
  // alongside the working-tree diff (initial load + the same debounced
  // git:statusChanged/files:changed refresh below) and threaded down to
  // DiffContentPane so it can gate its ConflictDiffPane branch. Empty
  // (EMPTY_CONFLICTS — see its own doc comment) in the ordinary case — no
  // live conflict in the repo.
  const [conflictedPaths, setConflictedPaths] = useState<ReadonlySet<string>>(EMPTY_CONFLICTS)
  // "Not a git repository" empty state doesn't show for an ordinary repo
  // while the initial git:diff round-trip is still in flight — `loading`
  // below already gates the tree/diff panes on the same round-trip, so this
  // mirrors that convention rather than introducing a third loading state.
  const [repo, setRepo] = useState(true)
  const [loading, setLoading] = useState(true)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [treeOpen, setTreeOpen] = useState(true)
  const [diffStyle, setDiffStyle] = useState<DiffStyle>('unified')
  // Phase 4-pre: the Diff sub-tab's data-source mode — 'working' (default,
  // unchanged Phase 1 behavior) or 'pr' (gh pr diff, gated on a PR existing —
  // see the module header's Phase 4-pre note). Reset to 'working' on every
  // workspace switch (below) so a PR-diff view never survives into a
  // different workspace that may have no PR at all.
  const [diffMode, setDiffMode] = useState<DiffMode>('working')
  const [subTab, setSubTab] = useState<GitSubTab>('diff')
  const [branch, setBranch] = useState<string | null>(null)
  const [gitInitRunning, setGitInitRunning] = useState(false)
  const [gitInitError, setGitInitError] = useState<string | null>(null)
  // Phase 3a: the PR for the current branch, or null (no PR / no `gh` / no
  // remote / detached HEAD). Populated by BOTH the `github:prChanged` push
  // (live updates while mounted) AND a direct `github:prForWorkspace` fetch
  // on mount/workspace-change (the bug fix — see the module header's "BUG
  // FIX (this pass)" note for why the push alone isn't reliable).
  const [pr, setPr] = useState<GhPullRequest | null>(null)
  // Phase 3b foundation: the rich PR payload (GhPullRequestDetail) backing
  // the Commits/Details/Checks sub-tabs — see the module header's "Phase 3b
  // foundation" note. Null until fetched (or when there's no PR at all).
  const [prDetail, setPrDetail] = useState<GhPullRequestDetail | null>(null)
  // Phase 4a: line-anchored PR review-comment threads, fetched only while
  // `diffMode === 'pr'` (comments anchor to the PR diff, not the working
  // tree — see docs/learnings/pr-comments.md's Q1 gap note). `null` means
  // "not applicable / not yet loaded" (working-tree mode, or before the
  // first PR-diff-mode fetch settles) — DiffContentPane treats null the
  // same as "no annotations" so a failed/pending fetch never blocks the
  // diff itself from rendering.
  const [reviewThreads, setReviewThreads] = useState<GhReviewCommentThread[] | null>(null)
  // Phase 4d: the LOCAL (Orpheus-owned) review-comment store's full list for
  // this workspace — see reviewStore.ts's own header. Unlike reviewThreads,
  // this is a plain array (never null): local comments have no PR
  // requirement, so there's no "not applicable" state, only "empty so far".
  // Fetched on workspace change (below) and refetched after every local
  // mutation (add/resolve/delete — see refetchLocalReviews).
  const [localReviews, setLocalReviews] = useState<LocalReviewComment[]>([])
  // Phase 4d: the NEW-comment composer's [GitHub | Local] source toggle —
  // app-session state (not persisted), defaults to 'github' since that's the
  // pre-4d behavior every existing composer already has. Lives in GitTab
  // (not the composer itself) so it survives a composer being closed/
  // reopened at a different line within the same session, matching how
  // diffStyle/diffMode are already lifted up rather than kept per-composer.
  // Phase 5: the toggle itself only ever RENDERS in PR-diff mode
  // (`allowGithubComments`/`allowGithub` gating in renderReviewCommentAnnotation)
  // — this value can still carry a stale 'github' selection across a mode
  // flip since it's not reset on `diffMode` change, which is exactly why
  // `submitComment` below ALSO checks `diffModeRef` rather than trusting
  // this alone.
  const [commentSource, setCommentSource] = useState<CommentSource>('github')
  // Phase 4b: open "start a comment" composers (gutter "+"/select-to-comment)
  // — see useReviewComposers.ts's own header. Reset alongside reviewThreads
  // at every point below that clears it (workspace switch, PR loss, leaving
  // PR-diff mode) PLUS on file/mode change specifically (the task's "Reset
  // pending composers on file/mode/PR change") since an open composer
  // anchored to file A's line 12 has no meaning once the user has navigated
  // to file B — see the file-change effect below.
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

  // Fix 1: every settled `files[]` (initial load AND live-refresh refetch)
  // runs through nextSelection so the tab auto-selects the first changed
  // file when nothing is selected (or the prior selection dropped out),
  // while preserving an existing selection that's still present. Wraps
  // `setFiles`/`setRepo` so every call site below gets this for free, rather
  // than repeating the selection-derivation at each of the two settle points.
  //
  // Perf fix — idempotent by signature (see diffSignature's comment): a
  // settled result IDENTICAL to what's already applied is a no-op — skips
  // setRepo/setFiles/setSelectedPath entirely so `files`/the selected file
  // keep their EXISTING object identity across a redundant refetch (nothing
  // downstream re-renders or remounts). `lastAppliedSigRef` starts `null` so
  // the very first settle always applies (there's nothing to compare yet).
  const lastAppliedSigRef = useRef<string | null>(null)
  const applyDiff = useCallback((result: DiffSettleResult) => {
    const sig = diffSignature(result)
    if (sig === lastAppliedSigRef.current) return
    lastAppliedSigRef.current = sig
    setRepo(result.repo)
    setFiles(result.files)
    setSelectedPath((prev) => nextSelection(result.files, prev))
  }, [])

  // Phase 4-pre: tracks which `diffMode` was last fetched, so the mode-switch
  // effect (below the workspace-change effect) can tell "the user actually
  // flipped the toggle" apart from "diffMode just got reset to 'working' as
  // a side effect of a workspace switch" — see that effect's own comment for
  // why the distinction matters (double-fetch avoidance).
  const lastFetchedModeForWorkspaceRef = useRef<DiffMode>('working')

  // Initial load + workspace change. Resets files/selectedPath alongside
  // loading — otherwise DiffTreePane/DiffContentPane would briefly render the
  // PREVIOUS workspace's changed files/diff (loading=true but stale `files`)
  // until the new workspace's git:diff settles (CodeRabbit finding, fixed).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: a workspace switch must show "Loading…" (with no stale prior-workspace data) immediately rather than waiting; the settled result arrives asynchronously via fetchDiff's callback below.
    setLoading(true)
    setFiles([])
    setSelectedPath(null)
    setGitInitError(null)
    // A new workspace always starts back on the working-tree view — a
    // PR-diff selection from the PREVIOUS workspace has no guarantee the new
    // one even has a PR (see the module header's Phase 4-pre note); the
    // toggle itself won't render until this workspace's own PR-detection
    // settles, so falling back here keeps the state consistent with what's
    // visible.
    setDiffMode('working')
    // A new workspace starts with no known PR until its own
    // `github:prChanged` push arrives (see the subscription effect below) —
    // otherwise a switch from a PR'd workspace to a non-PR one would keep
    // showing the PREVIOUS workspace's slim header/tab-strip growth.
    setPr(null)
    // Same reset for the rich PR-detail payload (Phase 3b foundation) — a
    // new workspace's Commits/Details/Checks tabs must not render the
    // PREVIOUS workspace's PR data while the fresh prDetail fetch (below,
    // keyed off `pr`) is still in flight.
    setPrDetail(null)
    // Phase 4a: same reset for review-comment threads — a new workspace's
    // PR-diff mode (if it even has a PR) must not render the PREVIOUS
    // workspace's stale comment threads while its own fetch is in flight.
    setReviewThreads(null)
    // Phase 4d: same reset for the LOCAL review-comment store — a new
    // workspace's local comments are fetched fresh below (unlike
    // reviewThreads, this has no PR dependency, so it's unconditional here
    // rather than gated behind the PR-detection push).
    setLocalReviews([])
    // Pierre adoption batch 4 — same reset for the conflict-detection set: a
    // new workspace's conflicted-paths list is fetched fresh below (unlike
    // reviewThreads, this has no PR dependency, so it's unconditional here).
    setConflictedPaths(new Set())
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
    setSubTab((prev) => (prev === 'details' || prev === 'checks' ? 'diff' : prev))
    // A new workspace has nothing in common with whatever signature the
    // PREVIOUS workspace last applied — reset so applyDiff can't mistake a
    // coincidentally-identical result (e.g. two different clean repos both
    // signature to the same "no changes" value) for a no-op and skip
    // applying the new workspace's (already correct, just-reset-above)
    // state. Purely a correctness/future-proofing reset; harmless either way
    // since files/selectedPath were already reset directly above.
    lastAppliedSigRef.current = null
    // Guards the mode-switch effect below from re-firing its own redundant
    // fetch for this same workspace-change tick — see that effect's comment.
    lastFetchedModeForWorkspaceRef.current = 'working'
    // Phase 4d: fetch the new workspace's local review comments — no PR
    // dependency (unlike reviewThreads), so this fires unconditionally on
    // every workspace switch rather than waiting on a PR-detection push.
    fetchLocalReviews(workspaceId, setLocalReviews)
    // Pierre adoption batch 4 — fetch the new workspace's conflicted-paths
    // list. Working-tree-only (see fetchConflicts' own doc comment) — safe to
    // fire unconditionally here since a fresh workspace always starts back in
    // 'working' mode (set above).
    fetchConflicts(workspaceId, setConflictedPaths)
    return fetchDiff(workspaceId, (result) => {
      applyDiff(result)
      setLoading(false)
    })
  }, [workspaceId, applyDiff, resetComposers])

  // Phase 4-pre: refetch whenever the [Working tree | PR diff] toggle
  // switches mode. Deliberately its own effect (not folded into the
  // workspace-change effect above) so switching modes on the SAME workspace
  // doesn't also reset pr/prDetail/subTab — only the diff data itself needs
  // to change.
  //
  // `lastFetchedModeForWorkspaceRef` guards against a redundant duplicate
  // fetch: the workspace-change effect above already fetches 'working' mode
  // (and resets `diffMode` to 'working') as part of handling a workspace
  // switch, so without this guard, EVERY workspace switch would ALSO trigger
  // this effect (since `diffMode` may be transitioning pr -> working) and
  // fire a second, redundant git:diff round-trip. The guard tracks which
  // mode was last fetched for the CURRENT workspace/mode pair and skips a
  // repeat.
  useEffect(() => {
    if (lastFetchedModeForWorkspaceRef.current === diffMode) return undefined
    lastFetchedModeForWorkspaceRef.current = diffMode
    // Intentional: switching modes must show "Loading…" (with no stale
    // prior-mode data) immediately; the settled result arrives asynchronously
    // via fetchForMode's callback below. (No eslint-disable needed here — the
    // early-return guard above means this isn't the unconditional
    // top-of-effect setState the react-hooks/set-state-in-effect rule flags.)
    setLoading(true)
    setFiles([])
    setSelectedPath(null)
    // Phase 4b: a mode flip (working <-> pr) invalidates any open composers
    // — working-tree mode can't show them at all (no PR to anchor to), and
    // entering PR-diff mode fresh has no composers of its own yet.
    resetComposers()
    lastAppliedSigRef.current = null
    // Pierre adoption batch 4 — conflict detection is working-tree-only (see
    // fetchConflicts' own doc comment): entering PR-diff mode clears the set
    // (a PR diff's files can never match a working-tree conflicted path
    // anyway); switching back to working-tree mode refetches it fresh.
    setConflictedPaths(new Set())
    if (diffMode !== 'pr') fetchConflicts(workspaceId, setConflictedPaths)
    return fetchForMode(diffMode, workspaceId, (result) => {
      applyDiff(result)
      setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- workspaceId intentionally excluded: this effect's guard already re-derives correctly on a workspace change (the workspace-change effect above sets the ref to 'working' in the same tick it resets diffMode to 'working', so this effect sees a no-op match and skips, exactly as intended).
  }, [diffMode])

  // Working-tree watcher (src/main/filesWatcher.ts) — see the module header's
  // PERF FIX note. Mirrors FilesTab.tsx's own watchStart/watchStop effect
  // exactly: start the main-process watch on mount (or workspaceId change),
  // stop it on unmount, same .catch-only error handling (a failed
  // start/stop here just means live-refresh degrades to the git.ts-only
  // signal, not a crash). GitTab is only ever mounted while it's the active
  // Workbench tab (see the module header's Gating note), so this start/stop
  // is exactly scoped to "while the Git tab is showing" — same lifecycle
  // FilesTab uses for "while the Files tab is showing". The two tabs being
  // mutually exclusive is what makes both safely calling watchStart/watchStop
  // non-conflicting: at most one of them is ever mounted at a time, so at
  // most one of them ever holds filesWatcher's single-active slot.
  useEffect(() => {
    window.api.files
      .watchStart(workspaceId)
      .catch((e) => console.error('[GitTab] watchStart failed:', e))
    return () => {
      window.api.files
        .watchStop(workspaceId)
        .catch((e) => console.error('[GitTab] watchStop failed:', e))
    }
  }, [workspaceId])

  // Live refresh: git:statusChanged (branch/index change — src/main/git.ts's
  // .git watcher, already running unconditionally since terminal:mount) and
  // files:changed (working-tree edits — filesWatcher.ts, now driven by THIS
  // tab via the watchStart/watchStop effect above) both indicate the working
  // TREE may have moved; refetch git:diff, debounced so a burst of either
  // collapses into one round-trip.
  //
  // Phase 4-pre: deliberately WORKING-TREE-ONLY. A PR diff is `base...head`
  // against already-committed history — neither a working-tree file save nor
  // the local index changing has any bearing on it (see the module header's
  // Phase 4-pre note: "don't wire PR-diff to files:changed, avoid churn").
  // `diffModeRef` (kept in sync below, same "latest value without an effect
  // dependency" pattern the existing `prRef` below uses) lets this callback
  // check the CURRENT mode without resubscribing/restarting the debounce
  // timer on every toggle flip.
  const diffModeRef = useRef(diffMode)
  useEffect(() => {
    diffModeRef.current = diffMode
  }, [diffMode])
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  // PERF FIX (LAG-LAYER #9): `prDetail`'s own onStatusChanged refresh used to
  // be a SEPARATE subscription (see the module header's old "Phase 3b
  // foundation" comment, now folded in below) — two independent listeners on
  // the same event meant every real status change did double dispatch work.
  // Collapsed into this ONE onStatusChanged listener: one filter, one
  // cleanup. prDetail refresh is debounced on its OWN timer (not folded into
  // scheduleRefetch's timer) and fires OUTSIDE the `diffModeRef` guard —
  // it must run in BOTH diff modes (a PR's checks/commits can update while
  // viewing PR-diff mode too), unlike the diff refetch which is
  // working-tree-only. `prRef` (kept in sync just below) lets it skip the
  // network round-trip entirely when there's no PR to refresh.
  const prRef = useRef(pr)
  useEffect(() => {
    prRef.current = pr
  }, [pr])
  const prDetailDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const scheduleRefetch = (): void => {
      if (diffModeRef.current !== 'working') return
      if (debounceRef.current !== null) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null
        cleanupRef.current?.()
        cleanupRef.current = fetchDiff(workspaceId, applyDiff)
        // Pierre adoption batch 4 — refresh the conflict-detection set on the
        // SAME debounced tick as the diff refetch above (a status/file change
        // that moves the diff may also resolve or introduce a conflict).
        // Already gated working-tree-only by this function's own early return.
        fetchConflicts(workspaceId, setConflictedPaths)
      }, REFRESH_DEBOUNCE_MS)
    }
    const scheduleRefreshPrDetail = (): void => {
      if (prRef.current === null) return
      if (prDetailDebounceRef.current !== null) clearTimeout(prDetailDebounceRef.current)
      prDetailDebounceRef.current = setTimeout(() => {
        prDetailDebounceRef.current = null
        window.api.github
          .prDetail(workspaceId)
          .then(setPrDetail)
          .catch((e2) => console.error('[GitTab] github:prDetail refresh failed:', e2))
      }, REFRESH_DEBOUNCE_MS)
    }
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
      if (debounceRef.current !== null) clearTimeout(debounceRef.current)
      if (prDetailDebounceRef.current !== null) clearTimeout(prDetailDebounceRef.current)
      cleanupRef.current?.()
      cleanupRef.current = null
    }
  }, [workspaceId, applyDiff])

  // BUG FIX (this pass): fetch-on-mount fallback for `pr` — see the module
  // header's "BUG FIX" note for the full root-cause writeup. `startGitWatch`'s
  // initial `github:prChanged` push (subscribed to just below) is a ONE-SHOT
  // event fired asynchronously at `terminal:mount` time; by the time the user
  // actually navigates to the Git sub-tab (GitTab is unmounted until then —
  // see the module header's Gating note) that push has almost always already
  // fired, so the subscription below is registered too late to ever catch it
  // and `pr` stayed null forever. This effect calls `github:prForWorkspace`
  // directly on mount and on every workspace change, in ADDITION to the
  // subscription (which still owns live updates while mounted — a branch
  // switch or PR update while the tab is open). Guarded against
  // setState-after-unmount the same way fetchDiff/fetchPrDiff above are;
  // deliberately does NOT reset `pr` to null itself on cleanup — the
  // workspace-change effect already does that reset synchronously (so no
  // stale-previous-workspace flash), and a fast unmount/remount here should
  // just let the next mount's own fetch settle rather than racing a clear.
  useEffect(() => {
    let cancelled = false
    window.api.github
      .prForWorkspace(workspaceId)
      .then((fetchedPr) => {
        if (cancelled) return
        // Race guard: `onPrChanged`'s live subscription (below) may resolve
        // a fresher, real PR before this slower fetch settles (both hit the
        // same cwd/branch, but the push can win the race) — never let this
        // fetch clobber an already-set non-null `pr` back to null. A genuine
        // PR-loss (branch switch, close) is still handled by the push's own
        // `e.pr === null` branch below, which this guard doesn't touch.
        setPr((prev) => (prev !== null && fetchedPr === null ? prev : fetchedPr))
      })
      .catch((e) => {
        console.error('[GitTab] github:prForWorkspace failed:', e)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  // Phase 3a: PR detection. `startGitWatch` (src/main/git.ts, running
  // unconditionally since terminal:mount) already resolves the current
  // branch's PR and pushes it over `github:prChanged` — once on initial
  // watch registration, again on every branch change, and again on a
  // re-mount (self-heal fix, same pass) — subscribed to here for LIVE
  // updates while mounted; the fetch-on-mount effect above covers the
  // one-shot-push-already-fired gap this subscription alone can't. Filtered
  // to this workspace the same way the git:statusChanged/files:changed
  // subscriptions above are.
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
        // (inside this event callback) rather than in the prDetail-fetch
        // effect below, for the same cascading-render reason noted above.
        setPrDetail(null)
        // Phase 4-pre: the PR-diff toggle is about to unmount out from under
        // the user for the same reason the Details/Checks tabs are above —
        // fall back to the working-tree view rather than leaving `diffMode`
        // pointed at 'pr' with no PR left to diff against. The mode-switch
        // effect (which owns fetching) reacts to this state change on its
        // own; no fetch call needed here.
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
        // previous one's stale diff. The mode-switch effect's own `diffMode`
        // dependency won't re-fire here (the mode itself didn't change), so
        // this is the one place that needs an explicit refetch call for this
        // case.
        cleanupRef.current?.()
        cleanupRef.current = fetchPrDiff(workspaceId, applyDiff)
        // Phase 4a: same "PR changed while already in PR-diff mode" case —
        // the review-comment threads belong to the OLD PR, refetch for the
        // new/updated one. Mirrors the diff refetch just above.
        fetchReviewComments(workspaceId, setReviewThreads)
      }
    })
  }, [workspaceId, applyDiff, resetComposers])

  // Phase 4a: fetch (or clear) review-comment threads on entering/leaving
  // PR-diff mode. Deliberately its own effect (not folded into the
  // mode-switch effect above, which owns the DIFF fetch) so a PR-diff-mode
  // refetch of the diff itself doesn't also need to know about comments —
  // this just tracks `diffMode`/`pr` directly. `diffMode !== 'pr'` clears
  // threads to null (working-tree mode never shows annotations — comments
  // anchor to the PR diff, not the live working tree, per
  // docs/learnings/pr-comments.md's Q1 gap note) rather than leaving a stale
  // PR-diff-mode fetch around for a mode the user just switched away from.
  //
  // `reviewThreadsClearedRef` guards the "clear" branch's setState so it's
  // not an unconditional top-of-effect call (react-hooks/set-state-in-effect
  // flags that shape) — it only actually clears once per non-PR-diff
  // stretch, mirroring the mode-switch effect's own early-return-guard
  // pattern above.
  const reviewThreadsClearedRef = useRef(true)
  useEffect(() => {
    if (diffMode !== 'pr' || pr === null) {
      if (!reviewThreadsClearedRef.current) {
        reviewThreadsClearedRef.current = true
        setReviewThreads(null)
      }
      return undefined
    }
    reviewThreadsClearedRef.current = false
    let cancelled = false
    window.api.github
      .prReviewComments(workspaceId)
      .then((threads) => {
        if (!cancelled) setReviewThreads(threads)
      })
      .catch((e) => {
        console.error('[GitTab] github:prReviewComments failed:', e)
        if (!cancelled) setReviewThreads(null)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally keyed on the PRIMITIVE pr?.number rather than the whole `pr` object, same rationale as the prDetail-fetch effect above: onPrChanged may push a referentially-new-but-equal PR on every branch-watch tick, and this effect must not refetch on those no-op pushes.
  }, [workspaceId, diffMode, pr?.number])

  // Phase 3b foundation: fetch the rich `github:prDetail` payload backing the
  // Commits/Details/Checks sub-tabs (see the module header's "Phase 3b
  // foundation" note) whenever a PR exists for this workspace/branch —
  // re-runs on `pr.number`/`pr.state` change (a new/updated PR, e.g. after a
  // branch switch or a merge/close) rather than on the whole `pr` object
  // reference, since `onPrChanged` above may push an equivalent-but-new
  // object on every branch-watch tick. The `pr === null` case needs no work
  // here at all — `prDetail` is already cleared synchronously wherever `pr`
  // itself is cleared (the workspace-switch reset above, and the
  // onPrChanged(null) branch above), so this effect simply has nothing to
  // fetch and skips straight to a no-op cleanup (avoids a setState-in-effect
  // lint error from clearing it a second time here).
  useEffect(() => {
    if (pr === null) return undefined
    let cancelled = false
    window.api.github
      .prDetail(workspaceId)
      .then((detail) => {
        if (!cancelled) setPrDetail(detail)
      })
      .catch((e) => {
        console.error('[GitTab] github:prDetail failed:', e)
        if (!cancelled) setPrDetail(null)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally keyed on the PRIMITIVE pr?.number/pr?.state rather than the whole `pr` object: onPrChanged (above) may push a referentially-new-but-equal PR on every branch-watch tick, and this effect must not refetch prDetail on those no-op pushes.
  }, [workspaceId, pr?.number, pr?.state])

  // PERF FIX (LAG-LAYER #9): prDetail's own status-driven refresh used to be
  // a second, independent `git:statusChanged` subscription here — it's now
  // folded into the single onStatusChanged listener above (see that effect's
  // own doc comment); `prRef` is declared there too since both the diff- and
  // prDetail-refresh callbacks need the SAME "latest pr without an effect
  // dependency" ref.

  // Phase 2 Git-init: runs git:init, then — regardless of outcome — clears
  // the running flag; on success, explicitly refetches git:diff (a brand-new
  // `.git` dir may not be picked up by the existing watchers immediately, so
  // this doesn't rely on live-refresh) which naturally moves the tab into
  // the clean-state render branch once `repo` flips true with empty `files`.
  const runGitInit = useCallback(() => {
    setGitInitRunning(true)
    setGitInitError(null)
    window.api.git
      .init(workspaceId)
      .then((result) => {
        if (result.ok) {
          cleanupRef.current?.()
          cleanupRef.current = fetchDiff(workspaceId, applyDiff)
        } else {
          setGitInitError(result.error)
        }
      })
      .catch((e) => {
        console.error('[GitTab] git:init failed:', e)
        setGitInitError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        setGitInitRunning(false)
      })
  }, [workspaceId, applyDiff])

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

  // Phase 4c: shared refetch-on-success callback — both a new-comment post
  // (submitGithubReviewComment below) and a Reply post (ReviewCommentThread's
  // own composer, via renderReviewCommentAnnotation's onRefetchThreads) need
  // to refresh reviewThreads after a successful write so the just-posted
  // comment/reply shows up as part of its thread immediately. Reuses the
  // existing fetchReviewComments one-shot helper (defined above, alongside
  // fetchDiff/fetchPrDiff) rather than duplicating its .then/.catch shape.
  const refetchReviewThreads = useCallback(() => {
    fetchReviewComments(workspaceId, setReviewThreads)
  }, [workspaceId])

  // Phase 4d: same "refetch after a successful write" callback for the LOCAL
  // review-comment store — add/resolve/delete all need localReviews to
  // reflect the just-applied mutation immediately rather than waiting for
  // the next incidental refresh (there is no live-refresh/push channel for
  // this local, mutation-driven data — see reviewStore.ts's header).
  const refetchLocalReviews = useCallback(() => {
    fetchLocalReviews(workspaceId, setLocalReviews)
  }, [workspaceId])

  // Phase 4c: same "refetch after a successful write" callback for the
  // Details tab's general-comment composer — a successful github:
  // postGeneralComment needs prDetail.comments.general to include the new
  // comment so it shows up in the timeline immediately. Direct one-shot
  // fetch (not wrapped in its own named helper like fetchReviewComments)
  // since this is the only caller.
  const refetchPrDetail = useCallback(() => {
    window.api.github
      .prDetail(workspaceId)
      .then(setPrDetail)
      .catch((e) => console.error('[GitTab] github:prDetail refetch failed:', e))
  }, [workspaceId])

  // Phase 4c: posts a NEW line-anchored review comment for real, via
  // github:postReviewComment. `commitId` is the PR's head commit sha — taken
  // from `prDetail.commits` (gh returns them oldest-first, confirmed live:
  // `commits[commits.length - 1].oid === headRefOid`), so the comment
  // anchors to the SAME commit the PR diff currently being viewed is
  // rendered against. Left undefined when prDetail/commits haven't loaded
  // yet (rare — PR-diff mode implies a PR exists, so prDetail is normally
  // already populated by the time a composer can even open); the main
  // process resolves its own live head sha in that case (see
  // resolvePrWriteContext in src/main/github.ts), so omitting it here still
  // succeeds rather than failing outright.
  //
  // On success: close the composer (removes it from openComposers) AND
  // refetch reviewThreads so the newly-posted comment appears as a thread
  // immediately, rather than waiting for the next incidental refresh. On
  // failure: return the result as-is so CommentComposer keeps the composer
  // open with the typed body + shows the inline error (never silently
  // swallowed) — closeComposer/refetch are NOT called on failure, matching
  // the task's "composer stays with the text so the user can retry".
  const submitGithubReviewComment = useCallback(
    async (draft: CommentDraft): Promise<GhSubmitResult> => {
      const headOid = prDetail?.commits[prDetail.commits.length - 1]?.oid
      const result = await window.api.github.postReviewComment({
        workspaceId,
        path: draft.path,
        line: draft.line,
        side: draft.side,
        body: draft.body,
        commitId: headOid
      })
      if (!result.ok) return result
      closeComposer(draft.id)
      refetchReviewThreads()
      return { ok: true }
    },
    [workspaceId, prDetail, closeComposer, refetchReviewThreads]
  )

  // Phase 4d: saves a NEW comment to the LOCAL store instead of posting to
  // GitHub — the [GitHub | Local] source toggle's 'local' branch. reviews:add
  // is total (a plain SQLite insert — see reviewStore.ts), so this can't fail
  // the way a `gh` network call can; still wrapped in the SAME
  // Promise<GhSubmitResult> contract CommentComposer expects (so it's a
  // drop-in alternative to submitGithubReviewComment, not a special case the
  // composer needs to know about) with a .catch belt-and-suspenders for an
  // unexpected IPC failure. `prNumber` is threaded from `pr` (Phase 3a) so a
  // local comment made while viewing a PR's diff records which PR it was
  // made against — even though local comments don't require one.
  const submitLocalComment = useCallback(
    async (draft: CommentDraft): Promise<GhSubmitResult> => {
      try {
        await window.api.reviews.add({
          workspaceId,
          prNumber: pr?.number ?? null,
          path: draft.path,
          line: draft.line,
          startLine: draft.startLine ?? null,
          side: draft.side,
          body: draft.body
        })
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
      closeComposer(draft.id)
      refetchLocalReviews()
      return { ok: true }
    },
    [workspaceId, pr, closeComposer, refetchLocalReviews]
  )

  // Phase 4d: the NEW-comment composer's submit dispatcher — routes to
  // whichever store the [GitHub | Local] toggle currently points at.
  // `commentSourceRef` (kept in sync below) lets this read the CURRENT
  // toggle value without needing it as a dependency of every composer-open
  // closure — same "latest value via ref" pattern the file already uses for
  // diffModeRef/prRef.
  //
  // Phase 5 FIX 1: also consults `diffModeRef` — working-tree mode's
  // composer never renders the SourceToggle at all (see
  // renderReviewCommentAnnotation's `allowGithub` gating), but
  // `commentSource` is app-session state that can carry a stale 'github'
  // value over from a PRIOR PR-diff-mode session on the same workspace (the
  // toggle isn't reset just because the mode flipped — see its own
  // declaration comment). Without this check, submitting a working-tree
  // composer right after leaving PR-diff mode with 'github' selected would
  // silently attempt `submitGithubReviewComment` against a mode with no PR
  // diff open. `diffModeRef.current !== 'pr'` always forces the local path,
  // regardless of the toggle's last value.
  const commentSourceRef = useRef(commentSource)
  useEffect(() => {
    commentSourceRef.current = commentSource
  }, [commentSource])
  const submitComment = useCallback(
    (draft: CommentDraft): Promise<GhSubmitResult> =>
      diffModeRef.current !== 'pr' || commentSourceRef.current === 'local'
        ? submitLocalComment(draft)
        : submitGithubReviewComment(draft),
    [submitLocalComment, submitGithubReviewComment]
  )

  // Phase 4d: resolve-toggle + delete for a LOCAL comment's card — both
  // mutate via the reviewStore IPCs then refetch, mirroring
  // submitLocalComment's own refetch-on-success convention.
  const toggleLocalResolved = useCallback(
    (comment: LocalReviewComment) => {
      window.api.reviews
        .setResolved(comment.id, !comment.resolved)
        .then(refetchLocalReviews)
        .catch((e) => console.error('[GitTab] reviews:setResolved failed:', e))
    },
    [refetchLocalReviews]
  )
  const deleteLocalComment = useCallback(
    (comment: LocalReviewComment) => {
      window.api.reviews
        .delete(comment.id)
        .then(refetchLocalReviews)
        .catch((e) => console.error('[GitTab] reviews:delete failed:', e))
    },
    [refetchLocalReviews]
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
  // (resolve/delete) plus the source-toggle state/setter for the pending
  // NEW-comment composer — see LocalCommentWiring's own doc comment.
  const localCommentWiring: LocalCommentWiring = useMemo(
    () => ({
      onToggleResolved: toggleLocalResolved,
      onDelete: deleteLocalComment,
      commentSource,
      onCommentSourceChange: setCommentSource
    }),
    [toggleLocalResolved, deleteLocalComment, commentSource]
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
  const diffOptions = useMemo(
    () => ({ wrapLines, flattenEmptyDirs }),
    [wrapLines, flattenEmptyDirs]
  )
  const setDiffOptions = useCallback((next: { wrapLines: boolean; flattenEmptyDirs: boolean }) => {
    updateUiState({
      gitDiffWrapLines: next.wrapLines,
      filesFlattenEmptyDirs: next.flattenEmptyDirs
    })
  }, [])

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
  const tokenHover = useTokenHoverPopover()

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
          onTokenEnter={tokenHover.onTokenEnter}
          onTokenLeave={tokenHover.onTokenLeave}
        />
      </div>
      {/* PERF FIX (token-hover lift): lives here now (a GitTabBody sibling of
          DiffContentPane), not inside DiffContentPaneImpl — see the hook call
          above + DiffContentPaneProps' onTokenEnter/onTokenLeave doc
          comment. */}
      <TokenHoverPopover
        state={tokenHover.state}
        onMouseEnter={tokenHover.cancelHide}
        onMouseLeave={tokenHover.scheduleHide}
      />
    </div>
  )
}

/** PERF FIX (LAG-LAYER #4): memoized — see DiffContentPane's own doc comment
 *  on why this firewalls unrelated parent re-renders (prDetail tick, PR/
 *  branch churn) from reaching the diff pane, on top of the tree-drag width
 *  no longer flowing through React state at all during an active drag. */
const GitTabBody = memo(GitTabBodyImpl)
