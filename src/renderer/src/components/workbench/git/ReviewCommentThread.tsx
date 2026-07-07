// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/git/ReviewCommentThread.tsx
//
// Workbench Git tab — Phase 4a built the inline GitHub-style comment-thread
// card rendered by @pierre/diffs' `renderAnnotation` on the PR diff
// (GitTab.tsx's DiffContentPane, PR-diff mode only). Phase 4c (this pass)
// adds the one write affordance this read-only card gets: a "Reply" button
// at the bottom of the thread that opens a CommentComposer posting via
// github:replyToReviewComment. There is still no resolve/collapse/edit
// affordance — those remain out of scope.
//
// Reusable by design (kept as its own file, not inlined into GitTab.tsx) —
// visual language mirrors DetailsTab's comment-card / timeline-entry
// treatment (initials avatar, "GitHub" source tag, markdown body via the SAME
// renderToSafeHtml pipeline) rather than forking a second avatar/markdown
// scheme — see DetailsTab.tsx's own header comment for why that pipeline
// (markdown-it + DOMPurify) is the one mandatory path.
//
// Initials/avatar-color helpers are shared with DetailsTab.tsx via
// ./avatarColor.ts (hoisted — the whole point of `avatarColorFor` is that
// the SAME login maps to the SAME color everywhere, so keeping two
// independently-editable copies risked them drifting apart). The relative-
// date formatter below is now similarly hoisted to ./relativeTime.ts (Fix
// #14, Workbench audit), shared with CommitsTab.tsx's own relative-time
// label — DetailsTab's `formatDate` remains separate, since it's an
// absolute-date formatter serving a different visual need (see this file's
// own `formatRelative` doc comment).
// ---------------------------------------------------------------------------

import type React from 'react'
import { useCallback, useMemo, useState } from 'react'
import type { GhReviewCommentThread, LocalReviewComment } from '@shared/types'
import { renderToSafeHtml } from '../previewRender'
import { CommentComposer, type CommentDraft, type GhSubmitResult } from './CommentComposer'
import { Avatar } from './Avatar'
import { relativeTimeIso } from './relativeTime'
import './ReviewCommentThread.css'

export interface ReviewCommentThreadProps {
  thread: GhReviewCommentThread
  /** The owning claude workspace's id — resolves to the workspace cwd in the
   *  main process, same as every other github:* call site. Needed here (not
   *  just in GitTab) because the Reply composer posts its own IPC call
   *  directly rather than bubbling the draft up to GitTab first. */
  workspaceId: string
  /** Called after a Reply successfully posts — GitTab passes its
   *  `refetchReviewThreads` so the new reply shows up in this thread
   *  immediately (mirrors the new-comment composer's own refetch-on-success). */
  onReplyPosted: () => void
}

/** ISO timestamp -> relative-ish short label. Inline review threads are
 *  usually recent/actionable (unlike DetailsTab's PR-spanning timeline), so a
 *  compact "3d ago" reads better here than DetailsTab's absolute date. Fix
 *  #14 (Workbench audit): now backed by the shared ./relativeTime.ts helper
 *  (round-based bucketing + an absolute-date tail past 30 days) rather than
 *  its own copy — behavior is unchanged, only the implementation moved. */
function formatRelative(iso: string): string {
  return relativeTimeIso(iso, {
    round: true,
    clampFuture: true,
    tail: (ms) =>
      new Date(ms).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      })
  })
}

function ThreadAvatar({
  login,
  avatarUrl
}: {
  login: string
  avatarUrl?: string | null
}): React.JSX.Element {
  // size=20 matches .rc-avatar's own width/height (ReviewCommentThread.css) —
  // <Avatar>'s size prop sets an inline style, which would otherwise win over
  // the class's 20px and resize the circle to the component's 24px default.
  return <Avatar login={login} avatarUrl={avatarUrl} size={20} className="rc-avatar" />
}

function CommentBody({ body }: { body: string }): React.JSX.Element {
  // renderToSafeHtml (previewRender.ts) is markdown-it + DOMPurify — the SAME
  // mandatory sanitize pipeline DetailsTab's description/comment bodies use.
  // GitHub review-comment bodies are untrusted user markdown, exactly like
  // the general PR comments/description that pipeline already handles.
  const html = useMemo(() => renderToSafeHtml(body, 'review-comment.md'), [body])
  // html is DOMPurify-sanitized above, matching DetailsTab.tsx's identical usage.
  return <div className="rc-body" dangerouslySetInnerHTML={{ __html: html }} />
}

/** One comment row within a thread — the root comment or a reply, visually
 *  identical (GitHub renders both the same way inline). */
function CommentRow({
  authorLogin,
  avatarUrl,
  createdAt,
  body,
  isRoot
}: {
  authorLogin: string
  avatarUrl?: string | null
  createdAt: string
  body: string
  isRoot: boolean
}): React.JSX.Element {
  return (
    <div className={isRoot ? 'rc-row rc-row--root' : 'rc-row rc-row--reply'}>
      <ThreadAvatar login={authorLogin} avatarUrl={avatarUrl} />
      <div className="rc-row-main">
        <div className="rc-row-head">
          <span className="rc-author">{authorLogin || 'unknown'}</span>
          <span className="rc-time">{formatRelative(createdAt)}</span>
          {isRoot && <span className="source-tag source-tag--github">GitHub</span>}
        </div>
        <CommentBody body={body} />
      </div>
    </div>
  )
}

/** Phase 4c — the "Reply" button + its CommentComposer, shown at the bottom
 *  of a thread. Kept as its own small component (rather than inlined into
 *  ReviewCommentThread's body) so the open/closed toggle state doesn't add
 *  another branch directly in the root render. The composer posts via
 *  github:replyToReviewComment, threaded to the thread's ROOT id (GitHub's
 *  replies endpoint nests under the root comment, not whichever comment in
 *  the thread visually reads as "last" — matches the API's own semantics,
 *  same as src/main/github.ts's replyToReviewComment). */
function ReplySection({
  rootCommentId,
  workspaceId,
  onReplyPosted
}: {
  rootCommentId: number
  workspaceId: string
  onReplyPosted: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)

  const draft = useMemo<Pick<CommentDraft, 'id' | 'path' | 'line' | 'side'>>(
    () => ({ id: `reply-${rootCommentId}`, path: '', line: 0, side: 'RIGHT' }),
    [rootCommentId]
  )

  const handleSubmit = useCallback(
    async (d: CommentDraft): Promise<GhSubmitResult> => {
      const result = await window.api.github.replyToReviewComment(
        workspaceId,
        rootCommentId,
        d.body
      )
      if (!result.ok) return result
      setOpen(false)
      onReplyPosted()
      return { ok: true }
    },
    [workspaceId, rootCommentId, onReplyPosted]
  )

  if (!open) {
    return (
      <button type="button" className="rc-reply-btn" onClick={() => setOpen(true)}>
        Reply
      </button>
    )
  }
  return (
    <CommentComposer
      draft={draft}
      onSubmit={handleSubmit}
      onCancel={() => setOpen(false)}
      placeholder="Write a reply…"
      submitLabel="Reply"
    />
  )
}

/** The inline review-comment thread card — passed to @pierre/diffs'
 *  `renderAnnotation` via GitTab.tsx's `lineAnnotations` mapping. Renders the
 *  root comment followed by any replies, in the already-sorted-by-createdAt
 *  order `groupReviewCommentsIntoThreads` (src/main/github.ts) produced.
 *  `thread.outdated` (root's `line` was null — anchored to `originalLine`
 *  instead) gets a subtle marker so a comment on a line that's since drifted
 *  doesn't read as freshly-anchored. Phase 4c adds a Reply affordance at the
 *  bottom (ReplySection above) — still no resolve/collapse/edit. */
export function ReviewCommentThread({
  thread,
  workspaceId,
  onReplyPosted
}: ReviewCommentThreadProps): React.JSX.Element {
  return (
    <div className="rc-thread">
      {thread.outdated && (
        <div
          className="rc-outdated"
          title="This comment's original line no longer exists in the current diff — anchored to its original position."
        >
          Outdated
        </div>
      )}
      {thread.comments.map((comment, i) => (
        <CommentRow
          key={comment.id}
          authorLogin={comment.authorLogin}
          avatarUrl={comment.avatarUrl}
          createdAt={comment.createdAt}
          body={comment.body}
          isRoot={i === 0}
        />
      ))}
      <ReplySection
        rootCommentId={thread.id}
        workspaceId={workspaceId}
        onReplyPosted={onReplyPosted}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Phase 4d — the LOCAL (Orpheus-owned) comment thread card. Reuses this
// module's CommentRow/ThreadAvatar/CommentBody (same avatar-circle + markdown
// pipeline) rather than forking a second implementation — a local comment is
// visually the SAME shape as a GitHub thread (one root "comment", no replies
// today), just tagged 'Local' (source-tag--local, see the CSS file) instead
// of 'GitHub', with a Resolve/Delete affordance a GitHub thread doesn't have
// (Orpheus owns this data, so it can mutate it directly — no `gh` write
// needed). Resolved comments dim + strike through (rc-thread--resolved) per
// the task's "a subtle resolved style", staying visible/reachable rather than
// collapsing away entirely (the Resolve toggle needs to stay clickable to
// un-resolve).
// ---------------------------------------------------------------------------

export interface LocalCommentThreadProps {
  comment: LocalReviewComment
  /** Toggles `resolved` via reviews:setResolved, then refetches (GitTab's own
   *  refetchLocalReviews) so this card reflects the new state immediately. */
  onToggleResolved: (comment: LocalReviewComment) => void
  /** Deletes via reviews:delete, then refetches — same refetch callback as
   *  onToggleResolved (both are "local store changed" events). */
  onDelete: (comment: LocalReviewComment) => void
}

/** A single-comment "thread" card for a LOCAL review comment — the third
 *  source in the 3-source model (github-from-others / my-github / LOCAL).
 *  Rendered by GitTab's `renderReviewCommentAnnotation` for a
 *  `kind: 'local'` annotation, into the SAME `renderAnnotation` slot the
 *  GitHub thread card and the pending composer already share. */
export function LocalCommentThread({
  comment,
  onToggleResolved,
  onDelete
}: LocalCommentThreadProps): React.JSX.Element {
  const cardClass = [
    'rc-thread',
    'rc-thread--local',
    comment.resolved ? 'rc-thread--resolved' : null
  ]
    .filter(Boolean)
    .join(' ')
  // Pierre adoption Batch 3 — a range indicator, shown only when this
  // comment actually spans multiple lines (startLine present and different
  // from the anchor `line`). Math.min/max defends against a bottom-to-top
  // drag, same as CommentComposer.tsx's own rangeLabel. The common
  // single-line case (startLine null, or no line at all) renders nothing
  // extra — matches today's output exactly.
  const rangeLabel =
    comment.startLine !== null && comment.line !== null && comment.startLine !== comment.line
      ? `Lines ${Math.min(comment.startLine, comment.line)}–${Math.max(comment.startLine, comment.line)}`
      : null
  return (
    <div className={cardClass}>
      <div className="rc-row rc-row--root">
        <ThreadAvatar login={comment.author} />
        <div className="rc-row-main">
          <div className="rc-row-head">
            <span className="rc-author">{comment.author || 'unknown'}</span>
            <span className="rc-time">
              {formatRelative(new Date(comment.createdAt).toISOString())}
            </span>
            <span className="source-tag source-tag--local">Local</span>
            {rangeLabel !== null && <span className="rc-time">{rangeLabel}</span>}
            {comment.resolved && <span className="rc-time">Resolved</span>}
          </div>
          <CommentBody body={comment.body} />
        </div>
      </div>
      <div className="rc-local-actions">
        <button type="button" className="rc-local-action" onClick={() => onToggleResolved(comment)}>
          {comment.resolved ? 'Unresolve' : 'Resolve ✓'}
        </button>
        <button
          type="button"
          className="rc-local-action rc-local-action--delete"
          onClick={() => onDelete(comment)}
        >
          Delete
        </button>
      </div>
    </div>
  )
}
