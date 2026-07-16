// ---------------------------------------------------------------------------
// pulseData.helpers — small pure helpers for the "Your pulse" section still
// needed by the renderer after usePulseData moved to sourcing real activity
// from the main-process transcript scanner (src/main/claudeActivity.ts,
// exposed via `claude:activity`). The actual sessions/streak/peak-hour/
// weekly-activity NUMBERS are now computed in claudeActivity.ts, not here —
// this file only re-exports the shared `WeeklyActivityDay` shape (so
// existing renderer imports don't churn) and keeps `formatHour12`, the one
// pure display-formatting helper DashboardView still uses directly.
// ---------------------------------------------------------------------------

export type { WeeklyActivityDay } from '@shared/types'

/** Format an hour-of-day (0-23) as a LOCALE-AWARE clock label, e.g. 22 -> "10
 *  PM" for a 12h-locale user, "22" for a 24h-locale one. Per the mockup's
 *  explicit note ("use toLocaleTimeString, not a hardcoded format") — this
 *  used to hand-roll AM/PM, which silently assumed every user runs a 12h
 *  clock; `toLocaleTimeString` instead follows the OS's actual 12h/24h
 *  preference. The hour is dropped into a throwaway local Date (this
 *  function only ever receives an hour-of-day integer, not a real date) and
 *  formatted with `hour: 'numeric'` only — no minute — matching the
 *  mockup's compact "11 PM" style. Kept under its original name to avoid a
 *  churny rename across its one call site (DashboardView.tsx's
 *  peakHourLabel). */
export function formatHour12(hour: number): string {
  return new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: 'numeric' })
}
