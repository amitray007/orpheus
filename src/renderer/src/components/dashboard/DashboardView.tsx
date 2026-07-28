import { useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useUiState } from '@/lib/uiStateStore'
import { DashboardTopBar } from './dashboard-home/DashboardTopBar'
import { InsightsTab } from './dashboard-home/InsightsTab'
import { LimitsTab } from './dashboard-home/LimitsTab'
import { OverviewTab } from './dashboard-home/OverviewTab'
import { useGithubData } from './dashboard-home/useGithubData'
import { useProviderUsage } from './dashboard-home/useProviderUsage'
import { usePulseData } from './dashboard-home/usePulseData'

function githubDestination(profileUrl: string | null | undefined, path: string): string | null {
  if (!profileUrl) return null
  try {
    return new URL(path, profileUrl).toString()
  } catch {
    return null
  }
}

function isFailedWorkflow(conclusion: string | null): boolean {
  const value = conclusion?.toLowerCase()
  return value === 'failure' || value === 'timed_out' || value === 'action_required'
}

export function DashboardView(): React.JSX.Element {
  const [insightsWeekOffset, setInsightsWeekOffset] = useState(0)
  const github = useGithubData()
  const usage = useProviderUsage()
  const pulse = usePulseData(insightsWeekOffset)
  const uiState = useUiState()

  const githubSnapshot = github.snapshot
  const profile = githubSnapshot?.profile
  const actions = githubSnapshot?.workflowRuns ?? []
  const repositories = githubSnapshot?.repositories ?? []
  const failedActions = actions.filter((action) => isFailedWorkflow(action.conclusion))
  const failingPrs = github.prs.filter((pr) => pr.checks === 'failure')
  const githubUnavailable =
    githubSnapshot?.availability === 'unavailable' || github.possiblyUnavailable
  const profileUrl = profile?.profileUrl

  function openExternal(url: string): void {
    void window.api.shell.openExternal(url)
  }

  return (
    <div className="mx-auto flex max-w-[1180px] flex-col gap-4">
      <DashboardTopBar
        login={profile?.login ?? null}
        name={uiState?.githubUsername ?? profile?.login ?? null}
        loading={github.loading}
        onViewProfile={profileUrl ? () => openExternal(profileUrl) : undefined}
      />

      <Tabs defaultValue="overview" className="gap-4">
        <TabsList
          variant="line"
          aria-label="Home sections"
          className="h-10 w-full justify-start gap-1 border-b border-border-default p-0"
        >
          <TabsTrigger value="overview" className="h-9 flex-none px-3">
            Overview
          </TabsTrigger>
          <TabsTrigger value="limits" className="h-9 flex-none px-3">
            Limits
          </TabsTrigger>
          <TabsTrigger value="insights" className="h-9 flex-none px-3">
            Insights
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <OverviewTab
            loading={github.loading}
            refreshing={github.refreshing}
            unavailable={githubUnavailable}
            prs={github.prs}
            issues={github.issues}
            actions={actions}
            repositories={repositories}
            openPrCount={github.openPrCount}
            draftPrCount={github.draftPrCount}
            openIssueCount={github.openIssueCount}
            reviewRequestedCount={githubSnapshot?.reviewRequestedCount ?? null}
            failedActionCount={failedActions.length}
            workflowScopeCount={githubSnapshot?.workflowScope.repositories.length ?? 0}
            actionsUnavailable={githubSnapshot?.workflowRunsStatus === 'unavailable'}
            repositoriesUnavailable={githubSnapshot?.repositoriesStatus === 'unavailable'}
            refreshError={github.refreshError}
            reviewRequestsUrl={githubDestination(profileUrl, '/pulls/review-requested')}
            failingPrsUrl={
              failingPrs[0]?.url ??
              githubDestination(profileUrl, '/pulls?q=is%3Aopen+status%3Afailure')
            }
            assignedIssuesUrl={
              github.issues[0]?.url ?? githubDestination(profileUrl, '/issues/assigned')
            }
            failedWorkflowsUrl={failedActions[0]?.url ?? githubDestination(profileUrl, '/actions')}
            onRefresh={github.refresh}
            onOpenExternal={openExternal}
          />
        </TabsContent>

        <TabsContent value="limits">
          <LimitsTab
            providers={usage.snapshot?.providers ?? []}
            loading={usage.loading}
            refreshing={usage.refreshing}
            refreshError={usage.refreshError}
            onRefresh={usage.refresh}
          />
        </TabsContent>

        <TabsContent value="insights">
          <InsightsTab
            weekOffset={insightsWeekOffset}
            claudePreparing={pulse.preparing}
            claudeRangeStart={pulse.result?.rangeStart}
            claudeRangeEnd={pulse.result?.rangeEnd}
            refreshing={pulse.refreshing}
            refreshError={pulse.refreshError}
            claudeError={pulse.error}
            weeklyActivity={pulse.weeklyActivity}
            peakHour={pulse.peakHour}
            activeDays={pulse.activeDays}
            longestStreak={pulse.longestStreak}
            sessions={pulse.sessions}
            recentSessions={pulse.recentSessions}
            modelActivity={pulse.modelActivity}
            onWeekOffsetChange={setInsightsWeekOffset}
            onRefresh={pulse.refresh}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
