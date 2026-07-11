// ---------------------------------------------------------------------------
// PrTable — the "Open PRs" card. Renders SAMPLE rows (see sampleData.ts)
// with the real column set (# / Title / Repo / Checks / Pushed), ordered by
// last push, so the layout is validated now. This is Phase-2 data (U5 wires
// real `gh search prs` results) — sample rows only for this shell unit.
// ---------------------------------------------------------------------------

import { cn } from '@/lib/utils'
import { DashboardCard } from './DashboardCard'
import { SAMPLE_PR_ROWS, type SampleCheckState } from './sampleData'

const CHECK_LABEL: Record<SampleCheckState, string> = {
  passing: '✓ passing',
  failing: '✕ failing',
  pending: '◷ pending',
  none: '— none'
}

const CHECK_CLASS: Record<SampleCheckState, string> = {
  passing: 'text-[color:var(--color-chart-3)] bg-[color:var(--color-chart-3)]/12',
  failing: 'text-[color:var(--color-chart-5)] bg-[color:var(--color-chart-5)]/12',
  pending: 'text-accent bg-accent/12',
  none: 'text-text-muted border border-border-default'
}

function CheckChip({ state }: { state: SampleCheckState }): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-[5px] px-1.5 py-0.5 font-mono text-[9px] whitespace-nowrap',
        CHECK_CLASS[state]
      )}
    >
      {CHECK_LABEL[state]}
    </span>
  )
}

export function PrTable(): React.JSX.Element {
  const draftCount = SAMPLE_PR_ROWS.filter((r) => r.draft).length

  return (
    <DashboardCard
      title="Open PRs"
      meta={`${SAMPLE_PR_ROWS.length} open${draftCount ? ` · ${draftCount} draft` : ''} · by last push`}
    >
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
              <th className="border-b border-border-default px-2.5 pb-1.5 text-left font-mono text-[9.5px] tracking-wider text-text-muted uppercase">
                Repo
              </th>
              <th className="border-b border-border-default px-2.5 pb-1.5 text-left font-mono text-[9.5px] tracking-wider text-text-muted uppercase">
                Checks
              </th>
              <th className="border-b border-border-default px-2.5 pb-1.5 text-right font-mono text-[9.5px] tracking-wider text-text-muted uppercase">
                Pushed
              </th>
            </tr>
          </thead>
          <tbody>
            {SAMPLE_PR_ROWS.map((row) => (
              <tr key={row.number} className="cursor-pointer hover:bg-surface-overlay">
                <td className="border-b border-border-default px-2.5 py-2 align-middle font-mono text-[10.5px] text-text-muted tabular-nums">
                  #{row.number}
                </td>
                <td className="max-w-0 truncate border-b border-border-default px-2.5 py-2 align-middle text-text-primary">
                  {row.title}
                  {row.draft ? (
                    <span className="ml-1.5 rounded border border-border-default px-1 py-px align-middle font-mono text-[9px] tracking-wide text-text-muted uppercase">
                      draft
                    </span>
                  ) : null}
                </td>
                <td className="border-b border-border-default px-2.5 py-2 align-middle font-mono text-[9.5px] whitespace-nowrap text-text-muted">
                  {row.repo}
                </td>
                <td className="border-b border-border-default px-2.5 py-2 align-middle">
                  <CheckChip state={row.checks} />
                </td>
                <td className="border-b border-border-default px-2.5 py-2 text-right align-middle font-mono text-[10.5px] whitespace-nowrap text-text-muted tabular-nums">
                  {row.pushed}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DashboardCard>
  )
}
