// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/git/ReviewCommentThread.tsx
//
// Workbench Git tab — Phase 4a: the inline GitHub-style comment-thread card
// rendered by @pierre/diffs' `renderAnnotation` on the PR diff (GitTab.tsx's
// DiffContentPane, PR-diff mode only). Read-only in 4a — no reply box / post
// affordance yet (that's 4c, per docs/learnings/pr-comments.md).
//
// Reusable by design (kept as its own file, not inlined into GitTab.tsx) —
// 4b/4c/4d (resolve/collapse, reply/post, other comment sources) all build on
// this same card. Visual language mirrors DetailsTab's comment-card /
// timeline-entry treatment (initials avatar, "GitHub" source tag, markdown
// body via the SAME renderToSafeHtml pipeline) rather than forking a second
// avatar/markdown scheme — see DetailsTab.tsx's own header comment for why
// that pipeline (markdown-it + DOMPurify) is the one mandatory path.
//
// Small helpers (initials/avatar-color/date) are duplicated here rather than
// imported from DetailsTab.tsx: that module doesn't export them (they're
// module-private), and re-exporting purely to share ~15 lines would couple
// two independently-phased tabs together for no real benefit — same
// "duplicated small literal, independently editable" rationale GitTab.tsx's
// own module header already applies to TREE_THEME/IMAGE_EXTENSIONS.
// ---------------------------------------------------------------------------

import type React from 'react'
import { useMemo } from 'react'
import type { GhReviewCommentThread } from '@shared/types'
import { renderToSafeHtml } from '../previewRender'
import './ReviewCommentThread.css'

export interface ReviewCommentThreadProps {
  thread: GhReviewCommentThread
}

function initialsOf(login: string): string {
  const trimmed = login.trim()
  if (trimmed.length === 0) return '?'
  return trimmed.slice(0, 2).toUpperCase()
}

// Same fixed palette DetailsTab.tsx uses — kept in sync manually (not
// imported, see the module header) so the same GitHub login gets the same
// avatar color whether it shows up in the Details timeline or an inline
// review-comment thread.
const AVATAR_COLORS = ['#d4a847', '#7c8cff', '#3fb950', '#f0883e', '#b18cf0', '#58a6ff', '#e0688f']

function avatarColorFor(login: string): string {
  let hash = 0
  for (let i = 0; i < login.length; i++) hash = (hash * 31 + login.charCodeAt(i)) | 0
  const idx = Math.abs(hash) % AVATAR_COLORS.length
  return AVATAR_COLORS[idx]
}

/** ISO timestamp -> relative-ish short label. Inline review threads are
 *  usually recent/actionable (unlike DetailsTab's PR-spanning timeline), so a
 *  compact "3d ago" reads better here than DetailsTab's absolute date — kept
 *  as its own small formatter rather than reusing DetailsTab's absolute
 *  `formatDate` for that reason. */
function formatRelative(iso: string): string {
  const d = new Date(iso)
  const ms = d.getTime()
  if (Number.isNaN(ms)) return ''
  const diffSec = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (diffSec < 60) return 'just now'
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.round(diffHr / 24)
  if (diffDay < 30) return `${diffDay}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function ThreadAvatar({ login }: { login: string }): React.JSX.Element {
  return (
    <span className="rc-avatar" style={{ background: avatarColorFor(login) }}>
      {initialsOf(login)}
    </span>
  )
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
  createdAt,
  body,
  isRoot
}: {
  authorLogin: string
  createdAt: string
  body: string
  isRoot: boolean
}): React.JSX.Element {
  return (
    <div className={isRoot ? 'rc-row rc-row--root' : 'rc-row rc-row--reply'}>
      <ThreadAvatar login={authorLogin} />
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

/** The inline review-comment thread card — passed to @pierre/diffs'
 *  `renderAnnotation` via GitTab.tsx's `lineAnnotations` mapping. Renders the
 *  root comment followed by any replies, in the already-sorted-by-createdAt
 *  order `groupReviewCommentsIntoThreads` (src/main/github.ts) produced.
 *  `thread.outdated` (root's `line` was null — anchored to `originalLine`
 *  instead) gets a subtle marker so a comment on a line that's since drifted
 *  doesn't read as freshly-anchored. Read-only: no reply box / resolve
 *  affordance in 4a. */
export function ReviewCommentThread({ thread }: ReviewCommentThreadProps): React.JSX.Element {
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
          createdAt={comment.createdAt}
          body={comment.body}
          isRoot={i === 0}
        />
      ))}
    </div>
  )
}
