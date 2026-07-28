// ---------------------------------------------------------------------------
// PrTable — the "Open PRs" card (Dashboard Phase 2, U5). Renders REAL
// account-wide open PRs from `useGithubData` (backed by `gh search prs
// --author @me`), ordered by last push (updatedAt desc — the search API's
// own last-activity timestamp, used here as the "last push" proxy per the
// design spec).
//
// TWO-LINE rows, mockup's `.l2row` pattern:
//   Line 1: title (truncates).
//   Line 2: repo (mono muted, truncates, flex:0 1 auto) · ONE checks chip
//     (passing/failing/pending/none, the defined 4-state set — never a
//     blank cell), PINNED right (shrink-0) · draft chip when
//     `state === 'draft'`.
// Row click opens the PR's GitHub url via `window.api.shell.openExternal`.
//
// V4 — a subtle GithubLogo sits before the "Open PRs" card title (DashboardCard's
// `title` widened to ReactNode to allow it); a tasteful inline mark, not loud.
//
// V1 REBUILD — overflow hardening: the outer <table> is table-layout:fixed
// with explicit widths on every column except Title (the one column that's
// allowed to flex), matching dashboard-v3.html's .col-num/.col-time —
// otherwise a very long title/repo can blow out the card's fixed width.
// Counts run through formatCompact so a busy account's "140 open" still fits
// the meta line.
// ---------------------------------------------------------------------------

import { useState } from 'react'
import { GithubLogo } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import type { GhSearchPr } from '@shared/types'
import { DashboardCard } from './DashboardCard'
import { TablePager } from './TablePager'
import { TableRowsSkeleton } from './DashboardSkeletons'
import { GithubCardFilters, GithubFilteredEmptyState } from './GithubCardFilters'
import { formatCompact, formatCompactAge } from './dashboardHome.helpers'

// PRs paginate 5/page — keeps the card a
// fixed height instead of dumping every open PR into one tall table.
const PR_PAGE_SIZE = 5
type PrFilter = 'all' | 'passing' | 'failing' | 'pending' | 'draft' | 'none'

const PR_FILTER_OPTIONS: ReadonlyArray<{ value: PrFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'passing', label: 'Passing' },
  { value: 'failing', label: 'Failing' },
  { value: 'pending', label: 'Pending' },
  { value: 'draft', label: 'Draft' },
  { value: 'none', label: 'No checks' }
]

type ChecksState = GhSearchPr['checks'] // 'success' | 'failure' | 'pending' | null

const CHECK_LABEL: Record<'success' | 'failure' | 'pending' | 'none', string> = {
  success: '✓ Passing',
  failure: '✕ Failing',
  pending: '◷ Pending',
  none: '— No Checks'
}

// THEME RULE: checks chips use Orpheus tokens, not raw GitHub colors —
// passing/failing reuse the existing --color-gh-open/--color-gh-closed
// tokens (already the app's green/red convention for PR state, see
// DetailsTab.css), pending reuses --accent, none is a bare muted border.
// Correct in light + dark since every value is a token, not a literal hex.
const CHECK_CLASS: Record<'success' | 'failure' | 'pending' | 'none', string> = {
  success: 'text-[color:var(--color-gh-open)] bg-[color:var(--color-gh-open)]/12',
  failure: 'text-[color:var(--color-gh-closed)] bg-[color:var(--color-gh-closed)]/12',
  pending: 'text-accent bg-accent/12',
  none: 'text-text-muted border border-border-default'
}

function checksKey(checks: ChecksState): 'success' | 'failure' | 'pending' | 'none' {
  return checks ?? 'none'
}

function CheckChip({ checks }: { checks: ChecksState }): React.JSX.Element {
  const key = checksKey(checks)
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-[5px] px-1.5 py-0.5 font-mono text-[9px] whitespace-nowrap',
        CHECK_CLASS[key]
      )}
    >
      {CHECK_LABEL[key]}
    </span>
  )
}

function EmptyState({ hint }: { hint: boolean }): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 py-10 text-center">
      <div className="text-[12.5px] font-medium text-text-primary">No open PRs</div>
      {hint ? (
        <div className="text-[11px] text-text-muted">
          GitHub unavailable — check that `gh` is installed and authenticated.
        </div>
      ) : null}
    </div>
  )
}

export interface PrTableProps {
  loading: boolean
  prs: GhSearchPr[]
  openPrCount: number
  draftPrCount: number
  possiblyUnavailable: boolean
}

export function PrTable({
  loading,
  prs,
  openPrCount,
  draftPrCount,
  possiblyUnavailable
}: PrTableProps): React.JSX.Element {
  const [requestedPage, setPage] = useState(0)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<PrFilter>('all')

  const normalizedQuery = query.trim().toLowerCase()
  const filteredPrs = prs.filter((pr) => {
    const matchesQuery =
      normalizedQuery.length === 0 ||
      `${pr.title} ${pr.repo} #${pr.number} ${pr.number}`.toLowerCase().includes(normalizedQuery)
    const matchesFilter =
      filter === 'all' ||
      (filter === 'draft' && pr.state === 'draft') ||
      (filter === 'passing' && pr.checks === 'success') ||
      (filter === 'failing' && pr.checks === 'failure') ||
      (filter === 'pending' && pr.checks === 'pending') ||
      (filter === 'none' && pr.checks === null)
    return matchesQuery && matchesFilter
  })
  const pageCount = Math.max(1, Math.ceil(filteredPrs.length / PR_PAGE_SIZE))
  // Background refreshes can shrink the row count under the current page
  // (e.g. a PR merged elsewhere) — clamp during render rather than storing
  // out-of-range state and correcting it in an effect (avoids the extra
  // cascading render an effect-driven setState would cause).
  const page = Math.min(requestedPage, pageCount - 1)

  const pagedPrs = filteredPrs.slice(page * PR_PAGE_SIZE, page * PR_PAGE_SIZE + PR_PAGE_SIZE)

  const meta = loading
    ? 'Loading…'
    : `${formatCompact(openPrCount)} Open · ${formatCompact(draftPrCount)} Draft · By Last Updated`

  function openPr(url: string): void {
    void window.api.shell.openExternal(url)
  }

  function updateQuery(value: string): void {
    setQuery(value)
    setPage(0)
  }

  function updateFilter(value: PrFilter): void {
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
      Open PRs
    </span>
  )

  if (loading && prs.length === 0) {
    return (
      <DashboardCard title={title} meta={meta} contentClassName="min-h-[284px]">
        <TableRowsSkeleton rows={5} />
      </DashboardCard>
    )
  }

  return (
    <DashboardCard title={title} meta={meta} contentClassName="min-h-[284px]">
      {prs.length === 0 ? (
        <EmptyState hint={possiblyUnavailable} />
      ) : (
        <>
          <GithubCardFilters<PrFilter>
            query={query}
            searchLabel="Search pull requests"
            placeholder="Search PRs"
            onQueryChange={updateQuery}
            filter={filter}
            defaultFilter="all"
            filterLabel="Pull request filter"
            filterOptions={PR_FILTER_OPTIONS}
            onFilterChange={updateFilter}
            onReset={resetFilters}
          />
          {filteredPrs.length === 0 ? (
            <GithubFilteredEmptyState />
          ) : (
            <div className="-mx-1 flex flex-1 flex-col overflow-x-auto pt-2">
              <table className="w-full table-fixed border-collapse text-xs">
                <colgroup>
                  <col className="w-[42px]" />
                  <col />
                  <col className="w-14" />
                </colgroup>
                <thead>
                  <tr>
                    <th className="border-b border-border-default px-2.5 pb-1.5 text-left font-mono text-[9.5px] tracking-wider text-text-muted uppercase">
                      #
                    </th>
                    <th className="border-b border-border-default px-2.5 pb-1.5 text-left font-mono text-[9.5px] tracking-wider text-text-muted uppercase">
                      Title
                    </th>
                    <th className="border-b border-border-default px-2.5 pb-1.5 text-right font-mono text-[9.5px] tracking-wider text-text-muted uppercase">
                      Updated
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {pagedPrs.map((pr) => (
                    <tr
                      key={`${pr.repo}#${pr.number}`}
                      onClick={() => openPr(pr.url)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') openPr(pr.url)
                      }}
                      role="link"
                      tabIndex={0}
                      aria-label={`Open pull request ${pr.repo} number ${pr.number}: ${pr.title}`}
                      className="cursor-pointer align-top hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
                    >
                      {/* Single <td> per logical column spans both visual lines via
                      a flex-col wrapper. Line 1 = title (truncates); line 2 =
                      repo (truncates, min-w-0) · checks chip pinned right
                      (shrink-0), matching the mockup's .l2row pattern. */}
                      <td className="border-b border-border-default px-2.5 py-2 align-top font-mono text-[10.5px] text-text-muted tabular-nums">
                        #{pr.number}
                      </td>
                      <td className="border-b border-border-default px-2.5 py-2 align-top">
                        <div className="flex items-center gap-1.5">
                          <span className="min-w-0 truncate text-text-primary">{pr.title}</span>
                          {pr.state === 'draft' ? (
                            <span className="shrink-0 rounded border border-border-default px-1 py-px font-mono text-[9px] tracking-wide text-text-muted uppercase">
                              Draft
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5">
                          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-text-muted">
                            {pr.repo}
                          </span>
                          <CheckChip checks={pr.checks} />
                        </div>
                      </td>
                      <td className="border-b border-border-default px-2.5 py-2 text-right align-top font-mono text-[10.5px] whitespace-nowrap text-text-muted tabular-nums">
                        {formatCompactAge(pr.updatedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {pageCount > 1 ? (
                <TablePager
                  page={page + 1}
                  pageCount={pageCount}
                  onPrev={() => setPage((p) => Math.max(0, p - 1))}
                  onNext={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                />
              ) : null}
            </div>
          )}
        </>
      )}
    </DashboardCard>
  )
}
