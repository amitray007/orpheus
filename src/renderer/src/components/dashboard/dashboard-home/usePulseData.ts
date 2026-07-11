// ---------------------------------------------------------------------------
// usePulseData — sources every "Your pulse" number from the REAL Claude
// activity scanner (`claude:activity`, src/main/claudeActivity.ts), which
// scans the on-disk `~/.claude/projects/**/*.jsonl` transcript store
// directly. This replaced an earlier version that derived these numbers from
// `sessions:listAll` (the Orpheus-registered-workspace session list) — that
// undercounted real Claude usage by ~40x, since the vast majority of a
// user's `claude` invocations never go through an Orpheus workspace.
//
// Stale-while-revalidate, mirroring useClaudeUsage.ts exactly: on mount, a
// disk-backed cached read (`activityCached()`) and the live scan
// (`activity()`) both kick off in parallel. Whichever resolves first paints
// the screen — if a cache row exists, the UI paints INSTANTLY with
// `loading: false`; the live scan then lands and silently overwrites state
// (no flash, no layout jump). `loading` is only ever true on a genuine
// first-ever load: no cache row AND the fresh scan hasn't landed yet.
//
// No renderer-side polling loop: the main process owns the background
// re-scan cadence (src/main/claudeActivityPoller.ts, every 3min, cheap
// steady-state thanks to claudeActivity.ts's per-file mtime/size cache).
// This hook just subscribes to the poller's pushes and applies them
// silently.
//
// `longestStreak`/`heatmap` from the old sessions:listAll-derived version
// are gone — the scanner doesn't compute a 6-month heatmap or an all-history
// "longest streak" (only the current one), and neither field had any
// consumer outside this file. `allTimeSessions`/`allTimeMessages` are new —
// free from the scanner's roll-up, for any future "N all-time" anchor UI.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react'
import type { ClaudeActivitySummary } from '@shared/types'
import type { WeeklyActivityDay } from './pulseData.helpers'

export type { WeeklyActivityDay }

export interface PulseData {
  loading: boolean
  error: string | null
  /** Real session count in the last 7 days (transcript file count, not
   *  Orpheus-workspace rows). */
  sessions: number
  /** Consecutive-day streak of real Claude activity, ending today or
   *  yesterday (see claudeActivity.ts's computeCurrentStreak). */
  currentStreak: number
  /** Local hour-of-day (0-23) with the most session-file activity in the
   *  last 7 days. Null when there's no data to compute a peak from. */
  peakHour: number | null
  /** Distinct calendar days with >=1 real session in the last 7 days. */
  activeDays: number
  /** Trailing 7 calendar days (Mon..Sun) of real sessions+messages — the
   *  Activity card's small-multiples chart data. */
  weeklyActivity: WeeklyActivityDay[]
  /** Total real session count across ALL history (every `.jsonl` file ever
   *  scanned), never limited to the 7-day window. */
  allTimeSessions: number
  /** Total real message count (summed line counts) across ALL history. */
  allTimeMessages: number
  /** Total tokens (input + output + cache read + cache creation) across
   *  sessions active in the last 7 days. */
  tokensLast7Days: number
  /** Same token sum as `tokensLast7Days`, across ALL history. */
  allTimeTokens: number
}

const EMPTY: Omit<PulseData, 'error'> = {
  loading: true,
  sessions: 0,
  currentStreak: 0,
  peakHour: null,
  activeDays: 0,
  weeklyActivity: [],
  allTimeSessions: 0,
  allTimeMessages: 0,
  tokensLast7Days: 0,
  allTimeTokens: 0
}

function fromSummary(summary: ClaudeActivitySummary): Omit<PulseData, 'error'> {
  return {
    loading: false,
    sessions: summary.sessionsLast7Days,
    currentStreak: summary.currentStreak,
    peakHour: summary.peakHour,
    activeDays: summary.activeDays,
    weeklyActivity: summary.weeklyActivity,
    allTimeSessions: summary.allTimeSessions,
    allTimeMessages: summary.allTimeMessages,
    tokensLast7Days: summary.tokensLast7Days,
    allTimeTokens: summary.allTimeTokens
  }
}

/** Takes no range argument (unlike the old sessions:listAll-derived
 *  version) — the real-activity scanner's window is fixed at a trailing 7
 *  days for every tile (see claudeActivity.ts), matching the Dashboard's
 *  own fixed-window design (no user-facing range picker). */
export function usePulseData(): PulseData {
  const [data, setData] = useState<Omit<PulseData, 'error'>>(EMPTY)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    void (async (): Promise<void> => {
      try {
        const cached = await window.api.claude.activityCached()
        if (cancelled || !cached) return
        setData(fromSummary(cached.value))
      } catch {
        // Cached read is best-effort — the live scan below is authoritative.
      }
    })()

    void (async (): Promise<void> => {
      try {
        const summary = await window.api.claude.activity()
        if (cancelled) return
        setData(fromSummary(summary))
        setError(null)
      } catch (err: unknown) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load activity')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  // Background poller pushes — silently adopt each fresh result as it
  // arrives, independent of the initial-load effect above. Purely additive:
  // never blanks/flashes.
  useEffect(() => {
    const off = window.api.claude.onActivityPushed((summary) => {
      setData(fromSummary(summary))
      setError(null)
    })
    return off
  }, [])

  return { ...data, error }
}
