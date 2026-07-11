// ---------------------------------------------------------------------------
// IssuesTable — the "Issues assigned" card (Dashboard Phase 2, U5). Renders
// REAL account-wide open issues from `useGithubData` (backed by `gh search
// issues --assignee @me`), ordered by updatedAt desc.
//
// TWO-LINE rows, mockup's `.l2row` pattern:
//   Line 1: title (truncates).
//   Line 2: repo (mono muted, truncates, flex:0 1 auto) · ONE label chip,
//     PINNED right (shrink-0) — the PRIMARY/first label only
//     (`issue.labels[0]`), never the full label set: the mockup explicitly
//     shows a single chip per row, and an issue with 5+ labels would
//     otherwise blow the line-2 row out or force a second wrap. Rendered
//     with the ACTUAL GitHub label color (`GhLabel.color`, hex with no
//     leading '#') — the ONE place in this table a real external color is
//     allowed per the THEME RULE; everything else uses Orpheus tokens.
// Row click opens the issue's GitHub url via `window.api.shell.openExternal`.
//
// V1 REBUILD — overflow hardening: table-layout:fixed with explicit widths
// on every column but Title, matching PrTable's hardening. Counts run
// through formatCompact.
// ---------------------------------------------------------------------------

import { useState } from 'react'
import { DashboardCard } from './DashboardCard'
import { TablePager } from './TablePager'
import { TableRowsSkeleton } from './DashboardSkeletons'
import { useGithubData } from './useGithubData'
import { formatCompact, formatCompactAge } from './dashboardHome.helpers'

// Issues paginate 10/page (exact size from the design spec) — keeps the
// card a fixed height instead of dumping every assigned issue in one table.
const ISSUE_PAGE_SIZE = 10

function EmptyState({ hint }: { hint: boolean }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-10 text-center">
      <div className="text-[12.5px] font-medium text-text-primary">No assigned issues</div>
      {hint ? (
        <div className="text-[11px] text-text-muted">
          GitHub unavailable — check that `gh` is installed and authenticated.
        </div>
      ) : null}
    </div>
  )
}

export function IssuesTable(): React.JSX.Element {
  const { loading, issues, openIssueCount, possiblyUnavailable } = useGithubData()
  const [requestedPage, setPage] = useState(0)

  const pageCount = Math.max(1, Math.ceil(issues.length / ISSUE_PAGE_SIZE))
  // Background refreshes can shrink the row count under the current page —
  // clamp during render rather than storing out-of-range state and
  // correcting it in an effect (avoids the extra cascading render an
  // effect-driven setState would cause).
  const page = Math.min(requestedPage, pageCount - 1)

  const pagedIssues = issues.slice(page * ISSUE_PAGE_SIZE, page * ISSUE_PAGE_SIZE + ISSUE_PAGE_SIZE)

  const meta = loading ? 'loading…' : `${formatCompact(openIssueCount)} · by updated`

  function openIssue(url: string): void {
    void window.api.shell.openExternal(url)
  }

  if (loading && issues.length === 0) {
    return (
      <DashboardCard title="Issues assigned" meta={meta}>
        <TableRowsSkeleton rows={5} />
      </DashboardCard>
    )
  }

  return (
    <DashboardCard title="Issues assigned" meta={meta}>
      {issues.length === 0 ? (
        <EmptyState hint={possiblyUnavailable} />
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
                // Primary/first label only — never the full label set (see
                // header comment). Undefined when an issue has no labels,
                // which the line-2 row below tolerates (repo alone).
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
                              // The ONE place a real external (non-token) color
                              // is allowed — GitHub's own label color, per the
                              // THEME RULE. `--lc` is the raw hex; color-mix
                              // derives the tinted bg/border from it so the
                              // chip still reads correctly in light + dark
                              // without a separate per-theme hex table.
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
              onPrev={() => setPage((p) => Math.max(0, p - 1))}
              onNext={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            />
          ) : null}
        </div>
      )}
    </DashboardCard>
  )
}
