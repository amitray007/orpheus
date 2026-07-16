/**
 * Pure (non-React) helpers for the dashboard-home components. Kept in a
 * dedicated file (rather than alongside DashboardTopBar.tsx) so that file
 * only exports the component — required for Fast Refresh
 * (react-refresh/only-export-components).
 */

export type DashboardRange = 'all' | '30d' | '7d'

/** "Good morning" <12, "Good afternoon" <18, else "Good evening". */
export function greetingForHour(hour: number): string {
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

/**
 * Named variant of greetingForHour (D4) — appends ", {firstName}" when a name
 * is available (the user's GitHub display name/login, refreshed via
 * `gh api user`), else falls back to the bare greeting with no trailing comma.
 * Only the FIRST name is shown (per user preference) — the full name stays
 * persisted in the DB; this is display-only. Null/empty-safe.
 */
export function greetingWithName(hour: number, name: string | null): string {
  const greeting = greetingForHour(hour)
  const first = name?.trim().split(/\s+/)[0]
  return first ? `${greeting}, ${first}` : greeting
}

/**
 * Compact relative-time label ("2m"/"3h"/"5d") for an ISO timestamp — used by
 * PrTable's "pushed" column and IssuesTable's "updated" column (both sourced
 * from `updatedAt`, gh's own last-activity timestamp). Deliberately terser
 * than liveAgents.helpers.ts's formatSinceLabel ("2m ago") — these are
 * narrow right-aligned table columns, not a standalone label, and the mockup
 * (section 1 of the design spec) shows the bare compact form ("2m", "1h").
 */
export function formatCompactAge(isoTimestamp: string, nowMs: number = Date.now()): string {
  const then = new Date(isoTimestamp).getTime()
  if (Number.isNaN(then)) return '—'
  const diffSec = Math.max(0, Math.floor((nowMs - then) / 1000))
  if (diffSec < 60) return 'just now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour}h`
  const diffDay = Math.floor(diffHour / 24)
  if (diffDay < 7) return `${diffDay}d`
  const diffWeek = Math.floor(diffDay / 7)
  return `${diffWeek}w`
}

/**
 * Compact FUTURE countdown ("resets in Xh Ym") for the Usage card's
 * five_hour/seven_day/limit `resetsAt` fields — the forward-looking
 * counterpart to formatCompactAge above (which is always past-facing). Shows
 * the two most significant units (e.g. "4h 12m", "2d 3h") and collapses to
 * "<1m" once the window is imminent; a past/invalid timestamp reads as
 * "resetting…" rather than a negative duration.
 */
export function formatResetCountdown(
  isoTimestamp: string | null,
  nowMs: number = Date.now()
): string {
  if (!isoTimestamp) return '—'
  const then = new Date(isoTimestamp).getTime()
  if (Number.isNaN(then)) return '—'
  const diffMs = then - nowMs
  if (diffMs <= 0) return 'resetting…'

  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return '<1m'

  const days = Math.floor(diffMin / (60 * 24))
  const hours = Math.floor((diffMin % (60 * 24)) / 60)
  const mins = diffMin % 60

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

/**
 * Compact count formatter (V1 rebuild — the mockup's "1.3k · 92M · 100k"
 * requirement) for the dashboard's stat/triage/table counts, which can grow
 * unbounded (session totals, message totals, GitHub counts on a busy
 * account) and would otherwise blow out the tightened layout's fixed-width
 * columns. Below 1000, returns the exact integer unchanged — small counts
 * are the common case and should read as plain numbers, not "0.1k". At
 * 1000+, scales to k/M/B/T and shows ONE decimal place only while the scaled
 * value is still single-digit (<10 of that unit, e.g. 1.3k/2.3k/23.2B) — once
 * it's double digits or more (>=10k, >=10M) the decimal is dropped since it
 * stops being meaningfully precise at a glance. A trailing ".0" (e.g. an
 * exact 1000 -> "1.0k") is stripped so round numbers read as "1k", not
 * "1.0k". The B/T tiers matter: token totals run to tens of billions
 * (cache-read tokens repeat context every turn), which would otherwise
 * render as an unreadable "23239M". Durations/timestamps are NOT run through
 * this — only raw counts.
 *
 * Defensive: a non-finite input (NaN, +/-Infinity — e.g. a stat sourced
 * from a stale cache payload that predates the field it's reading) renders
 * as "—" rather than the literal string "NaN"/"Infinity" leaking into the
 * UI. Every caller passes a real number in the steady state; this only
 * guards the "cache/IPC data is momentarily a different shape" edge.
 */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs < 1000) return `${sign}${abs}`

  // Threshold ladder k -> M -> B -> T (largest matching tier wins). Anything
  // >=1T stays on the T tier (a quadrillion-token stat isn't a real case).
  const TIERS: ReadonlyArray<readonly [number, string]> = [
    [1_000_000_000_000, 'T'],
    [1_000_000_000, 'B'],
    [1_000_000, 'M'],
    [1000, 'k']
  ]
  const [divisor, suffix] = TIERS.find(([threshold]) => abs >= threshold) ?? [1000, 'k']
  const scaled = abs / divisor
  // Round to 1 decimal first, then decide whether that rounded value still
  // qualifies as "<10 of the unit" — avoids e.g. 9.96k rounding to "10.0k"
  // instead of the intended "10k".
  const rounded1dp = Math.round(scaled * 10) / 10
  const value = rounded1dp < 10 ? rounded1dp : Math.round(rounded1dp)
  // Strip a trailing ".0" so exact/round values (1000 -> 1, 92000000 -> 92)
  // read as "1k"/"92M" rather than "1.0k"/"92.0M".
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(1)
  return `${sign}${formatted}${suffix}`
}
