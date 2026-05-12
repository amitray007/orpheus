import type React from 'react'
import { useState } from 'react'
import type { Icon } from '@phosphor-icons/react'
import {
  SquaresFour,
  ChatsCircle,
  Plus,
  CaretDown,
  CaretRight,
  PushPin,
  Stack,
  PencilSimple,
  Trash,
  Archive,
  Gear,
  SidebarSimple
} from '@phosphor-icons/react'
import type { ProjectRecord, WorkspaceRecord, PinnedItem, GitStatus } from '@shared/types'
import { ProjectListSkeleton, Skeleton } from '../Skeleton'
import { Identicon } from '../Identicon'
import { ContextMenu } from '../ContextMenu'

// ---------------------------------------------------------------------------
// Nav primitives
// ---------------------------------------------------------------------------

interface NavItemProps {
  Icon: Icon
  label: string
  active?: boolean
  collapsed: boolean
  onClick?: () => void
}

function NavItem({
  Icon,
  label,
  active = false,
  collapsed,
  onClick
}: NavItemProps): React.JSX.Element {
  return (
    <button
      className={[
        'w-full flex items-center rounded-md transition-colors duration-150',
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
// Active-session indicator
// ---------------------------------------------------------------------------

interface ActivePulseProps {
  className?: string
}

function ActivePulse({ className = '' }: ActivePulseProps): React.JSX.Element {
  return (
    <span className={['relative flex h-2 w-2 flex-shrink-0', className].join(' ')}>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
    </span>
  )
}

// ---------------------------------------------------------------------------
// Workspace sub-row (nested inside expanded project row)
// ---------------------------------------------------------------------------

interface WorkspaceRowProps {
  workspace: WorkspaceRecord
  project: ProjectRecord
  active: boolean
  isSessionActive: boolean
  gitStatus?: GitStatus | null
  onSelect: () => void
  onTogglePin: () => void
  renaming: boolean
  onBeginRename: () => void
  onFinishRename: (newName: string) => void
  onCancelRename: () => void
  onArchive: () => void
}

function WorkspaceSubRow({
  workspace,
  active,
  isSessionActive,
  gitStatus,
  onSelect,
  onTogglePin,
  renaming,
  onBeginRename,
  onFinishRename,
  onCancelRename,
  onArchive
}: WorkspaceRowProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [renameValue, setRenameValue] = useState(workspace.name)
  const isPinned = workspace.pinnedAt !== null

  // Sync rename input when workspace name changes externally
  if (!renaming && renameValue !== workspace.name) {
    setRenameValue(workspace.name)
  }

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

  return (
    <div
      className={[
        'relative flex items-center rounded-md transition-colors duration-150 group',
        // Indent via left padding instead of ml-7 so hover bg reaches full width
        active
          ? 'bg-accent/15 text-text-primary'
          : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay'
      ].join(' ')}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onContextMenu={handleContextMenu}
    >
      <button
        onClick={onSelect}
        className="flex items-center gap-1.5 pl-9 pr-2 py-1 flex-1 text-left min-w-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded-md"
        title={workspace.cwd}
        aria-label={workspace.name}
      >
        {isSessionActive ? (
          <ActivePulse />
        ) : (
          <Stack
            size={12}
            weight={active ? 'fill' : 'regular'}
            className={[
              'flex-shrink-0 transition-colors duration-150',
              active ? 'text-accent' : 'text-text-muted group-hover:text-text-secondary'
            ].join(' ')}
          />
        )}
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
          <span className="text-xs truncate min-w-0 flex-1">{workspace.name}</span>
        )}
        {/* Git diff chip — only when there are real tracked changes (ins or del > 0) */}
        {!renaming && gitStatus && (gitStatus.insertions > 0 || gitStatus.deletions > 0) && (
          <span className="text-[10px] font-mono flex items-center gap-1 ml-1 flex-shrink-0">
            {gitStatus.insertions > 0 && (
              <span className="text-emerald-400">+{gitStatus.insertions}</span>
            )}
            {gitStatus.deletions > 0 && (
              <span className="text-red-400">−{gitStatus.deletions}</span>
            )}
          </span>
        )}
      </button>

      {/* Pin affordance — visible on hover or when pinned */}
      {!renaming && (hovered || isPinned) && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onTogglePin()
          }}
          className="flex-shrink-0 p-1.5 mr-1 rounded text-text-muted hover:text-text-primary transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
          title={isPinned ? 'Unpin workspace' : 'Pin workspace'}
          aria-label={isPinned ? 'Unpin workspace' : 'Pin workspace'}
        >
          <PushPin size={12} weight={isPinned ? 'fill' : 'regular'} />
        </button>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
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
          ]}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Project row (with identicon, expand chevron, workspace count, pin)
// ---------------------------------------------------------------------------

interface ProjectRowProps {
  project: ProjectRecord
  active: boolean
  expanded: boolean
  workspaces: WorkspaceRecord[]
  workspaceCount: number
  workspaceCountInline: boolean
  selectedWorkspaceId?: string | null
  activeWorkspaceIds: Set<string>
  gitStatusByWorkspaceId: Record<string, GitStatus | null>
  onSelect: () => void
  onToggleExpand: () => void
  onSelectWorkspace: (workspaceId: string) => void
  onToggleWorkspacePin: (workspaceId: string) => void
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
}

function ProjectRow({
  project,
  active,
  expanded,
  workspaces,
  workspaceCount,
  workspaceCountInline,
  selectedWorkspaceId,
  activeWorkspaceIds,
  gitStatusByWorkspaceId,
  onSelect,
  onToggleExpand,
  onSelectWorkspace,
  onToggleWorkspacePin,
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
  onArchiveWorkspace
}: ProjectRowProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [renameValue, setRenameValue] = useState(project.name)

  // Sync rename input when project name changes externally
  if (!renaming && renameValue !== project.name) {
    setRenameValue(project.name)
  }

  function handleContextMenu(e: React.MouseEvent): void {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY })
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
          'relative flex items-center rounded-md transition-colors duration-150 group',
          active
            ? 'bg-accent/15 text-text-primary'
            : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay'
        ].join(' ')}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onContextMenu={handleContextMenu}
      >
        {/* Main clickable row — navigate to project view */}
        <button
          onClick={onSelect}
          className="flex items-center gap-2 px-2 py-1.5 flex-1 text-left min-w-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded-md"
          title={project.path}
          aria-label={project.name}
        >
          <Identicon seed={project.path} size={20} />
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

        {/* Right controls: add workspace + chevron */}
        {!renaming && (
          <div className="flex items-center gap-0.5 pr-1.5 flex-shrink-0">
            {/* Add workspace — visible on hover */}
            {hovered && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onAddWorkspace()
                }}
                className="p-1.5 rounded text-text-muted hover:text-text-primary transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
                title="New workspace"
                aria-label="New workspace"
              >
                <Plus size={13} weight="bold" />
              </button>
            )}

            {/* Expand/collapse chevron */}
            <button
              onClick={(e) => {
                e.stopPropagation()
                onToggleExpand()
              }}
              className="p-1.5 rounded text-text-muted hover:text-text-primary transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
              title={expanded ? 'Collapse' : 'Expand workspaces'}
              aria-label={expanded ? 'Collapse workspaces' : 'Expand workspaces'}
            >
              {expanded ? <CaretDown size={13} /> : <CaretRight size={13} />}
            </button>
          </div>
        )}
      </div>

      {/* Nested workspace rows */}
      {expanded && workspaces.length > 0 && (
        <div className="flex flex-col gap-0.5 mt-0.5">
          {workspaces.map((ws) => (
            <WorkspaceSubRow
              key={ws.id}
              workspace={ws}
              project={project}
              active={
                currentViewKind === 'workspace' &&
                (currentWorkspaceId === ws.id || selectedWorkspaceId === ws.id)
              }
              isSessionActive={activeWorkspaceIds.has(ws.id)}
              gitStatus={gitStatusByWorkspaceId[ws.id]}
              onSelect={() => onSelectWorkspace(ws.id)}
              onTogglePin={() => onToggleWorkspacePin(ws.id)}
              renaming={renamingWorkspaceId === ws.id}
              onBeginRename={() => onBeginRenameWorkspace(ws.id)}
              onFinishRename={(name) => onFinishRenameWorkspace(ws.id, name)}
              onCancelRename={onCancelRenameWorkspace}
              onArchive={() => onArchiveWorkspace(ws.id)}
            />
          ))}
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: 'Rename',
              icon: <PencilSimple size={13} />,
              onClick: onBeginRename
            },
            { divider: true, label: '', onClick: () => {} },
            {
              label: 'Remove from Orpheus…',
              icon: <Trash size={13} />,
              onClick: onRequestRemove,
              destructive: true
            }
          ]}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pinned section
// ---------------------------------------------------------------------------

interface PinnedSectionProps {
  pinnedItems: PinnedItem[]
  loading: boolean
  activeWorkspaceIds: Set<string>
  gitStatusByWorkspaceId: Record<string, GitStatus | null>
  currentViewKind: string
  currentWorkspaceId?: string | null
  renamingWorkspaceId: string | null
  onSelectWorkspace: (workspaceId: string, projectId: string) => void
  onUnpinWorkspace: (id: string) => void
  onBeginRenameWorkspace: (workspaceId: string) => void
  onFinishRenameWorkspace: (workspaceId: string, projectId: string, newName: string) => void
  onCancelRenameWorkspace: () => void
  onArchiveWorkspace: (workspaceId: string, projectId: string) => void
}

function PinnedSection({
  pinnedItems,
  loading,
  activeWorkspaceIds,
  gitStatusByWorkspaceId,
  currentViewKind,
  currentWorkspaceId,
  renamingWorkspaceId,
  onSelectWorkspace,
  onUnpinWorkspace,
  onBeginRenameWorkspace,
  onFinishRenameWorkspace,
  onCancelRenameWorkspace,
  onArchiveWorkspace
}: PinnedSectionProps): React.JSX.Element | null {
  if (loading) {
    return (
      <div className="mt-4 flex flex-col gap-0.5">
        <SectionHeader label="Pinned" />
        <div className="flex flex-col gap-1 px-1 mt-1">
          <Skeleton className="h-7 w-full opacity-60" />
          <Skeleton className="h-7 w-4/5 opacity-40" />
        </div>
      </div>
    )
  }

  if (pinnedItems.length === 0) return null

  return (
    <div className="mt-4 flex flex-col gap-0.5">
      <SectionHeader label="Pinned" />
      {pinnedItems.map((item) => {
        const isActive =
          currentViewKind === 'workspace' && currentWorkspaceId === item.workspace.id
        return (
          <PinnedWorkspaceRow
            key={`ws-${item.workspace.id}`}
            workspace={item.workspace}
            project={item.project}
            active={isActive}
            isSessionActive={activeWorkspaceIds.has(item.workspace.id)}
            gitStatus={gitStatusByWorkspaceId[item.workspace.id]}
            onSelect={() => onSelectWorkspace(item.workspace.id, item.project.id)}
            onUnpin={() => onUnpinWorkspace(item.workspace.id)}
            renaming={renamingWorkspaceId === item.workspace.id}
            onBeginRename={() => onBeginRenameWorkspace(item.workspace.id)}
            onFinishRename={(name) => onFinishRenameWorkspace(item.workspace.id, item.project.id, name)}
            onCancelRename={onCancelRenameWorkspace}
            onArchive={() => onArchiveWorkspace(item.workspace.id, item.project.id)}
          />
        )
      })}
    </div>
  )
}

interface PinnedWorkspaceRowProps {
  workspace: WorkspaceRecord
  project: ProjectRecord
  active: boolean
  isSessionActive: boolean
  gitStatus?: GitStatus | null
  onSelect: () => void
  onUnpin: () => void
  renaming: boolean
  onBeginRename: () => void
  onFinishRename: (newName: string) => void
  onCancelRename: () => void
  onArchive: () => void
}

function PinnedWorkspaceRow({
  workspace,
  project,
  active,
  isSessionActive,
  gitStatus,
  onSelect,
  onUnpin,
  renaming,
  onBeginRename,
  onFinishRename,
  onCancelRename,
  onArchive
}: PinnedWorkspaceRowProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [renameValue, setRenameValue] = useState(workspace.name)

  // Sync rename input when workspace name changes externally
  if (!renaming && renameValue !== workspace.name) {
    setRenameValue(workspace.name)
  }

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

  return (
    <>
      <div
        className={[
          'flex items-center rounded-md transition-colors duration-150 group',
          active
            ? 'bg-accent/15 text-text-primary'
            : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay'
        ].join(' ')}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onContextMenu={handleContextMenu}
      >
        <button
          onClick={onSelect}
          className="flex items-center gap-1.5 px-2 py-1.5 flex-1 text-left min-w-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded-md"
          title={workspace.cwd}
          aria-label={`${project.name} — ${workspace.name}`}
        >
          {isSessionActive ? (
            <ActivePulse />
          ) : (
            <PushPin size={13} weight="fill" className="text-accent flex-shrink-0" />
          )}
          <Identicon seed={project.path} size={14} />
          <span className="text-xs text-text-muted truncate flex-shrink-0 max-w-[50px]">
            {project.name}
          </span>
          <CaretRight size={9} className="flex-shrink-0 text-text-muted" />
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
            <span className="text-xs truncate min-w-0 flex-1">{workspace.name}</span>
          )}
          {/* Git diff chip — only when there are real tracked changes (ins or del > 0) */}
          {!renaming && gitStatus && (gitStatus.insertions > 0 || gitStatus.deletions > 0) && (
            <span className="text-[10px] font-mono flex items-center gap-1 ml-1 flex-shrink-0">
              {gitStatus.insertions > 0 && (
                <span className="text-emerald-400">+{gitStatus.insertions}</span>
              )}
              {gitStatus.deletions > 0 && (
                <span className="text-red-400">−{gitStatus.deletions}</span>
              )}
            </span>
          )}
        </button>
        {!renaming && hovered && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onUnpin()
            }}
            className="flex-shrink-0 p-1.5 mr-1 rounded text-text-muted hover:text-text-primary transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
            title="Unpin workspace"
            aria-label="Unpin workspace"
          >
            <PushPin size={13} weight="fill" />
          </button>
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: 'Rename',
              icon: <PencilSimple size={13} />,
              onClick: onBeginRename
            },
            {
              label: 'Unpin',
              icon: <PushPin size={13} weight="fill" />,
              onClick: onUnpin
            },
            { divider: true, label: '', onClick: () => {} },
            {
              label: 'Archive',
              icon: <Archive size={13} />,
              onClick: onArchive,
              destructive: true
            }
          ]}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export type SidebarActiveView = 'dashboard' | 'sessions' | 'project' | 'workspace' | 'settings'

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
  pinnedItems: PinnedItem[]
  pinnedLoading: boolean
  activeWorkspaceIds: Set<string>
  gitStatusByWorkspaceId: Record<string, GitStatus | null>
  // Sidebar behavior preferences (v12)
  pinnedSectionVisible: boolean
  workspaceCountInline: boolean
  sidebarWidth: number // px, expanded state only
  onToggleCollapsed: () => void
  onSelectSettings: () => void
  onSelectProject: (id: string) => void
  onSelectNav: (view: 'dashboard' | 'sessions') => void
  onAddProject: () => void
  addingProject?: boolean
  onToggleProjectExpand: (id: string) => void
  onSelectWorkspace: (workspaceId: string, projectId: string) => void
  onToggleWorkspacePin: (workspaceId: string, projectId: string) => void
  onRenameProject: (id: string, newName: string) => void | Promise<void>
  onRequestRemoveProject: (project: ProjectRecord) => void
  onAddWorkspace: (projectId: string) => void | Promise<void>
  onRenameWorkspace: (workspaceId: string, projectId: string, newName: string) => void | Promise<void>
  onArchiveWorkspace: (workspaceId: string, projectId: string) => void | Promise<void>
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
  pinnedItems,
  pinnedLoading,
  activeWorkspaceIds,
  gitStatusByWorkspaceId,
  pinnedSectionVisible,
  workspaceCountInline,
  sidebarWidth,
  onToggleCollapsed,
  onSelectSettings,
  onSelectProject,
  onSelectNav,
  onAddProject,
  addingProject = false,
  onToggleProjectExpand,
  onSelectWorkspace,
  onToggleWorkspacePin,
  onRenameProject,
  onRequestRemoveProject,
  onAddWorkspace,
  onRenameWorkspace,
  onArchiveWorkspace
}: SidebarProps): React.JSX.Element {
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null)
  const [renamingWorkspaceId, setRenamingWorkspaceId] = useState<string | null>(null)

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

  function handleFinishRenameWorkspace(workspaceId: string, projectId: string, newName: string): void {
    onRenameWorkspace(workspaceId, projectId, newName)
    setRenamingWorkspaceId(null)
  }

  function handleCancelRenameWorkspace(): void {
    setRenamingWorkspaceId(null)
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
        collapsed ? 'w-28' : '',
        'transition-[width] duration-150 ease-out',
        'bg-surface-raised border-r border-border-default',
        'pt-4 pb-0 flex flex-col gap-1 overflow-hidden shrink-0'
      ].join(' ')}
      style={collapsed ? undefined : { width: sidebarWidth + 'px' }}
    >
      {/* Top strip: traffic-lights spacer + toggle when expanded — drag region */}
      <div
        className="h-11 flex items-center pl-[76px] pr-2 mb-1 -mt-4 border-b border-border-default/50"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {!collapsed && (
          <button
            onClick={onToggleCollapsed}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            className={[
              'ml-auto p-1.5 rounded-md transition-colors duration-150',
              'text-text-secondary hover:text-text-primary hover:bg-surface-overlay',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40'
            ].join(' ')}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <SidebarSimple size={16} />
          </button>
        )}
      </div>

      {/* Top nav */}
      <NavItem
        Icon={SquaresFour}
        label="Dashboard"
        active={activeView === 'dashboard'}
        collapsed={collapsed}
        onClick={() => onSelectNav('dashboard')}
      />
      <NavItem
        Icon={ChatsCircle}
        label="Sessions"
        active={activeView === 'sessions'}
        collapsed={collapsed}
        onClick={() => onSelectNav('sessions')}
      />

      {/* Pinned section — only when not collapsed and pinnedSectionVisible is on */}
      {!collapsed && pinnedSectionVisible && (
        <PinnedSection
          pinnedItems={pinnedItems}
          loading={pinnedLoading}
          activeWorkspaceIds={activeWorkspaceIds}
          gitStatusByWorkspaceId={gitStatusByWorkspaceId}
          currentViewKind={currentViewKind}
          currentWorkspaceId={selectedWorkspaceId}
          renamingWorkspaceId={renamingWorkspaceId}
          onSelectWorkspace={onSelectWorkspace}
          onUnpinWorkspace={(id) => {
            const ws = pinnedItems.find((item) => item.workspace.id === id)
            if (ws) {
              onToggleWorkspacePin(id, ws.project.id)
            }
          }}
          onBeginRenameWorkspace={handleBeginRenameWorkspace}
          onFinishRenameWorkspace={handleFinishRenameWorkspace}
          onCancelRenameWorkspace={handleCancelRenameWorkspace}
          onArchiveWorkspace={(workspaceId, projectId) => onArchiveWorkspace(workspaceId, projectId)}
        />
      )}

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
              <div className="flex flex-col gap-0.5 overflow-y-auto max-h-80">
                {projects.map((p) => {
                  const expanded = expandedProjectIds.has(p.id)
                  // workspacesByProject now stores all (active + archived);
                  // sidebar only surfaces active ones.
                  const workspaces = (workspacesByProject[p.id] ?? []).filter(
                    (w) => w.archivedAt === null
                  )
                  return (
                    <ProjectRow
                      key={p.id}
                      project={p}
                      active={activeView === 'project' && selectedProjectId === p.id}
                      expanded={expanded}
                      workspaces={workspaces}
                      workspaceCount={workspaces.length}
                      workspaceCountInline={workspaceCountInline}
                      selectedWorkspaceId={selectedWorkspaceId}
                      activeWorkspaceIds={activeWorkspaceIds}
                      gitStatusByWorkspaceId={gitStatusByWorkspaceId}
                      onSelect={() => onSelectProject(p.id)}
                      onToggleExpand={() => onToggleProjectExpand(p.id)}
                      onSelectWorkspace={(wsId) => onSelectWorkspace(wsId, p.id)}
                      onToggleWorkspacePin={(wsId) => onToggleWorkspacePin(wsId, p.id)}
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
                      onFinishRenameWorkspace={(wsId, name) => handleFinishRenameWorkspace(wsId, p.id, name)}
                      onCancelRenameWorkspace={handleCancelRenameWorkspace}
                      onArchiveWorkspace={(wsId) => onArchiveWorkspace(wsId, p.id)}
                    />
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
                    <Identicon seed={p.path} size={22} />
                  </button>
                )
              })}
          </div>
        )}
      </div>

      {/* Bottom controls: Settings always; toggle only when collapsed */}
      <div className="mt-auto flex flex-col">
        {/* Settings button
            NOTE: activeView === 'settings' is the highlight gate. If this highlights
            on non-settings views, the bug is upstream in Dashboard.tsx passing the
            wrong activeView value. Sidebar.tsx only reads the prop — it cannot
            defensively override it without knowing the real view state. */}
        <button
          onClick={(e) => {
            ;(e.currentTarget as HTMLButtonElement).blur()
            onSelectSettings()
          }}
          aria-label="Settings"
          title="Settings"
          className={[
            'w-full flex items-center rounded-md transition-colors duration-150',
            collapsed ? 'justify-center py-2 px-2' : 'px-3 py-2 gap-3',
            activeView === 'settings'
              ? 'bg-accent/15 text-text-primary font-medium'
              : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40'
          ].join(' ')}
        >
          <Gear size={20} weight={activeView === 'settings' ? 'fill' : 'regular'} />
          {!collapsed && <span className="text-sm">Settings</span>}
        </button>

        {/* Sidebar toggle — only in collapsed state (expanded state toggle is in top strip) */}
        {collapsed && (
          <button
            onClick={onToggleCollapsed}
            aria-label="Expand sidebar"
            title="Expand sidebar"
            className={[
              'w-full flex items-center justify-center py-2 px-2 rounded-md transition-colors duration-150',
              'text-text-secondary hover:text-text-primary hover:bg-surface-overlay',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40'
            ].join(' ')}
          >
            <SidebarSimple size={20} weight="regular" />
          </button>
        )}
      </div>
    </aside>
  )
}
