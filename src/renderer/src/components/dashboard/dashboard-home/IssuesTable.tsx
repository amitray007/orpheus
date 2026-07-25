import { useState } from 'react'
import { GithubLogo } from '@phosphor-icons/react'
import type { GhSearchIssue } from '@shared/types'
import { DashboardCard } from './DashboardCard'
import { TablePager } from './TablePager'
import { TableRowsSkeleton } from './DashboardSkeletons'
import { useGithubData } from './useGithubData'
import { formatCompact, formatCompactAge } from './dashboardHome.helpers'

const ISSUE_PAGE_SIZE = 10

function EmptyState({ unavailable }: { unavailable: boolean }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-10 text-center">
      <div className="text-[12.5px] font-medium text-text-primary">
        {unavailable ? 'GitHub is unavailable' : 'No assigned issues'}
      </div>
      <div className="text-[11px] text-text-muted">
        {unavailable
          ? 'Check that gh is installed and authenticated, then retry.'
          : 'Nothing is assigned to you.'}
      </div>
    </div>
  )
}

export interface IssuesTableContentProps {
  loading: boolean
  issues: GhSearchIssue[]
  unavailable?: boolean
  meta?: string
  title?: React.ReactNode
}

/** Snapshot-fed table used by the home GitHub page without mounting its own data hook. */
export function IssuesTableContent({
  loading,
  issues,
  unavailable = false,
  meta = `${formatCompact(issues.length)} assigned · by updated`,
  title = 'Issues assigned'
}: IssuesTableContentProps): React.JSX.Element {
  const [requestedPage, setPage] = useState(0)
  const pageCount = Math.max(1, Math.ceil(issues.length / ISSUE_PAGE_SIZE))
  const page = Math.min(requestedPage, pageCount - 1)
  const pagedIssues = issues.slice(page * ISSUE_PAGE_SIZE, page * ISSUE_PAGE_SIZE + ISSUE_PAGE_SIZE)

  function openIssue(url: string): void {
    void window.api.shell.openExternal(url)
  }

  if (loading && issues.length === 0) {
    return (
      <DashboardCard title={title} meta={meta}>
        <TableRowsSkeleton rows={5} />
      </DashboardCard>
    )
  }

  return (
    <DashboardCard title={title} meta={meta}>
      {issues.length === 0 ? (
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
                  Updated
                </th>
              </tr>
            </thead>
            <tbody>
              {pagedIssues.map((issue) => {
                const primaryLabel = issue.labels[0]
                return (
                  <tr
                    key={`${issue.repo}#${issue.number}`}
                    onClick={() => openIssue(issue.url)}
                    className="cursor-pointer align-top hover:bg-surface-overlay"
                  >
                    <td className="border-b border-border-default px-2.5 py-2 align-top font-mono text-[10.5px] text-text-muted tabular-nums">
                      #{issue.number}
                    </td>
                    <td className="border-b border-border-default px-2.5 py-2 align-top">
                      <div className="truncate text-text-primary">{issue.title}</div>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-text-muted">
                          {issue.repo}
                        </span>
                        {primaryLabel ? (
                          <span
                            className="inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 font-mono text-[9.5px] whitespace-nowrap"
                            style={{
                              ['--lc' as string]: `#${primaryLabel.color}`,
                              color: 'var(--lc)',
                              background: 'color-mix(in srgb, var(--lc) 14%, transparent)',
                              borderColor: 'color-mix(in srgb, var(--lc) 35%, transparent)'
                            }}
                          >
                            {primaryLabel.name}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="border-b border-border-default px-2.5 py-2 text-right align-top font-mono text-[10.5px] whitespace-nowrap text-text-muted tabular-nums">
                      {formatCompactAge(issue.updatedAt)}
                    </td>
                  </tr>
                )
              })}
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
export function IssuesTable(): React.JSX.Element {
  const { loading, issues, openIssueCount, possiblyUnavailable } = useGithubData()
  const title = (
    <span className="inline-flex items-center gap-1.5">
      <GithubLogo size={14} weight="fill" className="text-text-muted" aria-hidden="true" />
      Issues assigned
    </span>
  )
  const meta = loading ? 'loading…' : `${formatCompact(openIssueCount)} · by updated`

  return (
    <IssuesTableContent
      loading={loading}
      issues={issues}
      unavailable={possiblyUnavailable}
      meta={meta}
      title={title}
    />
  )
}
