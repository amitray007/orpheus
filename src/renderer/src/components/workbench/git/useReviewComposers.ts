// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/git/useReviewComposers.ts
//
// Workbench Git tab — Phase 4b: tracks the set of currently-OPEN "start a
// comment" composers on the PR diff (one per gutter-"+"-click or
// select-to-comment action). Extracted out of GitTab.tsx so that component's
// own body doesn't grow another useState+useCallback cluster on top of its
// already-large effect list (cognitive-complexity ceiling, see CLAUDE.md).
//
// A "pending composer" is keyed by `path:side:line` (never more than one open
// composer per exact line/side — clicking the gutter "+" on a line that
// already has an open composer just re-focuses the existing one rather than
// stacking a second). It carries no draft TEXT itself (CommentComposer.tsx
// owns that in its own local state) — only the anchor (path/line/side) plus
// a stable `id` used as the React key / DiffLineAnnotation metadata identity.
// ---------------------------------------------------------------------------

import { useCallback, useMemo, useState } from 'react'

export interface PendingComposer {
  id: string
  path: string
  line: number
  side: 'LEFT' | 'RIGHT'
}

function keyFor(path: string, side: 'LEFT' | 'RIGHT', line: number): string {
  return `${path}:${side}:${line}`
}

export interface UseReviewComposersResult {
  /** Every currently-open pending composer, across all files (GitTab filters
   *  by path itself, same as it does for reviewThreads/annotationsForFile). */
  composers: readonly PendingComposer[]
  /** Opens (or re-focuses, if one already exists at this exact anchor) a
   *  composer at `path`/`side`/`line`. */
  open: (path: string, side: 'LEFT' | 'RIGHT', line: number) => void
  /** Closes the composer with the given id (Cancel, or after a future
   *  Phase-4c submit succeeds). */
  close: (id: string) => void
  /** Drops every open composer — called whenever the surrounding context
   *  (selected file, diff mode, PR) changes out from under them, mirroring
   *  GitTab's existing reviewThreads-reset effects. */
  reset: () => void
}

/** Pending-composer state, keyed so GitTab/annotationsForFile can merge it
 *  alongside `reviewThreads` into one `lineAnnotations` list per file. */
export function useReviewComposers(): UseReviewComposersResult {
  const [composers, setComposers] = useState<PendingComposer[]>([])

  const open = useCallback((path: string, side: 'LEFT' | 'RIGHT', line: number) => {
    const key = keyFor(path, side, line)
    setComposers((prev) => {
      if (prev.some((c) => keyFor(c.path, c.side, c.line) === key)) return prev
      const id = `pending-${key}-${Date.now()}-${Math.round(Math.random() * 1e6)}`
      return [...prev, { id, path, side, line }]
    })
  }, [])

  const close = useCallback((id: string) => {
    setComposers((prev) => prev.filter((c) => c.id !== id))
  }, [])

  const reset = useCallback(() => {
    setComposers((prev) => (prev.length === 0 ? prev : []))
  }, [])

  return useMemo(() => ({ composers, open, close, reset }), [composers, open, close, reset])
}
