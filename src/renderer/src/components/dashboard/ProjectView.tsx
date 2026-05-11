import { useState, useEffect } from 'react'
import {
  Folder,
  Archive,
  ArrowUUpLeft,
  CaretDown,
  CaretRight,
  ClockCounterClockwise
} from '@phosphor-icons/react'
import type { ProjectRecord, SessionRecord, SessionStatus } from '@shared/types'
import { SessionListSkeleton } from '../Skeleton'

// ---------------------------------------------------------------------------
// Relative time helper
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

// ---------------------------------------------------------------------------
// Status dot
// ---------------------------------------------------------------------------

function StatusDot({ status }: { status: SessionStatus }): React.JSX.Element {
  if (status === 'in_progress') {
    return (
      <span
        className="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0 animate-pulse"
        title="In progress"
      />
    )
  }
  if (status === 'in_review') {
    return (
      <span
        className="w-2 h-2 rounded-full bg-accent flex-shrink-0"
        title="In review"
      />
    )
  }
  // archived
  return (
    <span
      className="w-2 h-2 rounded-full bg-text-muted flex-shrink-0 opacity-50"
      title="Archived"
    />
  )
}

// ---------------------------------------------------------------------------
// Session row
// ---------------------------------------------------------------------------

interface SessionRowProps {
  session: SessionRecord
  onSetStatus: (id: string, status: SessionStatus) => void
}

function SessionRow({ session, onSetStatus }: SessionRowProps): React.JSX.Element {
  const [loading, setLoading] = useState(false)

  const displayTitle =
    session.title ?? `Session ${session.id.slice(0, 8)}`

  async function handleToggleArchive(): Promise<void> {
    if (loading) return
    setLoading(true)
    const next: SessionStatus = session.status === 'archived' ? 'in_review' : 'archived'
    onSetStatus(session.id, next)
    // Don't reset loading — parent will re-render with new status
  }

  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-surface-overlay group transition-colors duration-100">
      <StatusDot status={session.status} />
      <span className="text-sm text-text-primary truncate flex-1 min-w-0" title={displayTitle}>
        {displayTitle}
      </span>
      <span className="text-xs text-text-muted flex-shrink-0 flex items-center gap-1">
        <ClockCounterClockwise size={11} />
        {relativeTime(session.updatedAt)}
      </span>
      <button
        onClick={handleToggleArchive}
        disabled={loading}
        title={session.status === 'archived' ? 'Unarchive' : 'Archive'}
        className={[
          'flex-shrink-0 p-1 rounded transition-all duration-150',
          'opacity-0 group-hover:opacity-100',
          loading ? 'opacity-30 cursor-wait' : 'text-text-muted hover:text-text-primary hover:bg-surface-raised'
        ].join(' ')}
      >
        {session.status === 'archived' ? (
          <ArrowUUpLeft size={13} weight="regular" />
        ) : (
          <Archive size={13} weight="regular" />
        )}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Session group
// ---------------------------------------------------------------------------

interface SessionGroupProps {
  label: string
  sessions: SessionRecord[]
  collapsible?: boolean
  defaultCollapsed?: boolean
  onSetStatus: (id: string, status: SessionStatus) => void
}

function SessionGroup({
  label,
  sessions,
  collapsible = false,
  defaultCollapsed = false,
  onSetStatus
}: SessionGroupProps): React.JSX.Element | null {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)

  if (sessions.length === 0) return null

  return (
    <div className="flex flex-col">
      <button
        onClick={collapsible ? () => setCollapsed((v) => !v) : undefined}
        className={[
          'flex items-center gap-1.5 px-1 py-1 mb-1',
          collapsible ? 'cursor-pointer hover:text-text-primary' : 'cursor-default'
        ].join(' ')}
      >
        {collapsible ? (
          collapsed ? (
            <CaretRight size={11} className="text-text-muted" />
          ) : (
            <CaretDown size={11} className="text-text-muted" />
          )
        ) : null}
        <span className="text-xs font-medium uppercase tracking-wider text-text-muted">
          {label}
        </span>
        <span className="text-xs text-text-muted ml-1">({sessions.length})</span>
      </button>

      {!collapsed && (
        <div className="flex flex-col gap-0.5">
          {sessions.map((s) => (
            <SessionRow key={s.id} session={s} onSetStatus={onSetStatus} />
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ProjectView
// ---------------------------------------------------------------------------

interface ProjectViewProps {
  project: ProjectRecord
  onArchived: () => void
}

export function ProjectView({ project, onArchived }: ProjectViewProps): React.JSX.Element {
  const [archiving, setArchiving] = useState(false)
  // { projectId, list } — projectId tells us which fetch the list belongs to.
  // If projectId doesn't match props.project.id we treat it as loading.
  const [sessionData, setSessionData] = useState<{
    projectId: string | null
    list: SessionRecord[]
  }>({ projectId: null, list: [] })
  const [showArchived, setShowArchived] = useState(false)

  const sessions = sessionData.list
  const sessionsLoading = sessionData.projectId !== project.id

  useEffect(() => {
    let cancelled = false
    window.api.sessions
      .listForProject(project.id, { includeArchived: true })
      .then((list) => {
        if (!cancelled) setSessionData({ projectId: project.id, list })
      })
      .catch((err) => {
        console.error('[project-view] failed to load sessions', err)
        if (!cancelled) setSessionData({ projectId: project.id, list: [] })
      })
    return () => {
      cancelled = true
    }
  }, [project.id])

  async function handleArchiveProject(): Promise<void> {
    if (archiving) return
    setArchiving(true)
    try {
      await window.api.projects.archive(project.id)
      onArchived()
    } catch (err) {
      console.error('[project-view] archive failed', err)
      setArchiving(false)
    }
  }

  function handleSetSessionStatus(id: string, status: SessionStatus): void {
    // Optimistic update
    const updated = sessions.map((s) =>
      s.id === id
        ? {
            ...s,
            status,
            archivedAt: status === 'archived' ? Date.now() : null,
            updatedAt: Date.now()
          }
        : s
    )
    setSessionData({ projectId: project.id, list: updated })
    window.api.sessions.setStatus(id, status).catch((err) => {
      console.error('[project-view] setStatus failed', err)
      // Reload on failure
      window.api.sessions
        .listForProject(project.id, { includeArchived: true })
        .then((list) => setSessionData({ projectId: project.id, list }))
        .catch(console.error)
    })
  }

  const inProgressSessions = sessions.filter((s) => s.status === 'in_progress')
  const inReviewSessions = sessions.filter((s) => s.status === 'in_review')
  const archivedSessions = sessions.filter((s) => s.status === 'archived')

  const hasAnySessions = sessions.length > 0

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="mt-0.5 p-2 rounded-lg bg-surface-raised border border-border-default flex-shrink-0">
            <Folder size={20} weight="fill" className="text-accent" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-text-primary truncate">{project.name}</h1>
            <p className="text-xs text-text-muted mt-0.5 truncate" title={project.path}>
              {project.path}
            </p>
          </div>
        </div>

        <button
          onClick={handleArchiveProject}
          disabled={archiving}
          className={[
            'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium',
            'border border-border-default transition-colors duration-150 flex-shrink-0',
            archiving
              ? 'opacity-40 cursor-wait text-text-muted'
              : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay'
          ].join(' ')}
        >
          <Archive size={14} weight="regular" />
          {archiving ? 'Archiving…' : 'Archive'}
        </button>
      </div>

      {/* Sessions */}
      <section className="flex flex-col gap-1">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-xs font-medium uppercase tracking-wider text-text-secondary">
            Sessions
          </h2>
          {archivedSessions.length > 0 && (
            <button
              onClick={() => setShowArchived((v) => !v)}
              className="text-xs text-text-muted hover:text-text-primary transition-colors duration-150"
            >
              {showArchived ? 'Hide archived' : `Show archived (${archivedSessions.length})`}
            </button>
          )}
        </div>

        {sessionsLoading ? (
          <div className="bg-surface-raised border border-border-default rounded-lg py-3">
            <SessionListSkeleton />
          </div>
        ) : !hasAnySessions ? (
          <div className="bg-surface-raised border border-border-default rounded-lg p-8 flex flex-col items-center gap-2">
            <p className="text-sm text-text-muted text-center">No sessions yet</p>
            <p className="text-xs text-text-muted text-center max-w-xs">
              Start Claude Code in this folder and your sessions will appear here.
            </p>
          </div>
        ) : (
          <div className="bg-surface-raised border border-border-default rounded-lg p-3 flex flex-col gap-4">
            <SessionGroup
              label="In Progress"
              sessions={inProgressSessions}
              onSetStatus={handleSetSessionStatus}
            />
            <SessionGroup
              label="In Review"
              sessions={inReviewSessions}
              onSetStatus={handleSetSessionStatus}
            />
            {showArchived && (
              <SessionGroup
                label="Archived"
                sessions={archivedSessions}
                collapsible
                defaultCollapsed={false}
                onSetStatus={handleSetSessionStatus}
              />
            )}
          </div>
        )}
      </section>
    </div>
  )
}
