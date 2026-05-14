import { useState, useEffect } from 'react'
import { ClockCounterClockwise } from '@phosphor-icons/react'
import type { SessionRecord, SessionStatus } from '@shared/types'
import { SessionListSkeleton } from '../Skeleton'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  const s = Math.floor(diff / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  return `${mo}mo ago`
}

function StatusDot({ status }: { status: SessionStatus }): React.JSX.Element {
  if (status === 'in_progress') {
    return <span className="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0 animate-pulse" />
  }
  if (status === 'in_review') {
    return <span className="w-2 h-2 rounded-full bg-accent flex-shrink-0" />
  }
  return <span className="w-2 h-2 rounded-full bg-text-muted flex-shrink-0 opacity-50" />
}

// ---------------------------------------------------------------------------
// Filter chips
// ---------------------------------------------------------------------------

type Filter = 'in_review' | 'in_progress' | 'archived' | 'all'

const FILTERS: { label: string; value: Filter }[] = [
  { label: 'In Review', value: 'in_review' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'All', value: 'all' },
  { label: 'Archived', value: 'archived' }
]

// ---------------------------------------------------------------------------
// SessionsView
// ---------------------------------------------------------------------------

interface SessionsViewProps {
  onNavigateToProject: (projectId: string) => void
}

export function SessionsView({ onNavigateToProject }: SessionsViewProps): React.JSX.Element {
  const [filter, setFilter] = useState<Filter>('in_review')
  // { filter, list } — filter tells us which fetch the list belongs to.
  // If filter doesn't match current filter we treat it as loading.
  const [sessionData, setSessionData] = useState<{
    filter: Filter | null
    list: SessionRecord[]
  }>({ filter: null, list: [] })

  const sessions = sessionData.list
  const loading = sessionData.filter !== filter

  useEffect(() => {
    const opts = filter === 'all' ? undefined : { status: filter as SessionStatus }
    let cancelled = false
    window.api.sessions
      .listAll(opts)
      .then((list) => {
        if (!cancelled) setSessionData({ filter, list })
      })
      .catch((err) => {
        console.error('[sessions-view] failed to load sessions', err)
        if (!cancelled) setSessionData({ filter, list: [] })
      })
    return () => {
      cancelled = true
    }
  }, [filter])

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-primary">Sessions</h1>
        {/* Filter chips */}
        <div className="flex items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={[
                'px-3 py-1 rounded-md text-xs font-medium transition-colors duration-150 cursor-pointer',
                filter === f.value
                  ? 'bg-accent/15 text-text-primary border border-accent/30'
                  : 'text-text-muted hover:text-text-primary hover:bg-surface-overlay border border-transparent'
              ].join(' ')}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      {loading ? (
        <div className="bg-surface-raised border border-border-default rounded-lg py-3">
          <SessionListSkeleton />
        </div>
      ) : sessions.length === 0 ? (
        <div className="bg-surface-raised border border-border-default rounded-lg p-8 flex flex-col items-center gap-2">
          <p className="text-sm text-text-muted">No sessions found</p>
          <p className="text-xs text-text-muted">
            {filter === 'in_progress'
              ? 'No sessions are currently running.'
              : filter === 'archived'
                ? 'No archived sessions yet.'
                : 'Start Claude Code in any project folder to create sessions.'}
          </p>
        </div>
      ) : (
        <div className="bg-surface-raised border border-border-default rounded-lg divide-y divide-border-default/50">
          {sessions.map((session) => {
            const displayTitle = session.title ?? `Session ${session.id.slice(0, 8)}`

            return (
              <button
                key={session.id}
                onClick={() => onNavigateToProject(session.projectId)}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-surface-overlay transition-colors duration-100 text-left group cursor-pointer"
              >
                <StatusDot status={session.status} />
                <span
                  className="text-sm text-text-primary truncate flex-1 min-w-0"
                  title={displayTitle}
                >
                  {displayTitle}
                </span>
                <span className="text-xs text-text-muted flex-shrink-0 flex items-center gap-1 ml-2">
                  <ClockCounterClockwise size={11} />
                  {relativeTime(session.updatedAt)}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
