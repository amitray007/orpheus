import { useState } from 'react'
import { ChatCircleDots, ClockCounterClockwise } from '@phosphor-icons/react'
import type { ClaudeRecentSession } from '@shared/types'
import { DashboardCard } from './DashboardCard'
import { TableRowsSkeleton } from './DashboardSkeletons'
import { TablePager } from './TablePager'
import { formatCompact, formatCompactAge } from './dashboardHome.helpers'

const PAGE_SIZE = 5

function formatDuration(durationMs: number | null): string | null {
  if (durationMs === null || durationMs <= 0) return null
  const minutes = Math.max(1, Math.round(durationMs / 60000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`
}

export function RecentSessionsTable({
  sessions,
  loading
}: {
  sessions: ClaudeRecentSession[]
  loading: boolean
}): React.JSX.Element {
  const [requestedPage, setPage] = useState(0)
  const pageCount = Math.max(1, Math.ceil(sessions.length / PAGE_SIZE))
  const page = Math.min(requestedPage, pageCount - 1)
  const rows = sessions.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)
  const cardMeta = loading ? (
    <span className="inline-block h-3 w-16 animate-pulse rounded bg-surface-overlay" />
  ) : (
    `${sessions.length} Sessions`
  )

  if (loading) {
    return (
      <DashboardCard title="Claude Sessions" meta={cardMeta} className="h-full min-h-72">
        <TableRowsSkeleton rows={5} cols={1} />
      </DashboardCard>
    )
  }

  return (
    <DashboardCard title="Claude Sessions" meta={cardMeta} className="h-full min-h-72">
      {sessions.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <ClockCounterClockwise
            size={22}
            weight="duotone"
            className="text-text-muted"
            aria-hidden="true"
          />
          <div className="text-[12px] font-medium text-text-primary">No recent sessions</div>
          <div className="text-[11px] text-text-muted">
            Recent top-level Claude sessions will appear here.
          </div>
        </div>
      ) : (
        <div className="-mx-1 flex flex-1 flex-col">
          {rows.map((session) => {
            const duration = formatDuration(session.durationMs)
            const interactionCount = session.turnCount ?? session.messageCount
            return (
              <div
                key={session.id}
                className="flex min-w-0 items-center gap-2.5 border-b border-border-default px-2.5 py-2"
              >
                <ChatCircleDots
                  size={15}
                  weight="duotone"
                  className="shrink-0 text-accent"
                  aria-hidden="true"
                />
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="truncate text-xs text-text-primary">{session.title}</div>
                  <div className="truncate font-mono text-[10px] text-text-muted">
                    {session.projectLabel}
                    {interactionCount !== null
                      ? ` · ${formatCompact(interactionCount)} ${session.turnCount !== null ? 'turns' : 'messages'}`
                      : ''}
                    {duration ? ` · ${duration}` : ''}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end font-mono text-[10px] text-text-muted tabular-nums">
                  <span>{formatCompact(session.tokenTotal)} tok</span>
                  <span>{formatCompactAge(session.lastActivity)}</span>
                </div>
              </div>
            )
          })}
          {pageCount > 1 ? (
            <TablePager
              page={page + 1}
              pageCount={pageCount}
              onPrev={() => setPage((value) => Math.max(0, value - 1))}
              onNext={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
            />
          ) : null}
        </div>
      )}
    </DashboardCard>
  )
}
