import type React from 'react'
import type { Icon } from '@phosphor-icons/react'
import { SquaresFour, ChatsCircle, Plus } from '@phosphor-icons/react'

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
      onClick={onClick ?? (() => console.log(`[nav] ${label}`))}
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

interface SidebarProps {
  collapsed: boolean
}

export function Sidebar({ collapsed }: SidebarProps): React.JSX.Element {
  const addProjectButton = (
    <button
      aria-label="Add project"
      className="p-1 text-text-muted hover:text-text-primary hover:bg-surface-overlay rounded transition-colors duration-150"
      onClick={() => console.log('[projects] add project')}
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
      <NavItem Icon={SquaresFour} label="Dashboard" active collapsed={collapsed} />
      <NavItem Icon={ChatsCircle} label="Sessions" collapsed={collapsed} />

      {/* Pinned section — empty state for v0 */}
      <div className="mt-6">
        {!collapsed && <SectionHeader label="Pinned" />}
      </div>

      {/* Projects section */}
      <div className="mt-4">
        {!collapsed ? (
          <>
            <SectionHeader label="Projects" action={addProjectButton} />
            <p className="text-xs text-text-muted px-3 mt-1">No projects yet</p>
          </>
        ) : (
          <div className="flex justify-center">{addProjectButton}</div>
        )}
      </div>
    </aside>
  )
}
