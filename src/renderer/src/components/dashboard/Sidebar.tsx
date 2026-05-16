import type React from 'react'
import { useState, useEffect, useRef } from 'react'
import type { Icon } from '@phosphor-icons/react'
import { Kanban, Plus, CaretDown, CaretRight, Stack, Archive, Gear } from '@phosphor-icons/react'
import type {
  ProjectRecord,
  SessionRecord,
  WorkspaceRecord,
  GitStatus,
  WorkspaceActivityDetail
} from '@shared/types'
import { ProjectListSkeleton } from '../Skeleton'
import { Identicon } from '../Identicon'
import { ActivityIndicator } from './ActivityIndicator'
import { resolveWorkspaceName } from './resolveWorkspaceName'

// ---------------------------------------------------------------------------
// Nav primitives
// ---------------------------------------------------------------------------

interface NavItemProps {
  Icon: Icon
  label: string
  active?: boolean
  collapsed: boolean
  flushTop?: boolean
  onClick?: () => void
}

function NavItem({
  Icon,
  label,
  active = false,
  collapsed,
  flushTop = false,
  onClick
}: NavItemProps): React.JSX.Element {
  return (
    <button
      className={[
        'w-full flex items-center transition-colors duration-150',
        flushTop ? 'rounded-b-md' : 'rounded-md',
        collapsed ? 'justify-center px-2 py-2' : 'px-3 py-2 gap-3',
        active
          ? 'bg-accent/15 text-text-primary font-medium'
          : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40'
      ].join(' ')}
      onClick={onClick}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
    >
      <Icon
        size={20}
        weight={active ? 'fill' : 'regular'}
        className={active ? 'text-accent' : ''}
      />
      {!collapsed && <span className="text-sm">{label}</span>}
    </button>
  )
}

interface SectionHeaderProps {
  label: string
  action?: React.ReactNode
}

function SectionHeader({ label, action }: SectionHeaderProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between px-3 mb-1">
      <p className="text-xs font-medium uppercase tracking-wider text-text-muted">{label}</p>
      {action}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Workspace sub-row (nested inside expanded project row)
// ---------------------------------------------------------------------------

interface WorkspaceRowProps {
  workspace: WorkspaceRecord
  project: ProjectRecord
  active: boolean
  activity: WorkspaceActivityDetail | undefined
  gitStatus?: GitStatus | null
  /** Map from claudeSessionId → first-user-prompt title (fetched once per project). */
  sessionTitleBySessionId: Map<string, string>
  /** Map from claudeSessionId → last user message preview (fetched once per project). */
  sessionUserPreviewBySessionId: Map<string, string>
  onSelect: () => void
  renaming: boolean
  onBeginRename: () => void
  onFinishRename: (newName: string) => void
  onCancelRename: () => void
  onArchive: () => void
}

function WorkspaceSubRow({
  workspace,
  active,
  activity,
  gitStatus,
  sessionTitleBySessionId,
  sessionUserPreviewBySessionId,
  onSelect,
  renaming,
  onBeginRename,
  onFinishRename,
  onCancelRename,
  onArchive
}: WorkspaceRowProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const [renameValue, setRenameValue] = useState(workspace.name)
  const [terminalTitle, setTerminalTitle] = useState<string | null>(null)

  useEffect(() => {
    const workspaceId = workspace.id
    window.api.workspaces
      .getTitle(workspaceId)
      .then((t) => {
        setTerminalTitle(t)
      })
      .catch(() => {})
    const unsub = window.api.workspaces.onTitleChanged((e) => {
      if (e.workspaceId === workspaceId) {
        setTerminalTitle(e.title || null)
      }
    })
    return unsub
  }, [workspace.id])

  const sessionTitle = workspace.claudeSessionId
    ? (sessionTitleBySessionId.get(workspace.claudeSessionId) ?? null)
    : null

  const dn = resolveWorkspaceName({ workspace, terminalTitle, sessionTitle })
  const displayName = dn.text

  const lastUserMsgPreview = workspace.claudeSessionId
    ? (sessionUserPreviewBySessionId.get(workspace.claudeSessionId) ?? null)
    : null

  // Seed the rename input with whatever the user currently sees, so renaming
  // from a Claude title doesn't snap back to "New workspace".
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- conditional sync: only updates when renaming mode activates
    if (renaming) setRenameValue(displayName)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renaming])

  async function handleContextMenu(e: React.MouseEvent): Promise<void> {
    e.preventDefault()
    const action = await window.api.contextMenu.show([
      { label: 'Rename', action: 'rename' },
      { divider: true },
      { label: 'Archive', action: 'archive' }
    ])
    if (!action) return
    if (action === 'rename') onBeginRename()
    else if (action === 'archive') onArchive()
  }

  function handleRenameCommit(): void {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== workspace.name) {
      onFinishRename(trimmed)
    } else {
      onCancelRename()
    }
    setRenameValue(workspace.name) // reset so a future rename starts clean
  }

  return (
    <div
      className={[
        'relative flex items-center rounded-r-md transition-colors duration-150 group',
        // 2px left bar on active rows for unambiguous selection.
        // Workspaces use white (text-primary); projects use the yellow accent.
        active
          ? 'bg-text-primary/10 text-text-primary border-l-2 border-text-primary'
          : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay border-l-2 border-transparent'
      ].join(' ')}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onContextMenu={handleContextMenu}
    >
      <button
        onClick={onSelect}
        className="flex items-center gap-2 pl-8 pr-2 h-8 flex-1 text-left min-w-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded-r-md"
        title={lastUserMsgPreview ? `${lastUserMsgPreview}\n\n${workspace.cwd}` : workspace.cwd}
        aria-label={workspace.name}
      >
        {/* Left: activity glyph (vertically centered with single-line title) */}
        <span className="flex-shrink-0">
          {activity && activity !== 'archived' ? (
            <ActivityIndicator detail={activity} />
          ) : (
            <Stack
              size={12}
              weight={active ? 'fill' : 'regular'}
              className={[
                'transition-colors duration-150',
                active ? 'text-text-primary' : 'text-text-muted group-hover:text-text-secondary'
              ].join(' ')}
            />
          )}
        </span>

        {/* Right: single-line name + optional git chip.
            Preview lives on the Workspaces kanban view (and in this row's
            title tooltip); the sidebar stays compact navigation. */}
        <span className="flex items-center gap-1 min-w-0 flex-1">
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
              className="bg-surface-overlay border border-accent/40 rounded px-1.5 py-0 outline-none text-xs text-text-primary min-w-0 flex-1"
            />
          ) : (
            <span
              className={[
                'text-xs truncate min-w-0 flex-1 leading-snug',
                dn.muted ? 'text-text-muted italic' : ''
              ].join(' ')}
              title={dn.text}
            >
              {dn.text}
            </span>
          )}
          {/* Git diff chip */}
          {!renaming && gitStatus && (gitStatus.insertions > 0 || gitStatus.deletions > 0) && (
            <span className="text-[10px] font-mono flex items-center gap-1 flex-shrink-0">
              {gitStatus.insertions > 0 && (
                <span className="text-emerald-400">+{gitStatus.insertions}</span>
              )}
              {gitStatus.deletions > 0 && (
                <span className="text-red-400">−{gitStatus.deletions}</span>
              )}
            </span>
          )}
        </span>
      </button>

      {/* Archive affordance — visible on hover. 32x32 hit target. */}
      {!renaming && hovered && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onArchive()
          }}
          className="flex-shrink-0 w-8 h-8 flex items-center justify-center mr-1 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
          aria-label="Archive workspace"
        >
          <Archive size={13} />
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Project row (with identicon, expand chevron, workspace count)
// ---------------------------------------------------------------------------

interface ProjectRowProps {
  project: ProjectRecord
  active: boolean
  expanded: boolean
  workspaces: WorkspaceRecord[]
  workspaceCount: number
  workspaceCountInline: boolean
  fetchGithubAvatars: boolean
  selectedWorkspaceId?: string | null
  workspaceActivities: Record<string, WorkspaceActivityDetail>
  gitStatusByWorkspaceId: Record<string, GitStatus | null>
  /** Map from claudeSessionId → session title for all sessions in this project. */
  sessionTitleBySessionId: Map<string, string>
  /** Map from claudeSessionId → last user message preview for all sessions in this project. */
  sessionUserPreviewBySessionId: Map<string, string>
  onSelect: () => void
  onToggleExpand: () => void
  onSelectWorkspace: (workspaceId: string) => void
  currentViewKind: string
  currentWorkspaceId?: string | null
  renaming: boolean
  onBeginRename: () => void
  onFinishRename: (newName: string) => void
  onCancelRename: () => void
  onRequestRemove: () => void
  onAddWorkspace: () => void
  renamingWorkspaceId: string | null
  onBeginRenameWorkspace: (workspaceId: string) => void
  onFinishRenameWorkspace: (workspaceId: string, newName: string) => void
  onCancelRenameWorkspace: () => void
  onArchiveWorkspace: (workspaceId: string) => void
  wsDragId: string | null
  wsDropTargetId: string | null
  wsDropPos: 'before' | 'after'
  onWorkspaceDragStart: (
    e: React.DragEvent<HTMLDivElement>,
    wsId: string,
    projectId: string
  ) => void
  onWorkspaceDragOver: (e: React.DragEvent<HTMLDivElement>, wsId: string, projectId: string) => void
  onWorkspaceDrop: (
    e: React.DragEvent<HTMLDivElement>,
    targetId: string,
    projectId: string,
    workspaces: WorkspaceRecord[]
  ) => void
  onWorkspaceDragEnd: () => void
}

function ProjectRow({
  project,
  active,
  expanded,
  workspaces,
  workspaceCount,
  workspaceCountInline,
  fetchGithubAvatars,
  selectedWorkspaceId,
  workspaceActivities,
  gitStatusByWorkspaceId,
  sessionTitleBySessionId,
  sessionUserPreviewBySessionId,
  onSelect,
  onToggleExpand,
  onSelectWorkspace,
  currentViewKind,
  currentWorkspaceId,
  renaming,
  onBeginRename,
  onFinishRename,
  onCancelRename,
  onRequestRemove,
  onAddWorkspace,
  renamingWorkspaceId,
  onBeginRenameWorkspace,
  onFinishRenameWorkspace,
  onCancelRenameWorkspace,
  onArchiveWorkspace,
  wsDragId,
  wsDropTargetId,
  wsDropPos,
  onWorkspaceDragStart,
  onWorkspaceDragOver,
  onWorkspaceDrop,
  onWorkspaceDragEnd
}: ProjectRowProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const [renameValue, setRenameValue] = useState(project.name)

  // Sync rename input when project name changes externally
  if (!renaming && renameValue !== project.name) {
    setRenameValue(project.name)
  }

  async function handleContextMenu(e: React.MouseEvent): Promise<void> {
    e.preventDefault()
    const action = await window.api.contextMenu.show([
      { label: 'Rename', action: 'rename' },
      { divider: true },
      { label: 'Remove from Orpheus…', action: 'remove' }
    ])
    if (!action) return
    if (action === 'rename') onBeginRename()
    else if (action === 'remove') onRequestRemove()
  }

  function handleRenameCommit(): void {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== project.name) {
      onFinishRename(trimmed)
    } else {
      onCancelRename()
    }
  }

  return (
    <div className="flex flex-col">
      <div
        className={[
          'relative flex items-center rounded-r-md transition-colors duration-150 group',
          active
            ? 'bg-accent/15 text-text-primary border-l-2 border-accent'
            : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay border-l-2 border-transparent'
        ].join(' ')}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onContextMenu={handleContextMenu}
      >
        {/* Main clickable row — navigate to project view. py-2 → ~40px hit target */}
        <button
          onClick={onSelect}
          className="flex items-center gap-2 px-2 py-2 flex-1 text-left min-w-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded-r-md"
          title={project.path}
          aria-label={project.name}
        >
          <Identicon
            seed={project.path}
            size={20}
            avatarUrl={fetchGithubAvatars ? project.githubAvatarUrl : null}
          />
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
              className="bg-surface-overlay border border-accent/40 rounded px-2 py-0.5 outline-none text-sm font-medium text-text-primary min-w-0 flex-1"
            />
          ) : (
            <span className="text-sm truncate min-w-0 flex-1 flex items-center gap-1.5">
              <span className="truncate">{project.name}</span>
              {workspaceCountInline && workspaceCount > 0 && (
                <span className="text-xs text-text-muted flex-shrink-0">· {workspaceCount}</span>
              )}
            </span>
          )}
        </button>

        {/* Right controls: add workspace + chevron. Each button is 32x32. */}
        {!renaming && (
          <div className="flex items-center gap-0.5 pr-1 flex-shrink-0">
            {/* Add workspace — visible on hover */}
            {hovered && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onAddWorkspace()
                }}
                className="w-8 h-8 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
                title="New workspace"
                aria-label="New workspace"
              >
                <Plus size={14} weight="bold" />
              </button>
            )}

            {/* Expand/collapse chevron */}
            <button
              onClick={(e) => {
                e.stopPropagation()
                onToggleExpand()
              }}
              className="w-8 h-8 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
              title={expanded ? 'Collapse' : 'Expand workspaces'}
              aria-label={expanded ? 'Collapse workspaces' : 'Expand workspaces'}
            >
              {expanded ? <CaretDown size={14} /> : <CaretRight size={14} />}
            </button>
          </div>
        )}
      </div>

      {/* Nested workspace rows */}
      {expanded && workspaces.length === 0 && (
        <button
          onClick={onAddWorkspace}
          className="flex items-center gap-2 pl-8 pr-2 py-2 mt-0.5 text-left text-xs text-text-muted hover:text-text-primary hover:bg-surface-overlay rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
          aria-label="Add workspace"
        >
          <Plus size={12} />
          <span>Add workspace</span>
        </button>
      )}
      {expanded && workspaces.length > 0 && (
        <div className="flex flex-col gap-0.5 mt-0.5">
          {workspaces.map((ws) => {
            const showLineAbove = wsDropTargetId === ws.id && wsDropPos === 'before'
            const showLineBelow = wsDropTargetId === ws.id && wsDropPos === 'after'
            const isDragging = wsDragId === ws.id
            return (
              <div
                key={ws.id}
                draggable={renamingWorkspaceId !== ws.id}
                onDragStart={(e) => onWorkspaceDragStart(e, ws.id, project.id)}
                onDragOver={(e) => onWorkspaceDragOver(e, ws.id, project.id)}
                onDrop={(e) => onWorkspaceDrop(e, ws.id, project.id, workspaces)}
                onDragEnd={onWorkspaceDragEnd}
                className={`relative ${isDragging ? 'opacity-40' : ''}`}
              >
                {showLineAbove && <DropIndicator position="top" />}
                <WorkspaceSubRow
                  workspace={ws}
                  project={project}
                  active={
                    currentViewKind === 'workspace' &&
                    (currentWorkspaceId === ws.id || selectedWorkspaceId === ws.id)
                  }
                  activity={workspaceActivities[ws.id]}
                  gitStatus={gitStatusByWorkspaceId[ws.id]}
                  sessionTitleBySessionId={sessionTitleBySessionId}
                  sessionUserPreviewBySessionId={sessionUserPreviewBySessionId}
                  onSelect={() => onSelectWorkspace(ws.id)}
                  renaming={renamingWorkspaceId === ws.id}
                  onBeginRename={() => onBeginRenameWorkspace(ws.id)}
                  onFinishRename={(name) => onFinishRenameWorkspace(ws.id, name)}
                  onCancelRename={onCancelRenameWorkspace}
                  onArchive={() => onArchiveWorkspace(ws.id)}
                />
                {showLineBelow && <DropIndicator position="bottom" />}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Drop indicator
// ---------------------------------------------------------------------------

function DropIndicator({ position }: { position: 'top' | 'bottom' }): React.JSX.Element {
  return (
    <div
      className="absolute left-0 right-0 h-0.5 bg-accent rounded-full pointer-events-none z-10"
      style={position === 'top' ? { top: -1 } : { bottom: -1 }}
    />
  )
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export type SidebarActiveView = 'sessions' | 'project' | 'workspace' | 'settings'

interface SidebarProps {
  collapsed: boolean
  projects: ProjectRecord[]
  projectsLoading: boolean
  selectedProjectId: string | null
  selectedWorkspaceId: string | null
  activeView: SidebarActiveView
  currentViewKind: string
  expandedProjectIds: Set<string>
  workspacesByProject: Record<string, WorkspaceRecord[]>
  workspaceActivities: Record<string, WorkspaceActivityDetail>
  gitStatusByWorkspaceId: Record<string, GitStatus | null>
  // Sidebar behavior preferences (v12)
  workspaceCountInline: boolean
  sidebarWidth: number // px, expanded state only
  // Privacy (v37)
  fetchGithubAvatars: boolean
  onSelectProject: (id: string) => void
  onSelectNav: (view: 'sessions') => void
  onSelectSettings: () => void
  onAddProject: () => void
  addingProject?: boolean
  onToggleProjectExpand: (id: string) => void
  onSelectWorkspace: (workspaceId: string, projectId: string) => void
  onRenameProject: (id: string, newName: string) => void | Promise<void>
  onRequestRemoveProject: (project: ProjectRecord) => void
  onAddWorkspace: (projectId: string) => void | Promise<void>
  onRenameWorkspace: (
    workspaceId: string,
    projectId: string,
    newName: string
  ) => void | Promise<void>
  onArchiveWorkspace: (workspaceId: string, projectId: string) => void | Promise<void>
  onReorderProjects: (orderedIds: string[]) => void
  onReorderWorkspaces: (projectId: string, orderedIds: string[]) => void
}

export function Sidebar({
  collapsed,
  projects,
  projectsLoading,
  selectedProjectId,
  selectedWorkspaceId,
  activeView,
  currentViewKind,
  expandedProjectIds,
  workspacesByProject,
  workspaceActivities,
  gitStatusByWorkspaceId,
  workspaceCountInline,
  sidebarWidth,
  fetchGithubAvatars,
  onSelectProject,
  onSelectNav,
  onSelectSettings,
  onAddProject,
  addingProject = false,
  onToggleProjectExpand,
  onSelectWorkspace,
  onRenameProject,
  onRequestRemoveProject,
  onAddWorkspace,
  onRenameWorkspace,
  onArchiveWorkspace,
  onReorderProjects,
  onReorderWorkspaces
}: SidebarProps): React.JSX.Element {
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null)
  const [renamingWorkspaceId, setRenamingWorkspaceId] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [dropPos, setDropPos] = useState<'before' | 'after'>('before')
  const [wsDragId, setWsDragId] = useState<string | null>(null)
  const [wsDragProjectId, setWsDragProjectId] = useState<string | null>(null)
  const [wsDropTargetId, setWsDropTargetId] = useState<string | null>(null)
  const [wsDropPos, setWsDropPos] = useState<'before' | 'after'>('before')
  // Map from projectId → (Map from claudeSessionId → session title).
  // Fetched once per project when its workspaces first become visible.
  const [sessionTitlesByProject, setSessionTitlesByProject] = useState<
    Map<string, Map<string, string>>
  >(new Map())
  // Map from projectId → (Map from claudeSessionId → last user message preview).
  const [sessionUserPreviewsByProject, setSessionUserPreviewsByProject] = useState<
    Map<string, Map<string, string>>
  >(new Map())
  const fetchedProjectSessions = useRef<Set<string>>(new Set())

  // Fetch sessions for any visible project that hasn't been loaded yet.
  useEffect(() => {
    const projectIds = projects.map((p) => p.id)
    for (const projectId of projectIds) {
      if (fetchedProjectSessions.current.has(projectId)) continue
      fetchedProjectSessions.current.add(projectId)
      window.api.sessions
        .listForProject(projectId, { includeArchived: true })
        .then((sessions: SessionRecord[]) => {
          const titleMap = new Map<string, string>()
          const userPreviewMap = new Map<string, string>()
          for (const s of sessions) {
            if (s.title) titleMap.set(s.id, s.title)
            if (s.lastUserMessagePreview) userPreviewMap.set(s.id, s.lastUserMessagePreview)
          }
          setSessionTitlesByProject((prev) => {
            const next = new Map(prev)
            next.set(projectId, titleMap)
            return next
          })
          setSessionUserPreviewsByProject((prev) => {
            const next = new Map(prev)
            next.set(projectId, userPreviewMap)
            return next
          })
        })
        .catch((err) => console.error('[sidebar] sessions load failed for', projectId, err))
    }
  }, [projects])

  function handleBeginRename(id: string): void {
    setRenamingProjectId(id)
  }

  function handleFinishRename(id: string, newName: string): void {
    onRenameProject(id, newName)
    setRenamingProjectId(null)
  }

  function handleCancelRename(): void {
    setRenamingProjectId(null)
  }

  function handleBeginRenameWorkspace(id: string): void {
    setRenamingWorkspaceId(id)
  }

  function handleFinishRenameWorkspace(
    workspaceId: string,
    projectId: string,
    newName: string
  ): void {
    onRenameWorkspace(workspaceId, projectId, newName)
    setRenamingWorkspaceId(null)
  }

  function handleCancelRenameWorkspace(): void {
    setRenamingWorkspaceId(null)
  }

  function onProjectDragStart(e: React.DragEvent<HTMLDivElement>, id: string): void {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
    setDragId(id)
  }

  function onProjectDragOver(e: React.DragEvent<HTMLDivElement>, id: string): void {
    if (!dragId || dragId === id) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const isAbove = e.clientY < rect.top + rect.height / 2
    setDropTargetId(id)
    setDropPos(isAbove ? 'before' : 'after')
  }

  function onProjectDrop(e: React.DragEvent<HTMLDivElement>, targetId: string): void {
    e.preventDefault()
    if (!dragId || dragId === targetId) {
      setDragId(null)
      setDropTargetId(null)
      return
    }
    const ids = projects.map((p) => p.id)
    const fromIdx = ids.indexOf(dragId)
    if (fromIdx === -1) return
    ids.splice(fromIdx, 1)
    let toIdx = ids.indexOf(targetId)
    if (toIdx === -1) toIdx = ids.length
    if (dropPos === 'after') toIdx += 1
    ids.splice(toIdx, 0, dragId)
    onReorderProjects(ids)
    setDragId(null)
    setDropTargetId(null)
  }

  function onProjectDragEnd(): void {
    setDragId(null)
    setDropTargetId(null)
  }

  function onWorkspaceDragStart(
    e: React.DragEvent<HTMLDivElement>,
    wsId: string,
    projectId: string
  ): void {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', wsId)
    setWsDragId(wsId)
    setWsDragProjectId(projectId)
  }

  function onWorkspaceDragOver(
    e: React.DragEvent<HTMLDivElement>,
    wsId: string,
    projectId: string
  ): void {
    if (!wsDragId || wsDragId === wsId) return
    // Cross-project drag: no-op
    if (wsDragProjectId !== projectId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const isAbove = e.clientY < rect.top + rect.height / 2
    setWsDropTargetId(wsId)
    setWsDropPos(isAbove ? 'before' : 'after')
  }

  function onWorkspaceDrop(
    e: React.DragEvent<HTMLDivElement>,
    targetId: string,
    projectId: string,
    workspaces: WorkspaceRecord[]
  ): void {
    e.preventDefault()
    if (!wsDragId || wsDragId === targetId || wsDragProjectId !== projectId) {
      setWsDragId(null)
      setWsDragProjectId(null)
      setWsDropTargetId(null)
      return
    }
    const ids = workspaces.map((w) => w.id)
    const fromIdx = ids.indexOf(wsDragId)
    if (fromIdx === -1) {
      setWsDragId(null)
      setWsDragProjectId(null)
      setWsDropTargetId(null)
      return
    }
    ids.splice(fromIdx, 1)
    let toIdx = ids.indexOf(targetId)
    if (toIdx === -1) toIdx = ids.length
    if (wsDropPos === 'after') toIdx += 1
    ids.splice(toIdx, 0, wsDragId)
    onReorderWorkspaces(projectId, ids)
    setWsDragId(null)
    setWsDragProjectId(null)
    setWsDropTargetId(null)
  }

  function onWorkspaceDragEnd(): void {
    setWsDragId(null)
    setWsDragProjectId(null)
    setWsDropTargetId(null)
  }

  const addProjectButton = (
    <button
      aria-label="Add project"
      disabled={addingProject}
      className={[
        'p-1 rounded transition-colors duration-150',
        addingProject
          ? 'text-text-muted opacity-50 cursor-wait'
          : 'text-text-muted hover:text-text-primary hover:bg-surface-overlay'
      ].join(' ')}
      onClick={onAddProject}
    >
      <Plus size={14} weight="bold" />
    </button>
  )

  return (
    <aside
      className={[
        collapsed ? 'w-14' : '',
        'transition-[width] duration-150 ease-out',
        'bg-surface-raised border-r border-border-default',
        'flex flex-col gap-1 overflow-hidden shrink-0 h-full'
      ].join(' ')}
      style={collapsed ? undefined : { width: sidebarWidth + 'px' }}
    >
      {/* Top nav */}
      {/* Route key 'sessions' is preserved for back-compat with uiState serialisation; visible label is Workspaces */}
      <NavItem
        Icon={Kanban}
        label="Workspaces"
        active={activeView === 'sessions'}
        collapsed={collapsed}
        flushTop
        onClick={() => onSelectNav('sessions')}
      />

      {/* Projects section */}
      <div className="mt-4 flex flex-col gap-0.5">
        {!collapsed ? (
          <>
            <SectionHeader label="Projects" action={addProjectButton} />
            {projectsLoading ? (
              <ProjectListSkeleton />
            ) : projects.length === 0 ? (
              <p className="text-xs text-text-muted px-3 mt-1">No projects yet</p>
            ) : (
              <div className="flex flex-col gap-0.5 overflow-y-auto max-h-[40vh]">
                {projects.map((p) => {
                  const expanded = expandedProjectIds.has(p.id)
                  const workspaces = (workspacesByProject[p.id] ?? []).filter(
                    (w) => w.archivedAt === null
                  )
                  const showLineAbove = dropTargetId === p.id && dropPos === 'before'
                  const showLineBelow = dropTargetId === p.id && dropPos === 'after'
                  const isDragging = dragId === p.id
                  return (
                    <div
                      key={p.id}
                      draggable={renamingProjectId !== p.id}
                      onDragStart={(e) => onProjectDragStart(e, p.id)}
                      onDragOver={(e) => onProjectDragOver(e, p.id)}
                      onDrop={(e) => onProjectDrop(e, p.id)}
                      onDragEnd={onProjectDragEnd}
                      className={['relative', isDragging ? 'opacity-40' : ''].join(' ')}
                    >
                      {showLineAbove && <DropIndicator position="top" />}
                      <ProjectRow
                        project={p}
                        active={activeView === 'project' && selectedProjectId === p.id}
                        expanded={expanded}
                        workspaces={workspaces}
                        workspaceCount={workspaces.length}
                        workspaceCountInline={workspaceCountInline}
                        fetchGithubAvatars={fetchGithubAvatars}
                        selectedWorkspaceId={selectedWorkspaceId}
                        workspaceActivities={workspaceActivities}
                        gitStatusByWorkspaceId={gitStatusByWorkspaceId}
                        sessionTitleBySessionId={sessionTitlesByProject.get(p.id) ?? new Map()}
                        sessionUserPreviewBySessionId={
                          sessionUserPreviewsByProject.get(p.id) ?? new Map()
                        }
                        onSelect={() => onSelectProject(p.id)}
                        onToggleExpand={() => onToggleProjectExpand(p.id)}
                        onSelectWorkspace={(wsId) => onSelectWorkspace(wsId, p.id)}
                        currentViewKind={currentViewKind}
                        currentWorkspaceId={selectedWorkspaceId}
                        renaming={renamingProjectId === p.id}
                        onBeginRename={() => handleBeginRename(p.id)}
                        onFinishRename={(name) => handleFinishRename(p.id, name)}
                        onCancelRename={handleCancelRename}
                        onRequestRemove={() => onRequestRemoveProject(p)}
                        onAddWorkspace={() => onAddWorkspace(p.id)}
                        renamingWorkspaceId={renamingWorkspaceId}
                        onBeginRenameWorkspace={handleBeginRenameWorkspace}
                        onFinishRenameWorkspace={(wsId, name) =>
                          handleFinishRenameWorkspace(wsId, p.id, name)
                        }
                        onCancelRenameWorkspace={handleCancelRenameWorkspace}
                        onArchiveWorkspace={(wsId) => onArchiveWorkspace(wsId, p.id)}
                        wsDragId={wsDragId}
                        wsDropTargetId={wsDropTargetId}
                        wsDropPos={wsDropPos}
                        onWorkspaceDragStart={onWorkspaceDragStart}
                        onWorkspaceDragOver={onWorkspaceDragOver}
                        onWorkspaceDrop={onWorkspaceDrop}
                        onWorkspaceDragEnd={onWorkspaceDragEnd}
                      />
                      {showLineBelow && <DropIndicator position="bottom" />}
                    </div>
                  )
                })}
              </div>
            )}
          </>
        ) : (
          /* Collapsed: show identicons only */
          <div className="flex flex-col gap-1 items-center">
            <div className="flex justify-center mb-1">{addProjectButton}</div>
            {!projectsLoading &&
              projects.map((p) => {
                const isActive =
                  (activeView === 'project' || activeView === 'workspace') &&
                  selectedProjectId === p.id
                return (
                  <button
                    key={p.id}
                    onClick={() => onSelectProject(p.id)}
                    title={p.name}
                    aria-label={p.name}
                    className={[
                      'p-1 rounded-md transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
                      isActive ? 'bg-accent/15' : 'hover:bg-surface-overlay'
                    ].join(' ')}
                  >
                    <Identicon
                      seed={p.path}
                      size={22}
                      avatarUrl={fetchGithubAvatars ? p.githubAvatarUrl : null}
                    />
                  </button>
                )
              })}
          </div>
        )}
      </div>

      {/* Spacer pushes Settings to the bottom */}
      <div className="flex-1" />

      {/* Bottom: Settings */}
      <NavItem
        Icon={Gear}
        label="Settings"
        active={activeView === 'settings'}
        collapsed={collapsed}
        onClick={onSelectSettings}
      />
    </aside>
  )
}
