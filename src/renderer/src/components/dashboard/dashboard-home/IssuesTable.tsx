// ---------------------------------------------------------------------------
// IssuesTable — the "Issues assigned" card. Renders SAMPLE rows (see
// sampleData.ts) with the real column set (# / Title / Repo / Labels /
// Updated), ordered by updated, so the layout is validated now. This is
// Phase-2 data (U5 wires real `gh search issues` results with actual GitHub
// label name+color) — sample rows only for this shell unit.
// ---------------------------------------------------------------------------

import { DashboardCard } from './DashboardCard'
import { SAMPLE_ISSUE_ROWS } from './sampleData'

export function IssuesTable(): React.JSX.Element {
  return (
    <DashboardCard title="Issues assigned" meta={`${SAMPLE_ISSUE_ROWS.length} · by updated`}>
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
                Labels
              </th>
              <th className="border-b border-border-default px-2.5 pb-1.5 text-right font-mono text-[9.5px] tracking-wider text-text-muted uppercase">
                Updated
              </th>
            </tr>
          </thead>
          <tbody>
            {SAMPLE_ISSUE_ROWS.map((row) => (
              <tr key={row.number} className="cursor-pointer hover:bg-surface-overlay">
                <td className="border-b border-border-default px-2.5 py-2 align-middle font-mono text-[10.5px] text-text-muted tabular-nums">
                  #{row.number}
                </td>
                <td className="max-w-0 truncate border-b border-border-default px-2.5 py-2 align-middle text-text-primary">
                  {row.title}
                </td>
                <td className="border-b border-border-default px-2.5 py-2 align-middle font-mono text-[9.5px] whitespace-nowrap text-text-muted">
                  {row.repo}
                </td>
                <td className="border-b border-border-default px-2.5 py-2 align-middle whitespace-nowrap">
                  {row.labels.map((lab) => (
                    <span
                      key={lab.name}
                      className="mr-1 inline-flex items-center rounded-full border px-1.5 py-0.5 font-mono text-[9.5px] whitespace-nowrap"
                      style={{
                        color: lab.colorVar,
                        background: `color-mix(in srgb, ${lab.colorVar} 14%, transparent)`,
                        borderColor: `color-mix(in srgb, ${lab.colorVar} 35%, transparent)`
                      }}
                    >
                      {lab.name}
                    </span>
                  ))}
                </td>
                <td className="border-b border-border-default px-2.5 py-2 text-right align-middle font-mono text-[10.5px] whitespace-nowrap text-text-muted tabular-nums">
                  {row.updated}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DashboardCard>
  )
}
