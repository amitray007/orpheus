import { ArrowClockwise, GithubLogo } from '@phosphor-icons/react'
import { IssuesTableContent } from '../../dashboard-home/IssuesTable'
import { PrTableContent } from '../../dashboard-home/PrTable'
import { formatCompact } from '../../dashboard-home/dashboardHome.helpers'
import { refreshHomeSource } from '../homeStore'
import type { HomePageProps } from '../home.types'

function freshnessLabel(fetchedAt: number | undefined, refreshing: boolean, stale: boolean): string {
  if (refreshing) return 'Refreshing…'
  if (fetchedAt === undefined) return 'Not refreshed yet'
  if (stale) return 'Showing cached results'
  return `Updated ${new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(fetchedAt)}`
}

function RetryButton(): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => refreshHomeSource('github')}
      className="inline-flex items-center gap-1.5 rounded-md border border-border-default bg-surface-overlay px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-accent hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
    >
      <ArrowClockwise size={14} aria-hidden="true" />
      Retry
    </button>
  )
}

export function GithubPage({ snapshot }: HomePageProps): React.JSX.Element {
  const source = snapshot.github
  const { prs, issues } = source.data
  const workCount = prs.length + issues.length
  const hasRows = workCount > 0
  const unavailable = source.unavailable || Boolean(source.error)
  const status = freshnessLabel(source.fetchedAt, source.refreshing, source.stale)

  return (
    <section
      className="mx-auto flex w-full max-w-[1180px] flex-col gap-5"
      aria-labelledby="home-page-title"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1
            id="home-page-title"
            tabIndex={-1}
            className="flex items-center gap-2 text-xl font-semibold text-text-primary outline-none"
          >
            <GithubLogo size={20} weight="fill" className="text-text-muted" aria-hidden="true" />
            GitHub work
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            {source.loading && !hasRows
              ? 'Loading your open pull requests and assigned issues…'
              : `${formatCompact(workCount)} open item${workCount === 1 ? '' : 's'} across your account`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-text-muted" aria-live="polite">
            {status}
          </span>
          <RetryButton />
        </div>
      </header>

      {unavailable && !hasRows ? (
        <div className="rounded-lg border border-border-default bg-surface-raised p-5">
          <h2 className="text-sm font-medium text-text-primary">GitHub is unavailable</h2>
          <p className="mt-1 text-sm text-text-secondary">
            {source.error ?? 'Check that gh is installed and authenticated, then retry.'}
          </p>
          <div className="mt-4">
            <RetryButton />
          </div>
        </div>
      ) : (
        <>
          {unavailable ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-default bg-surface-raised px-4 py-3 text-sm text-text-secondary">
              <span>{source.error ?? 'GitHub is unavailable. Showing the last available results.'}</span>
              <RetryButton />
            </div>
          ) : null}
          <div className="grid gap-5 xl:grid-cols-2">
            <PrTableContent
              loading={source.loading}
              prs={prs}
              unavailable={source.unavailable}
              meta={`${formatCompact(prs.length)} open · by last push`}
            />
            <IssuesTableContent
              loading={source.loading}
              issues={issues}
              unavailable={source.unavailable}
              meta={`${formatCompact(issues.length)} assigned · by updated`}
            />
          </div>
        </>
      )}
    </section>
  )
}
