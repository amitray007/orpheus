// ---------------------------------------------------------------------------
// LiveAgentsTable — U4 (final Phase-1 unit). Real TanStack Table wired to
// `useLiveAgents` (workspaces + sessions + activity snapshot join).
//
// TanStack Table is HEADLESS — it owns column defs, row model, and (future)
// sort state; the actual markup below is hand-rolled to match Orpheus's
// existing card/table density (see DashboardCard, PrTable/IssuesTable
// siblings) and to support the two-line row layout, which a plain <table>
// column model can't express per-cell.
//
// Row layout — HYBRID one/two-line (not blanket two-line):
//   Line 1 (always): state badge · TASK TITLE (the agent's real current
//     task — session.lastUserMessagePreview/title/workspace.lastTitle,
//     resolved by resolveTaskTitle — NOT the generic workspace name) ·
//     project (muted mono) · model (muted mono, prettified) · since
//     (right-aligned, tabular-nums).
//   Line 2 (only when `doing` is non-null): "Claude Code" as the agent-kind
//     subline, muted mono. This is the long-content case two lines solve
//     for — line 1 already carries the meaningful task text, so line 2 is
//     just a quiet kind label. Rows with no doing text (e.g. a workspace
//     that just started, before any user message is recorded) collapse to
//     a single line so the table doesn't grow empty vertical space.
//
// V1 REBUILD — overflow hardening: table-layout:fixed with explicit widths
// on State/Project/Model/Since (mirroring PrTable/IssuesTable's hardening),
// leaving the Task Title column as the one flexible column (its cell
// already used the max-w-0 truncation trick, kept as-is). Empty state is
// the mockup's compact `.empty-inline` — one muted dot + one line, not a
// big padded void.
//
// V4 — column widths rebalanced (Project/Since were clipping): Project
// widened to fit typical project slugs, Model trimmed now the label is
// short ("Opus 4.8"), Since widened so "just now"/"39s ago" never clip.
// ---------------------------------------------------------------------------

import {
  createColumnHelper,
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
  type ColumnDef
} from '@tanstack/react-table'
import { cn } from '@/lib/utils'
import { DashboardCard } from './DashboardCard'
import { TablePager } from './TablePager'
import { TableRowsSkeleton } from './DashboardSkeletons'
import { useLiveAgents } from './useLiveAgents'
import {
  formatSinceLabel,
  LIVE_AGENT_STATE_LABEL,
  type LiveAgentDisplayState,
  type LiveAgentRow
} from './liveAgents.helpers'
import { formatCompact } from './dashboardHome.helpers'

// Live agents paginate 5/page (exact size from the design spec) — TanStack's
// own pagination row model owns the page state here rather than a local
// useState, since the table is already wired through useReactTable.
const AGENT_PAGE_SIZE = 5

// State badge colors — kept consistent with ActivityIndicator.tsx's own
// palette for the SAME states (that component uses text-emerald-400 for
// 'ready', text-amber-400 for 'attention', text-accent for 'working' dots),
// but expressed as Orpheus chart tokens here since this is a filled badge
// (bg + text) rather than a bare glyph, and the app has no semantic
// "success green" token — --color-chart-3 is the established stand-in used
// elsewhere in dashboard-home (see StatTile/SectionHeader "Your pulse" dot).
const STATE_BADGE_CLASS: Record<LiveAgentDisplayState, string> = {
  working: 'text-[color:var(--color-chart-3)] bg-[color:var(--color-chart-3)]/12',
  attention: 'text-accent bg-accent/13',
  ready: 'text-text-muted bg-surface-overlay'
}

const STATE_DOT_CLASS: Record<LiveAgentDisplayState, string> = {
  working: 'bg-[color:var(--color-chart-3)]',
  attention: 'bg-accent',
  ready: 'bg-text-muted'
}

function AgentStateBadge({ state }: { state: LiveAgentDisplayState }): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-[3px] font-mono text-[10px] tracking-wide whitespace-nowrap',
        STATE_BADGE_CLASS[state]
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', STATE_DOT_CLASS[state])} aria-hidden="true" />
      {LIVE_AGENT_STATE_LABEL[state]}
    </span>
  )
}

const columnHelper = createColumnHelper<LiveAgentRow>()

// Column defs exist mainly so TanStack owns the row model / (future) sort
// state consistently with the rest of the app's table stack; header labels
// are rendered directly below rather than via `flexRender(header.column...)`
// since there's exactly one fixed header row and no per-column customization
// yet (sorting can be added later by wiring getSortedRowModel + these defs).
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TanStack's ColumnDef<Row, Value> is per-column-value-typed; a heterogeneous array of columns (string/number/enum accessors) needs the `any` value param, same pattern TanStack's own docs use for a mixed column array.
const COLUMNS: ColumnDef<LiveAgentRow, any>[] = [
  columnHelper.accessor('state', { header: 'State' }),
  columnHelper.accessor('taskTitle', { header: 'Task' }),
  columnHelper.accessor('projectName', { header: 'Project' }),
  columnHelper.accessor('modelLabel', { header: 'Model' }),
  columnHelper.accessor('sinceMs', { header: 'Since' })
]

const HEADER_CLASS =
  'border-b border-border-default px-2.5 pb-1.5 text-left font-mono text-[9.5px] tracking-wider text-text-muted uppercase'

function EmptyState(): React.JSX.Element {
  return (
    <div className="flex items-center gap-2.5 px-1 py-3.5 text-[12px] text-text-muted">
      <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-text-muted/40" aria-hidden="true" />
      Nothing working, waiting, or recently finished right now.
    </div>
  )
}

export function LiveAgentsTable({
  onSelectWorkspace
}: {
  /** Optional — when provided, clicking a row navigates to that workspace
   *  (mirrors Dashboard.tsx's handleSelectWorkspace(workspaceId, projectId)
   *  signature, threaded down via MainContent -> DashboardView). When
   *  omitted, rows render inert (no clickable affordance). */
  onSelectWorkspace?: (workspaceId: string, projectId: string) => void
}): React.JSX.Element {
  const { loading, rows, waitingCount, finishedCount } = useLiveAgents()
  const running = rows.length - finishedCount

  const table = useReactTable({
    data: rows,
    columns: COLUMNS,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getRowId: (row) => row.workspaceId,
    initialState: { pagination: { pageSize: AGENT_PAGE_SIZE } }
  })

  // TanStack manages its own row-model memoization internally, so an extra
  // useMemo here was both redundant and tripped exhaustive-deps (the `rows`
  // dep is already reflected through `table`). Read it directly.
  const tableRows = table.getRowModel().rows
  // Background refreshes that shrink the row count under the current page
  // are handled by TanStack itself (getPaginationRowModel re-clamps
  // pageIndex against the new row count on every data update).
  const pageCount = table.getPageCount()
  const pageIndex = table.getState().pagination.pageIndex

  const meta = loading
    ? 'loading…'
    : `${formatCompact(running)} running · ${formatCompact(finishedCount)} finished · ${formatCompact(waitingCount)} waiting`

  if (loading && rows.length === 0) {
    return (
      <DashboardCard title="Live agents" meta={meta}>
        <TableRowsSkeleton rows={AGENT_PAGE_SIZE} cols={3} />
      </DashboardCard>
    )
  }

  return (
    <DashboardCard title="Live agents" meta={meta}>
      {rows.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="-mx-1 flex flex-1 flex-col overflow-x-auto">
          <table className="w-full table-fixed border-collapse text-xs">
            <colgroup>
              <col className="w-[104px]" />
              <col />
              <col className="w-[132px]" />
              <col className="w-[90px]" />
              <col className="w-[72px]" />
            </colgroup>
            <thead>
              <tr>
                <th className={HEADER_CLASS}>State</th>
                <th className={HEADER_CLASS}>Task</th>
                <th className={HEADER_CLASS}>Project</th>
                <th className={HEADER_CLASS}>Model</th>
                <th className={cn(HEADER_CLASS, 'text-right')}>Since</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((row) => {
                const agent = row.original
                const clickable = !!onSelectWorkspace
                const hasDoing = agent.doing !== null
                return (
                  <tr
                    key={agent.workspaceId}
                    onClick={
                      clickable
                        ? () => onSelectWorkspace(agent.workspaceId, agent.projectId)
                        : undefined
                    }
                    className={cn(
                      'align-top hover:bg-surface-overlay',
                      agent.state === 'ready' && 'opacity-70',
                      clickable && 'cursor-pointer'
                    )}
                  >
                    {/* Single <td> per logical column spans BOTH visual lines
                        via a flex-col wrapper — this is what makes the
                        one/two-line hybrid possible per-row without a second
                        <tr>: line 2 (doing text) only renders when present,
                        so the cell (and therefore the row) naturally
                        collapses to one line's height when there's nothing
                        to show. */}
                    <td className="border-b border-border-default px-2.5 py-2">
                      <AgentStateBadge state={agent.state} />
                    </td>
                    <td className="max-w-0 min-w-0 border-b border-border-default px-2.5 py-2">
                      <div className="min-w-0 truncate font-medium whitespace-nowrap text-text-primary">
                        {agent.taskTitle}
                      </div>
                      {hasDoing ? (
                        <div className="mt-0.5 truncate font-mono text-[10.5px] text-text-muted">
                          Claude Code
                        </div>
                      ) : null}
                    </td>
                    <td className="min-w-0 truncate border-b border-border-default px-2.5 py-2 font-mono text-[10.5px] text-text-muted">
                      {agent.projectName}
                    </td>
                    <td className="min-w-0 truncate border-b border-border-default px-2.5 py-2 font-mono text-[10px] text-text-muted">
                      {agent.modelLabel}
                    </td>
                    <td className="border-b border-border-default px-2.5 py-2 text-right font-mono text-[10.5px] whitespace-nowrap text-text-muted tabular-nums">
                      {formatSinceLabel(agent.sinceMs)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {pageCount > 1 ? (
            <TablePager
              page={pageIndex + 1}
              pageCount={pageCount}
              onPrev={() => table.previousPage()}
              onNext={() => table.nextPage()}
            />
          ) : null}
        </div>
      )}
    </DashboardCard>
  )
}
