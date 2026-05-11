import type React from 'react'
import type { Icon } from '@phosphor-icons/react'
import { SquaresFour, ChatsCircle, Plus, Folder } from '@phosphor-icons/react'
import type { ProjectRecord } from '@shared/types'
import { ProjectListSkeleton } from '../Skeleton'

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
// Project row
// ---------------------------------------------------------------------------

interface ProjectRowProps {
  project: ProjectRecord
  active: boolean
  onClick: () => void
}

function ProjectRow({ project, active, onClick }: ProjectRowProps): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={[
        'w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-left',
        'transition-colors duration-150 group',
        active
          ? 'bg-accent/15 text-text-primary'
          : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay'
      ].join(' ')}
      title={project.path}
    >
      <Folder
        size={14}
        weight={active ? 'fill' : 'regular'}
        className={[
          'flex-shrink-0 transition-colors duration-150',
          active ? 'text-accent' : 'text-text-muted group-hover:text-text-secondary'
        ].join(' ')}
      />
      <span className="text-xs truncate min-w-0 flex-1">{project.name}</span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export type SidebarActiveView = 'dashboard' | 'sessions' | 'project'

interface SidebarProps {
  collapsed: boolean
  projects: ProjectRecord[]
  projectsLoading: boolean
  selectedProjectId: string | null
  activeView: SidebarActiveView
  onSelectProject: (id: string) => void
  onSelectNav: (view: 'dashboard' | 'sessions') => void
  onAddProject: () => void
  addingProject?: boolean
}

export function Sidebar({
  collapsed,
  projects,
  projectsLoading,
  selectedProjectId,
  activeView,
  onSelectProject,
  onSelectNav,
  onAddProject,
  addingProject = false
}: SidebarProps): React.JSX.Element {
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
        collapsed ? 'w-14' : 'w-60',
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

      {/* Pinned section — hidden when collapsed */}
      <div className="mt-6">
        {!collapsed && <SectionHeader label="Pinned" />}
      </div>

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
              <div className="flex flex-col gap-0.5 overflow-y-auto max-h-72">
                {projects.map((p) => (
                  <ProjectRow
                    key={p.id}
                    project={p}
                    active={activeView === 'project' && selectedProjectId === p.id}
                    onClick={() => onSelectProject(p.id)}
                  />
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="flex justify-center">{addProjectButton}</div>
        )}
      </div>
    </aside>
  )
}
