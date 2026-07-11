// ---------------------------------------------------------------------------
// DashboardView — the real Dashboard PAGE SHELL (U2). This is a NEW overview
// surface reachable from the 🏠 rail item — NOT the removed home page (see
// CLAUDE.md: "Don't reintroduce a dashboard/home page"). It aggregates
// status (live agents + what needs you, plus an analytics "pulse" treat) and
// sends you to the right place; it does not re-home project/workspace
// navigation, which stays owned by the Projects surface.
//
// This unit builds STRUCTURE ONLY: page composition, the greeting + range
// control, section scaffolding, and the responsive grid, matching the design
// of record (dashboard-v2.html mockup). Sections are seeded with SAMPLE data
// — U3 wires real pulse numbers (sessions/tokens/streak/peak-hour/heatmap/
// models split) and U4 wires the real live-agents table; U5 wires real PR/
// issue tables via `gh`. See docs/plans/2026-07-11-003-dashboard-design.md.
// ---------------------------------------------------------------------------

import { useState } from 'react'
import { DashboardTopBar } from './dashboard-home/DashboardTopBar'
import type { DashboardRange } from './dashboard-home/dashboardHome.helpers'
import { SectionHeader } from './dashboard-home/SectionHeader'
import { StatTile } from './dashboard-home/StatTile'
import { TriageTile } from './dashboard-home/TriageTile'
import { DashboardCard } from './dashboard-home/DashboardCard'
import { ActivityHeatmapPlaceholder } from './dashboard-home/ActivityHeatmapPlaceholder'
import { ModelsDonut } from './dashboard-home/ModelsDonut'
import { LiveAgentsTable } from './dashboard-home/LiveAgentsTable'
import { PrTable } from './dashboard-home/PrTable'
import { IssuesTable } from './dashboard-home/IssuesTable'

// SAMPLE pulse stats — U3 replaces these with a `sessions:listAll`-backed
// rollup (sessions/tokens/streak/peak-hour all derive from session records).
const SAMPLE_PULSE_STATS = [
  { label: 'Sessions', value: '418' },
  { label: 'Tokens', value: '92.4', unit: 'M' },
  { label: 'Current streak', value: '9', unit: 'd' },
  { label: 'Peak hour', value: '10', unit: 'PM' }
]

export function DashboardView(): React.JSX.Element {
  const [range, setRange] = useState<DashboardRange>('all')

  return (
    <div className="mx-auto flex max-w-[1180px] flex-col gap-[18px]">
      <DashboardTopBar range={range} onRangeChange={setRange} />

      {/* ============ Your pulse (analytics treat) ============ */}
      <section className="flex flex-col gap-2.5">
        <SectionHeader label="Your pulse" dotClassName="bg-[color:var(--color-chart-3)]" />

        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {SAMPLE_PULSE_STATS.map((stat) => (
            <StatTile key={stat.label} label={stat.label} value={stat.value} unit={stat.unit} />
          ))}
        </div>

        <div className="grid grid-cols-1 gap-3.5 md:grid-cols-[1.6fr_1fr]">
          <DashboardCard title="Activity" meta="last 6 months · 73 active days">
            <ActivityHeatmapPlaceholder />
          </DashboardCard>
          <DashboardCard title="Models" meta="this month" contentClassName="flex-1">
            <ModelsDonut />
          </DashboardCard>
        </div>
      </section>

      {/* ============ Needs you now (triage) ============ */}
      <section className="flex flex-col gap-2.5">
        <SectionHeader label="Needs you now" dotClassName="bg-accent" />
        <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
          <TriageTile
            count={2}
            dotClassName="bg-accent"
            label="agents waiting"
            actionLabel="jump"
            hot
          />
          <TriageTile
            count={6}
            dotClassName="bg-[color:var(--color-chart-3)]"
            label="open PRs"
            sublabel="· 1 draft"
            actionLabel="open"
          />
          <TriageTile
            count={4}
            dotClassName="bg-[color:var(--color-chart-2)]"
            label="open issues"
            actionLabel="view"
          />
          <TriageTile
            count={4}
            dotClassName="bg-[color:var(--color-chart-3)]"
            label="finished runs"
            actionLabel="see"
          />
        </div>
      </section>

      {/* ============ Live agents (full width) ============ */}
      <LiveAgentsTable />

      {/* ============ Open PRs + Issues (side by side) ============ */}
      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
        <PrTable />
        <IssuesTable />
      </div>
    </div>
  )
}
