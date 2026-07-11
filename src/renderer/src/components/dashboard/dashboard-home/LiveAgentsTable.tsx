// ---------------------------------------------------------------------------
// LiveAgentsTable — the full-width "Live agents" card. Renders SAMPLE rows
// (see sampleData.ts) with the real column set (State/Agent/Project/Doing/
// Model/Elapsed) so the table layout is validated now; U4 replaces this with
// a real TanStack Table wired to the activity snapshot + session metadata.
// ---------------------------------------------------------------------------

import { cn } from '@/lib/utils'
import { DashboardCard } from './DashboardCard'
import { SAMPLE_AGENT_ROWS, type SampleAgentState } from './sampleData'

const STATE_LABEL: Record<SampleAgentState, string> = {
  working: 'Working',
  permission: 'Permission',
  finished: 'Finished'
}

const STATE_BADGE_CLASS: Record<SampleAgentState, string> = {
  working: 'text-[color:var(--color-chart-3)] bg-[color:var(--color-chart-3)]/12',
  permission: 'text-accent bg-accent/13',
  finished: 'text-text-muted bg-surface-overlay'
}

const STATE_DOT_CLASS: Record<SampleAgentState, string> = {
  working: 'bg-[color:var(--color-chart-3)]',
  permission: 'bg-accent',
  finished: 'bg-text-muted'
}

function AgentStateBadge({ state }: { state: SampleAgentState }): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-[3px] font-mono text-[10px] tracking-wide whitespace-nowrap',
        STATE_BADGE_CLASS[state]
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', STATE_DOT_CLASS[state])} aria-hidden="true" />
      {STATE_LABEL[state]}
    </span>
  )
}

export function LiveAgentsTable(): React.JSX.Element {
  const running = SAMPLE_AGENT_ROWS.filter((r) => r.state !== 'finished').length
  const finished = SAMPLE_AGENT_ROWS.length - running

  return (
    <DashboardCard title="Live agents" meta={`${running} running · ${finished} finished`}>
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              <th className="border-b border-border-default px-2.5 pb-1.5 text-left font-mono text-[9.5px] tracking-wider text-text-muted uppercase">
                State
              </th>
              <th className="border-b border-border-default px-2.5 pb-1.5 text-left font-mono text-[9.5px] tracking-wider text-text-muted uppercase">
                Agent
              </th>
              <th className="border-b border-border-default px-2.5 pb-1.5 text-left font-mono text-[9.5px] tracking-wider text-text-muted uppercase">
                Project
              </th>
              <th className="border-b border-border-default px-2.5 pb-1.5 text-left font-mono text-[9.5px] tracking-wider text-text-muted uppercase">
                Doing
              </th>
              <th className="border-b border-border-default px-2.5 pb-1.5 text-left font-mono text-[9.5px] tracking-wider text-text-muted uppercase">
                Model
              </th>
              <th className="border-b border-border-default px-2.5 pb-1.5 text-right font-mono text-[9.5px] tracking-wider text-text-muted uppercase">
                Elapsed
              </th>
            </tr>
          </thead>
          <tbody>
            {SAMPLE_AGENT_ROWS.map((row) => (
              <tr
                key={`${row.project}-${row.agent}`}
                className={cn('hover:bg-surface-overlay', row.state === 'finished' && 'opacity-60')}
              >
                <td className="border-b border-border-default px-2.5 py-2 align-middle">
                  <AgentStateBadge state={row.state} />
                </td>
                <td className="border-b border-border-default px-2.5 py-2 align-middle font-medium whitespace-nowrap text-text-primary">
                  {row.agent}
                </td>
                <td className="border-b border-border-default px-2.5 py-2 align-middle font-mono text-[10.5px] whitespace-nowrap text-text-muted">
                  {row.project}
                </td>
                <td className="max-w-0 truncate border-b border-border-default px-2.5 py-2 align-middle font-mono text-[10.5px] text-text-muted">
                  {row.doing}
                </td>
                <td className="border-b border-border-default px-2.5 py-2 align-middle font-mono text-[10px] whitespace-nowrap text-text-muted">
                  {row.model}
                </td>
                <td className="border-b border-border-default px-2.5 py-2 text-right align-middle font-mono text-[10.5px] whitespace-nowrap text-text-muted tabular-nums">
                  {row.elapsed}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DashboardCard>
  )
}
