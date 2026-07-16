// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/git/diff/renderReviewCommentAnnotation.tsx
//
// GitTab's PR review-comment annotation router (Phase 4a/4b/4d) — extracted
// verbatim from GitTab.tsx (Wave 3 Phase A structural extraction). Split
// into its own file (rather than sharing one with GutterAddCommentButton)
// because this repo's `react-refresh/only-export-components` lint rule
// requires a component file export ONLY components — `renderFoo`-style
// JSX-returning routing functions don't count as components by that rule's
// naming heuristic, so mixing one with a real PascalCase component in the
// same file breaks Fast Refresh for that file. The pure merge/mapping logic
// (ReviewAnnotationMeta, annotationsForFile, LocalCommentWiring) lives in the
// sibling reviewAnnotations.ts.
// ---------------------------------------------------------------------------

import type React from 'react'
import type { DiffLineAnnotation } from '@pierre/diffs'
import { ReviewCommentThread, LocalCommentThread } from '../ReviewCommentThread'
import {
  CommentComposer,
  type CommentDraft,
  type CommentSource,
  type GhSubmitResult
} from '../CommentComposer'
import type { LocalCommentWiring, ReviewAnnotationMeta } from './reviewAnnotations'

// A composer with no wired onSubmit (shouldn't happen per the doc comment
// below, but keeps the optional-callback fallback honest about its own
// return type instead of silently resolving `undefined` where a
// `GhSubmitResult` is expected).
const NO_SUBMIT_WIRED: GhSubmitResult = { ok: false, error: 'Comment posting is not available' }

/** Routes one merged annotation to its card: an existing GitHub thread (4a,
 *  read-only, with a Reply affordance as of 4c — see ReviewCommentThread.tsx),
 *  a pending composer (4b/4c), or a LOCAL review comment (4d — see
 *  reviewStore.ts's header for the 3-source model). `onCancelComposer`/
 *  `onSubmitComposer` are only ever actually invoked for a 'pending'
 *  annotation, which — per `annotationsForFile` (reviewAnnotations.ts) — can
 *  only exist when DiffContentPane was given a real (non-null) `composers`
 *  wiring object in the first place; they're still typed as optional (rather
 *  than required) so callers in a context with no composers at all (there
 *  are none today, but this keeps the helper honest about what it needs)
 *  don't have to invent placeholder callbacks. Same optionality for
 *  `localWiring` — a 'local' annotation can only exist once GitTab has
 *  fetched local comments at all, but the helper doesn't assume that.
 *  `workspaceId` is threaded through to ReviewCommentThread so its own Reply
 *  composer can post via github:replyToReviewComment + trigger the same
 *  onRefetch callback a new-comment post does. */
export function renderReviewCommentAnnotation(
  annotation: DiffLineAnnotation<ReviewAnnotationMeta>,
  workspaceId: string,
  onRefetchThreads: () => void,
  onCancelComposer?: (id: string) => void,
  onSubmitComposer?: (draft: CommentDraft, source: CommentSource) => Promise<GhSubmitResult>,
  localWiring?: LocalCommentWiring,
  // Phase 5: whether the pending-composer's dual [GitHub] Comment/[Local]
  // Comment BUTTONS should both render (`CommentComposer`'s `allowGithub`
  // prop) -- only true in PR-diff mode (there's a PR to post a GitHub
  // comment to). In working-tree mode this is false, so the composer falls
  // back to its single-button UI (submits with source 'local' — see
  // CommentComposer.tsx's own doc comment) -- exactly the working-tree-mode
  // UX this fix wants.
  allowGithub = false
): React.ReactNode {
  if (annotation.metadata.kind === 'pending') {
    const { composer } = annotation.metadata
    return (
      <CommentComposer
        draft={composer}
        onCancel={() => onCancelComposer?.(composer.id)}
        onSubmit={(draft, source) =>
          onSubmitComposer?.(draft, source) ?? Promise.resolve(NO_SUBMIT_WIRED)
        }
        allowGithub={allowGithub}
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
