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
