// ---------------------------------------------------------------------------
// pulseData.helpers — PURE functions that derive the "Your pulse" section's
// numbers from a `SessionRecord[]` (the cross-project, non-archived-project
// session list from `sessions:listAll`). No React, no IPC — kept pure and
// testable, imported only by `usePulseData` (the thin hook that fetches +
// wires these to component state) and, if needed later, unit tests.
//
// All "calendar day" bucketing uses the LOCAL timezone (via `Date` getters,
// not UTC) — a session at 11pm and one at 1am the next day are different
// activity days for the user, matching how a human reads "today"/"yesterday".
// ---------------------------------------------------------------------------

import type { SessionRecord } from '@shared/types'
import type { DashboardRange } from './dashboardHome.helpers'

const DAY_MS = 24 * 60 * 60 * 1000

/** Local calendar-day key, e.g. "2026-07-11". Stable, sortable, DST-safe
 *  (built from local Y/M/D getters, not a raw ms division). */
export function dayKey(epochMs: number): string {
  const d = new Date(epochMs)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Midnight-local Date for "today", used as the anchor for streaks + heatmap
 *  so both walk the same local calendar regardless of current time-of-day. */
function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

// ---------------------------------------------------------------------------
// Range filtering — All / 30d / 7d. Filters by `createdAt` (session start),
// matching the spec's "activity day" basis used everywhere else in this
// file. 30d/7d = createdAt >= now - N days; All = no filter.
// ---------------------------------------------------------------------------
export function filterByRange(
  sessions: SessionRecord[],
  range: DashboardRange,
  now: number = Date.now()
): SessionRecord[] {
  if (range === 'all') return sessions
  const days = range === '30d' ? 30 : 7
  const cutoff = now - days * DAY_MS
  return sessions.filter((s) => s.createdAt >= cutoff)
}

// ---------------------------------------------------------------------------
// 1. Sessions count — trivial, but centralized so the tile + donut total
//    agree (both read `sessions.length` of the SAME filtered list).
// ---------------------------------------------------------------------------
export function sessionsCount(sessions: SessionRecord[]): number {
  return sessions.length
}

// ---------------------------------------------------------------------------
// 2. Streaks — consecutive calendar days with >=1 session.
//    Current streak: walk backward from today. If there's a session today,
//    count today + consecutive prior days. If there's NO session today (but
//    the user was active yesterday), we still count the streak as "alive"
//    through yesterday — i.e. current streak = days ending at the most
//    recent active day, as long as that day is today or yesterday. This
//    matches how most streak UIs (Duolingo, GitHub) treat "haven't broken it
//    yet, just haven't shown up today": a streak doesn't reset to 0 the
//    INSTANT the clock ticks past midnight with no activity, it resets once
//    a full day is skipped. If the most recent active day is older than
//    yesterday, the streak is broken -> 0.
//    Longest streak: max run over all history (independent of "today").
// ---------------------------------------------------------------------------
export function computeStreaks(
  sessions: SessionRecord[],
  now: number = Date.now()
): { current: number; longest: number } {
  if (sessions.length === 0) return { current: 0, longest: 0 }

  // Distinct active-day keys, sorted ascending.
  const activeDays = Array.from(new Set(sessions.map((s) => dayKey(s.createdAt)))).sort()

  // Longest streak: scan sorted days, counting consecutive-day runs.
  let longest = 1
  let run = 1
  for (let i = 1; i < activeDays.length; i++) {
    const prev = new Date(activeDays[i - 1])
    const cur = new Date(activeDays[i])
    const diffDays = Math.round((cur.getTime() - prev.getTime()) / DAY_MS)
    if (diffDays === 1) {
      run += 1
    } else {
      run = 1
    }
    longest = Math.max(longest, run)
  }

  // Current streak: find the most recent active day, then walk backward
  // counting consecutive days as long as they're all active.
  const today = startOfLocalDay(new Date(now))
  const mostRecentActive = new Date(activeDays[activeDays.length - 1])
  const daysSinceMostRecent = Math.round((today.getTime() - mostRecentActive.getTime()) / DAY_MS)

  // More than 1 day since the last active day (i.e. nothing today AND
  // nothing yesterday) -> streak is broken.
  if (daysSinceMostRecent > 1) {
    return { current: 0, longest }
  }

  const activeSet = new Set(activeDays)
  let current = 0
  const cursor = new Date(mostRecentActive)
  while (activeSet.has(dayKey(cursor.getTime()))) {
    current += 1
    cursor.setDate(cursor.getDate() - 1)
  }

  return { current, longest }
}

// ---------------------------------------------------------------------------
// 3. Peak hour — local hour-of-day (0-23) with the most session starts.
//    Ties broken by lowest hour (stable/deterministic). Formatted 12h with
//    AM/PM, e.g. hour 22 -> "10 PM", hour 0 -> "12 AM", hour 12 -> "12 PM".
// ---------------------------------------------------------------------------
export function computePeakHour(sessions: SessionRecord[]): number | null {
  if (sessions.length === 0) return null
  const histogram = new Array<number>(24).fill(0)
  for (const s of sessions) {
    histogram[new Date(s.createdAt).getHours()] += 1
  }
  let peakHour = 0
  let peakCount = histogram[0]
  for (let h = 1; h < 24; h++) {
    if (histogram[h] > peakCount) {
      peakCount = histogram[h]
      peakHour = h
    }
  }
  return peakCount > 0 ? peakHour : null
}

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

// ---------------------------------------------------------------------------
// 4. Active days — distinct calendar days with >=1 session.
// ---------------------------------------------------------------------------
export function activeDaysCount(sessions: SessionRecord[]): number {
  return new Set(sessions.map((s) => dayKey(s.createdAt))).size
}

// ---------------------------------------------------------------------------
// 5. Activity heatmap — GitHub-style grid, 7 rows (Sun..Sat) x ~26 cols
//    (weeks), most recent WEEK on the right. Always spans the trailing ~6
//    months (26 weeks = 182 days) regardless of the active All/30d/7d range
//    filter — per spec, the heatmap IS a time view, so it keeps its own
//    fixed window rather than respecting the tile range control (avoids a
//    near-empty grid when the user picks "7d").
//
//    Intensity levels are FIXED thresholds (not quantile-based) so the
//    legend's meaning is stable and comparable across users/sessions rather
//    than rescaling per-dataset: 0 sessions = level 0, 1 = level 1, 2-3 =
//    level 2, 4-5 = level 3, 6+ = level 4. Chosen to roughly track a typical
//    "few sessions a day is already active" cadence for a single dev.
// ---------------------------------------------------------------------------
export interface HeatmapCell {
  date: string // dayKey, e.g. "2026-07-11"
  count: number
  level: 0 | 1 | 2 | 3 | 4
}

const HEATMAP_WEEKS = 26

export function levelForCount(count: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0
  if (count === 1) return 1
  if (count <= 3) return 2
  if (count <= 5) return 3
  return 4
}

/**
 * Returns a flat array of HEATMAP_WEEKS * 7 cells, column-major (all 7 days
 * of week 0, then all 7 of week 1, ...) so it can be dropped straight into a
 * `grid-auto-flow: column` CSS grid. The grid is anchored so the LAST column
 * ends on the current week, and each column starts on a Sunday (so rows are
 * a consistent Sun..Sat regardless of what day "today" is).
 */
export function computeHeatmap(sessions: SessionRecord[], now: number = Date.now()): HeatmapCell[] {
  const counts = new Map<string, number>()
  for (const s of sessions) {
    const key = dayKey(s.createdAt)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  const today = startOfLocalDay(new Date(now))
  // Sunday of the current week (0 = Sunday in JS getDay()).
  const currentWeekStart = new Date(today)
  currentWeekStart.setDate(currentWeekStart.getDate() - currentWeekStart.getDay())

  // First column's Sunday = currentWeekStart - (HEATMAP_WEEKS - 1) weeks.
  const gridStart = new Date(currentWeekStart)
  gridStart.setDate(gridStart.getDate() - (HEATMAP_WEEKS - 1) * 7)

  const cells: HeatmapCell[] = []
  for (let week = 0; week < HEATMAP_WEEKS; week++) {
    for (let dow = 0; dow < 7; dow++) {
      const cellDate = new Date(gridStart)
      cellDate.setDate(cellDate.getDate() + week * 7 + dow)
      const key = dayKey(cellDate.getTime())
      const count = cellDate.getTime() > today.getTime() ? 0 : (counts.get(key) ?? 0)
      cells.push({ date: key, count, level: levelForCount(count) })
    }
  }
  return cells
}

/** Weekday (0=Sun..6=Sat) with the highest total session count across the
 *  heatmap window, for the "Busiest on Wednesdays" caption. Returns null
 *  when every day is empty. */
export function busiestWeekday(cells: HeatmapCell[]): number | null {
  const totals = new Array<number>(7).fill(0)
  let any = false
  for (let i = 0; i < cells.length; i++) {
    const dow = i % 7
    totals[dow] += cells[i].count
    if (cells[i].count > 0) any = true
  }
  if (!any) return null
  let best = 0
  for (let d = 1; d < 7; d++) {
    if (totals[d] > totals[best]) best = d
  }
  return best
}

export const WEEKDAY_NAMES = [
  'Sundays',
  'Mondays',
  'Tuesdays',
  'Wednesdays',
  'Thursdays',
  'Fridays',
  'Saturdays'
]

// ---------------------------------------------------------------------------
// 6. Weekly activity — the Activity card's small-multiples chart data (V1
//    rebuild, replacing the 6-month heatmap in that card — see
//    ActivityChart.tsx). Exactly 7 entries covering the trailing 7 calendar
//    days ending today (local timezone, via the same dayKey/startOfLocalDay
//    helpers used above), ordered MONDAY-FIRST (weekday 0=Mon..6=Sun) to
//    match the mockup's "M T W T F S S" axis — a deliberate departure from
//    computeHeatmap's Sunday-first (dow via JS getDay()) convention, since
//    this is a distinct chart with its own weekday ordering, not a reuse of
//    the heatmap's grid.
// ---------------------------------------------------------------------------
export interface WeeklyActivityDay {
  weekday: number // 0=Mon..6=Sun
  sessions: number
  messages: number
}

export function computeWeeklyActivity(
  sessions: SessionRecord[],
  now: number = Date.now()
): WeeklyActivityDay[] {
  const sessionsByDay = new Map<string, number>()
  const messagesByDay = new Map<string, number>()
  for (const s of sessions) {
    const key = dayKey(s.createdAt)
    sessionsByDay.set(key, (sessionsByDay.get(key) ?? 0) + 1)
    messagesByDay.set(key, (messagesByDay.get(key) ?? 0) + (s.messageCount ?? 0))
  }

  const today = startOfLocalDay(new Date(now))
  // JS getDay() is Sun=0..Sat=6; remap to Mon=0..Sun=6 so "today" walks
  // backward to the correct Monday-anchored start of the trailing week.
  const todayMonFirst = (today.getDay() + 6) % 7
  const weekStart = new Date(today)
  weekStart.setDate(weekStart.getDate() - todayMonFirst)

  const days: WeeklyActivityDay[] = []
  for (let weekday = 0; weekday < 7; weekday++) {
    const cellDate = new Date(weekStart)
    cellDate.setDate(cellDate.getDate() + weekday)
    const key = dayKey(cellDate.getTime())
    days.push({
      weekday,
      sessions: sessionsByDay.get(key) ?? 0,
      messages: messagesByDay.get(key) ?? 0
    })
  }
  return days
}
