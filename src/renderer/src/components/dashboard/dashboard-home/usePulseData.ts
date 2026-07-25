import type { WeeklyActivityDay } from '@shared/types'
import { getHomeActivitySummary } from '../home/homeFacade'
import { useHomeSnapshot } from '../home/useHomeSnapshot'

export type { WeeklyActivityDay }

export interface PulseData {
  loading: boolean
  error: string | null
  sessions: number
  currentStreak: number
  peakHour: number | null
  activeDays: number
  weeklyActivity: WeeklyActivityDay[]
  allTimeSessions: number
  allTimeMessages: number
  tokensLast7Days: number
  allTimeTokens: number
}

/** Compatibility selector for the legacy pulse components. Activity scanning
 * and cache/push ownership live in the shared Home facade. */
export function usePulseData(): PulseData {
  const snapshot = useHomeSnapshot()
  const weekly = snapshot.stats.data.find((entry) => entry.window === 'weekly')
  const all = snapshot.stats.data.find((entry) => entry.window === 'all')
  const activitySummary = getHomeActivitySummary()
  return {
    loading: snapshot.activity.loading || snapshot.stats.loading,
    error: snapshot.activity.error ?? snapshot.stats.error,
    sessions: weekly?.sessions ?? 0,
    currentStreak: weekly?.streak ?? 0,
    peakHour: weekly?.peakHour ?? null,
    activeDays: weekly?.activeDays ?? 0,
    weeklyActivity: snapshot.activity.data[0]?.summaries ?? [],
    allTimeSessions: all?.sessions ?? 0,
    allTimeMessages: activitySummary?.allTimeMessages ?? 0,
    tokensLast7Days: weekly?.tokens ?? 0,
    allTimeTokens: all?.tokens ?? 0
  }
}
