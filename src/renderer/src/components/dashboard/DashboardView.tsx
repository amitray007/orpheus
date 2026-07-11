// ---------------------------------------------------------------------------
// DashboardView — the real Dashboard PAGE SHELL (U2). This is a NEW overview
// surface reachable from the 🏠 rail item — NOT the removed home page (see
// CLAUDE.md: "Don't reintroduce a dashboard/home page"). It aggregates
// status (live agents + what needs you, plus an analytics "pulse" treat) and
// sends you to the right place; it does not re-home project/workspace
// navigation, which stays owned by the Projects surface.
//
// V1 REBUILD (visual-only, per dashboard-v3.html "tightened" mockup) — the
// critique was "huge half-empty hero-metric cards, flat sameness, wasted
// space". New structure, top to bottom:
//   a. Hero row: greeting (DashboardTopBar) + an inline stats row (Sessions/
//      Tokens/Streak/Peak hour via the now-borderless StatTile) side by
//      side, NOT a 4-card grid.
//   b. Pulse row: a 0.85fr/1.25fr grid — Usage (the ONE focal/primary panel,
//      DashboardCard variant="primary") on the left, Activity (the new
//      weekly small-multiples chart, ActivityChart) on the right, stacking
//      to one column under 780px.
//   c. "Needs you now" — a flex-wrap strip of compact TriageTile chips
//      (replaces the old big-tile grid).
//   d. Live agents (full width, unchanged position).
//   e. Open PRs + Issues, side by side (unchanged position).
// All data wiring is unchanged from U3/U4/U5 below — this unit is
// presentation-only, no new fetches, no hook behavior changes.
//
// U3 wired the "Your pulse" numbers to REAL data derived from
// `sessions:listAll` via `usePulseData` — sessions/streak/peak-hour/active-
// days/heatmap/weeklyActivity all come from real session records; only
// Tokens stays a placeholder (no cross-session token rollup exists yet —
// see StatTile below, Phase 3).
//
// U4 wired the real Live-agents table + the "Agents waiting"/"Finished runs"
// triage tiles to `useLiveAgents` (workspaces + sessions + activity snapshot
// join — see that hook's header comment).
//
// U5 (Phase 2) wires the middle two triage tiles (Open PRs / Open issues)
// plus PrTable/IssuesTable to REAL account-wide GitHub data via
// `useGithubData` (`gh search prs --author @me` / `gh search issues
// --assignee @me`, new IPC in src/main/github.ts). See
// docs/plans/2026-07-11-003-dashboard-design.md.
// ---------------------------------------------------------------------------

import { DashboardTopBar } from './dashboard-home/DashboardTopBar'
import { SectionHeader } from './dashboard-home/SectionHeader'
import { StatTile } from './dashboard-home/StatTile'
import { TriageTile } from './dashboard-home/TriageTile'
import { DashboardCard } from './dashboard-home/DashboardCard'
import { ActivityChart } from './dashboard-home/ActivityChart'
import { UsageLimitsCard } from './dashboard-home/UsageLimitsCard'
import { LiveAgentsTable } from './dashboard-home/LiveAgentsTable'
import { PrTable } from './dashboard-home/PrTable'
import { IssuesTable } from './dashboard-home/IssuesTable'
import { usePulseData } from './dashboard-home/usePulseData'
import { useLiveAgents } from './dashboard-home/useLiveAgents'
import { useGithubData } from './dashboard-home/useGithubData'
import { useClaudeUsage } from './dashboard-home/useClaudeUsage'
import { formatHour12 } from './dashboard-home/pulseData.helpers'
import { formatCompact } from './dashboard-home/dashboardHome.helpers'

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
  // time view); weeklyActivity is always the trailing 7 days; the stat tiles
  // reflect the last 7 days.
  const pulse = usePulseData('7d')
  const liveAgents = useLiveAgents()
  const github = useGithubData()
  const claudeUsage = useClaudeUsage()

  const peakHourLabel = pulse.peakHour === null ? '—' : formatHour12(pulse.peakHour)

  return (
    <div className="mx-auto flex max-w-[1180px] flex-col gap-[22px]">
      {/* ============ Hero: greeting + inline stats (no big stat cards) ============ */}
      <div className="flex flex-wrap items-end justify-between gap-5">
        <DashboardTopBar />
        <div className="flex flex-wrap gap-6 gap-y-3">
          <StatTile
            label="Sessions"
            value={formatCompact(pulse.sessions)}
            loading={pulse.loading}
          />
          {/* Tokens: NOT derivable cheaply from sessions:listAll — per the
              feasibility audit, per-session token counts live only in JSONL
              transcripts and are never rolled up in the DB. Rather than fake
              a number, render a graceful placeholder; real rollup is Phase 3
              (either a JSONL parse pass over all sessions, or a new `tokens`
              column populated during refreshSessionMetadata). */}
          <StatTile label="Tokens" value="—" subLabel="soon" dim loading={pulse.loading} />
          <StatTile
            label="Current streak"
            value={String(pulse.currentStreak)}
            unit={pulse.currentStreak > 0 ? 'd' : undefined}
            loading={pulse.loading}
          />
          <StatTile label="Peak hour" value={peakHourLabel} loading={pulse.loading} />
        </div>
      </div>

      {/* ============ Pulse row: Usage (focal) + Activity ============ */}
      <div className="grid grid-cols-1 gap-4 min-[780px]:grid-cols-[0.85fr_1.25fr]">
        <DashboardCard title="Usage" meta="Claude · resets shown" variant="primary">
          <UsageLimitsCard result={claudeUsage.result} loading={claudeUsage.loading} />
        </DashboardCard>
        <DashboardCard title="Activity" meta="this week · Mon–Sun">
          <ActivityChart days={pulse.weeklyActivity} loading={pulse.loading} />
        </DashboardCard>
      </div>

      {/* ============ Needs you now (triage strip) ============ */}
      <div className="flex flex-col gap-2.5">
        <SectionHeader label="Needs you now" dotClassName="bg-accent" />
        <div className="flex flex-wrap gap-2">
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
      </div>

      {/* ============ Live agents (full width) ============ */}
      <LiveAgentsTable onSelectWorkspace={onSelectWorkspace} />

      {/* ============ Open PRs + Issues (side by side) ============ */}
      <div className="grid grid-cols-1 gap-4 min-[780px]:grid-cols-2">
        <PrTable />
        <IssuesTable />
      </div>
    </div>
  )
}
