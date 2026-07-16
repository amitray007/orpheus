// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/git/diff/reviewAnnotations.ts
//
// GitTab's PR review-comment inline-annotation MERGE logic (Phase 4a/4b/4d)
// — extracted verbatim from GitTab.tsx (Wave 3 Phase A structural
// extraction). Pure, non-JSX logic only: this repo's
// `react-refresh/only-export-components` lint rule requires a component file
// (.tsx) export ONLY components, so this stays a plain `.ts` module — the
// JSX-producing routing layer (renderReviewCommentAnnotation,
// GutterAddCommentButton) lives in the sibling reviewAnnotationRenderers.tsx
// (mirrors useReviewComposers.ts/CommentComposer.tsx's own hook/component
// split for the same reason).
//
// ReviewAnnotationMeta — the annotation metadata union rendered into the
// SAME `renderAnnotation` slot: an existing GitHub thread (4a, read-only), a
// pending composer the user just opened via the gutter "+"/select-to-comment
// (4b), or a LOCAL (Orpheus-owned) review comment (4d — see reviewStore.ts's
// own header for the 3-source model this completes).
// threadToAnnotation/composerToAnnotation/localCommentToAnnotation — map each
// source onto Pierre's side-relative `DiffLineAnnotation`.
// annotationsForFile — filters + merges all three sources down to ONE file's
// annotations (DiffContentPane renders one file's <PatchDiff> at a time).
// LocalCommentWiring — the subset of local-comment wiring
// renderReviewCommentAnnotation needs, plus the [GitHub | Local] source-
// toggle state for the pending NEW-comment composer.
// ---------------------------------------------------------------------------

import type { GhReviewCommentThread, LocalReviewComment } from '@shared/types'
import type { DiffLineAnnotation } from '@pierre/diffs'
import type { PendingComposer } from '../useReviewComposers'

// --- PR review-comment inline annotations (Phase 4a + 4b) --------------------

/** The annotation metadata union rendered into the SAME `renderAnnotation`
 *  slot (Phase 4b/4d): an existing GitHub thread (4a, read-only), a pending
 *  composer the user just opened via the gutter "+"/select-to-comment (4b),
 *  or a LOCAL (Orpheus-owned) review comment (4d — see reviewStore.ts's own
 *  header for the 3-source model this completes). `renderReviewCommentAnnotation`
 *  (reviewAnnotationRenderers.tsx) routes on `kind`. */
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
export function annotationsForFile(
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

/** Phase 4d — the subset of local-comment wiring `renderReviewCommentAnnotation`
 *  needs to route a `kind: 'local'` annotation to its card. Kept as its own
 *  small interface (rather than more loose optional params) so the growing
 *  parameter list stays readable — mirrors ReviewComposerWiring's own "named
 *  wiring bag" shape in DiffContentPane.tsx.
 *
 *  Phase 5: no longer carries the [GitHub | Local] source-toggle state —
 *  removed entirely (see CommentComposer.tsx's module header for the
 *  3-button redesign that replaced it; the pending-composer's destination is
 *  now decided by WHICH button the user clicks, not a separately-tracked
 *  toggle value). */
export interface LocalCommentWiring {
  onToggleResolved: (comment: LocalReviewComment) => void
  onDelete: (comment: LocalReviewComment) => void
}
