// ---------------------------------------------------------------------------
// IssuesTable — the "Issues assigned" card (Dashboard Phase 2, U5). Renders
// REAL account-wide open issues from `useGithubData` (backed by `gh search
// issues --assignee @me`), ordered by updatedAt desc. Replaces the
// SAMPLE_ISSUE_ROWS shell render from U2.
//
// TWO-LINE rows (per the design spec + this unit's brief):
//   Line 1: #number · title · label chips, rendered with the ACTUAL GitHub
//     label color (`GhLabel.color`, a hex string with no leading '#') — the
//     ONE place in this table a real external color is allowed per the
//     THEME RULE; everything else uses Orpheus tokens.
//   Line 2: repo (mono muted) · "updated Xago" (formatCompactAge).
// Row click opens the issue's GitHub url via `window.api.shell.openExternal`.
// ---------------------------------------------------------------------------

import { DashboardCard } from './DashboardCard'
import { useGithubData } from './useGithubData'
import { formatCompactAge } from './dashboardHome.helpers'

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

  const meta = loading ? 'loading…' : `${openIssueCount} · by updated`

  function openIssue(url: string): void {
    void window.api.shell.openExternal(url)
  }

  return (
    <DashboardCard title="Issues assigned" meta={meta}>
      {!loading && issues.length === 0 ? (
        <EmptyState hint={possiblyUnavailable} />
      ) : (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                <th className="w-[1%] border-b border-border-default px-2.5 pb-1.5 text-left font-mono text-[9.5px] tracking-wider text-text-muted uppercase">
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
              {issues.map((issue) => (
                <tr
                  key={`${issue.repo}#${issue.number}`}
                  onClick={() => openIssue(issue.url)}
                  className="cursor-pointer align-top hover:bg-surface-overlay"
                >
                  <td className="border-b border-border-default px-2.5 py-2 align-top font-mono text-[10.5px] text-text-muted tabular-nums">
                    #{issue.number}
                  </td>
                  <td className="max-w-0 border-b border-border-default px-2.5 py-2 align-top">
                    <div className="flex items-center gap-1.5">
                      <span className="min-w-0 truncate text-text-primary">{issue.title}</span>
                      {issue.labels.map((lab) => (
                        <span
                          key={lab.name}
                          className="inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 font-mono text-[9.5px] whitespace-nowrap"
                          style={{
                            // The ONE place a real external (non-token) color
                            // is allowed — GitHub's own label color, per the
                            // THEME RULE. `--lc` is the raw hex; color-mix
                            // derives the tinted bg/border from it so the
                            // chip still reads correctly in light + dark
                            // without a separate per-theme hex table.
                            ['--lc' as string]: `#${lab.color}`,
                            color: 'var(--lc)',
                            background: 'color-mix(in srgb, var(--lc) 14%, transparent)',
                            borderColor: 'color-mix(in srgb, var(--lc) 35%, transparent)'
                          }}
                        >
                          {lab.name}
                        </span>
                      ))}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[10.5px] whitespace-nowrap text-text-muted">
                      {issue.repo}
                    </div>
                  </td>
                  <td className="border-b border-border-default px-2.5 py-2 text-right align-top font-mono text-[10.5px] whitespace-nowrap text-text-muted tabular-nums">
                    {formatCompactAge(issue.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </DashboardCard>
  )
}
