import { useState } from 'react'
import {
  CheckCircle,
  CircleNotch,
  Clock,
  GithubLogo,
  MinusCircle,
  XCircle
} from '@phosphor-icons/react'
import type { GithubWorkflowRunSummary } from '@shared/types'
import { cn } from '@/lib/utils'
import { DashboardCard } from './DashboardCard'
import { TableRowsSkeleton } from './DashboardSkeletons'
import { TablePager } from './TablePager'
import { GithubCardFilters, GithubFilteredEmptyState } from './GithubCardFilters'
import { formatCompactAge } from './dashboardHome.helpers'

const PAGE_SIZE = 5

export type GithubActionStatus =
  | 'success'
  | 'failure'
  | 'in_progress'
  | 'queued'
  | 'cancelled'
  | 'neutral'

type ActionFilter = 'all' | GithubActionStatus

const ACTION_FILTER_OPTIONS: ReadonlyArray<{ value: ActionFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'success', label: 'Passed' },
  { value: 'failure', label: 'Failed' },
  { value: 'in_progress', label: 'Running' },
  { value: 'queued', label: 'Queued' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'neutral', label: 'Neutral' }
]

const STATUS_LABEL: Record<GithubActionStatus, string> = {
  success: 'Passed',
  failure: 'Failed',
  in_progress: 'Running',
  queued: 'Queued',
  cancelled: 'Cancelled',
  neutral: 'Neutral'
}

function normalizedStatus(action: GithubWorkflowRunSummary): GithubActionStatus {
  const conclusion = action.conclusion?.toLowerCase()
  if (conclusion === 'success') return 'success'
  if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'action_required') {
    return 'failure'
  }
  if (conclusion === 'cancelled' || conclusion === 'skipped') return 'cancelled'
  if (conclusion === 'neutral' || conclusion === 'stale') return 'neutral'

  const status = action.status.toLowerCase()
  if (status === 'in_progress' || status === 'waiting') return 'in_progress'
  if (status === 'queued' || status === 'requested' || status === 'pending') return 'queued'
  return 'neutral'
}

function StatusIcon({ status }: { status: GithubActionStatus }): React.JSX.Element {
  const shared = 'size-3.5 shrink-0'
  if (status === 'success') {
    return (
      <CheckCircle
        weight="fill"
        className={cn(shared, 'text-[color:var(--color-gh-open)]')}
        aria-hidden="true"
      />
    )
  }
  if (status === 'failure') {
    return (
      <XCircle
        weight="fill"
        className={cn(shared, 'text-[color:var(--color-gh-closed)]')}
        aria-hidden="true"
      />
    )
  }
  if (status === 'in_progress') {
    return <CircleNotch weight="bold" className={cn(shared, 'text-accent')} aria-hidden="true" />
  }
  if (status === 'queued') {
    return <Clock weight="fill" className={cn(shared, 'text-text-muted')} aria-hidden="true" />
  }
  return <MinusCircle weight="fill" className={cn(shared, 'text-text-muted')} aria-hidden="true" />
}

export function ActionsTable({
  actions,
  loading,
  unavailable = false,
  scopeRepositoryCount = 0,
  onOpen
}: {
  actions: GithubWorkflowRunSummary[]
  loading: boolean
  unavailable?: boolean
  scopeRepositoryCount?: number
  onOpen: (url: string) => void
}): React.JSX.Element {
  const [requestedPage, setPage] = useState(0)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ActionFilter>('all')
  const normalizedQuery = query.trim().toLowerCase()
  const filteredActions = actions.filter((action) => {
    const matchesQuery =
      normalizedQuery.length === 0 ||
      `${action.workflowName} ${action.repo} ${action.headBranch ?? ''}`
        .toLowerCase()
        .includes(normalizedQuery)
    return matchesQuery && (filter === 'all' || normalizedStatus(action) === filter)
  })
  const pageCount = Math.max(1, Math.ceil(filteredActions.length / PAGE_SIZE))
  const page = Math.min(requestedPage, pageCount - 1)
  const rows = filteredActions.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)

  function updateQuery(value: string): void {
    setQuery(value)
    setPage(0)
  }

  function updateFilter(value: ActionFilter): void {
    setFilter(value)
    setPage(0)
  }

  function resetFilters(): void {
    setQuery('')
    setFilter('all')
    setPage(0)
  }

  const title = (
    <span className="inline-flex items-center gap-1.5">
      <GithubLogo size={14} weight="fill" className="text-text-muted" aria-hidden="true" />
      Actions
    </span>
  )

  if (loading && actions.length === 0) {
    return (
      <DashboardCard
        title={title}
        meta="Loading…"
        className="h-full"
        contentClassName="min-h-[284px]"
      >
        <TableRowsSkeleton rows={5} />
      </DashboardCard>
    )
  }

  return (
    <DashboardCard
      title={title}
      meta={
        actions.length === 0
          ? undefined
          : `${actions.length} Recent · ${scopeRepositoryCount} Registered Repos`
      }
      className="h-full"
      contentClassName="min-h-[284px]"
    >
      {actions.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 py-8 text-center">
          <div className="text-[12.5px] font-medium text-text-primary">No recent workflows</div>
          <div className="max-w-60 text-[11px] text-text-muted">
            {unavailable
              ? 'GitHub Actions is unavailable for the registered repositories.'
              : scopeRepositoryCount === 0
                ? 'Link a GitHub repository to an Orpheus project to see workflow runs.'
                : 'Recent workflow runs will appear here.'}
          </div>
        </div>
      ) : (
        <>
          <GithubCardFilters<ActionFilter>
            query={query}
            searchLabel="Search workflow runs"
            placeholder="Search Actions"
            onQueryChange={updateQuery}
            filter={filter}
            defaultFilter="all"
            filterLabel="Workflow status filter"
            filterOptions={ACTION_FILTER_OPTIONS}
            onFilterChange={updateFilter}
            onReset={resetFilters}
          />
          {filteredActions.length === 0 ? (
            <GithubFilteredEmptyState />
          ) : (
            <div className="-mx-1 flex flex-1 flex-col pt-2">
              <div className="border-b border-border-default px-2.5 pb-1.5 font-mono text-[9.5px] tracking-wider text-text-muted uppercase">
                Recent Workflow Runs
              </div>
              {rows.map((action) => {
                const status = normalizedStatus(action)
                return (
                  <button
                    key={action.id}
                    type="button"
                    onClick={() => onOpen(action.url)}
                    className="flex min-w-0 items-center gap-2.5 border-b border-border-default px-2.5 py-2 text-left hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    <StatusIcon status={status} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-xs text-text-primary">
                        {action.workflowName}
                      </span>
                      <span className="truncate font-mono text-[10.5px] text-text-muted">
                        {action.repo}
                        {action.headBranch ? ` · ${action.headBranch}` : ''}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-px font-mono text-[10px]">
                      <span
                        className={cn(
                          status === 'failure'
                            ? 'text-[color:var(--color-gh-closed)]'
                            : 'text-text-secondary'
                        )}
                      >
                        {STATUS_LABEL[status]}
                      </span>
                      <span className="text-text-muted">{formatCompactAge(action.updatedAt)}</span>
                    </span>
                  </button>
                )
              })}
              {pageCount > 1 ? (
                <TablePager
                  page={page + 1}
                  pageCount={pageCount}
                  onPrev={() => setPage((value) => Math.max(0, value - 1))}
                  onNext={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
                />
              ) : null}
            </div>
          )}
        </>
      )}
    </DashboardCard>
  )
}
