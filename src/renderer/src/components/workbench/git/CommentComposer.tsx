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
// Phase 4d — an optional [GitHub | Local] SOURCE toggle, shown only when the
// caller passes `source`/`onSourceChange` (GitTab's new-line-comment composer
// is the only call site that does; Reply/general-comment composers post to a
// fixed destination and never render this). Lets a brand-new comment either
// post to GitHub (4c's github:postReviewComment) or save to the LOCAL store
// (reviews:add) — GitTab routes `onSubmit` based on the CURRENT toggle value
// at submit time (see its own submitReviewComment/addLocalComment split).
// ---------------------------------------------------------------------------

import type React from 'react'
import { useCallback, useState } from 'react'
import './CommentComposer.css'

/** Phase 4d — which store a new comment is being drafted for. */
export type CommentSource = 'github' | 'local'

interface SourceToggleProps {
  value: CommentSource
  onChange: (source: CommentSource) => void
  disabled: boolean
}

/** [GitHub | Local] segmented control — compact pill segments matching the
 *  rest of the Git tab's toggle language (GitTab.tsx's DiffModeToggle/
 *  SubTabStrip). Disabled while a submit is in flight, same as the textarea. */
function SourceToggle({ value, onChange, disabled }: SourceToggleProps): React.JSX.Element {
  const seg = (source: CommentSource, label: string): React.JSX.Element => (
    <button
      key={source}
      type="button"
      onClick={() => onChange(source)}
      aria-pressed={value === source}
      disabled={disabled}
      className={value === source ? 'gcc-source-seg gcc-source-seg--active' : 'gcc-source-seg'}
    >
      {label}
    </button>
  )
  return (
    <div className="gcc-source-toggle">
      {seg('github', 'GitHub')}
      {seg('local', 'Local')}
    </div>
  )
}

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
   *  Phase 4d: when `source`/`onSourceChange` are wired (see below), `onSubmit`
   *  is called with whichever source is CURRENTLY selected at submit time
   *  (`source` itself, read fresh by the caller — this component doesn't
   *  thread it through the draft object, since `CommentDraft` is also the
   *  shape ReviewCommentThread's Reply composer uses, which has no source
   *  concept at all). GitTab's own onSubmit closure reads its `commentSource`
   *  state directly rather than needing it passed back here. */
  onSubmit: (draft: CommentDraft) => Promise<GhSubmitResult>
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
   *  (ReviewCommentThread's reply composer). Defaults to "Comment". */
  submitLabel?: string
  /** Phase 4d — the SOURCE toggle's current value. Omitted entirely (the
   *  default) means "don't render the toggle at all" — only GitTab's
   *  new-line-comment composer wires this; Reply/general-comment composers
   *  post to one fixed destination and have no toggle. */
  source?: CommentSource
  /** Phase 4d — called when the user flips the [GitHub | Local] toggle.
   *  Required together with `source` (both omitted or both present) so the
   *  toggle is fully controlled by the caller, matching GitTab's own
   *  controlled-state convention elsewhere (diffMode, diffStyle, etc.). */
  onSourceChange?: (source: CommentSource) => void
}

/** The inline "start a comment" compose box — a markdown textarea + Comment/
 *  Cancel buttons. "Comment"/"Reply" IS the confirmation (no extra modal,
 *  per the task's explicit UX direction) — clicking it awaits the real
 *  `onSubmit` IPC call, showing "Posting…" + a disabled button meanwhile.
 *  On success, this component does nothing further itself (the caller closes
 *  the composer / refetches, since only the caller knows what "success"
 *  should do next); on failure, it surfaces the error inline and leaves the
 *  typed body in place so the user can retry without retyping.
 *  Uncontrolled-from-outside: the typed body lives in this component's own
 *  state, not lifted to the caller, since nothing outside needs to observe
 *  keystrokes — only the final submitted/cancelled draft matters. */
export function CommentComposer({
  draft,
  onSubmit,
  onCancel,
  placeholder = 'Leave a comment on this line…',
  submitLabel,
  source,
  onSourceChange
}: CommentComposerProps): React.JSX.Element {
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Phase 4d: when the source toggle is wired, the button label follows the
  // CURRENT source so "Comment" always reads as "post to GitHub" vs "save
  // locally" rather than a fixed generic label — defaults to the original
  // "Comment" copy when no toggle is wired (Reply/general-comment composers,
  // and the 'github' source itself, which keeps the original wording).
  const resolvedSubmitLabel = submitLabel ?? (source === 'local' ? 'Save locally' : 'Comment')

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setBody(e.target.value)
  }, [])

  const handleSubmit = useCallback(() => {
    const trimmed = body.trim()
    if (trimmed.length === 0 || submitting) return
    setSubmitting(true)
    setError(null)
    onSubmit({ ...draft, body: trimmed })
      .then((result) => {
        // On success, the caller (GitTab/ReviewCommentThread/DetailsTab)
        // closes this composer / triggers a refetch — this component just
        // stops showing its own in-flight state. On failure, surface the
        // error and leave `body` untouched so the click can be retried.
        if (!result.ok) {
          setSubmitting(false)
          setError(result.error)
        }
      })
      .catch((e) => {
        // Belt-and-suspenders: onSubmit closures are expected to always
        // resolve to a GhSubmitResult (never reject), but a thrown error
        // must still surface here rather than vanish silently.
        setSubmitting(false)
        setError(e instanceof Error ? e.message : String(e))
      })
  }, [body, draft, onSubmit, submitting])

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
      {source !== undefined && onSourceChange !== undefined && (
        <SourceToggle value={source} onChange={onSourceChange} disabled={submitting} />
      )}
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
        {submitting && <span className="gcc-hint">Posting…</span>}
        <div className="gcc-actions">
          <button
            type="button"
            className="gcc-btn gcc-btn--cancel"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="gcc-btn gcc-btn--primary"
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            {submitting ? 'Posting…' : resolvedSubmitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
