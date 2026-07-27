import { useState } from 'react'
import { GitBranch, GithubLogo, LockSimple } from '@phosphor-icons/react'
import type { GithubRepositorySummary } from '@shared/types'
import { DashboardCard } from './DashboardCard'
import { TableRowsSkeleton } from './DashboardSkeletons'
import { TablePager } from './TablePager'
import { GithubCardFilters, GithubFilteredEmptyState } from './GithubCardFilters'
import { formatCompactAge } from './dashboardHome.helpers'

const PAGE_SIZE = 5
type RepositoryFilter = 'all' | 'public' | 'private'

const REPOSITORY_FILTER_OPTIONS: ReadonlyArray<{ value: RepositoryFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'public', label: 'Public' },
  { value: 'private', label: 'Private' }
]

export function RepositoriesTable({
  repositories,
  loading,
  unavailable = false,
  onOpen
}: {
  repositories: GithubRepositorySummary[]
  loading: boolean
  unavailable?: boolean
  onOpen: (url: string) => void
}): React.JSX.Element {
  const [requestedPage, setPage] = useState(0)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<RepositoryFilter>('all')
  const normalizedQuery = query.trim().toLowerCase()
  const filteredRepositories = repositories.filter((repository) => {
    const matchesQuery =
      normalizedQuery.length === 0 ||
      `${repository.nameWithOwner} ${repository.description ?? ''} ${repository.primaryLanguage ?? ''}`
        .toLowerCase()
        .includes(normalizedQuery)
    const matchesFilter =
      filter === 'all' ||
      (filter === 'private' && repository.isPrivate) ||
      (filter === 'public' && !repository.isPrivate)
    return matchesQuery && matchesFilter
  })
  const pageCount = Math.max(1, Math.ceil(filteredRepositories.length / PAGE_SIZE))
  const page = Math.min(requestedPage, pageCount - 1)
  const rows = filteredRepositories.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)

  function updateQuery(value: string): void {
    setQuery(value)
    setPage(0)
  }

  function updateFilter(value: RepositoryFilter): void {
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
      Recently updated
    </span>
  )

  if (loading && repositories.length === 0) {
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
        repositories.length === 0
          ? undefined
          : `${repositories.length} Repositories · By Last Updated`
      }
      className="h-full"
      contentClassName="min-h-[284px]"
    >
      {repositories.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 py-8 text-center">
          <div className="text-[12.5px] font-medium text-text-primary">
            No recently updated repositories
          </div>
          <div className="max-w-64 text-[11px] text-text-muted">
            {unavailable
              ? 'Repository activity is unavailable for this account.'
              : 'Repositories you update will appear here.'}
          </div>
        </div>
      ) : (
        <>
          <GithubCardFilters<RepositoryFilter>
            query={query}
            searchLabel="Search repositories"
            placeholder="Search repositories"
            onQueryChange={updateQuery}
            filter={filter}
            defaultFilter="all"
            filterLabel="Repository visibility filter"
            filterOptions={REPOSITORY_FILTER_OPTIONS}
            onFilterChange={updateFilter}
            onReset={resetFilters}
          />
          {filteredRepositories.length === 0 ? (
            <GithubFilteredEmptyState />
          ) : (
            <div className="-mx-1 flex flex-1 flex-col pt-2">
              <div className="border-b border-border-default px-2.5 pb-1.5 font-mono text-[9.5px] tracking-wider text-text-muted uppercase">
                Repository Activity
              </div>
              {rows.map((repo) => (
                <button
                  key={repo.nameWithOwner}
                  type="button"
                  onClick={() => onOpen(repo.url)}
                  className="flex min-w-0 items-center gap-2.5 border-b border-border-default px-2.5 py-2 text-left hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <GitBranch size={14} weight="bold" className="shrink-0 text-text-muted" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-xs font-medium text-text-primary">
                        {repo.nameWithOwner}
                      </span>
                      {repo.isPrivate ? (
                        <LockSimple size={11} weight="bold" className="shrink-0 text-text-muted" />
                      ) : null}
                    </span>
                    <span className="truncate text-[10.5px] text-text-muted">
                      {repo.description || repo.primaryLanguage || 'No Description'}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-text-muted tabular-nums">
                    {formatCompactAge(repo.pushedAt || repo.updatedAt)}
                  </span>
                </button>
              ))}
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
