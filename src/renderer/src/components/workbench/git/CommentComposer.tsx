// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/git/CommentComposer.tsx
//
// Workbench Git tab — Phase 4b built the inline "start a comment" compose
// box, rendered by @pierre/diffs' `renderAnnotation` on the PR diff (same
// slot ReviewCommentThread.tsx uses, see GitTab.tsx's `annotationsForFile`/
// `renderReviewCommentAnnotation`) for a PENDING comment — one the user is
// actively drafting but hasn't posted yet. Phase 4c (this pass) wires
// `onSubmit` to the real GitHub-post IPCs (github:postReviewComment /
// github:replyToReviewComment / github:postGeneralComment, depending on the
// caller) and adds the in-flight/error UX around that real network call:
// `onSubmit` is now ASYNC (returns a `GhSubmitResult`), and this component
// owns the "Posting…" disabled-button state plus an inline error banner on
// failure — the composer stays open with the typed body intact on failure
// so the user can retry (never silently swallowed, never auto-discarded).
//
// Reused by three call sites (GitTab.tsx's new-line-comment composer,
// ReviewCommentThread.tsx's "Reply" composer, DetailsTab.tsx's general-
// comment composer) — kept as its own file for exactly that reason: one
// textarea+buttons+in-flight-state implementation, not three forks of it.
//
// Visual language mirrors DetailsTab.tsx's own (formerly stubbed)
// `CommentComposer` — dark surface card, `.btn`/`.btn-primary` button
// classes, same textarea treatment — but scoped under its own `.gcc-*`
// classes/CSS file (CommentComposer.css) rather than sharing DetailsTab's
// `.comment-composer`/`.btn` selectors: DetailsTab's classes are scoped
// under `.details-scroll` (see DetailsTab.tsx's header comment on why
// ReviewCommentThread.tsx doesn't reuse them either), so they wouldn't apply
// inside a diff-pane annotation slot anyway — same "duplicated small
// treatment, independently editable" rationale that module already
// documents.
//
// Phase 5 (this pass) — REPLACED the old [GitHub | Local] SOURCE TOGGLE +
// single "Comment" button with 3 explicit action buttons for the ONE call
// site that can post to either destination (GitTab's new-line-comment
// composer, gated via the new `allowGithub` prop): Cancel (left), then
// [GitHub] Comment + [Local] Comment (right) — the button the user CLICKS
// decides the destination, no separate toggle state to keep in sync with
// which button reads as "the" action. `onSubmit` now takes the chosen
// `CommentSource` as its second argument so the caller (GitTab's
// `submitComment`) routes on the value the click itself carried, rather than
// reading a ref to a toggle that could drift from what's on screen (the
// exact class of bug the old toggle design left open — see GitTab.tsx's
// prior `commentSourceRef` doc comment). Reply (ReviewCommentThread) and the
// Details-tab general comment each still post to exactly ONE fixed
// destination and are UNCHANGED — they don't pass `allowGithub`, so this
// component renders its original single button for them (see `allowGithub`'s
// own doc comment below).
// ---------------------------------------------------------------------------

import type React from 'react'
import { useCallback, useState } from 'react'
import { GithubLogo, HardDrive } from '@phosphor-icons/react'
import './CommentComposer.css'

/** Which store a comment is posted/saved to. */
export type CommentSource = 'github' | 'local'

export interface CommentDraft {
  /** The pending composer's own id (see useReviewComposers.ts) — lets the
   *  onSubmit implementation know WHICH pending composer produced this
   *  draft without re-deriving it from path/line. */
  id: string
  path: string
  line: number
  /** Pierre adoption Batch 3 — the range's START line for a true multi-line
   *  select-to-comment gesture; undefined for a plain single-line comment.
   *  See useReviewComposers.ts's PendingComposer for the same field. */
  startLine?: number
  side: 'LEFT' | 'RIGHT'
  body: string
}

/** The result of an actual post attempt — mirrors the shape
 *  github:postReviewComment/replyToReviewComment/postGeneralComment already
 *  return (src/shared/ipc.ts), so callers can pass their IPC result straight
 *  through without remapping. `error` is whatever `gh` reported (see
 *  src/main/github.ts's extractGhErrorMessage) — shown verbatim so an
 *  auth/rate-limit message is actually legible instead of a generic
 *  "something went wrong". */
export type GhSubmitResult = { ok: true } | { ok: false; error: string }

export interface CommentComposerProps {
  draft: Pick<CommentDraft, 'id' | 'path' | 'line' | 'side' | 'startLine'>
  /** Posts the draft for real (Phase 4c) — GitTab/ReviewCommentThread/
   *  DetailsTab each pass a closure that calls the matching github:* IPC and
   *  resolves to a `GhSubmitResult`. This component awaits it to drive its
   *  own in-flight ("Posting…", disabled button) and error-banner state; the
   *  CALLER is responsible for closing the composer / triggering a refetch
   *  on a `{ ok: true }` result (this component only renders, it doesn't
   *  know how to invalidate the caller's data).
   *
   *  Phase 5: `onSubmit` now receives the SOURCE the user's click chose as
   *  its second argument. Single-destination callers (Reply, general
   *  comment) simply ignore it — their closures already only know how to
   *  post to their one fixed destination. The dual-destination caller
   *  (GitTab's new-line composer, `allowGithub={true}`) reads it to route
   *  between `github:postReviewComment` and `reviews:add` (see GitTab's
   *  `submitComment`). */
  onSubmit: (draft: CommentDraft, source: CommentSource) => Promise<GhSubmitResult>
  /** Closes/removes this pending composer (its annotation entry) without
   *  submitting anything. Disabled while a submit is in flight — cancelling
   *  mid-post would orphan the composer's error/success handling. */
  onCancel: () => void
  /** Placeholder text — lets Reply/general-comment call sites use copy that
   *  matches their context ("Reply…" vs "Leave a comment on this line…")
   *  without forking the component. Defaults to the original line-comment
   *  copy. */
  placeholder?: string
  /** Button label — "Comment" (new comment / general comment) vs "Reply"
   *  (ReviewCommentThread's reply composer). Defaults to "Comment". Ignored
   *  when `allowGithub` is true (the two buttons carry their own
   *  source-specific labels — see the module header). */
  submitLabel?: string
  /** Phase 5 — when true, renders BOTH the [GitHub] Comment and [Local]
   *  Comment buttons (PR-diff mode: there's a real PR to post a GitHub
   *  comment to, per GitTab's `allowGithubComments`). When false/omitted
   *  (the default), renders the ORIGINAL single button, submitting with
   *  source `'local'` — every existing single-destination caller
   *  (Reply/general-comment, both always-GitHub in practice; working-tree
   *  mode's local-only new-line composer) keeps its one-button UI exactly as
   *  before. Only GitTab's new-line-comment composer in PR-diff mode passes
   *  `true`. */
  allowGithub?: boolean
}

/** One of the two Phase-5 destination buttons (GitHub/Local) shown when
 *  `allowGithub` is true. Disabled while ANY submit is in flight (not just
 *  its own) — posting to one destination while the other button is also
 *  clickable would let a fast double-click fire two concurrent submits for
 *  the same draft. `busy` (this specific button's own in-flight state) swaps
 *  its label to "Posting…", matching the pre-Phase-5 single-button
 *  behavior. */
function DestinationButton({
  icon,
  label,
  busyLabel,
  busy,
  disabled,
  primary,
  onClick
}: {
  icon: React.ReactNode
  label: string
  busyLabel: string
  busy: boolean
  disabled: boolean
  primary: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={primary ? 'gcc-btn gcc-btn--primary' : 'gcc-btn gcc-btn--secondary'}
      disabled={disabled}
      onClick={onClick}
    >
      {!busy && icon}
      {busy ? busyLabel : label}
    </button>
  )
}

/** The inline "start a comment" compose box — a markdown textarea + action
 *  buttons. Clicking a submit button IS the confirmation (no extra modal, per
 *  the task's explicit UX direction) — it awaits the real `onSubmit` IPC
 *  call, showing "Posting…" + a disabled button meanwhile. On success, this
 *  component does nothing further itself (the caller closes the composer /
 *  refetches, since only the caller knows what "success" should do next); on
 *  failure, it surfaces the error inline and leaves the typed body in place
 *  so the user can retry without retyping.
 *  Uncontrolled-from-outside: the typed body lives in this component's own
 *  state, not lifted to the caller, since nothing outside needs to observe
 *  keystrokes — only the final submitted/cancelled draft matters. */
export function CommentComposer({
  draft,
  onSubmit,
  onCancel,
  placeholder = 'Leave a comment on this line…',
  submitLabel,
  allowGithub = false
}: CommentComposerProps): React.JSX.Element {
  const [body, setBody] = useState('')
  // Phase 5: which destination is CURRENTLY posting — null when nothing is
  // in flight, otherwise the source the clicked button carried. Replaces the
  // old plain `submitting` boolean so the two-button case can show
  // "Posting…" on ONLY the clicked button (see DestinationButton's own doc
  // comment on why BOTH buttons are still disabled meanwhile).
  const [submittingSource, setSubmittingSource] = useState<CommentSource | null>(null)
  const [error, setError] = useState<string | null>(null)
  const submitting = submittingSource !== null

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setBody(e.target.value)
  }, [])

  const handleSubmit = useCallback(
    (source: CommentSource) => {
      const trimmed = body.trim()
      if (trimmed.length === 0 || submitting) return
      setSubmittingSource(source)
      setError(null)
      onSubmit({ ...draft, body: trimmed }, source)
        .then((result) => {
          // On success, the caller (GitTab/ReviewCommentThread) typically
          // unmounts this composer / triggers a refetch — but DetailsTab's
          // GeneralCommentComposer is PERSISTENT (always rendered at the
          // bottom of the timeline, never unmounted on success), so this
          // component must clear its own in-flight state and posted text
          // itself rather than assuming the caller will do it via unmount.
          // For the unmount-on-success callers this state update simply
          // targets an unmounting instance, which is harmless in React 19.
          if (result.ok) {
            setSubmittingSource(null)
            setBody('')
          } else {
            setSubmittingSource(null)
            setError(result.error)
          }
        })
        .catch((e) => {
          // Belt-and-suspenders: onSubmit closures are expected to always
          // resolve to a GhSubmitResult (never reject), but a thrown error
          // must still surface here rather than vanish silently.
          setSubmittingSource(null)
          setError(e instanceof Error ? e.message : String(e))
        })
    },
    [body, draft, onSubmit, submitting]
  )

  const canSubmit = body.trim().length > 0 && !submitting

  // Pierre adoption Batch 3 — a range label, shown ONLY for a true
  // multi-line selection (startLine present and different from the anchor
  // line). Math.min/max defends against a bottom-to-top drag, where Pierre's
  // own SelectedLineRange doesn't guarantee start <= end. The common
  // single-line case (startLine undefined or === line) renders nothing extra
  // here — pixel-identical to the pre-Batch-3 composer.
  const { startLine, line } = draft
  const rangeLabel =
    startLine !== undefined && startLine !== line
      ? `Commenting on lines ${Math.min(startLine, line)}–${Math.max(startLine, line)}`
      : null

  return (
    <div className="gcc-composer">
      {rangeLabel !== null && <div className="gcc-range-label">{rangeLabel}</div>}
      <textarea
        className="gcc-textarea"
        value={body}
        onChange={handleChange}
        placeholder={placeholder}
        rows={3}
        autoFocus
        disabled={submitting}
        aria-label={placeholder}
      />
      {error !== null && (
        <div className="gcc-error" role="alert">
          {error}
        </div>
      )}
      <div className="gcc-footer">
        <button
          type="button"
          className="gcc-btn gcc-btn--cancel"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </button>
        <div className="gcc-actions">
          {allowGithub ? (
            <>
              <DestinationButton
                icon={<GithubLogo size={13} weight="fill" />}
                label="Comment"
                busyLabel="Posting…"
                busy={submittingSource === 'github'}
                disabled={!canSubmit}
                primary={false}
                onClick={() => handleSubmit('github')}
              />
              <DestinationButton
                icon={<HardDrive size={13} weight="fill" />}
                label="Comment"
                busyLabel="Posting…"
                busy={submittingSource === 'local'}
                disabled={!canSubmit}
                primary={true}
                onClick={() => handleSubmit('local')}
              />
            </>
          ) : (
            <button
              type="button"
              className="gcc-btn gcc-btn--primary"
              disabled={!canSubmit}
              onClick={() => handleSubmit('local')}
            >
              {submitting ? 'Posting…' : (submitLabel ?? 'Comment')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
