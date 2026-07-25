import { useState } from 'react'
import { GithubLogo } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import type { GhSearchPr } from '@shared/types'
import { DashboardCard } from './DashboardCard'
import { TablePager } from './TablePager'
import { TableRowsSkeleton } from './DashboardSkeletons'
import { useGithubData } from './useGithubData'
import { formatCompact, formatCompactAge } from './dashboardHome.helpers'

const PR_PAGE_SIZE = 10
type ChecksState = GhSearchPr['checks']

const CHECK_LABEL: Record<'success' | 'failure' | 'pending' | 'none', string> = {
  success: '✓ passing',
  failure: '✕ failing',
  pending: '◷ pending',
  none: '— none'
}

const CHECK_CLASS: Record<'success' | 'failure' | 'pending' | 'none', string> = {
  success: 'text-[color:var(--color-gh-open)] bg-[color:var(--color-gh-open)]/12',
  failure: 'text-[color:var(--color-gh-closed)] bg-[color:var(--color-gh-closed)]/12',
  pending: 'text-accent bg-accent/12',
  none: 'text-text-muted border border-border-default'
}

function CheckChip({ checks }: { checks: ChecksState }): React.JSX.Element {
  const key = checks ?? 'none'
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

function EmptyState({ unavailable }: { unavailable: boolean }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-10 text-center">
      <div className="text-[12.5px] font-medium text-text-primary">
        {unavailable ? 'GitHub is unavailable' : 'No open PRs'}
      </div>
      <div className="text-[11px] text-text-muted">
        {unavailable ? 'Check that gh is installed and authenticated, then retry.' : 'Nothing needs review.'}
      </div>
    </div>
  )
}

export interface PrTableContentProps {
  loading: boolean
  prs: GhSearchPr[]
  unavailable?: boolean
  meta?: string
  title?: React.ReactNode
}

/** Snapshot-fed table used by the home GitHub page without mounting its own data hook. */
export function PrTableContent({
  loading,
  prs,
  unavailable = false,
  meta = `${formatCompact(prs.length)} open · by last push`,
  title = 'Open PRs'
}: PrTableContentProps): React.JSX.Element {
  const [requestedPage, setPage] = useState(0)
  const pageCount = Math.max(1, Math.ceil(prs.length / PR_PAGE_SIZE))
  const page = Math.min(requestedPage, pageCount - 1)
  const pagedPrs = prs.slice(page * PR_PAGE_SIZE, page * PR_PAGE_SIZE + PR_PAGE_SIZE)

  function openPr(url: string): void {
    void window.api.shell.openExternal(url)
  }

  if (loading && prs.length === 0) {
    return (
      <DashboardCard title={title} meta={meta}>
        <TableRowsSkeleton rows={5} />
      </DashboardCard>
    )
  }

  return (
    <DashboardCard title={title} meta={meta}>
      {prs.length === 0 ? (
        <EmptyState unavailable={unavailable} />
      ) : (
        <div className="-mx-1 flex flex-1 flex-col overflow-x-auto">
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
                  Pushed
                </th>
              </tr>
            </thead>
            <tbody>
              {pagedPrs.map((pr) => (
                <tr
                  key={`${pr.repo}#${pr.number}`}
                  onClick={() => openPr(pr.url)}
                  className="cursor-pointer align-top hover:bg-surface-overlay"
                >
                  <td className="border-b border-border-default px-2.5 py-2 align-top font-mono text-[10.5px] text-text-muted tabular-nums">
                    #{pr.number}
                  </td>
                  <td className="border-b border-border-default px-2.5 py-2 align-top">
                    <div className="flex items-center gap-1.5">
                      <span className="min-w-0 truncate text-text-primary">{pr.title}</span>
                      {pr.state === 'draft' ? (
                        <span className="shrink-0 rounded border border-border-default px-1 py-px font-mono text-[9px] tracking-wide text-text-muted uppercase">
                          draft
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
              onPrev={() => setPage(Math.max(0, page - 1))}
              onNext={() => setPage(Math.min(pageCount - 1, page + 1))}
            />
          ) : null}
        </div>
      )}
    </DashboardCard>
  )
}

/** Compatibility wrapper for the legacy dashboard. */
export function PrTable(): React.JSX.Element {
  const { loading, prs, openPrCount, draftPrCount, possiblyUnavailable } = useGithubData()
  const title = (
    <span className="inline-flex items-center gap-1.5">
      <GithubLogo size={14} weight="fill" className="text-text-muted" aria-hidden="true" />
      Open PRs
    </span>
  )
  const meta = loading
    ? 'loading…'
    : `${formatCompact(openPrCount)} open${draftPrCount ? ` · ${formatCompact(draftPrCount)} draft` : ''} · by last push`

  return (
    <PrTableContent
      loading={loading}
      prs={prs}
      unavailable={possiblyUnavailable}
      meta={meta}
      title={title}
    />
  )
}
