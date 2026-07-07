// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/git/relativeTime.ts
//
// Shared relative-time formatter (Fix #14 — Workbench audit). Two Git-tab
// call sites each had their own near-identical "Nm/Nh/Nd ago" formatter that
// only differed in (a) floor vs. round and (b) what happens past 30 days:
//   - CommitsTab.tsx's `relativeTime`: Math.floor throughout, and past 30
//     days falls through to a floored "Nmo ago" (months-ago) tail.
//   - ReviewCommentThread.tsx's `formatRelative`: Math.round throughout, and
//     past 30 days falls through to an ABSOLUTE date string
//     ("Jan 5, 2025") instead of a relative tail.
//
// This module hoists the shared minute/hour/day bucketing into one
// `relativeTimeMs(ms, opts)`, parameterized so each site's exact prior
// behavior is preserved byte-for-byte via `opts.round` (default false =
// floor, matching CommitsTab) and `opts.tail` (a callback that produces the
// string once `diffDay >= 30`; CommitsTab passes a "Nmo ago" tail,
// ReviewCommentThread passes an absolute-date tail). Do NOT change the
// defaults — they exist so a caller that doesn't pass `opts` still floors
// (CommitsTab's original behavior).
// ---------------------------------------------------------------------------

export interface RelativeTimeOptions {
  /** Round each bucket boundary instead of flooring. Default false (floor),
   *  matching CommitsTab.tsx's original `relativeTime`. ReviewCommentThread's
   *  original `formatRelative` rounded, so it passes `round: true`. */
  round?: boolean
  /** Clamp a negative diff (timestamp in the future, e.g. clock skew) to 0
   *  before bucketing, matching ReviewCommentThread's original
   *  `Math.max(0, …)`. Default false, matching CommitsTab's original (which
   *  had no such guard — a future `ms` there just floors to a negative `s`,
   *  which is `< 60` and reads as "just now" either way). */
  clampFuture?: boolean
  /** Produces the label once the elapsed time is >= 30 days. Receives the
   *  ORIGINAL (unclamped) `ms`/`iso` value passed in, not the clamped diff —
   *  ReviewCommentThread's tail needs the real timestamp to render an
   *  absolute date. Required — the two original call sites diverge
   *  completely past this point (a floored "Nmo ago" vs. an absolute date),
   *  so there is no sane shared default. */
  tail: (ms: number) => string
}

/** Epoch-ms -> relative label ("just now" / "Nm ago" / "Nh ago" / "Nd ago"),
 *  falling through to `opts.tail(ms)` (passed the original, unclamped `ms`)
 *  once the elapsed time reaches 30 days. Bucketing uses `Math.floor` unless
 *  `opts.round` is true. */
export function relativeTimeMs(ms: number, opts: RelativeTimeOptions): string {
  const bucket = opts.round ? Math.round : Math.floor
  const rawDiff = Date.now() - ms
  const diff = opts.clampFuture === true ? Math.max(0, rawDiff) : rawDiff
  const s = bucket(diff / 1000)
  if (s < 60) return 'just now'
  const m = bucket(s / 60)
  if (m < 60) return `${m}m ago`
  const h = bucket(m / 60)
  if (h < 24) return `${h}h ago`
  const d = bucket(h / 24)
  if (d < 30) return `${d}d ago`
  return opts.tail(ms)
}

/** ISO-timestamp wrapper around `relativeTimeMs` for callers that only have
 *  an ISO string (ReviewCommentThread's comment/reply timestamps). Guards
 *  against an unparseable value the same way the original `formatRelative`
 *  did (`Number.isNaN` check -> `''`). */
export function relativeTimeIso(iso: string, opts: RelativeTimeOptions): string {
  const ms = new Date(iso).getTime()
  if (Number.isNaN(ms)) return ''
  return relativeTimeMs(ms, opts)
}
