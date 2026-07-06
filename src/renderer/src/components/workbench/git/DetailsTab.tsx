// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/git/DetailsTab.tsx
//
// Git tab — Details sub-tab (PHASE 3d). GitHub PR "Conversation" layout:
// a flexible main column (description card + chronological timeline +
// display-only comment composer) and a fixed-width right sidebar
// (reviewers/assignees/labels/milestone/merge-box) — see the mockup at
// docs/brainstorms/git-tab-mockup/ (its Details-tab section in script.js's
// renderDetailsTab/renderDetailsSidebar + styles.css's "Details tab" block)
// for the approved structure this mirrors. Reflows to a single column when
// the pane is narrow via a container query (see DetailsTab.css) — the tab
// lives in a resizable Workbench pane, not the full viewport, so a plain
// media query would never fire at the widths that matter here.
//
// Data comes entirely from `prDetail: GhPullRequestDetail` (src/shared/
// types.ts) — no new IPC. The PR description body and general comments are
// rendered as sanitized markdown via the SAME pipeline the Files-tab Preview
// mode uses (previewRender.ts's renderToSafeHtml — markdown-it + DOMPurify),
// reused rather than forked so there's exactly one markdown-rendering path in
// the renderer. The timeline interleaves general comments (prDetail.comments.
// general[], timestamped via createdAt) with review events (prDetail.reviews[],
// timestamped via submittedAt) in chronological order; labels/review-requests
// have no timestamp in the fetched shape, so they render as sidebar-only /
// untimed content rather than fabricating a timeline position for them.
//
// Posting (the composer) and merging (the sidebar's merge button) are
// explicitly out of scope here — Phase 4 per GhPullRequestDetail's own
// comment on line-anchored review comments. Both render as inert/disabled
// affordances that match the mockup's visual language.
// ---------------------------------------------------------------------------

import type React from 'react'
import { useCallback, useMemo } from 'react'
import type {
  GhCheck,
  GhGeneralComment,
  GhPullRequestDetail,
  GhReview,
  GhReviewRequest
} from '@shared/types'
import { renderToSafeHtml } from '../previewRender'
import { CommentComposer, type CommentDraft, type GhSubmitResult } from './CommentComposer'
import { initialsOf, avatarColorFor } from './avatarColor'
import './DetailsTab.css'

export interface DetailsTabProps {
  /** The current branch's PR detail, or null when there's no PR for this
   *  branch (no `gh` / no remote / detached HEAD / not-yet-pushed) — this
   *  sub-tab is only reachable while a PR exists, but stays nullable to
   *  match CommitsTab/ChecksTab's shared signature. */
  prDetail: GhPullRequestDetail | null
  /** The owning claude workspace's id — resolves to the workspace cwd in the
   *  main process, same as GitTab's own `workspaceId` prop. Used by the
   *  general-comment composer (Phase 4c) to post via
   *  github:postGeneralComment. */
  workspaceId: string
  /** The current branch name (from GitTab's `git:statusChanged` push), or
   *  null before the first push arrives / on a detached HEAD. Unused by this
   *  tab's own rendering (the PR's own headRefName/branch chip already lives
   *  in GitTab's PrSlimHeader), kept for signature parity. */
  branch: string | null
  /** Phase 4c — called after a general comment successfully posts, so GitTab
   *  can refetch `prDetail` (the new comment needs to show up in the
   *  timeline above). GitTab passes its own `refetchPrDetail`. */
  onCommentPosted: () => void
}

// ---------------------------------------------------------------------------
// Small shared bits — relative-date formatting (initials/avatar-color now
// live in ./avatarColor.ts, shared with ReviewCommentThread.tsx)
// ---------------------------------------------------------------------------

/** ISO timestamp -> short absolute date (e.g. "Jul 3, 2026"). The timeline
 *  spans potentially many months (review history), so a relative "3d ago"
 *  reads worse than GitHub's own absolute-on-hover convention here — this
 *  keeps it simple (no live-updating "Xm ago" ticker to maintain) and still
 *  unambiguous. */
function formatDate(iso: string | null): string {
  if (iso === null) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function Avatar({ login, size = 24 }: { login: string; size?: number }): React.JSX.Element {
  return (
    <span
      className="details-avatar"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.4)),
        background: avatarColorFor(login)
      }}
    >
      {initialsOf(login)}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Description card
// ---------------------------------------------------------------------------

function DescriptionCard({ prDetail }: { prDetail: GhPullRequestDetail }): React.JSX.Element {
  const author = prDetail.author ?? 'unknown'
  const bodyHtml = useMemo(
    () =>
      prDetail.body.trim().length > 0
        ? renderToSafeHtml(prDetail.body, 'description.md')
        : '<p class="details-empty">No description provided.</p>',
    [prDetail.body]
  )
  return (
    <div className="details-desc-card">
      <div className="details-desc-card__strip">
        <Avatar login={author} size={22} />
        <span className="details-desc-card__byline">
          <b>{author}</b> opened this pull request on {formatDate(prDetail.createdAt)}
        </span>
      </div>
      {/* bodyHtml is DOMPurify-sanitized by renderToSafeHtml (previewRender.ts), same mandatory pipeline the Files-tab Preview mode uses. */}
      <div className="details-desc-card__body" dangerouslySetInnerHTML={{ __html: bodyHtml }} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Timeline: interleaved comments + review events
// ---------------------------------------------------------------------------

type TimelineItem =
  | { kind: 'comment'; at: number; comment: GhGeneralComment }
  | { kind: 'review'; at: number; review: GhReview }

const REVIEW_STATE_LABEL: Record<GhReview['state'], string> = {
  APPROVED: 'approved these changes',
  CHANGES_REQUESTED: 'requested changes',
  COMMENTED: 'commented',
  DISMISSED: 'had their review dismissed',
  PENDING: 'has a pending review'
}

/** Builds the chronological timeline from the two timestamped sources this
 *  payload actually carries — general comments (createdAt) and reviews
 *  (submittedAt). Labels/review-requests have no timestamp in
 *  GhPullRequestDetail, so they're intentionally left out of the timeline
 *  (they surface in the sidebar instead) rather than fabricating an ordering
 *  for them. Reviews with a null submittedAt (pending) are also excluded from
 *  the timeline for the same reason — pending reviewers already show in the
 *  sidebar's Reviewers section. */
function buildTimeline(prDetail: GhPullRequestDetail): TimelineItem[] {
  const items: TimelineItem[] = []
  for (const comment of prDetail.comments.general) {
    const at = new Date(comment.createdAt).getTime()
    if (!Number.isNaN(at)) items.push({ kind: 'comment', at, comment })
  }
  for (const review of prDetail.reviews) {
    if (review.submittedAt === null) continue
    const at = new Date(review.submittedAt).getTime()
    if (!Number.isNaN(at)) items.push({ kind: 'review', at, review })
  }
  return items.sort((a, b) => a.at - b.at)
}

function ReviewEventRow({ review }: { review: GhReview }): React.JSX.Element {
  const stateClass =
    review.state === 'APPROVED'
      ? 'timeline-event__icon--approve'
      : review.state === 'CHANGES_REQUESTED'
        ? 'timeline-event__icon--close'
        : ''
  return (
    <div className="timeline-event">
      <span className={`timeline-event__icon ${stateClass}`}>
        <ReviewGlyph state={review.state} />
      </span>
      <span className="timeline-event__text">
        <b>{review.author}</b> {REVIEW_STATE_LABEL[review.state]}
      </span>
      <span className="timeline-event__time">{formatDate(review.submittedAt)}</span>
    </div>
  )
}

function ReviewGlyph({ state }: { state: GhReview['state'] }): React.JSX.Element {
  if (state === 'APPROVED') return <span aria-hidden="true">✓</span>
  if (state === 'CHANGES_REQUESTED') return <span aria-hidden="true">✕</span>
  return <span aria-hidden="true">◐</span>
}

function CommentEntry({ comment }: { comment: GhGeneralComment }): React.JSX.Element {
  const bodyHtml = useMemo(() => renderToSafeHtml(comment.body, 'comment.md'), [comment.body])
  return (
    <div className="timeline-entry">
      <span className="timeline-entry__dot" />
      <div className="timeline-entry__card">
        <div className="comment-card">
          <Avatar login={comment.author} size={20} />
          <div className="comment-body">
            <span className="comment-author">{comment.author}</span>
            <span className="comment-time">{formatDate(comment.createdAt)}</span>
            <span className="source-tag source-tag--github">GitHub</span>
            {/* bodyHtml is DOMPurify-sanitized (see DescriptionCard's identical usage above). */}
            <div
              className="comment-text details-desc-card__body"
              dangerouslySetInnerHTML={{ __html: bodyHtml }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

function Timeline({ prDetail }: { prDetail: GhPullRequestDetail }): React.JSX.Element {
  const timeline = useMemo(() => buildTimeline(prDetail), [prDetail])
  if (timeline.length === 0) {
    return (
      <div className="details-timeline">
        <div className="details-empty" style={{ padding: '8px 0' }}>
          No activity yet.
        </div>
      </div>
    )
  }
  return (
    <div className="details-timeline">
      {timeline.map((item) =>
        item.kind === 'review' ? (
          <ReviewEventRow key={`review-${item.review.id}`} review={item.review} />
        ) : (
          <CommentEntry key={`comment-${item.comment.id}`} comment={item.comment} />
        )
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// General-comment composer (Phase 4c wires posting via
// github:postGeneralComment). Reuses the shared CommentComposer.tsx
// component (the SAME one the PR-diff's line-comment/reply composers use)
// rather than keeping its own bespoke `.comment-composer`/`.btn` markup —
// this pass deliberately consolidates onto the one composer implementation
// instead of forking a second in-flight/error-handling copy for the
// Details-tab call site. Visually this changes the composer's classes from
// `.comment-composer`/`.btn` (DetailsTab.css) to `.gcc-*`
// (CommentComposer.css) — both already match the same dark-surface-card
// language, so this isn't a visual regression, just a de-duplication.
// ---------------------------------------------------------------------------

// A general PR comment has no path/line/side to anchor to — CommentDraft's
// shape still requires them (it's shared with the line-anchored composers),
// so this is a fixed placeholder draft; postGeneralComment (main process)
// never reads path/line/side, only `body`.
const GENERAL_COMMENT_DRAFT: Pick<CommentDraft, 'id' | 'path' | 'line' | 'side'> = {
  id: 'general-comment',
  path: '',
  line: 0,
  side: 'RIGHT'
}

function GeneralCommentComposer({
  workspaceId,
  onCommentPosted
}: {
  workspaceId: string
  onCommentPosted: () => void
}): React.JSX.Element {
  const handleSubmit = useCallback(
    async (draft: CommentDraft): Promise<GhSubmitResult> => {
      const result = await window.api.github.postGeneralComment(workspaceId, draft.body)
      if (!result.ok) return result
      onCommentPosted()
      return { ok: true }
    },
    [workspaceId, onCommentPosted]
  )

  // No onCancel affordance here — a general PR comment isn't anchored to
  // anything the user needs to "cancel out of" the way a line-comment's
  // gutter-opened composer is; CommentComposer still requires the prop, so
  // this is a no-op (there's nothing to close — the composer is always
  // present at the bottom of the timeline, matching the mockup's persistent
  // "leave a comment" box).
  return (
    <CommentComposer
      draft={GENERAL_COMMENT_DRAFT}
      onSubmit={handleSubmit}
      onCancel={() => {}}
      placeholder="Leave a general PR comment…"
      submitLabel="Comment"
    />
  )
}

// ---------------------------------------------------------------------------
// Sidebar sections
// ---------------------------------------------------------------------------

function SidebarSection({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="details-sidebar__section">
      <div className="details-sidebar__heading">
        <span>{title}</span>
      </div>
      {children}
    </div>
  )
}

// Reviewer row state: a submitted review always wins over a still-pending
// request for the same login (a reviewer who's requested again after
// approving still shows as approved — matches GitHub's own sidebar, which
// keys the row off the review, not the outstanding request).
interface ReviewerRow {
  login: string
  state: GhReview['state'] | 'pending'
}

function buildReviewerRows(
  reviewRequests: readonly GhReviewRequest[],
  reviews: readonly GhReview[]
): ReviewerRow[] {
  const rows = new Map<string, ReviewerRow>()
  for (const req of reviewRequests) rows.set(req.login, { login: req.login, state: 'pending' })
  // Later reviews win over an earlier state for the same author (e.g. a
  // CHANGES_REQUESTED superseded by a later APPROVED) — reviews are already
  // in gh's own returned order, so a simple overwrite-on-iterate is correct.
  for (const review of reviews)
    rows.set(review.author, { login: review.author, state: review.state })
  return Array.from(rows.values())
}

const REVIEWER_STATE_LABEL: Record<ReviewerRow['state'], string> = {
  pending: 'pending',
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
  PENDING: 'pending'
}

function ReviewersSection({ prDetail }: { prDetail: GhPullRequestDetail }): React.JSX.Element {
  const rows = useMemo(
    () => buildReviewerRows(prDetail.reviewRequests, prDetail.reviews),
    [prDetail.reviewRequests, prDetail.reviews]
  )
  return (
    <SidebarSection title="Reviewers">
      {rows.length === 0 ? (
        <span className="details-empty">No reviews requested</span>
      ) : (
        rows.map((row) => (
          <div className="sidebar-person-row" key={row.login}>
            <span
              className={row.state === 'pending' ? 'reviewer-avatar pending' : 'reviewer-avatar'}
            >
              {row.state === 'pending' ? '' : <Avatar login={row.login} size={18} />}
            </span>
            <span className="reviewer-name">
              {row.login} · {REVIEWER_STATE_LABEL[row.state]}
            </span>
          </div>
        ))
      )}
    </SidebarSection>
  )
}

function AssigneesSection({ assignees }: { assignees: readonly string[] }): React.JSX.Element {
  return (
    <SidebarSection title="Assignees">
      {assignees.length === 0 ? (
        <span className="details-empty">No one assigned</span>
      ) : (
        assignees.map((login) => (
          <div className="sidebar-person-row" key={login}>
            <Avatar login={login} size={18} />
            <span className="reviewer-name">{login}</span>
          </div>
        ))
      )}
    </SidebarSection>
  )
}

function LabelsSection({ prDetail }: { prDetail: GhPullRequestDetail }): React.JSX.Element {
  return (
    <SidebarSection title="Labels">
      {prDetail.labels.length === 0 ? (
        <span className="details-empty">None yet</span>
      ) : (
        <div className="chip-group">
          {prDetail.labels.map((label) => (
            <span
              key={label.name}
              className="label-chip"
              style={{ background: `#${label.color}` }}
              title={label.description ?? undefined}
            >
              {label.name}
            </span>
          ))}
        </div>
      )}
    </SidebarSection>
  )
}

function MilestoneSection({
  milestone
}: {
  milestone: GhPullRequestDetail['milestone']
}): React.JSX.Element {
  return (
    <SidebarSection title="Milestone">
      {milestone === null ? (
        <span className="details-empty">No milestone</span>
      ) : (
        <div className="milestone-row">
          <span className="milestone-name">{milestone.title}</span>
          {milestone.dueOn !== null && (
            <span className="milestone-count">Due {formatDate(milestone.dueOn)}</span>
          )}
        </div>
      )}
    </SidebarSection>
  )
}

// Mirrors PrChip.tsx-adjacent aggregate reduction: reduce the un-reduced
// per-check list into a pass/fail summary line for the merge box, without
// duplicating GhPullRequest['checks']'s own 3-state field (this tab only has
// the un-reduced `checks[]`, not that separate aggregate).
function summarizeChecks(checks: readonly GhCheck[]): { failing: number; total: number } {
  const failing = checks.filter((c) => c.state === 'failure').length
  return { failing, total: checks.length }
}

function mergeablePillText(mergeable: GhPullRequestDetail['mergeable']): {
  ok: boolean
  text: string
} {
  if (mergeable === 'MERGEABLE') return { ok: true, text: 'No conflicts' }
  if (mergeable === 'CONFLICTING') return { ok: false, text: 'Conflicts must be resolved' }
  return { ok: false, text: 'Mergeable status unknown' }
}

/** The merge button's label, decided by PR state first (a merged/closed/draft
 *  PR always wins over the mergeable/checks detail), then mergeable-ness,
 *  then checks — extracted from MergeSection so that component's own
 *  cognitive complexity stays under the ceiling; this is a flat priority
 *  chain over already-reduced inputs, easy to verify standalone. */
function mergeButtonLabel(
  state: GhPullRequestDetail['state'],
  pillOk: boolean,
  failing: number
): string {
  if (state === 'merged') return 'Already merged'
  if (state === 'closed') return 'Pull request closed'
  if (state === 'draft') return 'Ready for review to merge'
  if (!pillOk) return 'Resolve conflicts to merge'
  if (failing > 0) return 'Checks failing'
  return 'Merge pull request'
}

function MergeSection({ prDetail }: { prDetail: GhPullRequestDetail }): React.JSX.Element {
  const { failing, total } = useMemo(() => summarizeChecks(prDetail.checks), [prDetail.checks])
  const pill = mergeablePillText(prDetail.mergeable)
  const isOpenState = prDetail.state === 'open' || prDetail.state === 'draft'
  const canMerge = pill.ok && isOpenState && failing === 0
  const mergeLabel = mergeButtonLabel(prDetail.state, pill.ok, failing)
  return (
    <SidebarSection title="Merge">
      <div className="merge-box">
        <span
          className={`mergeable-pill ${pill.ok ? 'mergeable-pill--ok' : 'mergeable-pill--conflict'}`}
        >
          {pill.text}
        </span>
        <span
          className={`merge-box__checks ${failing > 0 ? 'merge-box__checks--fail' : 'merge-box__checks--pass'}`}
        >
          {total === 0
            ? 'No checks reported'
            : failing > 0
              ? `${failing} failing check${failing === 1 ? '' : 's'}`
              : 'All checks passed'}
        </span>
        <button type="button" className="btn btn-primary merge-box__btn" disabled={!canMerge}>
          {mergeLabel}
        </button>
      </div>
    </SidebarSection>
  )
}

function DetailsSidebar({ prDetail }: { prDetail: GhPullRequestDetail }): React.JSX.Element {
  return (
    <div className="details-sidebar">
      <ReviewersSection prDetail={prDetail} />
      <AssigneesSection assignees={prDetail.assignees} />
      <LabelsSection prDetail={prDetail} />
      <MilestoneSection milestone={prDetail.milestone} />
      <MergeSection prDetail={prDetail} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

function NoDetails(): React.JSX.Element {
  return (
    <div className="flex-1 flex items-center justify-center min-h-0">
      <span className="text-xs text-text-muted select-none">No PR details available</span>
    </div>
  )
}

/** Details sub-tab — GitHub PR "Conversation" layout. Two columns (main +
 *  sidebar) inside a container-query root (see DetailsTab.css) so the layout
 *  collapses to a single column when the Workbench pane itself is narrow,
 *  independent of the app window's overall width. */
export function DetailsTab({
  prDetail,
  workspaceId,
  branch,
  onCommentPosted
}: DetailsTabProps): React.JSX.Element {
  if (prDetail === null) return <NoDetails />
  return (
    <div
      className="details-scroll flex-1 min-h-0"
      data-workspace-id={workspaceId}
      data-branch={branch ?? undefined}
    >
      <div className="details-columns">
        <div className="details-main">
          <DescriptionCard prDetail={prDetail} />
          <Timeline prDetail={prDetail} />
          <GeneralCommentComposer workspaceId={workspaceId} onCommentPosted={onCommentPosted} />
        </div>
        <DetailsSidebar prDetail={prDetail} />
      </div>
    </div>
  )
}
