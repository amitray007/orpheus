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
// Live refresh: subscribes to `git:statusChanged` (src/main/git.ts's .git
// watcher — started unconditionally on terminal:mount, covers branch/index
// changes) AND `files:changed` (filesWatcher.ts — working-tree file
// create/edit/delete). git.ts's watcher alone is NOT enough: it only covers
// `.git/HEAD` + `.git/index`, so a bare file save never touches either and
// never fires it — the tab would only refresh incidentally (e.g. via a
// staging operation) and feel slow/stale for a plain edit.
//
// PERF FIX (this pass): GitTab now DRIVES filesWatcher.ts itself — starting
// the working-tree watch on mount and stopping it on unmount, exactly like
// FilesTab.tsx does (see its own watchStart/watchStop effect). This used to
// be explicitly disallowed here ("must NOT call files:watchStart, would
// fight the single-active invariant") because filesWatcher.ts allows only
// ONE active watcher app-wide. That reasoning no longer blocks this: the Git
// and Files tabs are mutually exclusive Workbench tabs (WorkbenchPanel mounts
// at most one of them at a time), so whichever one is active owns the
// single watcher slot for as long as it's shown, and there is never a moment
// both are mounted to contend over it. Unmount (tab switch, workspace
// change) always stops the watch it started, so the handoff to the other
// tab's own watchStart is clean.
//
// Combined with the idempotent applyDiff no-op below (diffSignature), this
// is what makes updates fast WITHOUT reintroducing the flicker loop that was
// just fixed: the watcher now fires promptly on a real change, but an
// unchanged git:diff result is still a complete no-op (no re-render).
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
//   FIX 3 — (superseded) a custom per-row "+N -M" count decoration was tried
//     and then explicitly reversed: the changed-files tree renders NO custom
//     row content at all now — just @pierre/trees' own native git-status
//     letter (U/M/A/D/R) via `setGitStatus`/`toTreeGitStatus`, see the
//     "Changed-files tree pane" section below for why.
//   FIX 4 — binary files (gitDiff.ts flags `binary: boolean`) never reach
//     <PatchDiff> (which would render a blank pane for one); the diff pane
//     instead renders the current image (via files:readImage) for image
//     extensions, or a "no preview" placeholder for other binary files. (The
//     changed-files ROW no longer shows a "Binary" label — see FIX 3 above —
//     this is the diff PANE's own binary handling only.)
//
// Phase 2 — edge states (docs/brainstorms/2026-07-06-git-tab-requirements.md
// states 1 "not a git repo" + 2 "clean/no changes"; mockup's Edge-states
// panel): `git:diff`'s result now carries a `repo: boolean` discriminator
// (src/shared/types.ts's GitDiffResult) so this component can tell "not a
// git repo" apart from "clean tree" — both previously resolved to the same
// empty `files: []}`. Three render branches: `!repo` → a centered empty
// state with a "Git init" button (calls the new `git:init` IPC, then
// explicitly refetches `git:diff` — the watcher may not pick up a brand-new
// `.git` dir immediately, so this doesn't rely on live-refresh); `repo &&
// files.length === 0` → a centered "No changes" empty state; otherwise the
// unchanged Phase-1 tree+diff view.
//
// Phase 3a — PR detection + slim header (docs/brainstorms/
// 2026-07-06-git-tab-requirements.md "Full-PR experience" → slim header;
// mockup's `.pr-header--slim`). `startGitWatch` (src/main/git.ts, started
// unconditionally on `terminal:mount` — see index.ts) resolves the current
// branch's PR via `getPrForBranch` and pushes it over `github:prChanged` —
// once on the initial watch registration, and again every time the branch
// changes (plus, as of the fetch-on-mount fix below, again on a re-mount).
// This component subscribes to `window.api.github.onPrChanged` (same pattern
// as its existing `git:statusChanged` subscription) and stores whatever
// arrives. `pr: null` (no PR / no `gh` / no remote / detached HEAD) renders
// the header as it did before this phase — the slim header is additive,
// gated entirely on `pr !== null`.
//
// BUG FIX (this pass) — fetch-on-mount fallback: the push above is a
// ONE-SHOT event that fires asynchronously at `terminal:mount` time, a
// window that's usually already closed by the time the user actually opens
// Workbench → Git (GitTab unmounts while its own sub-tab isn't active — see
// the module header's Gating note), so `pr` stayed null forever for a
// perfectly normal PR'd branch: the Details/Checks tabs, the [Working tree |
// PR diff] toggle, and inline review comments were all unreachable. The
// PR-detection effect below now ALSO calls `github:prForWorkspace` directly
// on mount/workspace-change (in addition to keeping the onPrChanged
// subscription, which still handles live updates while mounted) — see
// src/main/github.ts::getPrForWorkspace + src/shared/ipc.ts's own comment on
// this channel. Once this fetch sets `pr`, the existing prDetail/
// reviewThreads effects below (keyed on `pr.number`/`pr.state`) cascade
// exactly as they already did for a push-delivered `pr`.
//
// Slim header fields, matching the mockup's `renderPrHeader` 1:1: a colored
// status badge (open/draft/merged/closed → the app's own `--color-gh-*`
// tokens, reusing `PrChip`'s STATE_COLOR/STATE_LABEL rather than
// re-deriving a second copy), the PR title (clickable → `openPrUrl`, no
// separate link button/icon per the requirements doc), `#<number>`, and the
// branch. `GhPullRequest` doesn't carry a base-ref field (see
// shared/types.ts) — the doc explicitly allows "best-effort" here for 3a,
// so the arrow only renders when a base is available; today that's never,
// so it's just the branch chip alone until a future phase threads
// `baseRefName` through `getPrForBranch`. The existing worktree chip stays
// in the header row unchanged.
//
// Tab-strip growth: `[Diff | Commits]` becomes `[Diff | Commits | Details |
// Checks]` once `pr !== null` — Details/Checks are stubs this phase
// ("Coming soon" placeholders, same convention the Commits stub already
// uses); 3c/3d build their real content. No PR → the strip (and the rest of
// the tab) is completely unchanged from Phase 1/2.
//
// PR-header polish (this pass, live-QA follow-up) — two fixes:
//   FIX 1 — the sub-tab strip used to render a bare "local" pill (from
//     WorktreeChip) immediately left of [Diff|Commits|Details|Checks] for
//     every non-worktree workspace (the common case), reading as a stray
//     extra tab segment rather than a deliberate indicator. Root-caused to
//     WorktreeChip always rendering SOME text ("worktree · x" or "local")
//     instead of nothing when there's nothing notable to say — fixed by
//     having it render `null` for the non-worktree case (see its own doc
//     comment) rather than visually hiding/repositioning the same string.
//   FIX 2 — PrSlimHeader is now one full-width `flex flex-wrap` row (badge,
//     title, #id, branch chip+copy, worktree chip) instead of a cramped
//     top-left block with wasted width and a truncated title; a long title
//     wraps instead of ellipsizing. The branch chip grew a copy-icon button
//     (BranchCopyButton, mirroring git/CommitsTab.tsx's CommitShaCopyButton
//     copy/timeout-reset-to-check pattern). The worktree chip — now a no-op
//     for the common non-worktree case per Fix 1 — moved into this row
//     (after the branch chip) for the has-PR case; the no-PR case still
//     renders it (a no-op for non-worktrees) beside the sub-tab strip, since
//     there's no PR header row for it to live in there.
//
// Phase 3b foundation (this pass) — the three-parallel-agent split. The
// Commits/Details/Checks sub-tabs are now their OWN files under ./git/
// (CommitsTab.tsx / DetailsTab.tsx / ChecksTab.tsx), each a self-contained
// placeholder receiving `{ prDetail, workspaceId, branch }` as props — so a
// later pass can build out each tab's real content in parallel, with each
// agent editing only its own file (no shared-file collision with GitTab.tsx
// or with each other). This component's only new responsibility is fetching
// the rich `github:prDetail` payload (src/shared/types.ts's
// GhPullRequestDetail — meta, labels, assignees, reviews, milestone,
// commits[], checks[], general comments) into `prDetail` state and handing it
// down: once on PR detection/change (the existing `onPrChanged` push below
// already tells us a PR now exists or changed), and again whenever the
// working-tree diff refetches (mirrors the existing refresh cadence rather
// than adding a second poll loop — the IPC itself is cached server-side for
// 5 minutes, so this doesn't hammer `gh`). `prDetail` resets to null exactly
// where `pr` resets to null (workspace switch, PR loss) so a stale previous
// workspace's/PR's rich data never leaks into the new one.
//
// Phase 4-pre — PR-diff mode (this pass): the prerequisite for Phase 4a's
// inline PR review comments, which anchor to the PR DIFF (branch vs base),
// not the working-tree diff this component has rendered since Phase 1. Adds
// a `diffMode: 'working' | 'pr'` state and a [Working tree | PR diff]
// segmented toggle (DiffModeToggle), shown only once `pr !== null` (no PR ->
// no toggle, tab stays exactly as before). Both modes feed the SAME
// DiffTreePane/DiffContentPane — `git:prDiff` (src/main/gitDiff.ts's
// getPrDiff) returns the identical `GitDiffResult` shape `git:diff` does, by
// reusing this module's own splitPatchByFile/fileFromChunk parsers server-
// side (gh pr diff emits the same `diff --git` format). Refresh cadence
// differs deliberately by mode: working-tree mode keeps its existing
// git:statusChanged/files:changed debounce; PR-diff mode refetches on mode
// switch and on `github:prChanged` (a PR diff is base...head against
// committed history — a working-tree file save has no bearing on it, so
// it's NOT wired to files:changed, per the task's explicit "avoid churn"
// direction). A PR disappearing (branch switch/close) while PR-diff mode is
// active falls back to working-tree mode, same fallback pattern the
// Details/Checks sub-tabs already use for PR loss.
//
// Phase 4b — starting a comment (this pass): COMPOSE UI ONLY, no
// posting/network (that's Phase 4c). Adds the "add a comment" entry points
// on the PR diff (PR-diff mode only, same gating as 4a's read-only threads):
// a hover gutter "+" (@pierre/diffs' `enableGutterUtility` +
// `renderGutterUtility` + `onGutterUtilityClick`, see buildDiffOptions/
// GutterAddCommentButton below) and select-a-range-to-comment
// (`enableLineSelection` + `onLineSelected`, same buildDiffOptions — scoped
// to the FINAL committed selection, single-line-anchored via
// `anchorFromRange`'s end-of-range rule, see that function's own comment).
// Both open a "pending composer" (useReviewComposers.ts) rendered into the
// SAME `renderAnnotation` slot 4a's read-only threads use — `annotationsForFile`
// now merges GhReviewCommentThread[] (4a) and PendingComposer[] (4b) into one
// `ReviewAnnotationMeta` union, and `renderReviewCommentAnnotation` routes
// each to <ReviewCommentThread> or the new <CommentComposer> (git/
// CommentComposer.tsx) accordingly. Pending composers reset on file/mode/PR
// change (see the composer-reset effects near reviewComposers' declaration)
// since an in-progress draft anchored to a since-navigated-away-from
// file/line/PR has nothing left to anchor to. `CommentComposer`'s "Comment"
// button calls a still-stubbed `onSubmit` (GitTab's `submitReviewComment` —
// logs the draft and closes the composer) rather than posting anywhere;
// Phase 4c wires that to the real GitHub-post IPC.
//
// Phase 5 (this pass, live-QA follow-up) — two comment-UX fixes:
//   FIX 1 — LOCAL comments now work in WORKING-TREE mode too, not just
//     PR-diff mode. `composers`/`localWiring` are now passed to
//     DiffContentPane UNCONDITIONALLY (both modes) instead of only while
//     `diffMode === 'pr'` — the gutter "+"/select-to-comment affordance and
//     the local-comment cards (resolve/delete) now render on the
//     working-tree diff exactly like they already did on the PR diff.
//     GitHub comments stay PR-diff-only (`reviewThreads` is still `null` in
//     working-tree mode, unchanged) since they anchor to the PR, not the
//     working tree. The new `allowGithubComments` prop (`diffMode === 'pr'`)
//     gates whether the pending-composer's [GitHub | Local] SourceToggle
//     renders at all -- in working-tree mode there's no PR to post a GitHub
//     comment to, so the composer is local-only (no toggle) rather than
//     showing a toggle with a disabled/meaningless GitHub option.
//     `submitComment`'s dispatcher now also checks `diffModeRef` (not just
//     `commentSourceRef`) so a stale 'github' toggle selection carried over
//     from a previous PR-diff-mode session can never route a
//     working-tree-mode submit to `submitGithubReviewComment` (which has no
//     PR to post against there).
//   FIX 2 -- the gutter "+" is GitHub-style already (Pierre's
//     `renderGutterUtility` mounts ONE slot per file that the underlying
//     custom element repositions to track the currently-hovered row -- see
//     GutterAddCommentButton's doc comment) but LOOKED like an always-on
//     accent-filled pill rather than a subtle affordance that only reads as
//     "accented" on hover. CommentComposer.css's `.gcc-gutter-add` is now
//     subtle by default (muted icon, transparent bg) and only turns
//     accent-filled on `:hover`/`:focus-visible` of the button itself --
//     purely a CSS change, no positioning logic touched.
// ---------------------------------------------------------------------------

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { FileTree, useFileTree, useFileTreeSearch, useFileTreeSelection } from '@pierre/trees/react'
import { themeToTreeStyles, type TreeThemeInput } from '@pierre/trees'
import { PatchDiff } from '@pierre/diffs/react'
import {
  List,
  Rows,
  Columns,
  MagnifyingGlass,
  GitBranch,
  CheckCircle,
  GitMerge,
  GitPullRequest,
  Plus,
  X,
  Copy,
  Check
} from '@phosphor-icons/react'
import type {
  FileImage,
  GhPullRequest,
  GhPullRequestDetail,
  GhPullRequestState,
  GhReviewCommentThread,
  GitDiffFile,
  GitStatusEntry,
  LocalReviewComment
} from '@shared/types'
import type { DiffLineAnnotation, FileDiffOptions, SelectedLineRange } from '@pierre/diffs'
import { UI_STATE_DEFAULTS } from '@shared/uiStateDefaults'
import { Button } from '../Button'
import { useUiState, updateUiState } from '../../lib/uiStateStore'
import { openPrUrl } from '../../lib/overlayClient'
import { PIERRE_VIEWER_BG } from './editor/chromeTheme'
import { GitDiffOptionsPopover } from './GitDiffOptionsPopover'
import { useTreeWidthDrag, TREE_WIDTH_CSS_VAR } from './useTreeWidthDrag'
import { useImageZoomPan } from './useImageZoomPan'
import { ImageZoomBar } from './ImageZoomBar'
import { CommitsTab } from './git/CommitsTab'
import { DetailsTab } from './git/DetailsTab'
import { ChecksTab } from './git/ChecksTab'
import { ReviewCommentThread, LocalCommentThread } from './git/ReviewCommentThread'
import {
  CommentComposer,
  type CommentDraft,
  type CommentSource,
  type GhSubmitResult
} from './git/CommentComposer'
import { useReviewComposers, type PendingComposer } from './git/useReviewComposers'
import { preloadDiffHighlighter } from './diffHighlighterPreload'

// Same minimal dark ThemeLike shape FilesTab uses for its tree — kept as its
// own const (rather than importing FilesTab's) so this component doesn't
// couple to FilesTab's module for a plain data literal; the visual result is
// identical (§5.1 recommends one shared theme, but a duplicated small object
// is cheap and keeps the two tabs independently editable). `focusBorder` here
// does NOT by itself zero the selected-row focus ring — see FilesTab.tsx's
// TREE_THEME doc comment for the full chain writeup; the actual ring removal
// is the two `-override` CSS vars on TREE_GIT_STATUS_VARS below.
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
// comment for the override-chain rationale). Also carries the FOCUS-RING
// REMOVAL override vars (this pass) — see FilesTab.tsx's TREE_THEME doc
// comment for the full `focusBorder` → `list.focusOutline` →
// `--trees-theme-focus-ring` chain writeup on why `focusBorder` alone can't
// zero the ring and these two `-override` vars are the reliable mechanism.
// Both are needed: `--trees-focus-ring-color-override` for a focused-but-
// unselected row, `--trees-selected-focused-border-color-override` for a row
// that's both focused AND selected (the common case right after a click).
const TREE_GIT_STATUS_VARS = {
  '--trees-padding-inline-override': '0px',
  '--trees-git-added-color-override': '#3fb950',
  '--trees-git-modified-color-override': '#d29922',
  '--trees-git-deleted-color-override': '#f85149',
  '--trees-git-renamed-color-override': '#58a6ff',
  '--trees-git-untracked-color-override': '#6e7681',
  '--trees-focus-ring-color-override': 'transparent',
  '--trees-selected-focused-border-color-override': 'transparent'
} as const

const VIEWER_THEME = { dark: 'pierre-dark', light: 'pierre-light' } as const

// Crash fix #2 (belt-and-suspenders) — see buildDiffOptions' doc comment.
const DIFF_TOKENIZE_MAX_LINE_LENGTH = 1000

// Pierre-adoption Batch 1a — whole-diff byte cap (distinct from the per-LINE
// cap above). BaseCodeOptions.tokenizeMaxLength (confirmed in
// node_modules/@pierre/diffs/dist/types.d.ts:300) bounds the TOTAL bytes
// Pierre will tokenize with Shiki before falling back to plain (uncoloured)
// text for the rest — belt-and-suspenders alongside the OversizedDiffPlaceholder
// gate above `buildDiffOptions`' caller: that gate keeps genuinely huge patches
// out of <PatchDiff> entirely, while this handles the mid-size case (a
// large-but-ordinary-line-length file that's under the placeholder's
// byte/line thresholds but would still be a heavy synchronous tokenize pass).
// Pierre's own default (DEFAULT_TOKENIZE_MAX_LENGTH, dist/constants.js) is
// 100_000 bytes; 750_000 gives real-world diffs (a few thousand lines) full
// highlighting while still bailing out gracefully to plaintext well before
// the OversizedDiffPlaceholder's own much larger hard cap.
const DIFF_TOKENIZE_MAX_LENGTH = 750_000

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

export type DiffStyle = 'unified' | 'split'

/** Phase 4-pre — the Diff sub-tab's data-source mode: the uncommitted
 *  working-tree diff (default, unchanged from Phase 1) vs the full PR diff
 *  (base...head, via `gh pr diff`). See the module header's Phase 4-pre note. */
export type DiffMode = 'working' | 'pr'

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

// --- PR review-comment inline annotations (Phase 4a + 4b) --------------------

/** The annotation metadata union rendered into the SAME `renderAnnotation`
 *  slot (Phase 4b/4d): an existing GitHub thread (4a, read-only), a pending
 *  composer the user just opened via the gutter "+"/select-to-comment (4b),
 *  or a LOCAL (Orpheus-owned) review comment (4d — see reviewStore.ts's own
 *  header for the 3-source model this completes). `renderReviewCommentAnnotation`
 *  below routes on `kind`. */
export type ReviewAnnotationMeta =
  | { kind: 'thread'; thread: GhReviewCommentThread }
  | { kind: 'pending'; composer: PendingComposer }
  | { kind: 'local'; comment: LocalReviewComment }

/** Maps a GitHub review-comment thread onto Pierre's side-relative
 *  `DiffLineAnnotation` (see docs/learnings/pr-comments.md §Q2 "Mapping to
 *  Pierre's DiffLineAnnotation"): `RIGHT`→`additions`/`LEFT`→`deletions`
 *  (Pierre's `lineNumber` is side-relative — new-file for additions, old-file
 *  for deletions — matching GitHub's line/original_line semantics 1:1, no
 *  further transform needed), and `lineNumber` from the thread's own
 *  `line` (root comment's `line ?? originalLine`, already resolved
 *  server-side by groupReviewCommentsIntoThreads — see src/main/github.ts).
 *  A `subjectType: 'file'` thread (no per-line anchor) maps to `lineNumber: 0`
 *  per Pierre's own documented file-level-annotation convention
 *  (`dist/types.d.ts`'s doc comment on `DiffLineAnnotation`) — 4a doesn't
 *  special-case file-level comments beyond this placement; a future phase can
 *  render them distinctly if that reads better in practice. */
function threadToAnnotation(
  thread: GhReviewCommentThread
): DiffLineAnnotation<ReviewAnnotationMeta> {
  const lineNumber = thread.subjectType === 'file' ? 0 : (thread.line ?? 0)
  return {
    side: thread.side === 'LEFT' ? 'deletions' : 'additions',
    lineNumber,
    metadata: { kind: 'thread', thread }
  }
}

/** Maps an open pending composer (Phase 4b) onto the same annotation shape —
 *  `side`/`line` come straight from the composer's own anchor (set at
 *  gutter-"+"-click time, see `useReviewComposers`'s `open`), no `line ??
 *  originalLine` fallback needed since a pending composer is always anchored
 *  to a line actually rendered in the CURRENT PR diff (it can only be opened
 *  by clicking a line that's on screen right now). */
function composerToAnnotation(composer: PendingComposer): DiffLineAnnotation<ReviewAnnotationMeta> {
  return {
    side: composer.side === 'LEFT' ? 'deletions' : 'additions',
    lineNumber: composer.line,
    metadata: { kind: 'pending', composer }
  }
}

/** Phase 4d — maps a LOCAL review comment onto the same annotation shape.
 *  `side`/`line` come straight from the comment's own anchor (set at
 *  reviews:add time — see GitTab's addLocalComment); a null `line` (a
 *  file-level local comment, mirroring GhReviewCommentThread's `subjectType:
 *  'file'`) maps to `lineNumber: 0`, same convention threadToAnnotation above
 *  already uses for a file-level GitHub thread. A null `side` defaults to
 *  'additions' (RIGHT) — every local comment created via the current gutter-
 *  "+"/select-to-comment entry points always sets a real side, so this only
 *  matters for a hypothetical future file-level-only entry point. */
function localCommentToAnnotation(
  comment: LocalReviewComment
): DiffLineAnnotation<ReviewAnnotationMeta> {
  return {
    side: comment.side === 'LEFT' ? 'deletions' : 'additions',
    lineNumber: comment.line ?? 0,
    metadata: { kind: 'local', comment }
  }
}

/** Filters + merges the full thread list and the open pending composers down
 *  to ONE file's annotations — DiffContentPane renders one file's
 *  <PatchDiff> at a time, so this is recomputed per selected file (memoized
 *  by the caller). Threads with `line === null` AND `subjectType !== 'file'`
 *  (an outdated line-anchored comment with no `originalLine` fallback either
 *  — shouldn't happen per pr-comments.md's "original_line is never null"
 *  finding, but guarded defensively) are skipped rather than guessing
 *  lineNumber 0, which would misleadingly render them as file-level. */
function annotationsForFile(
  threads: readonly GhReviewCommentThread[],
  composers: readonly PendingComposer[],
  localComments: readonly LocalReviewComment[],
  path: string
): DiffLineAnnotation<ReviewAnnotationMeta>[] {
  const threadAnnotations = threads
    .filter((t) => t.path === path && (t.subjectType === 'file' || t.line !== null))
    .map(threadToAnnotation)
  const composerAnnotations = composers.filter((c) => c.path === path).map(composerToAnnotation)
  // Phase 4d: local comments merge into the SAME per-file annotation list as
  // GitHub threads/pending composers — completing the 3-source model inline
  // on the same diff (github-from-others / my-github / LOCAL).
  const localAnnotations = localComments
    .filter((c) => c.path === path)
    .map(localCommentToAnnotation)
  return [...threadAnnotations, ...composerAnnotations, ...localAnnotations]
}

// A composer with no wired onSubmit (shouldn't happen per the doc comment
// below, but keeps the optional-callback fallback honest about its own
// return type instead of silently resolving `undefined` where a
// `GhSubmitResult` is expected).
const NO_SUBMIT_WIRED: GhSubmitResult = { ok: false, error: 'Comment posting is not available' }

/** Phase 4d — the subset of local-comment wiring `renderReviewCommentAnnotation`
 *  needs to route a `kind: 'local'` annotation to its card, PLUS the
 *  [GitHub | Local] source-toggle state for the pending NEW-comment composer
 *  (a 'pending' annotation is also routed by this same function — see the
 *  'pending' branch below). Kept as its own small interface (rather than more
 *  loose optional params) so the growing parameter list stays readable —
 *  mirrors ReviewComposerWiring's own "named wiring bag" shape below. */
interface LocalCommentWiring {
  onToggleResolved: (comment: LocalReviewComment) => void
  onDelete: (comment: LocalReviewComment) => void
  commentSource: CommentSource
  onCommentSourceChange: (source: CommentSource) => void
}

/** Routes one merged annotation to its card: an existing GitHub thread (4a,
 *  read-only, with a Reply affordance as of 4c — see ReviewCommentThread.tsx),
 *  a pending composer (4b/4c), or a LOCAL review comment (4d — see
 *  reviewStore.ts's header for the 3-source model). `onCancelComposer`/
 *  `onSubmitComposer` are only ever actually invoked for a 'pending'
 *  annotation, which — per `annotationsForFile` — can only exist when
 *  DiffContentPane was given a real (non-null) `composers` wiring object in
 *  the first place; they're still typed as optional (rather than required)
 *  so callers in a context with no composers at all (there are none today,
 *  but this keeps the helper honest about what it needs) don't have to
 *  invent placeholder callbacks. Same optionality for `localWiring` — a
 *  'local' annotation can only exist once GitTab has fetched local comments
 *  at all, but the helper doesn't assume that. `workspaceId` is threaded
 *  through to ReviewCommentThread so its own Reply composer can post via
 *  github:replyToReviewComment + trigger the same onRefetch callback a
 *  new-comment post does. */
function renderReviewCommentAnnotation(
  annotation: DiffLineAnnotation<ReviewAnnotationMeta>,
  workspaceId: string,
  onRefetchThreads: () => void,
  onCancelComposer?: (id: string) => void,
  onSubmitComposer?: (draft: CommentDraft) => Promise<GhSubmitResult>,
  localWiring?: LocalCommentWiring,
  // Phase 5 FIX 1: whether the pending-composer's [GitHub | Local]
  // SourceToggle should render at all -- only true in PR-diff mode (there's
  // a PR to post a GitHub comment to). In working-tree mode this is false,
  // so `source`/`onSourceChange` are omitted entirely (both undefined) rather
  // than passed-but-pointless: CommentComposer already treats `source ===
  // undefined` as "no toggle, local-only composer" (see its own doc
  // comment) -- exactly the working-tree-mode UX this fix wants.
  allowGithub = false
): React.ReactNode {
  if (annotation.metadata.kind === 'pending') {
    const { composer } = annotation.metadata
    return (
      <CommentComposer
        draft={composer}
        onCancel={() => onCancelComposer?.(composer.id)}
        onSubmit={(draft) => onSubmitComposer?.(draft) ?? Promise.resolve(NO_SUBMIT_WIRED)}
        source={allowGithub ? localWiring?.commentSource : undefined}
        onSourceChange={allowGithub ? localWiring?.onCommentSourceChange : undefined}
      />
    )
  }
  if (annotation.metadata.kind === 'local') {
    const { comment } = annotation.metadata
    return (
      <LocalCommentThread
        comment={comment}
        onToggleResolved={(c) => localWiring?.onToggleResolved(c)}
        onDelete={(c) => localWiring?.onDelete(c)}
      />
    )
  }
  return (
    <ReviewCommentThread
      thread={annotation.metadata.thread}
      workspaceId={workspaceId}
      onReplyPosted={onRefetchThreads}
    />
  )
}

/** BUG FIX (this pass) — Pierre's `@pierre/diffs` has TWO mutually exclusive
 *  gutter-utility APIs, and the previous code set both at once: `options.
 *  onGutterUtilityClick` (a built-in, non-custom-render click handler) AND
 *  the React `renderGutterUtility` prop (a custom-render React node,
 *  auto-detected by the library and translated into `options.
 *  renderGutterUtility` — see `useFileDiffInstance.mergeFileDiffOptions` in
 *  @pierre/diffs' own source). `InteractionManager` throws "Cannot use both
 *  'onGutterUtilityClick' and 'renderGutterUtility'" the instant BOTH end up
 *  non-null in its resolved options — which happened on every PR-diff-mode
 *  render, crashing the whole app to the error boundary. This was dormant
 *  since Phase 4b introduced it: PR-diff mode was unreachable until this
 *  pass's `pr`-state fix made it reachable for the first time, so this
 *  latent crash never actually fired in practice until now.
 *
 *  FIX: since a custom React node IS wanted here (GutterAddCommentButton),
 *  only the `renderGutterUtility` prop is used — `onGutterUtilityClick`/
 *  `enableGutterUtility` are removed from buildDiffOptions entirely. The
 *  click itself is now wired directly on the button's own onClick, reading
 *  the currently-hovered line via the `getHoveredLine` accessor Pierre passes
 *  into `renderGutterUtility(getHoveredLine)` (see renderDiffChildren.tsx) —
 *  the same line/side data `onGutterUtilityClick`'s `SelectedLineRange`
 *  argument used to carry, just sourced from the render-prop's own accessor
 *  instead of a second parallel callback. */
function GutterAddCommentButton({
  getHoveredLine,
  onAdd
}: {
  getHoveredLine: () => { lineNumber: number; side: 'additions' | 'deletions' } | undefined
  onAdd: (lineNumber: number, side: 'additions' | 'deletions') => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="gcc-gutter-add"
      title="Add a comment on this line"
      tabIndex={-1}
      onClick={() => {
        const hovered = getHoveredLine()
        if (hovered) onAdd(hovered.lineNumber, hovered.side)
      }}
    >
      <Plus size={11} weight="bold" />
    </button>
  )
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
      {hasPr && seg('details', 'Details')}
      {hasPr && seg('checks', 'Checks')}
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

// --- Diff-mode segmented toggle (Phase 4-pre) --------------------------------

interface DiffModeToggleProps {
  value: DiffMode
  onChange: (mode: DiffMode) => void
}

/** [Working tree | PR diff] segmented control — only rendered by GitTab while
 *  a PR exists for the current branch (see the module header's Phase 4-pre
 *  note: PR review comments anchor to the PR diff, not the working-tree
 *  diff, so this toggle is the prerequisite for Phase 4a's inline comments).
 *  Matches SubTabStrip's compact pill-segment visual language rather than
 *  DiffStyleToggle's icon-only style — this needs readable labels, not icons,
 *  since "working tree" vs "PR diff" isn't obviously representable as a
 *  glyph pair. */
function DiffModeToggle({ value, onChange }: DiffModeToggleProps): React.JSX.Element {
  const seg = (mode: DiffMode, label: string): React.JSX.Element => (
    <button
      key={mode}
      type="button"
      onClick={() => onChange(mode)}
      aria-pressed={value === mode}
      className={[
        'px-2 py-0.5 rounded text-[11px] font-medium transition-colors duration-100',
        value === mode
          ? 'bg-surface-raised text-text-primary'
          : 'text-text-muted hover:text-text-secondary'
      ].join(' ')}
    >
      {label}
    </button>
  )
  return (
    <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-surface-overlay/60 border border-border-default/60">
      {seg('working', 'Working tree')}
      {seg('pr', 'PR diff')}
    </div>
  )
}

// --- Worktree chip ------------------------------------------------------------

/** "worktree · <branch>" — the app already tracks worktreeParentCwd/
 *  worktreeBranch per workspace (see WorkspaceTitleBar's own worktree chip),
 *  so this is pure presentation over props passed down from WorkspaceView, no
 *  new IPC needed.
 *
 *  BUG FIX (this pass) — the stray "local" pill: this component used to
 *  render a literal "local" pill for the (extremely common) main-checkout
 *  case, sitting in the sub-tab-strip row right next to
 *  [Diff|Commits|Details|Checks] — from a QA glance it read as a bogus extra
 *  segment glued onto the tab strip, not as a deliberate "this is not a
 *  worktree" indicator. Root cause: a worktree-vs-main-checkout distinction
 *  doesn't need an always-visible "local" pill to make its point — it only
 *  needs to say something when there IS something notable to say (i.e. this
 *  workspace IS an isolated worktree). So this now renders `null` entirely
 *  for the non-worktree case; only a genuine worktree gets a chip, which
 *  GitTab now places in the PR slim header row (Fix 2) — see PrSlimHeader —
 *  rather than in the sub-tab-strip row this used to occupy. */
function WorktreeChip({
  worktreeParentCwd,
  worktreeBranch
}: {
  worktreeParentCwd: string | null
  worktreeBranch: string | null
}): React.JSX.Element | null {
  if (worktreeParentCwd === null) return null
  return (
    <span
      title={`Worktree branch: ${worktreeBranch ?? 'unknown'}\nParent repo: ${worktreeParentCwd}`}
      className="flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium text-text-muted bg-surface-overlay/60 border border-border-default/60 select-none whitespace-nowrap"
    >
      {`worktree · ${worktreeBranch ?? '?'}`}
    </span>
  )
}

// --- Branch copy button --------------------------------------------------------

/** Copy-to-clipboard button for the PR header's branch chip — mirrors
 *  git/CommitsTab.tsx's `CommitShaCopyButton` pattern 1:1 (copy via
 *  `navigator.clipboard`, flip to a Check icon for ~1.2s, reset on unmount/
 *  re-click via the same cleanup-timer shape) rather than re-deriving a
 *  second copy-button implementation for a branch name instead of a SHA. */
function BranchCopyButton({ branch }: { branch: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(id)
  }, [copied])

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(branch)
      setCopied(true)
    } catch (err) {
      console.error('[GitTab] clipboard copy failed:', err)
    }
  }

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      aria-label={copied ? 'Copied branch name' : `Copy branch name ${branch}`}
      title={copied ? 'Copied' : 'Copy branch name'}
      className="p-0.5 rounded text-text-muted hover:text-text-primary transition-colors duration-150 cursor-pointer"
    >
      {copied ? (
        <Check size={10} weight="bold" className="text-emerald-400" />
      ) : (
        <Copy size={10} weight="bold" />
      )}
    </button>
  )
}

// --- PR slim header (Phase 3a) ------------------------------------------------

// Badge color/label/icon per PR state — same vocabulary PrChip.tsx already
// established (github/PrChip.tsx's STATE_COLOR/STATE_LABEL) for the sidebar/
// kanban/title-bar chip. Duplicated here as small literals rather than
// imported: PrChip's own component renders its OWN compact pill shape
// (rounded-full pixel badge, tokenized bg colors) that doesn't match the
// mockup's `.pr-badge` (solid color chip, white text, pill icon+label) this
// header specifically asks for — see docs/brainstorms/git-tab-mockup's
// `renderPrHeader`. Same "duplicated small literal, independently editable"
// rationale the module already applies to TREE_THEME/IMAGE_EXTENSIONS.
const PR_BADGE_BG: Record<GhPullRequestState, string> = {
  open: 'bg-gh-open',
  draft: 'bg-gh-draft',
  merged: 'bg-gh-merged',
  closed: 'bg-gh-closed'
}

const PR_BADGE_LABEL: Record<GhPullRequestState, string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed'
}

function PrBadgeIcon({ state }: { state: GhPullRequestState }): React.JSX.Element {
  if (state === 'merged') return <GitMerge size={11} weight="fill" />
  if (state === 'closed') return <X size={11} weight="bold" />
  return <GitPullRequest size={11} weight={state === 'draft' ? 'regular' : 'fill'} />
}

/** Full-PR slim header (requirements doc's "Full-PR experience" → slim
 *  header; mockup's `.pr-header--slim`/`renderPrHeader`): status badge, a
 *  clickable title (→ `openPrUrl`, no separate link button per the doc),
 *  `#<number>`, and the current branch. Rendered ABOVE the existing tab
 *  header row, only while a PR is detected for this branch — `pr === null`
 *  (no PR / no `gh` / no remote / detached HEAD) means this never mounts and
 *  the rest of the tab is visually unchanged from Phase 1/2.
 *
 *  Base branch: `GhPullRequest` (shared/types.ts) has no base-ref field
 *  today, so — per the doc's "keep 3a simple: branch shown; base
 *  best-effort" — this only shows the head branch; a future pass can thread
 *  `baseRefName` through `getPrForBranch` and add the mockup's
 *  `branch → base` arrow here without changing this component's shape.
 *
 *  REDESIGN (this pass) — full-width, wrapping single row. Previously this
 *  crammed [badge][title #id/branch two-line stack] into the top-left with a
 *  large empty expanse to the right of a `truncate`d title — on a long real
 *  PR title that meant the header wasted most of its width AND ellipsized
 *  the one thing (the title) a reviewer most wants to actually read in full.
 *  Now it's ONE `flex flex-wrap` row — badge, title, #id, branch chip (+copy),
 *  worktree chip — that fills the header's width and wraps to a second line
 *  when it doesn't fit, instead of truncating or overflowing. `gap-x`/`gap-y`
 *  give both the inline spacing and a sane row-gap once it wraps. The title
 *  is `min-w-0` + no `truncate`/`whitespace-nowrap` so long titles can break
 *  across lines like any other wrapped inline content, and it keeps its
 *  `openPrUrl` click/hover-underline behavior unchanged from before.
 *
 *  Worktree chip: moved here (Fix 1) from the sub-tab-strip row, where it
 *  used to render a bare "local" pill for the (common) main-checkout case —
 *  see WorktreeChip's own doc comment for the root-cause writeup. It's
 *  `null` for a main checkout, so nothing renders for the common case; a
 *  genuine worktree gets its chip placed after the branch chip, per the
 *  task's "place it sensibly in the row" direction. */
function PrSlimHeader({
  pr,
  branch,
  worktreeParentCwd,
  worktreeBranch
}: {
  pr: GhPullRequest
  branch: string | null
  worktreeParentCwd: string | null
  worktreeBranch: string | null
}): React.JSX.Element {
  return (
    <div className="flex-shrink-0 px-3.5 py-2.5 border-b border-border-default bg-surface-raised">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span
          className={`flex-shrink-0 inline-flex items-center gap-1 text-[10.5px] font-bold px-1.5 py-0.5 rounded-full text-white tracking-wide ${PR_BADGE_BG[pr.state]}`}
        >
          <PrBadgeIcon state={pr.state} />
          {PR_BADGE_LABEL[pr.state]}
        </span>
        <button
          type="button"
          onClick={() => openPrUrl(pr.url)}
          title="Open in browser"
          className="min-w-0 text-left text-[15px] font-semibold text-text-primary cursor-pointer hover:underline"
        >
          {pr.title}
        </button>
        <span className="flex-shrink-0 text-[11.5px] text-text-muted">#{pr.number}</span>
        {branch !== null && (
          <span className="flex-shrink-0 inline-flex items-center gap-1 font-mono text-[11px] px-1.5 py-0 rounded bg-surface-overlay border border-border-default text-text-secondary">
            {branch}
            <BranchCopyButton branch={branch} />
          </span>
        )}
        <WorktreeChip worktreeParentCwd={worktreeParentCwd} worktreeBranch={worktreeBranch} />
      </div>
    </div>
  )
}

// --- Changed-files tree pane ---------------------------------------------------

// Redesign (this pass, reversed per follow-up direction): the user first
// asked for a custom "+N -M" count decoration; then explicitly reversed that
// — drop the counts entirely and keep ONLY Pierre's own native git-status
// LETTER (the "U"/"M"/"A"/"D"/"R" the user actually wanted, "we had
// previously"). So this pane no longer injects any custom row content at
// all: no `renderRowDecoration`, no `unsafeCSS` lane styling, no "Binary"
// label. `setGitStatus(toTreeGitStatus(files))` below (already wired) is the
// ENTIRE mechanism — @pierre/trees renders that letter + a
// `data-item-git-status`-colored icon/row on its own
// (dist/render/FileTreeView.js's `getBuiltInGitStatusDecoration` /
// `GIT_STATUS_LABEL`), nothing else needed here. See git history on this
// file for the removed custom-decoration approach if it's ever revisited.
//
// The one unsafeCSS rule that DOES still need to be injected is unrelated to
// git-status rendering at all: it's Fix 2's search-icon-toggle visibility
// fix (see DiffTreeToolbar below) — @pierre/trees always mounts its
// `[data-file-tree-search-container]` box once `search: true` is passed,
// regardless of the controller's own isOpen state (same quirk FilesTab's
// TreePane works around), so this override keys the box's actual show/hide
// off the SAME `data-open` attribute the library stamps on it.
const SEARCH_BOX_VISIBILITY_CSS = `
  [data-file-tree-search-container][data-open="false"] {
    display: none;
  }
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

  const { model } = useFileTree({
    paths,
    initialExpansion: 'open',
    search: true,
    flattenEmptyDirectories: flattenEmptyDirs,
    unsafeCSS: SEARCH_BOX_VISIBILITY_CSS
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
  /** Phase 4a — PR review-comment threads for the CURRENTLY selected file
   *  only (already filtered by path), or null when annotations don't apply
   *  (working-tree mode, or no PR-diff comments loaded yet/failed). GitTab
   *  only ever passes a non-null list while `diffMode === 'pr'` — GitHub
   *  comments anchor to the PR diff, not the live working tree (see
   *  docs/learnings/pr-comments.md's Q1 gap note) — this stays PR-diff-only
   *  even after Phase 5's FIX 1 below. */
  reviewThreads: readonly GhReviewCommentThread[] | null
  /** Phase 4b — the "add a comment" affordance (gutter "+" + select-to-
   *  comment). `null` means "don't wire the affordance at all" (no diff
   *  loaded); a non-null value means it's ALWAYS available now (Phase 5 FIX
   *  1: previously PR-diff-mode-only, since a GitHub post has nothing to
   *  anchor to without a PR — but a LOCAL comment (reviews:add) needs no PR
   *  at all, so GitTab now passes this unconditionally in both modes; see
   *  `allowGithubComments` below for how the composer still knows whether
   *  GitHub is actually a valid destination). */
  composers: ReviewComposerWiring | null
  /** Phase 4c — refetches `reviewThreads` (GitTab's own `fetchReviewComments`
   *  helper, bound to `setReviewThreads`). Passed down to ReviewCommentThread
   *  via renderReviewCommentAnnotation so a successful Reply post refreshes
   *  the thread list the same way a new-comment post does. A no-op function
   *  in working-tree mode (nothing ever renders a thread there to reply to,
   *  so this is never actually invoked in that mode — kept required rather
   *  than optional so every call site is explicit about wiring it). */
  onRefetchThreads: () => void
  /** Phase 4d — LOCAL review comments for the CURRENTLY selected file only
   *  (GitTab passes the full per-workspace list; `annotationsForFile` filters
   *  by path the same way it already does for threads/composers). A plain
   *  array (never null) in EITHER mode as of Phase 5 FIX 1 — local comments
   *  have no PR requirement, so there's no "not applicable" state, only
   *  "empty so far", in both working-tree and PR-diff mode. */
  localComments: readonly LocalReviewComment[]
  /** Phase 4d — resolve/delete actions for a LOCAL comment's card, plus the
   *  source toggle wiring for the NEW-comment composer (GitHub vs Local —
   *  see CommentComposer.tsx's own SourceToggle). Phase 5 FIX 1: passed
   *  unconditionally now (both modes), same reasoning as `composers` above —
   *  `allowGithubComments` (not this being non-null) is what actually gates
   *  whether the SourceToggle itself renders. */
  localWiring: LocalCommentWiring | null
  /** Phase 5 FIX 1 — `diffMode === 'pr'`: whether GitHub is a valid
   *  destination for a NEW comment right now. Threaded down (rather than
   *  inferring it from `reviewThreads !== null`, which can legitimately be
   *  null in PR-diff mode too, e.g. a failed fetch) so
   *  renderReviewCommentAnnotation can omit the pending composer's [GitHub |
   *  Local] SourceToggle entirely in working-tree mode — there's no PR to
   *  post a GitHub comment to there, so the composer is local-only. */
  allowGithubComments: boolean
}

/** Phase 4b/4c — the subset of `useReviewComposers`'s result DiffContentPane
 *  needs, plus the submit callback (Phase 4c: now a real async post, see
 *  GitTab's `submitReviewComment`). Kept as its own small interface (rather
 *  than threading the whole hook result down) so this pane's prop surface
 *  only names what it actually uses. */
interface ReviewComposerWiring {
  composers: readonly PendingComposer[]
  open: (path: string, side: 'LEFT' | 'RIGHT', line: number) => void
  close: (id: string) => void
  onSubmit: (draft: CommentDraft) => Promise<GhSubmitResult>
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

/** Crash fix #1 — the default view for a `file.oversized` diff: a lightweight
 *  placeholder instead of feeding the full patch into the non-virtualized
 *  <PatchDiff> (which would materialize every line into shadow-DOM and
 *  Shiki-tokenize it synchronously, the whole-app OOM/crash root cause). `N
 *  lines` uses `additions + deletions` — already computed server-side from
 *  the full chunk, so this needs no client-side re-scan of the patch text.
 *  "Show anyway" hands control back to the caller for power users who want
 *  to pay the cost knowingly. */
function OversizedDiffPlaceholder({
  lineCount,
  onShowAnyway
}: {
  lineCount: number
  onShowAnyway: () => void
}): React.JSX.Element {
  return (
    <div
      className="flex-1 flex flex-col items-center justify-center min-h-0 gap-2"
      style={{ backgroundColor: PIERRE_VIEWER_BG }}
    >
      <span className="text-xs text-text-muted select-none">
        Large diff hidden — {lineCount.toLocaleString()} lines
      </span>
      <button
        type="button"
        onClick={onShowAnyway}
        className="text-xs text-accent hover:underline select-none"
      >
        Show anyway
      </button>
    </div>
  )
}

// --- Phase 2 edge states: not-a-repo (+ Git init) / clean ---------------------

/** Shared empty-state shell — centered icon + title + sub-line + optional
 *  action, matching the mockup's `.empty-state` (docs/brainstorms/
 *  git-tab-mockup/styles.css): centered column, muted 40px icon at 55%
 *  opacity, 13.5px title, 12px muted sub-line capped ~320px wide. Reuses
 *  PIERRE_VIEWER_BG so the edge states sit on the same dark viewer surface
 *  the diff pane itself uses, rather than introducing a third background. */
function EmptyStateShell({
  icon,
  title,
  subtitle,
  children
}: {
  icon: React.ReactNode
  title: string
  subtitle: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className="flex-1 flex flex-col items-center justify-center gap-2.5 min-h-0 px-10 text-center"
      style={{ backgroundColor: PIERRE_VIEWER_BG }}
    >
      <div className="text-text-muted opacity-55">{icon}</div>
      <div className="text-[13.5px] font-semibold text-text-primary">{title}</div>
      <div className="text-xs text-text-muted max-w-[320px]">{subtitle}</div>
      {children}
    </div>
  )
}

/** State 1 (mockup) — `!repo`: this workspace's cwd isn't a git working tree
 *  at all. A primary "Git init" button runs `git:init`, then the caller
 *  refetches `git:diff` explicitly (a brand-new `.git` may not be picked up
 *  by the existing watchers immediately — see the module header). Inline
 *  status text stands in for a toast (the app has no global toast/notice
 *  mechanism to reuse — see the module header's Phase 2 note); the button is
 *  disabled while the init call is in flight. */
function NotARepoState({
  onInit,
  running,
  error
}: {
  onInit: () => void
  running: boolean
  error: string | null
}): React.JSX.Element {
  return (
    <EmptyStateShell
      icon={<GitBranch size={40} weight="regular" />}
      title="Not a git repository"
      subtitle="This workspace's folder isn't tracked by git yet. Initialize a repository here to start tracking changes."
    >
      <Button size="sm" onClick={onInit} loading={running} disabled={running}>
        <GitBranch size={14} />
        Git init
      </Button>
      {error !== null && <span className="text-xs text-red-400 max-w-[320px]">{error}</span>}
    </EmptyStateShell>
  )
}

/** State 2 (mockup) — `repo && files.length === 0`: a real repo with a clean
 *  working tree. `branch` comes from the existing `git:statusChanged` push
 *  GitTab already subscribes to for live-refresh (no new IPC round-trip) —
 *  it's `null` until that first push arrives (or on a branch-less/detached
 *  HEAD repo), in which case this falls back to the branch-less "No changes"
 *  copy rather than blocking the empty state on one. */
function CleanState({ branch }: { branch: string | null }): React.JSX.Element {
  const title = branch !== null ? `No changes on ${branch}` : 'No changes'
  return (
    <EmptyStateShell
      icon={<CheckCircle size={40} weight="regular" />}
      title={title}
      subtitle="The working tree is clean. Nothing to review yet."
    />
  )
}

/** Phase 4-pre — PR-diff mode's own empty state: `files.length === 0` while
 *  viewing PR diff means the fetch itself came back empty (no PR / no gh /
 *  network failure — see gitDiff.ts::getPrDiff's safety-net note; a PR that
 *  genuinely has zero changed files can't exist on GitHub). Distinct copy
 *  from CleanState's "working tree is clean" — that phrasing would be
 *  actively misleading here, since the PR diff has nothing to do with the
 *  working tree at all. */
function PrDiffEmptyState(): React.JSX.Element {
  return (
    <EmptyStateShell
      icon={<GitPullRequest size={40} weight="regular" />}
      title="No PR diff available"
      subtitle="Couldn't load the PR's diff right now. Try switching back to Working tree, or check that `gh` is authenticated."
    />
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
 *  files:readImage has no revision parameter for).
 *
 *  FIX 2: reuses FilesTab's zoom/pan exactly (useImageZoomPan + ImageZoomBar,
 *  see FilesTab.tsx's ImageBody) rather than reimplementing it — same
 *  `useImageZoomPan(path)` keyed on path so zoom/pan resets whenever the
 *  selected file changes, same pan-container wiring (wheel/pointer handlers
 *  + `zoom.style` transform + `zoom.cursorClassName`), same floating
 *  `<ImageZoomBar>`. The non-image "Binary file — no preview" placeholder in
 *  DiffContentPane is untouched — this only applies to the image branch. */
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

  // Zoom/pan state resets whenever the viewed path changes — keyed on
  // `path` (not the loaded image), matching FilesTab's ImageBody comment on
  // why it's keyed on the SELECTION rather than the settled fetch.
  const zoom = useImageZoomPan(path)

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
      className={`relative flex-1 min-h-0 flex items-center justify-center overflow-hidden ${zoom.cursorClassName}`}
      style={{ backgroundColor: PIERRE_VIEWER_BG }}
      onWheel={zoom.onWheel}
      onPointerDown={zoom.onPointerDown}
      onPointerMove={zoom.onPointerMove}
      onPointerUp={zoom.onPointerUp}
      onPointerCancel={zoom.onPointerUp}
    >
      <img
        src={current.dataUrl}
        alt=""
        draggable={false}
        className="max-w-full max-h-full object-contain"
        style={zoom.style}
      />
      <ImageZoomBar zoom={zoom} />
    </div>
  )
}

/** Phase 4b — converts a Pierre `SelectedLineRange` (from `onLineSelected`'s
 *  select-a-range gesture) into the anchor a pending composer opens at.
 *  Scoped to SINGLE-LINE comments only, per the task's explicit fallback:
 *  "If range-comments are fiddly, single-line via the gutter '+' is the
 *  priority" — a multi-line selection (`start !== end`) opens its composer
 *  on the range's END line (matches GitHub's own "comment on lines X-Y"
 *  UX, which anchors the thread to the last line of the range), keeping
 *  the anchor itself always a single line/side pair rather than modeling a
 *  true range-comment (Pierre's own `SelectedLineRange` has no notion of
 *  "the comment's line" distinct from start/end — GitHub's `start_line`/
 *  `line` split is a server-side concept this UI doesn't need to model
 *  before Phase 4c actually posts anything). */
function anchorFromRange(range: SelectedLineRange): { line: number; side: 'LEFT' | 'RIGHT' } {
  const side = (range.endSide ?? range.side) === 'deletions' ? 'LEFT' : 'RIGHT'
  return { line: range.end, side }
}

/** Phase 4b — builds the BASE `options` object passed to <PatchDiff>: theme/
 *  diffStyle/overflow (unchanged since Phase 1) plus the crash-fix-#2
 *  tokenize cap. Extracted so DiffContentPane's own body doesn't inline this
 *  into the JSX (cognitive-complexity ceiling).
 *
 *  BUG FIX (this pass): the gutter-"+" click is now wired entirely through
 *  `renderGutterUtility`/`GutterAddCommentButton`'s own onClick (see that
 *  component's doc comment for the full root-cause writeup) — `options` no
 *  longer sets `enableGutterUtility`/`onGutterUtilityClick` at all, since
 *  those conflict with the `renderGutterUtility` React prop DiffContentPane
 *  also passes and crash @pierre/diffs' InteractionManager.
 *
 *  PERF FIX (LAG-LAYER #5): deliberately does NOT take `onLineSelected` as a
 *  parameter (it used to) — react-hooks' ref-safety lint rule flags passing
 *  a ref-closing callback into ANY function call during render, even one
 *  that never invokes it synchronously. The caller (DiffContentPaneImpl)
 *  instead spreads this function's return value into its OWN inline object
 *  literal inside `useMemo` and sets `onLineSelected` there directly — see
 *  its own comment. This function's return value still only depends on
 *  primitives (diffStyle/wrapLines/hasComposers), which is what lets the
 *  caller's memo actually recognize two calls as equal instead of always
 *  observing a new object and forcing a full diff DOM re-apply.
 *
 *  Pierre-adoption Batch 1a (docs/learnings/pierre-libraries.md,
 *  scratchpad/pierre-roadmap.json "quick-win" items) — four static option
 *  fields confirmed against node_modules/@pierre/diffs/dist/types.d.ts's
 *  `BaseDiffOptions`/`BaseCodeOptions` before adding (versions drift; every
 *  field name/value below was checked against the installed 1.2.12, not
 *  assumed from the README):
 *   - `lineDiffType: 'word-alt'` — CDP-verified (this pass) that Pierre
 *     already renders per-token intra-line highlighting on a MODIFIED line
 *     (an added/deleted line has no counterpart to diff against, so it's
 *     solid — that's correct, not a bug) even without this field set, since
 *     'word-alt' is BaseDiffOptions' own default. Set explicitly anyway so
 *     the choice is documented in code, not just inherited silently, and so
 *     a future Pierre version changing its default doesn't silently change
 *     Orpheus's rendering.
 *   - `tokenizeMaxLength: DIFF_TOKENIZE_MAX_LENGTH` — see that constant's own
 *     comment: a whole-diff byte cap distinct from `tokenizeMaxLineLength`
 *     above, belt-and-suspenders alongside (not a replacement for) the
 *     OversizedDiffPlaceholder gate the caller applies before this component
 *     ever mounts <PatchDiff>.
 *   - `diffIndicators: 'classic'` — GitHub-style +/-  glyphs in the gutter
 *     instead of the default 'bars' (a plain colored vertical bar with no
 *     glyph). Chosen over 'bars' because Orpheus's Git tab is explicitly a
 *     git-review surface where users already have a GitHub-diff mental
 *     model — the +/- glyph reads faster than a color-only bar at a glance,
 *     and CDP-verified (this pass) that 'classic' renders cleanly against
 *     the pierre-dark gutter background.
 *   - `hunkSeparators: 'line-info'` — KEPT (already the default) rather than
 *     changed, since 'line-info' is what renders the "N unmodified lines"
 *     collapsed-context band the task requires stay visible. Set explicitly
 *     for the same self-documentation reason as lineDiffType above.
 */
function buildDiffOptions(
  diffStyle: DiffStyle,
  wrapLines: boolean,
  hasComposers: boolean
): FileDiffOptions<ReviewAnnotationMeta> {
  const base: FileDiffOptions<ReviewAnnotationMeta> = {
    theme: VIEWER_THEME,
    themeType: 'dark',
    diffStyle,
    overflow: wrapLines ? 'wrap' : 'scroll',
    // Crash fix #2 (belt-and-suspenders) — the oversized-file gate above
    // already keeps genuinely huge patches out of <PatchDiff> entirely, but a
    // single extremely long line (a minified bundle's one-liner, still under
    // the oversized byte/line thresholds) would otherwise force a full
    // synchronous Shiki tokenize pass on that line. Cap it so Pierre falls
    // back to plaintext for any one line beyond this length instead.
    tokenizeMaxLineLength: DIFF_TOKENIZE_MAX_LINE_LENGTH,
    // Whole-diff cap — see DIFF_TOKENIZE_MAX_LENGTH's own comment.
    tokenizeMaxLength: DIFF_TOKENIZE_MAX_LENGTH,
    // Word/token-level intra-line diff highlighting — see this function's
    // own doc comment for why this is set explicitly despite matching the
    // library default.
    lineDiffType: 'word-alt',
    // GitHub-style +/- gutter glyphs — see this function's own doc comment.
    diffIndicators: 'classic',
    // Renders the "N unmodified lines" collapsed-context band — already the
    // library default; set explicitly for self-documentation.
    hunkSeparators: 'line-info'
  }
  if (!hasComposers) return base
  return {
    ...base,
    // Select-to-comment: scoped to reporting the FINAL committed selection
    // (`onLineSelected`, fired once per gesture) rather than every
    // in-progress tick (`onLineSelectionChange`) — opening a composer per
    // intermediate frame while the user is still dragging would be noisy
    // and would fight the "one composer per exact anchor" de-dupe in
    // useReviewComposers.open. A `null` range means the selection was
    // cleared (e.g. clicking elsewhere) — nothing to open. `onLineSelected`
    // itself is set by the caller (see this function's own doc comment on
    // why it can't be a parameter here).
    enableLineSelection: true
  }
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
 *  gets a plain "no preview" placeholder.
 *
 *  Phase 4b/5: the gutter "+"/select-to-comment affordance
 *  (renderGutterUtility + the select-to-comment option from
 *  buildDiffOptions) is wired whenever `composers` is non-null — as of
 *  Phase 5 FIX 1 that's BOTH modes (see DiffContentPaneProps' doc comment):
 *  working-tree mode gets a local-only composer, PR-diff mode gets the full
 *  [GitHub | Local] composer. See GutterAddCommentButton's doc comment for
 *  the bug fix (Phase 4c) to how the gutter "+" click itself is wired. */
/** PERF FIX (LAG-LAYER #5): every value this ref carries is read ONLY from
 *  inside the stable `onLineSelected` callback below (never during render),
 *  so `DiffContentPaneImpl` can build that callback ONCE (empty deps) instead
 *  of on every render — which in turn lets `buildDiffOptions`'s return value
 *  be memoized on plain primitives instead of always allocating a fresh
 *  `options` object (defeating Pierre's `areOptionsEqual` and forcing a full
 *  diff DOM re-apply). */
interface LatestSelectHandlerInputs {
  path: string
  composers: ReviewComposerWiring | null
}

function DiffContentPaneImpl({
  workspaceId,
  file,
  diffStyle,
  wrapLines,
  loading,
  reviewThreads,
  composers,
  onRefetchThreads,
  localComments,
  localWiring,
  allowGithubComments
}: DiffContentPaneProps): React.JSX.Element {
  // Crash fix #1 — per-file "show anyway" override for an oversized diff.
  // Lives here (not keyed to a single file, since DiffContentPane itself
  // isn't remounted per selection — only the inner <PatchDiff key={path}> is)
  // so switching away and back to an already-force-shown file doesn't ask
  // again within the same Git-tab session.
  const [shownAnyway, setShownAnyway] = useState<ReadonlySet<string>>(() => new Set())

  // PERF FIX (LAG-LAYER #5): the hooks below must run UNCONDITIONALLY on
  // every render (rules-of-hooks) — so they're hoisted above every early
  // return (loading/no-selection/binary/oversized), even though their
  // OUTPUT is only actually used by the plain-diff JSX at the bottom. This
  // is what lets `lineAnnotations`/`options` stay referentially stable
  // across an unrelated re-render (e.g. the tree-drag commit, prDetail
  // ticks) instead of forcing @pierre/diffs to re-apply the whole diff DOM.
  const path = file?.path ?? null
  const latestRef = useRef<LatestSelectHandlerInputs>({ path: path ?? '', composers })
  useEffect(() => {
    latestRef.current = { path: path ?? '', composers }
  })

  // Stable identity (empty deps) for the whole component lifetime — reads
  // the CURRENT path/composers off latestRef rather than closing over the
  // render's own values, so it never needs to be recreated.
  const onLineSelected = useCallback((range: SelectedLineRange | null) => {
    if (range === null) return
    const { composers: currentComposers, path: currentPath } = latestRef.current
    if (currentComposers === null) return
    const { line, side } = anchorFromRange(range)
    currentComposers.open(currentPath, side, line)
  }, [])

  // Phase 4a/4b/4d/5: only computed while EITHER reviewThreads is non-null
  // (PR-diff mode with a loaded/attempted GitHub comment fetch) OR
  // localWiring is non-null (now true in BOTH modes as of Phase 5 FIX 1) —
  // annotationsForFile itself returns [] for a file with no threads/
  // composers/local comments, which PatchDiff renders exactly like an
  // omitted lineAnnotations prop (a plain diff, no annotations). Memoized so
  // an unrelated re-render (tree-drag commit, prDetail poll tick) doesn't
  // reallocate a fresh (but content-equal) array every time — a fresh array
  // identity alone is enough to make @pierre/diffs treat annotations as
  // "changed" and re-apply the diff DOM.
  const showAnnotations = reviewThreads !== null || localWiring !== null
  const composerList = composers?.composers ?? EMPTY_COMPOSERS
  const lineAnnotations = useMemo(
    () =>
      showAnnotations && path !== null
        ? annotationsForFile(reviewThreads ?? [], composerList, localComments, path)
        : undefined,
    [showAnnotations, reviewThreads, composerList, localComments, path]
  )

  // Memoized on primitives + the composers-WIRING identity only — see
  // buildDiffOptions' own doc comment for why this is the fix for the
  // "fresh onLineSelected every render" forceRender bug. `onLineSelected` is
  // spread in via this OWN inline object literal (not passed as an argument
  // into buildDiffOptions) — react-hooks' ref-safety lint rule flags a
  // ref-closing callback passed into any function call during render, but
  // accepts it being placed directly into an object literal the same way a
  // DOM `ref` prop is accepted.
  const hasComposers = composers !== null
  const options = useMemo(() => {
    const base = buildDiffOptions(diffStyle, wrapLines, hasComposers)
    return hasComposers ? { ...base, onLineSelected } : base
  }, [diffStyle, wrapLines, hasComposers, onLineSelected])

  if (loading) return <DiffMessage text="Loading…" />
  if (file === null) return <DiffMessage text="Select a changed file to view its diff" />
  if (file.binary) {
    if (isImagePath(file.path)) {
      return <BinaryImageBody workspaceId={workspaceId} path={file.path} />
    }
    return <DiffMessage text="Binary file — no preview" />
  }
  if (file.oversized && !shownAnyway.has(file.path)) {
    return (
      <OversizedDiffPlaceholder
        lineCount={file.additions + file.deletions}
        onShowAnyway={() =>
          setShownAnyway((prev) => {
            const next = new Set(prev)
            next.add(file.path)
            return next
          })
        }
      />
    )
  }
  return (
    <div className="flex-1 min-h-0 overflow-auto" style={{ backgroundColor: PIERRE_VIEWER_BG }}>
      <PatchDiff
        key={file.path}
        patch={file.patch}
        options={options}
        lineAnnotations={lineAnnotations}
        renderAnnotation={(annotation) =>
          renderReviewCommentAnnotation(
            annotation,
            workspaceId,
            onRefetchThreads,
            composers?.close,
            composers?.onSubmit,
            localWiring ?? undefined,
            allowGithubComments
          )
        }
        renderGutterUtility={
          composers !== null
            ? (getHoveredLine) => (
                <GutterAddCommentButton
                  getHoveredLine={getHoveredLine}
                  onAdd={(lineNumber, side) =>
                    composers.open(file.path, side === 'deletions' ? 'LEFT' : 'RIGHT', lineNumber)
                  }
                />
              )
            : undefined
        }
      />
    </div>
  )
}

/** PERF FIX (LAG-LAYER #5) — a stable empty-array fallback for `composers?.
 *  composers` so `lineAnnotations`'s useMemo deps don't see a fresh `[]`
 *  identity every render when `composers` is null. */
const EMPTY_COMPOSERS: readonly PendingComposer[] = []

/** PERF FIX (LAG-LAYER #4/#5): memoized so an unrelated re-render one level
 *  up (prDetail poll tick, tree-drag width COMMIT on mouseup, branch churn)
 *  doesn't force @pierre/diffs to re-apply the entire (non-virtualized) diff
 *  DOM — React.memo's shallow prop comparison short-circuits the re-render
 *  entirely when every prop is referentially unchanged, which is now the
 *  common case since the props this pane receives are themselves stabilized
 *  in GitTab/GitTabBody. */
const DiffContentPane = memo(DiffContentPaneImpl)

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

/** A settled `git:diff` result, as GitTab needs it: the discriminator plus
 *  the files. Named separately from GitDiffResult so a network/IPC failure
 *  (caught below) can still produce a value of this shape — `repo: true`
 *  with an empty `files[]` is the deliberate "assume it's a repo, just
 *  couldn't read it right now" fallback, matching the old pre-Phase-2
 *  behavior of silently resolving to an empty diff on any failure. */
interface DiffSettleResult {
  repo: boolean
  files: GitDiffFile[]
}

// Loop-breaker (perf fix — see src/main/git.ts's statusSignature comment for
// the root cause): `git diff`/`git status` opportunistically rewrite
// `.git/index`'s stat-cache as a side effect of running them, which on some
// repos never "settles" — every read re-touches the index, re-firing the
// main-process watcher, pushing another `git:statusChanged`/`files:changed`
// event, scheduling another refetch, forever. src/main/git.ts now dedupes
// its OWN push on an unchanged status, which stops most of this at the
// source — but this signature is the renderer-side backstop: even if a
// refetch DOES fire (a real edit, a burst the main-process dedupe didn't
// catch, a future new event source), applying an IDENTICAL result is a
// no-op — no setFiles/setSelectedPath, so no re-render, no tree-flicker, no
// <PatchDiff> remount. A real change always produces a different signature
// (any changed patch text changes its own entry) and still applies.
//
// PERF FIX (LAG-LAYER #7): this used to concatenate every file's FULL patch
// TEXT into one giant string per settle (`path\x00status\x00patch`, joined by
// `\x01`) purely to build a comparison key — on a large diff that's a
// multi-MB string allocation on every debounced live-refresh, just to detect
// a no-op. `f.sig` (src/main/gitDiff.ts's fileFromChunk) is a cyrb53 content
// hash already computed ONCE per file in main over the exact same
// path+status+patch inputs, so combining those short per-file hashes here is
// O(files.length) string-building instead of O(total-diff-bytes) — same
// correctness (a same-length content edit still changes its file's hash, so
// still registers as a change; see gitDiff.ts's own doc comment for why this
// is a 53-bit hash, not 32-bit or length-only). The `\x00`/`\x01` separators
// are no longer needed (no raw patch text flows through this function
// anymore) but kept as the join delimiter for consistency/no-collision with
// any hash value itself.
function diffSignature(result: DiffSettleResult): string {
  if (!result.repo) return 'no-repo'
  return result.files.map((f) => f.sig).join('\x01')
}

/** Fetch the working-tree diff for `workspaceId`. Extracted so the debounced
 *  refetch effect below and the initial-load effect share one code path,
 *  keeping GitTab's own body under the cognitive-complexity ceiling. */
function fetchDiff(workspaceId: string, onSettled: (result: DiffSettleResult) => void): () => void {
  let cancelled = false
  window.api.git
    .diff(workspaceId)
    .then((result) => {
      if (!cancelled) onSettled({ repo: result.repo, files: result.files })
    })
    .catch((e) => {
      console.error('[GitTab] git:diff failed:', e)
      if (!cancelled) onSettled({ repo: true, files: [] })
    })
  return () => {
    cancelled = true
  }
}

/** Fetch the PR diff (Phase 4-pre) for `workspaceId` — same shape/contract as
 *  fetchDiff above, just backed by `git:prDiff` (gh pr diff <n>) instead of
 *  the working-tree `git:diff`. Kept as its own function (rather than a
 *  parameterized fetchDiff) so each mode's console-error label stays
 *  distinct and the mode-dispatch below reads as a plain if/else. */
function fetchPrDiff(
  workspaceId: string,
  onSettled: (result: DiffSettleResult) => void
): () => void {
  let cancelled = false
  window.api.git
    .prDiff(workspaceId)
    .then((result) => {
      if (!cancelled) onSettled({ repo: result.repo, files: result.files })
    })
    .catch((e) => {
      console.error('[GitTab] git:prDiff failed:', e)
      if (!cancelled) onSettled({ repo: true, files: [] })
    })
  return () => {
    cancelled = true
  }
}

/** Fetch review-comment threads (Phase 4a) for `workspaceId`'s current PR,
 *  reporting the settled value (or null on failure) via `onSettled`. Fire-
 *  and-forget by design (unlike fetchDiff/fetchPrDiff, callers here don't
 *  need a cancel token — this is only called from the onPrChanged event
 *  callback's "PR changed while already in PR-diff mode" branch, a single
 *  one-shot refetch, not a mount/dependency-driven effect that could race a
 *  cleanup). */
function fetchReviewComments(
  workspaceId: string,
  onSettled: (threads: GhReviewCommentThread[] | null) => void
): void {
  window.api.github
    .prReviewComments(workspaceId)
    .then(onSettled)
    .catch((e) => {
      console.error('[GitTab] github:prReviewComments failed:', e)
      onSettled(null)
    })
}

/** Phase 4d — fetch the LOCAL review-comment store's full list for
 *  `workspaceId`, reporting the settled value via `onSettled` (falls back to
 *  `[]` on failure — an empty list renders identically to "no local comments
 *  yet", never blocking the diff pane). Fire-and-forget, same shape as
 *  fetchReviewComments above (this is also only ever called as a one-shot
 *  refetch after a mutation or on workspace change, never inside a bare
 *  mount effect that needs its own cancel token). */
function fetchLocalReviews(
  workspaceId: string,
  onSettled: (comments: LocalReviewComment[]) => void
): void {
  window.api.reviews
    .list(workspaceId)
    .then(onSettled)
    .catch((e) => {
      console.error('[GitTab] reviews:list failed:', e)
      onSettled([])
    })
}

/** Diff-mode dispatcher — the [Working tree | PR diff] toggle's data-source
 *  switch (Phase 4-pre). Both branches share the exact same
 *  fetch/cancel/onSettled contract, so every call site (initial load, mode
 *  switch, live-refresh) can stay mode-agnostic by just calling this. */
function fetchForMode(
  mode: DiffMode,
  workspaceId: string,
  onSettled: (result: DiffSettleResult) => void
): () => void {
  return mode === 'pr' ? fetchPrDiff(workspaceId, onSettled) : fetchDiff(workspaceId, onSettled)
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
  // Phase 2: `repo` starts optimistic (`true`) so a first-paint flash of the
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
      <div className="h-8 flex-shrink-0 border-b border-border-default flex items-center px-1 gap-1">
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
  onSelectFile,
  onGitInit
}: GitTabBodyProps): React.JSX.Element {
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
        />
      </div>
    </div>
  )
}

/** PERF FIX (LAG-LAYER #4): memoized — see DiffContentPane's own doc comment
 *  on why this firewalls unrelated parent re-renders (prDetail tick, PR/
 *  branch churn) from reaching the diff pane, on top of the tree-drag width
 *  no longer flowing through React state at all during an active drag. */
const GitTabBody = memo(GitTabBodyImpl)
