// ---------------------------------------------------------------------------
// DashboardView — the real Dashboard PAGE SHELL (U2). This is a NEW overview
// surface reachable from the 🏠 rail item — NOT the removed home page (see
// CLAUDE.md: "Don't reintroduce a dashboard/home page"). It aggregates
// status (live agents + what needs you, plus an analytics "pulse" treat) and
// sends you to the right place; it does not re-home project/workspace
// navigation, which stays owned by the Projects surface.
//
// U2 built STRUCTURE ONLY with sample data. U3 wired the "Your pulse"
// section to REAL numbers derived from `sessions:listAll` via `usePulseData`
// — sessions/streak/peak-hour/active-days/heatmap/models all come from real
// session records; only Tokens stays a placeholder (no cross-session token
// rollup exists yet — see StatTile below, Phase 3).
//
// U4 wired the real Live-agents table + the "Agents waiting"/"Finished runs"
// triage tiles to `useLiveAgents` (workspaces + sessions + activity snapshot
// join — see that hook's header comment).
//
// U5 (Phase 2, this unit) wires the middle two triage tiles (Open PRs / Open
// issues) plus PrTable/IssuesTable to REAL account-wide GitHub data via
// `useGithubData` (`gh search prs --author @me` / `gh search issues
// --assignee @me`, new IPC in src/main/github.ts). See
// docs/plans/2026-07-11-003-dashboard-design.md.
// ---------------------------------------------------------------------------

import { DashboardTopBar } from './dashboard-home/DashboardTopBar'
import { SectionHeader } from './dashboard-home/SectionHeader'
import { StatTile } from './dashboard-home/StatTile'
import { TriageTile } from './dashboard-home/TriageTile'
import { DashboardCard } from './dashboard-home/DashboardCard'
import { ActivityHeatmap } from './dashboard-home/ActivityHeatmap'
import { ModelsDonut } from './dashboard-home/ModelsDonut'
import { LiveAgentsTable } from './dashboard-home/LiveAgentsTable'
import { PrTable } from './dashboard-home/PrTable'
import { IssuesTable } from './dashboard-home/IssuesTable'
import { usePulseData } from './dashboard-home/usePulseData'
import { useLiveAgents } from './dashboard-home/useLiveAgents'
import { useGithubData } from './dashboard-home/useGithubData'
import { formatHour12 } from './dashboard-home/pulseData.helpers'

export function DashboardView({
  onSelectWorkspace
}: {
  /** Threaded from MainContent's onSelectWorkspace (ultimately
   *  Dashboard.tsx's handleSelectWorkspace) so Live-agents rows can navigate
   *  to their workspace. Optional so DashboardView still renders standalone
   *  (e.g. in isolation/tests) without a navigation handler. */
  onSelectWorkspace?: (workspaceId: string, projectId: string) => void
}): React.JSX.Element {
  // The Dashboard is fixed to a rolling 7-day window (no user-facing range
  // picker — see DashboardTopBar). The heatmap still shows ~6 months (it's a
  // time view); the tiles + models reflect the last 7 days.
  const pulse = usePulseData('7d')
  const liveAgents = useLiveAgents()
  const github = useGithubData()

  const peakHourLabel = pulse.peakHour === null ? '—' : formatHour12(pulse.peakHour)
  const activeDaysMeta =
    pulse.loading || pulse.heatmap.length === 0
      ? 'last 6 months'
      : `last 6 months · ${pulse.activeDays} active days`

  return (
    <div className="mx-auto flex max-w-[1180px] flex-col gap-[18px]">
      <DashboardTopBar />

      {/* ============ Your pulse (analytics treat) ============ */}
      <section className="flex flex-col gap-2.5">
        <SectionHeader label="Your pulse" dotClassName="bg-[color:var(--color-chart-3)]" />

        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <StatTile label="Sessions" value={String(pulse.sessions)} loading={pulse.loading} />
          {/* Tokens: NOT derivable cheaply from sessions:listAll — per the
              feasibility audit, per-session token counts live only in JSONL
              transcripts and are never rolled up in the DB. Rather than fake
              a number, render a graceful placeholder; real rollup is Phase 3
              (either a JSONL parse pass over all sessions, or a new `tokens`
              column populated during refreshSessionMetadata). */}
          <StatTile label="Tokens" value="—" subLabel="soon" loading={pulse.loading} />
          <StatTile
            label="Current streak"
            value={String(pulse.currentStreak)}
            unit={pulse.currentStreak > 0 ? 'd' : undefined}
            loading={pulse.loading}
          />
          <StatTile label="Peak hour" value={peakHourLabel} loading={pulse.loading} />
        </div>

        <div className="grid grid-cols-1 gap-3.5 md:grid-cols-[1.6fr_1fr]">
          <DashboardCard title="Activity" meta={activeDaysMeta}>
            <ActivityHeatmap cells={pulse.heatmap} loading={pulse.loading} />
          </DashboardCard>
          <DashboardCard title="Models" meta="last 7 days" contentClassName="flex-1">
            <ModelsDonut models={pulse.models} loading={pulse.loading} />
          </DashboardCard>
        </div>
      </section>

      {/* ============ Needs you now (triage) ============ */}
      <section className="flex flex-col gap-2.5">
        <SectionHeader label="Needs you now" dotClassName="bg-accent" />
        <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
          {/* REAL — live count of workspaces with activity==='attention',
              from the same useLiveAgents() join the table below renders
              (see liveAgents.helpers.ts's buildLiveAgentRows). `hot` when
              >0 since a waiting agent is the most actionable state. */}
          <TriageTile
            count={liveAgents.waitingCount}
            dotClassName="bg-accent"
            label="agents waiting"
            actionLabel="jump"
            hot={liveAgents.waitingCount > 0}
          />
          {/* REAL — account-wide open PR count (incl. drafts) + draft
              sublabel from useGithubData (`gh search prs --author @me`, U5). */}
          <TriageTile
            count={github.openPrCount}
            dotClassName="bg-[color:var(--color-chart-3)]"
            label="open PRs"
            sublabel={github.draftPrCount > 0 ? `· ${github.draftPrCount} draft` : undefined}
            actionLabel="open"
          />
          {/* REAL — account-wide assigned open-issue count from
              useGithubData (`gh search issues --assignee @me`, U5). */}
          <TriageTile
            count={github.openIssueCount}
            dotClassName="bg-[color:var(--color-chart-2)]"
            label="open issues"
            actionLabel="view"
          />
          {/* REAL — live count of workspaces currently 'ready' (recently
              finished), from the same join as above. This is the LIVE count
              only; a historical "finished since you left" count needs new
              transition tracking and is Phase 3 (see plan doc U6). */}
          <TriageTile
            count={liveAgents.finishedCount}
            dotClassName="bg-[color:var(--color-chart-3)]"
            label="finished runs"
            actionLabel="see"
          />
        </div>
      </section>

      {/* ============ Live agents (full width) ============ */}
      <LiveAgentsTable onSelectWorkspace={onSelectWorkspace} />

      {/* ============ Open PRs + Issues (side by side) ============ */}
      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
        <PrTable />
        <IssuesTable />
      </div>
    </div>
  )
}
