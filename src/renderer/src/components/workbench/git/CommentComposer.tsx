// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/git/CommentComposer.tsx
//
// Workbench Git tab — Phase 4b: the inline "start a comment" compose box,
// rendered by @pierre/diffs' `renderAnnotation` on the PR diff (same slot
// ReviewCommentThread.tsx uses, see GitTab.tsx's `annotationsForFile`/
// `renderReviewCommentAnnotation`) for a PENDING comment — one the user is
// actively drafting but hasn't posted yet.
//
// COMPOSE UI ONLY. There is no network/post call here — `onSubmit` is a stub
// prop GitTab.tsx currently just logs/discards; Phase 4c wires it to the real
// GitHub-post IPC once that lands. Kept as its own reusable file (not inlined
// into GitTab.tsx) for the same reason ReviewCommentThread.tsx is: 4c/4d will
// both want this same composer (replying to an existing thread, editing a
// draft) without forking a second textarea+buttons implementation.
//
// Visual language mirrors DetailsTab.tsx's own (also currently stubbed)
// `CommentComposer` — dark surface card, `.btn`/`.btn-primary` button
// classes, same textarea treatment — but scoped under its own `.gcc-*`
// classes/CSS file (CommentComposer.css) rather than sharing DetailsTab's
// `.comment-composer`/`.btn` selectors: DetailsTab's classes are scoped
// under `.details-scroll` (see DetailsTab.tsx's header comment on why
// ReviewCommentThread.tsx doesn't reuse them either), so they wouldn't apply
// inside a diff-pane annotation slot anyway — same "duplicated small
// treatment, independently editable" rationale that module already
// documents.
// ---------------------------------------------------------------------------

import type React from 'react'
import { useCallback, useState } from 'react'
import './CommentComposer.css'

export interface CommentDraft {
  /** The pending composer's own id (see useReviewComposers.ts) — lets a
   *  future onSubmit implementation (Phase 4c) know WHICH pending composer
   *  produced this draft without re-deriving it from path/line. */
  id: string
  path: string
  line: number
  side: 'LEFT' | 'RIGHT'
  body: string
}

export interface CommentComposerProps {
  draft: Pick<CommentDraft, 'id' | 'path' | 'line' | 'side'>
  /** Stub for Phase 4c — called with the full draft (including the typed
   *  body) when the user clicks "Comment". Today nothing in GitTab actually
   *  posts anywhere; see the module header. */
  onSubmit: (draft: CommentDraft) => void
  /** Closes/removes this pending composer (its annotation entry) without
   *  submitting anything. */
  onCancel: () => void
}

/** The inline "start a comment" compose box — a markdown textarea + Comment/
 *  Cancel buttons. "Comment" calls `onSubmit` with the current draft (Phase
 *  4c wires that to a real post); it does NOT perform any network call
 *  itself. Uncontrolled-from-outside: the typed body lives in this
 *  component's own state, not lifted to GitTab, since nothing outside needs
 *  to observe keystrokes — only the final submitted/cancelled draft matters. */
export function CommentComposer({
  draft,
  onSubmit,
  onCancel
}: CommentComposerProps): React.JSX.Element {
  const [body, setBody] = useState('')

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setBody(e.target.value)
  }, [])

  const handleSubmit = useCallback(() => {
    const trimmed = body.trim()
    if (trimmed.length === 0) return
    onSubmit({ ...draft, body: trimmed })
  }, [body, draft, onSubmit])

  const canSubmit = body.trim().length > 0

  return (
    <div className="gcc-composer">
      <textarea
        className="gcc-textarea"
        value={body}
        onChange={handleChange}
        placeholder="Leave a comment on this line…"
        rows={3}
        autoFocus
        aria-label="Comment on this line"
      />
      <div className="gcc-footer">
        <span className="gcc-hint">Posting comments is coming soon.</span>
        <div className="gcc-actions">
          <button type="button" className="gcc-btn gcc-btn--cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="gcc-btn gcc-btn--primary"
            disabled={!canSubmit}
            title="Posting coming soon"
            onClick={handleSubmit}
          >
            Comment
          </button>
        </div>
      </div>
    </div>
  )
}
