// ---------------------------------------------------------------------------
// usePulseData — fetches `sessions:listAll` ONCE (cross-project, non-
// archived-project sessions) and derives every "Your pulse" number from it
// via the pure helpers in `pulseData.helpers.ts`. Thin by design: this hook
// owns fetch/loading/error state + the range filter; all math lives in the
// sibling pure-functions file so it stays independently testable.
//
// Range wiring: the heatmap is ALWAYS computed over its own fixed ~6-month
// window (see pulseData.helpers) regardless of `range` — it's a time view of
// its own. The stat tiles + models donut DO respect `range` (all/30d/7d),
// filtering the session list by `createdAt` before aggregating.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react'
import type { SessionRecord } from '@shared/types'
import type { DashboardRange } from './dashboardHome.helpers'
import {
  activeDaysCount,
  computeHeatmap,
  computePeakHour,
  computeStreaks,
  computeWeeklyActivity,
  filterByRange,
  sessionsCount,
  type HeatmapCell,
  type WeeklyActivityDay
} from './pulseData.helpers'

export interface PulseData {
  loading: boolean
  error: string | null
  /** Total sessions in the current range. */
  sessions: number
  /** Current + longest consecutive-day streaks, in the current range's
   *  underlying history (streaks always look at ALL history for continuity;
   *  see note in usePulseData body). */
  currentStreak: number
  longestStreak: number
  /** Local hour-of-day (0-23) with the most session starts, in range. Null
   *  when there's no session data to compute a peak from. */
  peakHour: number | null
  /** Distinct calendar days with >=1 session, in range. */
  activeDays: number
  /** Fixed ~6-month heatmap, independent of `range` (see file header). Kept
   *  for any other consumer of the raw grid data — the Activity CARD itself
   *  now renders `weeklyActivity` below, not this (V1 rebuild). */
  heatmap: HeatmapCell[]
  /** Trailing 7 calendar days (Mon..Sun), independent of `range` for the
   *  same reason the heatmap is — the Activity card's own fixed-window
   *  small-multiples chart data (V1 rebuild), not a range-filtered stat. */
  weeklyActivity: WeeklyActivityDay[]
}

export function usePulseData(range: DashboardRange): PulseData {
  const [allSessions, setAllSessions] = useState<SessionRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.sessions
      .listAll()
      .then((rows) => {
        if (!cancelled) setAllSessions(rows)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load sessions')
          setAllSessions([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  return useMemo(() => {
    const loading = allSessions === null

    if (loading || allSessions === null) {
      return {
        loading: true,
        error,
        sessions: 0,
        currentStreak: 0,
        longestStreak: 0,
        peakHour: null,
        activeDays: 0,
        heatmap: [],
        weeklyActivity: []
      }
    }

    const ranged = filterByRange(allSessions, range)

    // Streaks intentionally derive from the FULL history, not the ranged
    // slice: a "7d" range filter shouldn't make a 40-day streak look broken
    // just because day 8 falls outside the window. The streak tile answers
    // "how many days in a row have I shown up", which is range-independent
    // by nature (same reasoning GitHub's own streak counters use).
    const { current: currentStreak, longest: longestStreak } = computeStreaks(allSessions)

    return {
      loading: false,
      error,
      sessions: sessionsCount(ranged),
      currentStreak,
      longestStreak,
      peakHour: computePeakHour(ranged),
      activeDays: activeDaysCount(ranged),
      // Heatmap always spans its own fixed 6-month window (see file header),
      // computed from full history so a "7d" range doesn't blank it out.
      heatmap: computeHeatmap(allSessions),
      // Same reasoning — the Activity card's own fixed trailing-7-day window,
      // computed from full history so it doesn't depend on `range`.
      weeklyActivity: computeWeeklyActivity(allSessions)
    }
  }, [allSessions, range, error])
}
