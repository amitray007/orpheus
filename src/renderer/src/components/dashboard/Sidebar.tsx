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
  Folder,
  PencilSimple,
  Trash,
  Archive
} from '@phosphor-icons/react'
import type { ProjectRecord, WorkspaceRecord, PinnedItem } from '@shared/types'
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
          : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay'
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
    if (trimmed) {
      onFinishRename(trimmed)
    } else {
      onCancelRename()
    }
  }

  return (
    <div
      className={[
        'relative flex items-center ml-7 rounded-md transition-colors duration-150 group',
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
        className="flex items-center gap-1.5 px-2 py-1 flex-1 text-left min-w-0"
        title={workspace.cwd}
      >
        <Stack
          size={12}
          weight={active ? 'fill' : 'regular'}
          className={[
            'flex-shrink-0 transition-colors duration-150',
            active ? 'text-accent' : 'text-text-muted group-hover:text-text-secondary'
          ].join(' ')}
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
            onMouseDown={(e) => e.stopPropagation()}
            className="bg-surface-overlay border border-accent/40 rounded px-1.5 py-0 outline-none text-xs text-text-primary min-w-0 flex-1"
          />
        ) : (
          <span className="text-xs truncate min-w-0 flex-1">{workspace.name}</span>
        )}
      </button>

      {/* Pin affordance — visible on hover or when pinned */}
      {!renaming && (hovered || isPinned) && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onTogglePin()
          }}
          className="flex-shrink-0 p-1 mr-1 rounded text-text-muted hover:text-text-primary transition-colors duration-150"
          title={isPinned ? 'Unpin workspace' : 'Pin workspace'}
        >
          <PushPin size={10} weight={isPinned ? 'fill' : 'regular'} />
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
  selectedWorkspaceId?: string | null
  onSelect: () => void
  onToggleExpand: () => void
  onSelectWorkspace: (workspaceId: string) => void
  onToggleProjectPin: () => void
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
  selectedWorkspaceId,
  onSelect,
  onToggleExpand,
  onSelectWorkspace,
  onToggleProjectPin,
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
  const isPinned = project.pinnedAt !== null

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
          className="flex items-center gap-2 px-2 py-1.5 flex-1 text-left min-w-0"
          title={project.path}
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
            <span className="text-sm truncate min-w-0 flex-1">{project.name}</span>
          )}
        </button>

        {/* Right controls: add workspace + pin + count + chevron */}
        {!renaming && (
          <div className="flex items-center gap-0.5 pr-1.5 flex-shrink-0">
            {/* Add workspace — visible on hover */}
            {hovered && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onAddWorkspace()
                }}
                className="p-1 rounded text-text-muted hover:text-text-primary transition-colors duration-150"
                title="New workspace"
              >
                <Plus size={11} weight="bold" />
              </button>
            )}

            {/* Pin affordance — visible on hover or when pinned */}
            {(hovered || isPinned) && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleProjectPin()
                }}
                className="p-1 rounded text-text-muted hover:text-text-primary transition-colors duration-150"
                title={isPinned ? 'Unpin project' : 'Pin project'}
              >
                <PushPin size={11} weight={isPinned ? 'fill' : 'regular'} />
              </button>
            )}

            {/* Workspace count pill */}
            {workspaceCount > 0 && (
              <span className="text-xs text-text-muted px-1.5 py-0.5 rounded bg-surface-overlay">
                {workspaceCount}
              </span>
            )}

            {/* Expand/collapse chevron */}
            <button
              onClick={(e) => {
                e.stopPropagation()
                onToggleExpand()
              }}
              className="p-1 rounded text-text-muted hover:text-text-primary transition-colors duration-150"
              title={expanded ? 'Collapse' : 'Expand workspaces'}
            >
              {expanded ? <CaretDown size={11} /> : <CaretRight size={11} />}
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
            {
              label: isPinned ? 'Unpin' : 'Pin',
              icon: <PushPin size={13} weight={isPinned ? 'fill' : 'regular'} />,
              onClick: onToggleProjectPin
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
  currentViewKind: string
  currentProjectId?: string | null
  currentWorkspaceId?: string | null
  renamingProjectId: string | null
  renamingWorkspaceId: string | null
  onSelectProject: (id: string) => void
  onSelectWorkspace: (workspaceId: string, projectId: string) => void
  onUnpinProject: (id: string) => void
  onUnpinWorkspace: (id: string) => void
  onBeginRenameProject: (id: string) => void
  onFinishRenameProject: (id: string, newName: string) => void
  onCancelRenameProject: () => void
  onRequestRemoveProject: (project: ProjectRecord) => void
  onBeginRenameWorkspace: (workspaceId: string) => void
  onFinishRenameWorkspace: (workspaceId: string, projectId: string, newName: string) => void
  onCancelRenameWorkspace: () => void
  onArchiveWorkspace: (workspaceId: string, projectId: string) => void
}

function PinnedSection({
  pinnedItems,
  loading,
  currentViewKind,
  currentProjectId,
  currentWorkspaceId,
  renamingProjectId,
  renamingWorkspaceId,
  onSelectProject,
  onSelectWorkspace,
  onUnpinProject,
  onUnpinWorkspace,
  onBeginRenameProject,
  onFinishRenameProject,
  onCancelRenameProject,
  onRequestRemoveProject,
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
        if (item.kind === 'project') {
          const isActive =
            currentViewKind === 'project' && currentProjectId === item.project.id
          return (
            <PinnedProjectRow
              key={`proj-${item.project.id}`}
              project={item.project}
              active={isActive}
              onSelect={() => onSelectProject(item.project.id)}
              onUnpin={() => onUnpinProject(item.project.id)}
              renaming={renamingProjectId === item.project.id}
              onBeginRename={() => onBeginRenameProject(item.project.id)}
              onFinishRename={(name) => onFinishRenameProject(item.project.id, name)}
              onCancelRename={onCancelRenameProject}
              onRequestRemove={() => onRequestRemoveProject(item.project)}
            />
          )
        }
        // workspace
        const isActive =
          currentViewKind === 'workspace' && currentWorkspaceId === item.workspace.id
        return (
          <PinnedWorkspaceRow
            key={`ws-${item.workspace.id}`}
            workspace={item.workspace}
            project={item.project}
            active={isActive}
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

interface PinnedProjectRowProps {
  project: ProjectRecord
  active: boolean
  onSelect: () => void
  onUnpin: () => void
  renaming: boolean
  onBeginRename: () => void
  onFinishRename: (newName: string) => void
  onCancelRename: () => void
  onRequestRemove: () => void
}

function PinnedProjectRow({
  project,
  active,
  onSelect,
  onUnpin,
  renaming,
  onBeginRename,
  onFinishRename,
  onCancelRename,
  onRequestRemove
}: PinnedProjectRowProps): React.JSX.Element {
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
          className="flex items-center gap-2 px-2 py-1.5 flex-1 text-left min-w-0"
          title={project.path}
        >
          <PushPin size={11} weight="fill" className="text-accent flex-shrink-0" />
          <Identicon seed={project.path} size={16} />
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
            <span className="text-sm truncate min-w-0 flex-1">{project.name}</span>
          )}
        </button>
        {!renaming && hovered && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onUnpin()
            }}
            className="flex-shrink-0 p-1 mr-1 rounded text-text-muted hover:text-text-primary transition-colors duration-150"
            title="Unpin project"
          >
            <PushPin size={11} weight="fill" />
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
              label: 'Remove from Orpheus…',
              icon: <Trash size={13} />,
              onClick: onRequestRemove,
              destructive: true
            }
          ]}
        />
      )}
    </>
  )
}

interface PinnedWorkspaceRowProps {
  workspace: WorkspaceRecord
  project: ProjectRecord
  active: boolean
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
    if (trimmed) {
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
          className="flex items-center gap-1.5 px-2 py-1.5 flex-1 text-left min-w-0"
          title={workspace.cwd}
        >
          <PushPin size={11} weight="fill" className="text-accent flex-shrink-0" />
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
        </button>
        {!renaming && hovered && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onUnpin()
            }}
            className="flex-shrink-0 p-1 mr-1 rounded text-text-muted hover:text-text-primary transition-colors duration-150"
            title="Unpin workspace"
          >
            <PushPin size={11} weight="fill" />
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

export type SidebarActiveView = 'dashboard' | 'sessions' | 'project' | 'workspace'

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
  onSelectProject: (id: string) => void
  onSelectNav: (view: 'dashboard' | 'sessions') => void
  onAddProject: () => void
  addingProject?: boolean
  onToggleProjectExpand: (id: string) => void
  onSelectWorkspace: (workspaceId: string, projectId: string) => void
  onToggleProjectPin: (id: string) => void
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
  onSelectProject,
  onSelectNav,
  onAddProject,
  addingProject = false,
  onToggleProjectExpand,
  onSelectWorkspace,
  onToggleProjectPin,
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
        collapsed ? 'w-14' : 'w-64',
        'transition-[width] duration-150 ease-out',
        'bg-surface-raised border-r border-border-default',
        'px-2 py-4 flex flex-col gap-1 overflow-hidden shrink-0'
      ].join(' ')}
    >
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

      {/* Pinned section — only when not collapsed */}
      {!collapsed && (
        <PinnedSection
          pinnedItems={pinnedItems}
          loading={pinnedLoading}
          currentViewKind={currentViewKind}
          currentProjectId={selectedProjectId}
          currentWorkspaceId={selectedWorkspaceId}
          renamingProjectId={renamingProjectId}
          renamingWorkspaceId={renamingWorkspaceId}
          onSelectProject={onSelectProject}
          onSelectWorkspace={onSelectWorkspace}
          onUnpinProject={(id) => onToggleProjectPin(id)}
          onUnpinWorkspace={(id) => {
            const ws = pinnedItems.find(
              (item) => item.kind === 'workspace' && item.workspace.id === id
            )
            if (ws && ws.kind === 'workspace') {
              onToggleWorkspacePin(id, ws.project.id)
            }
          }}
          onBeginRenameProject={handleBeginRename}
          onFinishRenameProject={handleFinishRename}
          onCancelRenameProject={handleCancelRename}
          onRequestRemoveProject={onRequestRemoveProject}
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
                  const workspaces = workspacesByProject[p.id] ?? []
                  return (
                    <ProjectRow
                      key={p.id}
                      project={p}
                      active={activeView === 'project' && selectedProjectId === p.id}
                      expanded={expanded}
                      workspaces={workspaces}
                      workspaceCount={workspaces.length}
                      selectedWorkspaceId={selectedWorkspaceId}
                      onSelect={() => onSelectProject(p.id)}
                      onToggleExpand={() => onToggleProjectExpand(p.id)}
                      onSelectWorkspace={(wsId) => onSelectWorkspace(wsId, p.id)}
                      onToggleProjectPin={() => onToggleProjectPin(p.id)}
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
                    className={[
                      'p-1 rounded-md transition-colors duration-150',
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

      {/* Collapsed: Folder icon for sessions */}
      {collapsed && (
        <div className="mt-auto flex justify-center">
          <button
            title="Add project"
            disabled={addingProject}
            onClick={onAddProject}
            className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-overlay"
          >
            <Folder size={18} />
          </button>
        </div>
      )}
    </aside>
  )
}
