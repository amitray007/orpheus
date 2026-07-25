import { DashboardCard } from '../../dashboard-home/DashboardCard'
import { formatCompact } from '../../dashboard-home/dashboardHome.helpers'
import { formatHour12 } from '../../dashboard-home/pulseData.helpers'
import { StatTile } from '../../dashboard-home/StatTile'
import { HomePageFrame } from './HomePageFrame'
import type { HomePageProps, HomeStatsSnapshot } from '../home.types'

function emptyStatsMessage({
  loading,
  error,
  unavailable
}: HomePageProps['snapshot']['stats']): string {
  if (loading) return 'Loading statistics…'
  if (error) return error
  if (unavailable) return 'Statistics are unavailable.'
  return 'No statistics are available yet.'
}

function optionalMetric(value: number | undefined): string {
  return value === undefined ? '—' : formatCompact(value)
}

function WeeklyStats({ stats }: { stats: HomeStatsSnapshot }): React.JSX.Element {
  return (
    <DashboardCard title="This week" meta="last 7 days">
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 min-[620px]:grid-cols-5">
        <StatTile label="Sessions" value={optionalMetric(stats.sessions)} />
        <StatTile label="Tokens" value={optionalMetric(stats.tokens)} />
        <StatTile label="Active days" value={optionalMetric(stats.activeDays)} />
        <StatTile
          label="Current streak"
          value={optionalMetric(stats.streak)}
          unit={stats.streak === undefined || stats.streak === 0 ? undefined : 'd'}
        />
        <StatTile
          label="Peak hour"
          value={stats.peakHour === undefined ? '—' : formatHour12(stats.peakHour)}
        />
      </div>
    </DashboardCard>
  )
}

function AllHistoryStats({ stats }: { stats: HomeStatsSnapshot }): React.JSX.Element {
  return (
    <DashboardCard title="All history">
      <div className="grid grid-cols-2 gap-6">
        <StatTile label="Sessions" value={optionalMetric(stats.sessions)} />
        <StatTile label="Tokens" value={optionalMetric(stats.tokens)} />
      </div>
    </DashboardCard>
  )
}

export function StatsPage({ snapshot }: HomePageProps): React.JSX.Element {
  const weeklyStats = snapshot.stats.data.filter((stats) => stats.window === 'weekly')
  const allStats = snapshot.stats.data.filter((stats) => stats.window === 'all')
  const hasStats = weeklyStats.length > 0 || allStats.length > 0

  return (
    <HomePageFrame
      title="Stats"
      source={snapshot.stats}
      emptyCopy="No statistics are available yet."
    >
      {!hasStats ? (
        <div className="rounded-lg border border-border-default bg-surface-raised p-5 text-sm text-text-secondary">
          {emptyStatsMessage(snapshot.stats)}
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {snapshot.stats.error ? (
            <p role="status" className="text-sm text-text-secondary">
              Could not refresh statistics: {snapshot.stats.error}. Showing the most recent data.
            </p>
          ) : null}
          <div className="grid grid-cols-1 gap-5 min-[760px]:grid-cols-2">
            {weeklyStats.map((stats) => (
              <WeeklyStats key={stats.provider.id} stats={stats} />
            ))}
            {allStats.map((stats) => (
              <AllHistoryStats key={stats.provider.id} stats={stats} />
            ))}
          </div>
        </div>
      )}
    </HomePageFrame>
  )
}
