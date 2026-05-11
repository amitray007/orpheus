import { useState, useEffect, useRef } from 'react'
import {
  Folder,
  Archive,
  ArrowUUpLeft,
  CaretDown,
  CaretRight,
  ClockCounterClockwise,
  Stack,
  Plus,
  X,
  Terminal
} from '@phosphor-icons/react'
import type { ProjectRecord, SessionRecord, SessionStatus, WorkspaceRecord } from '@shared/types'
import { SessionListSkeleton, Skeleton } from '../Skeleton'

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
// Workspace card
// ---------------------------------------------------------------------------

interface WorkspaceCardProps {
  workspace: WorkspaceRecord
  onSelect: () => void
  onArchive: () => void
}

function WorkspaceCard({ workspace, onSelect, onArchive }: WorkspaceCardProps): React.JSX.Element {
  return (
    <div className="group relative bg-surface-raised border border-border-default rounded-lg p-4 transition-colors duration-150 hover:border-accent/30 hover:bg-surface-overlay/40">
      <button
        onClick={onSelect}
        className="w-full text-left flex flex-col gap-2"
      >
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded bg-surface-overlay">
            <Stack size={14} weight="fill" className="text-accent" />
          </div>
          <span className="text-sm font-medium text-text-primary truncate flex-1">
            {workspace.name}
          </span>
        </div>
        <p className="text-xs text-text-muted truncate flex items-center gap-1" title={workspace.cwd}>
          <Folder size={10} className="flex-shrink-0" />
          {workspace.cwd}
        </p>
        {workspace.lastOpenedAt ? (
          <p className="text-xs text-text-muted">
            Last opened {relativeTime(workspace.lastOpenedAt)}
          </p>
        ) : (
          <p className="text-xs text-text-muted">Never opened</p>
        )}
      </button>

      {/* Archive button on hover */}
      <button
        onClick={(e) => {
          e.stopPropagation()
          onArchive()
        }}
        title="Archive workspace"
        className="absolute top-3 right-3 p-1 rounded opacity-0 group-hover:opacity-100 transition-all duration-150 text-text-muted hover:text-text-primary hover:bg-surface-overlay"
      >
        <Archive size={12} />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// New workspace inline form
// ---------------------------------------------------------------------------

interface NewWorkspaceFormProps {
  projectPath: string
  onCancel: () => void
  onCreate: (name: string, cwd: string) => Promise<void>
}

function NewWorkspaceForm({ projectPath, onCancel, onCreate }: NewWorkspaceFormProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState(projectPath)
  const [creating, setCreating] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  async function handleCreate(): Promise<void> {
    if (!name.trim() || creating) return
    setCreating(true)
    try {
      await onCreate(name.trim(), cwd.trim() || projectPath)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="border border-accent/30 rounded-lg p-4 bg-surface-overlay/30 flex flex-col gap-3">
      <p className="text-xs font-medium text-text-secondary uppercase tracking-wider">New workspace</p>
      <div className="flex flex-col gap-2">
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Workspace name"
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleCreate()
            if (e.key === 'Escape') onCancel()
          }}
          className="px-3 py-1.5 rounded-md text-sm bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus:border-accent/50 transition-colors duration-150 w-full"
        />
        <input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="Working directory (defaults to project root)"
          className="px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-muted placeholder-text-muted outline-none focus:border-accent/50 transition-colors duration-150 w-full font-mono"
        />
      </div>
      <div className="flex gap-2">
        <button
          onClick={handleCreate}
          disabled={!name.trim() || creating}
          className={[
            'px-3 py-1.5 rounded-md text-xs font-medium transition-colors duration-150',
            !name.trim() || creating
              ? 'bg-accent/30 text-text-muted cursor-not-allowed'
              : 'bg-accent text-white hover:bg-accent/80'
          ].join(' ')}
        >
          {creating ? 'Creating…' : 'Create'}
        </button>
        <button
          onClick={onCancel}
          className="px-3 py-1.5 rounded-md text-xs font-medium border border-border-default text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-colors duration-150"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ProjectView
// ---------------------------------------------------------------------------

interface ProjectViewProps {
  project: ProjectRecord
  onRemoved: () => void
  onSelectWorkspace: (workspaceId: string) => void
  onWorkspaceCreated: (name: string, cwd: string) => Promise<void>
}

export function ProjectView({
  project,
  onRemoved,
  onSelectWorkspace,
  onWorkspaceCreated
}: ProjectViewProps): React.JSX.Element {
  const [removing, setRemoving] = useState(false)

  // Workspaces — projectId-keyed shape so `loading` derives from state without
  // a synchronous setState inside the effect (matches the sessions pattern below).
  const [workspaceData, setWorkspaceData] = useState<{
    projectId: string | null
    list: WorkspaceRecord[]
  }>({ projectId: null, list: [] })
  const workspaces = workspaceData.list
  const workspacesLoading = workspaceData.projectId !== project.id
  const [showNewWorkspaceForm, setShowNewWorkspaceForm] = useState(false)

  // Sessions (legacy CC)
  const [sessionData, setSessionData] = useState<{
    projectId: string | null
    list: SessionRecord[]
  }>({ projectId: null, list: [] })
  const [legacyExpanded, setLegacyExpanded] = useState(false)
  const [showArchived, setShowArchived] = useState(false)

  const sessions = sessionData.list
  const sessionsLoading = sessionData.projectId !== project.id

  // Load workspaces
  useEffect(() => {
    let cancelled = false
    window.api.workspaces
      .listForProject(project.id)
      .then((list) => {
        if (!cancelled) setWorkspaceData({ projectId: project.id, list })
      })
      .catch((err) => {
        console.error('[project-view] failed to load workspaces', err)
        if (!cancelled) setWorkspaceData({ projectId: project.id, list: [] })
      })
    return () => {
      cancelled = true
    }
  }, [project.id])

  // Load sessions
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

  async function handleRemoveProject(): Promise<void> {
    if (removing) return
    setRemoving(true)
    try {
      await window.api.projects.remove(project.id)
      onRemoved()
    } catch (err) {
      console.error('[project-view] remove failed', err)
      setRemoving(false)
    }
  }

  function handleSetSessionStatus(id: string, status: SessionStatus): void {
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
      window.api.sessions
        .listForProject(project.id, { includeArchived: true })
        .then((list) => setSessionData({ projectId: project.id, list }))
        .catch(console.error)
    })
  }

  async function handleArchiveWorkspace(workspaceId: string): Promise<void> {
    try {
      await window.api.workspaces.archive(workspaceId)
      setWorkspaceData((prev) => ({
        projectId: prev.projectId,
        list: prev.list.filter((w) => w.id !== workspaceId)
      }))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('last active')) {
        alert('Cannot archive the last active workspace in this project.')
      } else {
        console.error('[project-view] workspace archive failed', err)
      }
    }
  }

  async function handleCreateWorkspace(name: string, cwd: string): Promise<void> {
    await onWorkspaceCreated(name, cwd)
    // Refresh workspace list
    const list = await window.api.workspaces.listForProject(project.id)
    setWorkspaceData({ projectId: project.id, list })
    setShowNewWorkspaceForm(false)
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
          onClick={handleRemoveProject}
          disabled={removing}
          className={[
            'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium',
            'border border-border-default transition-colors duration-150 flex-shrink-0',
            removing
              ? 'opacity-40 cursor-wait text-text-muted'
              : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay'
          ].join(' ')}
        >
          <Archive size={14} weight="regular" />
          {removing ? 'Removing…' : 'Remove'}
        </button>
      </div>

      {/* Workspaces section — primary */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-medium uppercase tracking-wider text-text-secondary flex items-center gap-1.5">
            <Stack size={12} className="text-accent" />
            Workspaces
          </h2>
          <button
            onClick={() => setShowNewWorkspaceForm((v) => !v)}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border border-border-default text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-colors duration-150"
          >
            {showNewWorkspaceForm ? (
              <>
                <X size={11} />
                Cancel
              </>
            ) : (
              <>
                <Plus size={11} />
                New workspace
              </>
            )}
          </button>
        </div>

        {showNewWorkspaceForm && (
          <NewWorkspaceForm
            projectPath={project.path}
            onCancel={() => setShowNewWorkspaceForm(false)}
            onCreate={handleCreateWorkspace}
          />
        )}

        {workspacesLoading ? (
          <div className="grid grid-cols-2 gap-3">
            <Skeleton className="h-24 rounded-lg opacity-70" />
            <Skeleton className="h-24 rounded-lg opacity-40" />
          </div>
        ) : workspaces.length === 0 ? (
          <div className="bg-surface-raised border border-border-default rounded-lg p-8 flex flex-col items-center gap-2">
            <Terminal size={24} className="text-text-muted opacity-50" />
            <p className="text-sm text-text-muted text-center">No workspaces yet</p>
            <p className="text-xs text-text-muted text-center max-w-xs">
              Create a workspace to start working in this project.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {workspaces.map((ws) => (
              <WorkspaceCard
                key={ws.id}
                workspace={ws}
                onSelect={() => onSelectWorkspace(ws.id)}
                onArchive={() => handleArchiveWorkspace(ws.id)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Legacy CC Sessions — collapsed by default */}
      <section className="flex flex-col gap-1">
        <button
          onClick={() => setLegacyExpanded((v) => !v)}
          className="flex items-center gap-1.5 px-1 py-1 rounded cursor-pointer hover:text-text-primary transition-colors duration-150"
        >
          {legacyExpanded ? (
            <CaretDown size={11} className="text-text-muted" />
          ) : (
            <CaretRight size={11} className="text-text-muted" />
          )}
          <h2 className="text-xs font-medium uppercase tracking-wider text-text-secondary">
            Legacy Claude Code Sessions
          </h2>
          {!sessionsLoading && (
            <span className="text-xs text-text-muted ml-1">({sessions.length})</span>
          )}
        </button>

        {legacyExpanded && (
          <>
            <div className="flex items-center justify-end mb-1">
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
              <div className="bg-surface-raised border border-border-default rounded-lg p-6 flex flex-col items-center gap-2">
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
          </>
        )}
      </section>
    </div>
  )
}
