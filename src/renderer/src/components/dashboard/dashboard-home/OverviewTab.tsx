import type {
  GhSearchIssue,
  GhSearchPr,
  GithubRepositorySummary,
  GithubWorkflowRunSummary
} from '@shared/types'
import { ActionsTable } from './ActionsTable'
import { IssuesTable } from './IssuesTable'
import { PrTable } from './PrTable'
import { RepositoriesTable } from './RepositoriesTable'
import { SectionHeader } from './SectionHeader'
import { SourceRefreshButton } from './SourceRefreshButton'
import { TriageTile } from './TriageTile'

export interface OverviewTabProps {
  loading: boolean
  refreshing?: boolean
  unavailable: boolean
  prs: GhSearchPr[]
  issues: GhSearchIssue[]
  actions: GithubWorkflowRunSummary[]
  repositories: GithubRepositorySummary[]
  openPrCount: number
  draftPrCount: number
  openIssueCount: number
  reviewRequestedCount?: number | null
  failedActionCount?: number
  workflowScopeCount?: number
  actionsUnavailable?: boolean
  repositoriesUnavailable?: boolean
  refreshError?: string | null
  reviewRequestsUrl?: string | null
  failingPrsUrl?: string | null
  assignedIssuesUrl?: string | null
  failedWorkflowsUrl?: string | null
  onRefresh: () => void
  onOpenExternal: (url: string) => void
}

export function OverviewTab({
  loading,
  refreshing = false,
  unavailable,
  prs,
  issues,
  actions,
  repositories,
  openPrCount,
  draftPrCount,
  openIssueCount,
  reviewRequestedCount = null,
  failedActionCount,
  workflowScopeCount = 0,
  actionsUnavailable = false,
  repositoriesUnavailable = false,
  refreshError,
  reviewRequestsUrl,
  failingPrsUrl,
  assignedIssuesUrl,
  failedWorkflowsUrl,
  onRefresh,
  onOpenExternal
}: OverviewTabProps): React.JSX.Element {
  const failedRuns =
    failedActionCount ??
    actions.filter((action) => {
      const conclusion = action.conclusion?.toLowerCase()
      return conclusion === 'failure' || conclusion === 'timed_out'
    }).length
  const failingPrs = prs.filter((pr) => pr.checks === 'failure').length

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-3">
          <SectionHeader label="Needs Attention" dotClassName="bg-accent" />
          <SourceRefreshButton refreshing={refreshing} onRefresh={onRefresh} />
        </div>
        <div className="grid grid-cols-2 gap-2 min-[900px]:grid-cols-4">
          <TriageTile
            count={reviewRequestedCount}
            dotClassName="bg-accent"
            label="Review Requests"
            actionLabel="View requested reviews"
            hot={reviewRequestedCount !== null && reviewRequestedCount > 0}
            onClick={reviewRequestsUrl ? () => onOpenExternal(reviewRequestsUrl) : undefined}
          />
          <TriageTile
            count={failingPrs}
            dotClassName="bg-[color:var(--color-gh-closed)]"
            label="PRs With Failing Checks"
            actionLabel="View failing pull requests"
            hot={failingPrs > 0}
            onClick={failingPrsUrl ? () => onOpenExternal(failingPrsUrl) : undefined}
          />
          <TriageTile
            count={openIssueCount}
            dotClassName="bg-[color:var(--color-chart-2)]"
            label="Assigned Issues"
            actionLabel="View assigned issues"
            onClick={assignedIssuesUrl ? () => onOpenExternal(assignedIssuesUrl) : undefined}
          />
          <TriageTile
            count={failedRuns}
            dotClassName="bg-[color:var(--color-gh-closed)]"
            label="Failed Workflows"
            actionLabel="View failed workflows"
            hot={failedRuns > 0}
            onClick={failedWorkflowsUrl ? () => onOpenExternal(failedWorkflowsUrl) : undefined}
          />
        </div>
        {refreshError ? (
          <div
            role="status"
            className="border border-border-default bg-surface-overlay px-3 py-2 text-xs text-text-muted"
          >
            Refresh failed for part of GitHub. Showing the last available data.
          </div>
        ) : null}
      </section>

      <section className="grid grid-cols-1 items-stretch gap-4 min-[840px]:grid-cols-2">
        <PrTable
          loading={loading}
          prs={prs}
          openPrCount={openPrCount}
          draftPrCount={draftPrCount}
          possiblyUnavailable={unavailable}
        />
        <IssuesTable
          loading={loading}
          issues={issues}
          openIssueCount={openIssueCount}
          possiblyUnavailable={unavailable}
        />
      </section>

      <section className="grid grid-cols-1 items-stretch gap-4 min-[840px]:grid-cols-2">
        <ActionsTable
          actions={actions}
          loading={loading}
          unavailable={unavailable || actionsUnavailable}
          scopeRepositoryCount={workflowScopeCount}
          onOpen={onOpenExternal}
        />
        <RepositoriesTable
          repositories={repositories}
          loading={loading}
          unavailable={unavailable || repositoriesUnavailable}
          onOpen={onOpenExternal}
        />
      </section>
    </div>
  )
}
