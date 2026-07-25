import { DashboardCard } from '../../dashboard-home/DashboardCard'
import { StatTile } from '../../dashboard-home/StatTile'
import { formatCompact } from '../../dashboard-home/dashboardHome.helpers'
import type {
  HomePageId,
  HomePageProps,
  HomeSourceState,
  ProviderLimitSnapshot
} from '../home.types'

function localDateLabel(): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  }).format(new Date())
}

function actionCopy<T>(source: HomeSourceState<T>, count: number, emptyCopy: string): string {
  if (source.loading) return 'Loading…'
  if (source.error) return source.error
  if (source.unavailable) return 'Unavailable'
  return count === 0 ? emptyCopy : formatCompact(count)
}

function LimitsPreview({
  source
}: {
  source: HomeSourceState<ProviderLimitSnapshot[]>
}): React.JSX.Element {
  if (source.loading) {
    return <div className="h-16 animate-pulse rounded bg-surface-overlay" />
  }
  if (source.unavailable) {
    return <p className="text-xs text-text-muted">Usage is unavailable.</p>
  }
  if (source.error) {
    return <p className="text-xs text-text-muted">{source.error}</p>
  }
  const buckets = source.data[0]?.buckets.slice(0, 2) ?? []
  if (buckets.length === 0) {
    return <p className="text-xs text-text-muted">No usage limits are available.</p>
  }
  return (
    <div className="flex flex-col gap-3">
      {buckets.map((bucket) => {
        const percent = bucket.total ? Math.round(((bucket.used ?? 0) / bucket.total) * 100) : null
        return (
          <div key={bucket.id} className="flex flex-col gap-1">
            <div className="flex justify-between text-xs text-text-secondary">
              <span>{bucket.label}</span>
              <span className="font-mono tabular-nums">
                {percent === null ? '—' : `${percent}%`}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-overlay">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${percent ?? 0}%` }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function metricValue<T>(source: HomeSourceState<T>, value: number): string {
  if (source.loading) return 'Loading…'
  if (source.error || source.unavailable || source.fetchedAt === undefined) return '—'
  return formatCompact(value)
}

function navigationInput(event: React.MouseEvent<HTMLButtonElement>): 'pointer' | 'keyboard' {
  return event.detail === 0 ? 'keyboard' : 'pointer'
}

function HomeRouteCard({
  title,
  value,
  detail,
  page,
  onNavigate
}: {
  title: string
  value: string
  detail: string
  page: HomePageId
  onNavigate: HomePageProps['onNavigate']
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={(event) =>
        onNavigate({ surface: 'home', homePage: page, input: navigationInput(event) })
      }
      className="min-h-28 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <DashboardCard title={title} className="h-full transition-colors hover:bg-surface-overlay">
        <div className="flex flex-1 flex-col justify-between gap-3">
          <span className="font-mono text-2xl font-semibold text-text-primary tabular-nums">
            {value}
          </span>
          <span className="text-xs text-text-secondary">{detail}</span>
        </div>
      </DashboardCard>
    </button>
  )
}

export function HomeOverviewPage({ snapshot, onNavigate }: HomePageProps): React.JSX.Element {
  const weeklyStats = snapshot.stats.data.find((stats) => stats.window === 'weekly')
  const allStats = snapshot.stats.data.find((stats) => stats.window === 'all')
  return (
    <section
      className="mx-auto flex w-full max-w-[1180px] flex-col gap-6"
      aria-labelledby="home-page-title"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <h1
          id="home-page-title"
          tabIndex={-1}
          className="text-xl font-semibold text-text-primary outline-none"
        >
          Home
        </h1>
        <p className="text-sm text-text-secondary">{localDateLabel()}</p>
      </header>

      <section className="flex flex-col gap-2.5" aria-label="Needs your attention">
        <h2 className="text-sm font-semibold text-text-primary">Needs you now</h2>
        <div className="grid grid-cols-1 gap-3 min-[620px]:grid-cols-3">
          <HomeRouteCard
            title="Needs you now"
            value={actionCopy(snapshot.actions, snapshot.counts.needsYou, 'All clear')}
            detail="Agent input and completed runs"
            page="needs-you"
            onNavigate={onNavigate}
          />
          <HomeRouteCard
            title="Live agents"
            value={actionCopy(snapshot.agents, snapshot.counts.liveAgents, 'No live agents')}
            detail="Working, waiting, and ready workspaces"
            page="live-agents"
            onNavigate={onNavigate}
          />
          <HomeRouteCard
            title="GitHub"
            value={actionCopy(snapshot.github, snapshot.counts.github, 'No open work')}
            detail="Your open pull requests and assigned issues"
            page="github"
            onNavigate={onNavigate}
          />
        </div>
      </section>

      <section className="flex flex-col gap-2.5" aria-label="Your pulse">
        <h2 className="text-sm font-semibold text-text-primary">Your pulse</h2>
        <div className="grid grid-cols-1 gap-3 min-[760px]:grid-cols-[0.9fr_1.1fr_0.9fr]">
          <button
            type="button"
            onClick={(event) =>
              onNavigate({ surface: 'home', homePage: 'limits', input: navigationInput(event) })
            }
            className="min-h-44 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <DashboardCard
              title="Limits"
              variant="primary"
              className="h-full transition-colors hover:bg-surface-overlay"
            >
              <LimitsPreview source={snapshot.limits} />
            </DashboardCard>
          </button>
          <HomeRouteCard
            title="Activity"
            value={metricValue(snapshot.activity, weeklyStats?.sessions ?? 0)}
            detail={snapshot.activity.error ?? 'Claude sessions this week'}
            page="activity"
            onNavigate={onNavigate}
          />
          <button
            type="button"
            onClick={(event) =>
              onNavigate({ surface: 'home', homePage: 'stats', input: navigationInput(event) })
            }
            className="min-h-44 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <DashboardCard
              title="Stats"
              className="h-full transition-colors hover:bg-surface-overlay"
            >
              <div className="flex flex-1 items-center justify-around gap-3">
                <StatTile
                  label="Weekly tokens"
                  value={metricValue(snapshot.stats, weeklyStats?.tokens ?? 0)}
                  loading={snapshot.stats.loading}
                />
                <StatTile
                  label="All sessions"
                  value={metricValue(snapshot.stats, allStats?.sessions ?? 0)}
                  loading={snapshot.stats.loading}
                />
              </div>
            </DashboardCard>
          </button>
        </div>
      </section>
    </section>
  )
}
