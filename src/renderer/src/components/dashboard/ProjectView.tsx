import { useState, useEffect } from 'react'
import {
  Folder,
  Archive,
  ArrowUUpLeft,
  CaretDown,
  CaretRight,
  ClockCounterClockwise,
  Stack,
  Plus,
  Terminal,
  PencilSimple,
  PushPin
} from '@phosphor-icons/react'
import type { ProjectRecord, SessionRecord, SessionStatus, WorkspaceRecord } from '@shared/types'
import { SessionListSkeleton, Skeleton } from '../Skeleton'
import { ContextMenu } from '../ContextMenu'

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
    <div className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-surface-overlay group transition-colors duration-100 cursor-default">
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
          loading ? 'opacity-30 cursor-wait' : 'text-text-muted hover:text-text-primary hover:bg-surface-raised cursor-pointer'
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
  archived?: boolean
  renaming: boolean
  onSelect: () => void
  onBeginRename: () => void
  onFinishRename: (newName: string) => void
  onCancelRename: () => void
  onTogglePin: () => void
  onArchive: () => void
  onUnarchive?: () => void
}

function WorkspaceCard({
  workspace,
  archived = false,
  renaming,
  onSelect,
  onBeginRename,
  onFinishRename,
  onCancelRename,
  onTogglePin,
  onArchive,
  onUnarchive
}: WorkspaceCardProps): React.JSX.Element {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [renameValue, setRenameValue] = useState(workspace.name)

  // Sync rename value when workspace name changes externally
  if (!renaming && renameValue !== workspace.name) {
    setRenameValue(workspace.name)
  }

  const isPinned = workspace.pinnedAt !== null

  function handleContextMenu(e: React.MouseEvent): void {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY })
  }

  function handleRenameCommit(): void {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== workspace.name) {
      onFinishRename(trimmed)
    } else {
      onCancelRename()
    }
  }

  const activeMenuItems = [
    {
      label: 'Rename',
      icon: <PencilSimple size={13} />,
      onClick: onBeginRename
    },
    {
      label: isPinned ? 'Unpin' : 'Pin',
      icon: <PushPin size={13} weight={isPinned ? 'fill' : 'regular'} />,
      onClick: onTogglePin
    },
    { divider: true, label: '', onClick: () => {} },
    {
      label: 'Archive',
      icon: <Archive size={13} />,
      onClick: onArchive,
      destructive: true
    }
  ]

  const archivedMenuItems = [
    {
      label: 'Unarchive',
      icon: <ArrowUUpLeft size={13} />,
      onClick: onUnarchive ?? (() => {})
    },
    {
      label: 'Rename',
      icon: <PencilSimple size={13} />,
      onClick: onBeginRename
    }
  ]

  return (
    <div
      className={[
        'group relative bg-surface-raised border border-border-default rounded-lg p-4 transition-all duration-150 hover:border-accent/30 hover:bg-surface-overlay/40',
        archived ? 'opacity-60 hover:opacity-80 grayscale-[30%]' : ''
      ].join(' ')}
      onContextMenu={handleContextMenu}
    >
      <button
        onClick={renaming ? undefined : onSelect}
        className={[
          'w-full text-left flex flex-col gap-2',
          renaming ? 'cursor-default' : 'cursor-pointer'
        ].join(' ')}
      >
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded bg-surface-overlay">
            <Stack size={14} weight="fill" className={archived ? 'text-text-muted' : 'text-accent'} />
          </div>
          {renaming ? (
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRenameCommit()
                if (e.key === 'Escape') onCancelRename()
              }}
              onBlur={handleRenameCommit}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              className="text-sm bg-surface-overlay border border-accent/40 rounded px-2 py-0.5 outline-none text-text-primary min-w-0 flex-1"
            />
          ) : (
            <span className="text-sm font-medium text-text-primary truncate flex-1">
              {workspace.name}
            </span>
          )}
        </div>
        {!renaming && (
          <>
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
          </>
        )}
      </button>

      {/* Archived: hover-revealed Unarchive button */}
      {archived && !renaming && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onUnarchive?.()
          }}
          title="Unarchive workspace"
          className="absolute top-3 right-3 p-1 rounded opacity-0 group-hover:opacity-100 transition-all duration-150 text-text-muted hover:text-text-primary hover:bg-surface-overlay cursor-pointer"
        >
          <ArrowUUpLeft size={12} />
        </button>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={archived ? archivedMenuItems : activeMenuItems}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ProjectView
// ---------------------------------------------------------------------------

interface ProjectViewProps {
  project: ProjectRecord
  // null = not yet fetched (Dashboard lazy-loads on select); array = ready
  workspaces: WorkspaceRecord[] | null
  onRequestRemove: () => void
  onSelectWorkspace: (workspaceId: string) => void
  onAddWorkspace: (projectId: string) => void | Promise<void>
  onRenameWorkspace: (workspaceId: string, projectId: string, newName: string) => void | Promise<void>
  onArchiveWorkspace: (workspaceId: string, projectId: string) => void | Promise<void>
  onUnarchiveWorkspace: (workspaceId: string, projectId: string) => void | Promise<void>
  onToggleWorkspacePin: (workspaceId: string, projectId: string) => void | Promise<void>
}

export function ProjectView({
  project,
  workspaces,
  onRequestRemove,
  onSelectWorkspace,
  onAddWorkspace,
  onRenameWorkspace,
  onArchiveWorkspace,
  onUnarchiveWorkspace,
  onToggleWorkspacePin
}: ProjectViewProps): React.JSX.Element {
  const workspacesLoading = workspaces === null
  const allWorkspaces = workspaces ?? []
  const activeWorkspaces = allWorkspaces.filter((w) => w.archivedAt === null)
  const archivedWorkspaces = allWorkspaces.filter((w) => w.archivedAt !== null)

  const [renamingWorkspaceId, setRenamingWorkspaceId] = useState<string | null>(null)
  const [archivedExpanded, setArchivedExpanded] = useState(false)

  // Sessions (legacy CC)
  const [sessionData, setSessionData] = useState<{
    projectId: string | null
    list: SessionRecord[]
  }>({ projectId: null, list: [] })
  const [legacyExpanded, setLegacyExpanded] = useState(false)
  const [showArchived, setShowArchived] = useState(false)

  const sessions = sessionData.list
  const sessionsLoading = sessionData.projectId !== project.id

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
          onClick={onRequestRemove}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-border-default transition-colors duration-150 flex-shrink-0 text-text-secondary hover:text-text-primary hover:bg-surface-overlay cursor-pointer"
        >
          <Archive size={14} weight="regular" />
          Remove
        </button>
      </div>

      {/* Workspaces section — active */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-medium uppercase tracking-wider text-text-secondary flex items-center gap-1.5">
            <Stack size={12} className="text-accent" />
            Workspaces
          </h2>
          <button
            onClick={() => onAddWorkspace(project.id)}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border border-border-default text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-colors duration-150 cursor-pointer"
          >
            <Plus size={11} />
            New workspace
          </button>
        </div>

        {workspacesLoading ? (
          <div className="grid grid-cols-2 gap-3">
            <Skeleton className="h-24 rounded-lg opacity-70" />
            <Skeleton className="h-24 rounded-lg opacity-40" />
          </div>
        ) : activeWorkspaces.length === 0 && archivedWorkspaces.length === 0 ? (
          <div className="bg-surface-raised border border-border-default rounded-lg p-8 flex flex-col items-center gap-2">
            <Terminal size={24} className="text-text-muted opacity-50" />
            <p className="text-sm text-text-muted text-center">No workspaces yet</p>
            <p className="text-xs text-text-muted text-center max-w-xs">
              Create a workspace to start working in this project.
            </p>
          </div>
        ) : activeWorkspaces.length === 0 ? (
          <div className="bg-surface-raised border border-border-default rounded-lg p-6 flex flex-col items-center gap-2">
            <p className="text-sm text-text-muted text-center">All workspaces are archived.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {activeWorkspaces.map((ws) => (
              <WorkspaceCard
                key={ws.id}
                workspace={ws}
                renaming={renamingWorkspaceId === ws.id}
                onBeginRename={() => setRenamingWorkspaceId(ws.id)}
                onFinishRename={(newName) => {
                  onRenameWorkspace(ws.id, project.id, newName)
                  setRenamingWorkspaceId(null)
                }}
                onCancelRename={() => setRenamingWorkspaceId(null)}
                onSelect={() => onSelectWorkspace(ws.id)}
                onTogglePin={() => onToggleWorkspacePin(ws.id, project.id)}
                onArchive={() => onArchiveWorkspace(ws.id, project.id)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Archived workspaces section */}
      {archivedWorkspaces.length > 0 && (
        <section className="flex flex-col gap-1">
          <button
            onClick={() => setArchivedExpanded((v) => !v)}
            className="flex items-center gap-1.5 px-1 py-1 rounded cursor-pointer hover:text-text-primary transition-colors duration-150 self-start"
          >
            {archivedExpanded ? (
              <CaretDown size={11} className="text-text-muted" />
            ) : (
              <CaretRight size={11} className="text-text-muted" />
            )}
            <h2 className="text-xs font-medium uppercase tracking-wider text-text-secondary">Archived</h2>
            <span className="text-xs text-text-muted ml-1">({archivedWorkspaces.length})</span>
          </button>

          {archivedExpanded && (
            <div className="grid grid-cols-2 gap-3 mt-1">
              {archivedWorkspaces.map((ws) => (
                <WorkspaceCard
                  key={ws.id}
                  workspace={ws}
                  archived
                  renaming={renamingWorkspaceId === ws.id}
                  onBeginRename={() => setRenamingWorkspaceId(ws.id)}
                  onFinishRename={(newName) => {
                    onRenameWorkspace(ws.id, project.id, newName)
                    setRenamingWorkspaceId(null)
                  }}
                  onCancelRename={() => setRenamingWorkspaceId(null)}
                  onSelect={() => onSelectWorkspace(ws.id)}
                  onTogglePin={() => onToggleWorkspacePin(ws.id, project.id)}
                  onArchive={() => onArchiveWorkspace(ws.id, project.id)}
                  onUnarchive={() => onUnarchiveWorkspace(ws.id, project.id)}
                />
              ))}
            </div>
          )}
        </section>
      )}

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
                  className="text-xs text-text-muted hover:text-text-primary transition-colors duration-150 cursor-pointer"
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
