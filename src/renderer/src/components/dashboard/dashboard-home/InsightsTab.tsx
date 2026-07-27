import {
  CalendarDots,
  CaretLeft,
  CaretRight,
  ChatCircleText,
  GitCommit,
  GitPullRequest,
  GithubLogo
} from '@phosphor-icons/react'
import type { ClaudeModelActivityDay, ClaudeRecentSession, WeeklyActivityDay } from '@shared/types'
import { DashboardCard } from './DashboardCard'
import { ActivityChart } from './ActivityChart'
import { RecentSessionsTable } from './RecentSessionsTable'
import { SourceRefreshButton } from './SourceRefreshButton'
import { StatTile } from './StatTile'
import { formatCompact } from './dashboardHome.helpers'
import { formatHour12 } from './pulseData.helpers'
import { useGithubContributionWindow } from './useGithubContributionWindow'

interface ModelTotal {
  model: string
  turns: number
  tokens: number
}

function modelTotals(days: ClaudeModelActivityDay[]): ModelTotal[] {
  const totals = new Map<string, { turns: number; tokens: number }>()
  for (const day of days) {
    const current = totals.get(day.model) ?? { turns: 0, tokens: 0 }
    current.turns += day.turns
    current.tokens += day.tokens
    totals.set(day.model, current)
  }
  return [...totals]
    .map(([model, values]) => ({ model, ...values }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 4)
}

function WorkRhythmCard({
  loading,
  peakHour,
  activeDays,
  longestStreak,
  sessions,
  modelActivity
}: {
  loading: boolean
  peakHour: number | null
  activeDays: number
  longestStreak: number
  sessions: number
  modelActivity: ClaudeModelActivityDay[]
}): React.JSX.Element {
  const models = modelTotals(modelActivity)
  const maxTokens = Math.max(1, ...models.map((model) => model.tokens))
  const emptyRows = Math.max(0, 4 - models.length)

  return (
    <DashboardCard title="Work Rhythm" className="h-full min-h-72">
      <div className="grid min-h-[68px] grid-cols-4 items-center gap-4 border-b border-border-default py-3">
        <StatTile
          label="Peak Hour"
          value={peakHour === null ? '—' : formatHour12(peakHour)}
          loading={loading}
        />
        <StatTile label="Active Days" value={`${activeDays}/7`} loading={loading} />
        <StatTile
          label="Longest Streak"
          value={String(longestStreak)}
          unit={longestStreak > 0 ? 'd' : undefined}
          loading={loading}
        />
        <StatTile label="Sessions" value={formatCompact(sessions)} loading={loading} />
      </div>

      <div className="flex flex-1 flex-col pt-3">
        <div className="mb-2 font-mono text-[9.5px] tracking-wider text-text-muted uppercase">
          Model Activity
        </div>
        {loading ? (
          <div className="grid h-[132px] grid-rows-4 gap-2">
            {[0, 1, 2, 3].map((row) => (
              <div key={row} className="grid grid-cols-[minmax(0,1fr)_2fr_auto] items-center gap-3">
                <div className="h-2.5 w-20 animate-pulse rounded bg-surface-overlay" />
                <div className="h-1.5 animate-pulse rounded-full bg-surface-overlay" />
                <div className="h-2.5 w-16 animate-pulse rounded bg-surface-overlay" />
              </div>
            ))}
          </div>
        ) : models.length === 0 ? (
          <div className="flex h-[132px] items-center justify-center text-center text-[11px] text-text-muted">
            Model-level activity will appear when it can be derived from recent transcripts.
          </div>
        ) : (
          <div className="grid h-[132px] grid-rows-4 gap-2">
            {models.map((model) => (
              <div
                key={model.model}
                className="grid grid-cols-[minmax(0,1fr)_2fr_auto] items-center gap-3"
              >
                <span className="truncate text-[11px] text-text-secondary">{model.model}</span>
                <div className="h-1.5 overflow-hidden rounded-full bg-surface-overlay">
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{ width: `${Math.max(4, (model.tokens / maxTokens) * 100)}%` }}
                  />
                </div>
                <span className="w-16 text-right font-mono text-[9.5px] text-text-muted tabular-nums">
                  {formatCompact(model.tokens)} tok
                </span>
              </div>
            ))}
            {Array.from({ length: emptyRows }).map((_, index) => (
              <div key={`empty-${index}`} aria-hidden="true" />
            ))}
          </div>
        )}
      </div>
    </DashboardCard>
  )
}

function parseCalendarDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!match) return new Date(value)
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

function formatRange(fromValue: string, toValue: string): string {
  const from = parseCalendarDate(fromValue)
  const to = parseCalendarDate(toValue)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 'Last 7 Days'
  const formatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
  return `${formatter.format(from)} – ${formatter.format(to)}`
}

function weekLabel(weekOffset: number): string {
  if (weekOffset === 0) return 'This Week'
  if (weekOffset === -1) return 'Last Week'
  return `${Math.abs(weekOffset)} Weeks Ago`
}

function toCalendarKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function localWeekRange(weekOffset: number): { rangeStart: string; rangeEnd: string } {
  const start = new Date()
  start.setHours(12, 0, 0, 0)
  const daysSinceMonday = (start.getDay() + 6) % 7
  start.setDate(start.getDate() - daysSinceMonday + weekOffset * 7)
  const end = new Date(start)
  end.setDate(start.getDate() + 6)
  return { rangeStart: toCalendarKey(start), rangeEnd: toCalendarKey(end) }
}

function InsightsWeekNavigator({
  weekOffset,
  rangeStart,
  rangeEnd,
  onPreviousWeek,
  onNextWeek
}: {
  weekOffset: number
  rangeStart: string
  rangeEnd: string
  onPreviousWeek: () => void
  onNextWeek: () => void
}): React.JSX.Element {
  return (
    <div
      className="inline-flex h-9 shrink-0 self-center border border-border-default bg-surface-raised"
      aria-label={`Activity insights for ${weekLabel(weekOffset)}`}
    >
      <button
        type="button"
        className="inline-flex h-full w-8 cursor-pointer items-center justify-center text-text-muted transition-[color,background-color,transform] hover:bg-surface-overlay hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 active:scale-95"
        aria-label="View previous week"
        title="View previous week"
        onClick={onPreviousWeek}
      >
        <CaretLeft size={12} weight="bold" aria-hidden="true" />
      </button>
      <div
        className="inline-flex h-full w-[116px] flex-col items-center justify-center border-x border-border-default px-1"
        aria-live="polite"
      >
        <span className="text-[10px] leading-3 font-medium whitespace-nowrap text-text-secondary">
          {weekLabel(weekOffset)}
        </span>
        <span className="mt-0.5 font-mono text-[9px] leading-3 whitespace-nowrap text-text-muted tabular-nums">
          {formatRange(rangeStart, rangeEnd)}
        </span>
      </div>
      <button
        type="button"
        className="inline-flex h-full w-8 cursor-pointer items-center justify-center text-text-muted transition-[color,background-color,transform] hover:bg-surface-overlay hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 active:scale-95 disabled:cursor-not-allowed disabled:opacity-35"
        aria-label="View next week"
        title={weekOffset === 0 ? 'Already viewing this week' : 'View next week'}
        disabled={weekOffset === 0}
        onClick={onNextWeek}
      >
        <CaretRight size={12} weight="bold" aria-hidden="true" />
      </button>
    </div>
  )
}

function GithubActivityCard({
  result,
  weekOffset,
  preparing,
  error
}: {
  result: Awaited<ReturnType<typeof window.api.github.contributionWindow>> | null
  weekOffset: number
  preparing: boolean
  error: string | null
}): React.JSX.Element {
  const currentResult = result?.weekOffset === weekOffset ? result : null
  const activity = currentResult?.activity ?? null
  const unavailable =
    currentResult?.status === 'unavailable' || (activity === null && Boolean(error))
  const isPreparing = preparing || (currentResult === null && error === null)
  const mix = [
    {
      label: 'Commits',
      value: activity?.commits ?? null,
      icon: GitCommit,
      accentClassName: 'bg-accent',
      iconClassName: 'text-accent'
    },
    {
      label: 'Pull Requests',
      value: activity?.pullRequests ?? null,
      icon: GitPullRequest,
      accentClassName: 'bg-[color:var(--color-chart-2)]',
      iconClassName: 'text-[color:var(--color-chart-2)]'
    },
    {
      label: 'Reviews',
      value: activity?.reviews ?? null,
      icon: ChatCircleText,
      accentClassName: 'bg-[color:var(--color-chart-3)]',
      iconClassName: 'text-[color:var(--color-chart-3)]'
    },
    {
      label: 'Issues',
      value: activity?.issues ?? null,
      icon: CalendarDots,
      accentClassName: 'bg-[color:var(--color-chart-4)]',
      iconClassName: 'text-[color:var(--color-chart-4)]'
    }
  ]
  return (
    <DashboardCard
      title={
        <span className="inline-flex items-center gap-1.5">
          <GithubLogo size={14} weight="fill" className="text-text-muted" aria-hidden="true" />
          GitHub Contributions
        </span>
      }
      className="h-full min-h-72"
    >
      <div
        className="grid min-h-52 flex-1 grid-cols-1 gap-4 py-2 min-[520px]:grid-cols-[minmax(120px,0.72fr)_minmax(0,1.7fr)]"
        aria-busy={isPreparing}
      >
        <div className="flex min-w-0 flex-col justify-center border-b border-border-default pb-4 min-[520px]:border-r min-[520px]:border-b-0 min-[520px]:pr-4 min-[520px]:pb-0">
          {isPreparing ? (
            <div className="h-11 w-24 animate-pulse rounded bg-surface-overlay" />
          ) : (
            <div className="font-mono text-4xl leading-11 font-semibold tracking-tight text-text-primary tabular-nums">
              {activity ? formatCompact(activity.totalContributions) : '—'}
            </div>
          )}
          <div
            className="mt-1 min-h-4 text-xs font-medium text-text-muted"
            title={error ?? undefined}
          >
            {unavailable ? 'Data Unavailable' : 'Total Contributions'}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {mix.map((item) => {
            const Icon = item.icon
            return (
              <div
                key={item.label}
                className="relative flex min-h-24 min-w-0 flex-col justify-between gap-3 overflow-hidden rounded border border-border-default bg-surface-overlay/35 p-3"
              >
                <span
                  className={`absolute inset-y-2 left-0 w-0.5 rounded-r ${item.accentClassName}`}
                  aria-hidden="true"
                />
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-text-secondary">
                  <Icon
                    size={14}
                    weight="bold"
                    className={`shrink-0 ${item.iconClassName}`}
                    aria-hidden="true"
                  />
                  <span className="truncate">{item.label}</span>
                </span>
                {isPreparing ? (
                  <span className="h-8 w-14 animate-pulse rounded bg-surface-overlay" />
                ) : (
                  <span className="font-mono text-2xl leading-8 font-semibold text-text-primary tabular-nums">
                    {item.value === null ? '—' : formatCompact(item.value)}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </DashboardCard>
  )
}

export function InsightsTab({
  weekOffset,
  claudePreparing,
  claudeRangeStart,
  claudeRangeEnd,
  refreshing = false,
  refreshError,
  claudeError,
  weeklyActivity,
  peakHour,
  activeDays,
  longestStreak,
  sessions,
  recentSessions,
  modelActivity,
  onWeekOffsetChange,
  onRefresh
}: {
  weekOffset: number
  claudePreparing: boolean
  claudeRangeStart?: string | null
  claudeRangeEnd?: string | null
  refreshing?: boolean
  refreshError?: string | null
  claudeError?: string | null
  weeklyActivity: WeeklyActivityDay[]
  peakHour: number | null
  activeDays: number
  longestStreak: number
  sessions: number
  recentSessions: ClaudeRecentSession[]
  modelActivity: ClaudeModelActivityDay[]
  onWeekOffsetChange: (weekOffset: number) => void
  onRefresh: () => void
}): React.JSX.Element {
  const contributions = useGithubContributionWindow(weekOffset)
  const immediateRange = localWeekRange(weekOffset)
  const githubReady = contributions.result?.weekOffset === weekOffset
  const claudeReady =
    claudeRangeStart?.slice(0, 10) === immediateRange.rangeStart &&
    claudeRangeEnd?.slice(0, 10) === immediateRange.rangeEnd
  const selectedClaudePreparing = claudePreparing || (!claudeReady && !claudeError)
  const selectedGithubPreparing = contributions.preparing || (!githubReady && !contributions.error)
  const displayedRange =
    githubReady && contributions.result
      ? {
          rangeStart: contributions.result.rangeStart,
          rangeEnd: contributions.result.rangeEnd
        }
      : immediateRange

  function refreshInsights(): void {
    onRefresh()
    contributions.refresh()
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-text-primary">Activity Insights</div>
          <div className="mt-0.5 truncate text-[11px] text-text-muted">
            Your recent Claude rhythm and GitHub contribution mix.
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <InsightsWeekNavigator
            weekOffset={weekOffset}
            rangeStart={displayedRange.rangeStart}
            rangeEnd={displayedRange.rangeEnd}
            onPreviousWeek={() => onWeekOffsetChange(weekOffset - 1)}
            onNextWeek={() => onWeekOffsetChange(Math.min(0, weekOffset + 1))}
          />
          <SourceRefreshButton
            refreshing={refreshing || contributions.refreshing}
            onRefresh={refreshInsights}
          />
        </div>
      </div>

      {refreshError || claudeError || contributions.error ? (
        <div
          role="status"
          className="border border-border-default bg-surface-overlay px-3 py-2 text-xs text-text-muted"
        >
          Part of the insight refresh failed. Showing the last available data.
        </div>
      ) : null}

      <div className="grid grid-cols-1 items-stretch gap-4 min-[840px]:grid-cols-2">
        <DashboardCard title="Claude Activity" className="h-full min-h-72">
          <ActivityChart
            days={weeklyActivity}
            loading={selectedClaudePreparing}
            expanded
            highlightToday={weekOffset === 0}
          />
        </DashboardCard>
        <WorkRhythmCard
          loading={selectedClaudePreparing}
          peakHour={peakHour}
          activeDays={activeDays}
          longestStreak={longestStreak}
          sessions={sessions}
          modelActivity={modelActivity}
        />
        <RecentSessionsTable
          key={weekOffset}
          sessions={recentSessions}
          loading={selectedClaudePreparing}
        />
        <GithubActivityCard
          result={contributions.result}
          weekOffset={weekOffset}
          preparing={selectedGithubPreparing}
          error={contributions.error}
        />
      </div>
    </div>
  )
}
