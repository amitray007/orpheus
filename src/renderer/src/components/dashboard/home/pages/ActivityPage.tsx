import { ActivityChart } from '../../dashboard-home/ActivityChart'
import { DashboardCard } from '../../dashboard-home/DashboardCard'
import { AccessibleActivitySummary } from '../AccessibleActivitySummary'
import { HomePageFrame } from './HomePageFrame'
import type { HomeActivitySnapshot, HomePageProps } from '../home.types'

function emptyActivityMessage({
  loading,
  error,
  unavailable
}: HomePageProps['snapshot']['activity']): string {
  if (loading) return 'Loading activity…'
  if (error) return error
  if (unavailable) return 'Activity is unavailable.'
  return 'No activity is available yet.'
}

function WeeklyActivity({ activity }: { activity: HomeActivitySnapshot }): React.JSX.Element {
  const sessions = activity.summaries.reduce((total, day) => total + day.sessions, 0)
  const messages = activity.summaries.reduce((total, day) => total + day.messages, 0)

  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="activity-weekly-title">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 id="activity-weekly-title" className="text-sm font-semibold text-text-primary">
              This week
            </h2>
            <p className="mt-1 text-xs text-text-secondary">Monday through Sunday</p>
          </div>
          <p className="text-sm text-text-secondary">
            <span className="font-mono font-semibold text-text-primary tabular-nums">
              {sessions}
            </span>{' '}
            sessions ·{' '}
            <span className="font-mono font-semibold text-text-primary tabular-nums">
              {messages}
            </span>{' '}
            messages
          </p>
        </div>
        <DashboardCard title="Activity" meta="this week · Mon–Sun">
          <ActivityChart days={activity.summaries} loading={false} />
        </DashboardCard>
      </section>
      <AccessibleActivitySummary
        days={activity.summaries}
        providerLabel={activity.provider.label}
      />
    </div>
  )
}

export function ActivityPage({ snapshot }: HomePageProps): React.JSX.Element {
  const weeklyActivity = snapshot.activity.data.filter((activity) =>
    activity.supportedRanges.includes('weekly')
  )
  const hasActivity = weeklyActivity.length > 0

  return (
    <HomePageFrame
      title="Activity"
      source={snapshot.activity}
      emptyCopy="No activity is available yet."
    >
      {!hasActivity ? (
        <div className="rounded-lg border border-border-default bg-surface-raised p-5 text-sm text-text-secondary">
          {emptyActivityMessage(snapshot.activity)}
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {snapshot.activity.error ? (
            <p role="status" className="text-sm text-text-secondary">
              Could not refresh activity: {snapshot.activity.error}. Showing the most recent data.
            </p>
          ) : null}
          <p className="text-sm text-text-secondary">
            Weekly activity is the only available range.
          </p>
          {weeklyActivity.map((activity) => (
            <WeeklyActivity key={activity.provider.id} activity={activity} />
          ))}
        </div>
      )}
    </HomePageFrame>
  )
}
