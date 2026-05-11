import type React from 'react'

interface NavItemProps {
  icon: string
  label: string
  active?: boolean
  collapsed: boolean
}

function NavItem({ icon, label, active = false, collapsed }: NavItemProps): React.JSX.Element {
  return (
    <button
      className={[
        'w-full flex items-center rounded-md transition-colors duration-100',
        collapsed ? 'justify-center px-1 py-2' : 'px-2 py-2',
        active
          ? 'bg-accent/10 border-l-2 border-accent text-text-primary'
          : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay border-l-2 border-transparent'
      ].join(' ')}
      onClick={() => console.log(`[nav] ${label}`)}
      aria-label={label}
    >
      <span className="text-base leading-none">{icon}</span>
      {!collapsed && <span className="ml-2 text-sm">{label}</span>}
    </button>
  )
}

interface SidebarProps {
  collapsed: boolean
}

export function Sidebar({ collapsed }: SidebarProps): React.JSX.Element {
  return (
    <aside
      className={[
        collapsed ? 'w-14' : 'w-60',
        'transition-[width] duration-150 ease-out',
        'bg-surface-raised border-r border-border-default',
        'px-2 py-4 flex flex-col gap-1 overflow-hidden shrink-0'
      ].join(' ')}
    >
      {/* Top nav items */}
      <NavItem icon="▣" label="Dashboard" active={true} collapsed={collapsed} />
      <NavItem icon="⌕" label="Sessions" active={false} collapsed={collapsed} />

      {/* PINNED section */}
      <div className="mt-6">
        {!collapsed && (
          <p className="text-xs font-medium uppercase tracking-wide text-text-muted px-2 mb-1">
            Pinned
          </p>
        )}
        {collapsed && (
          <div className="flex justify-center px-1 py-1">
            <span className="text-base text-text-muted select-none">╌</span>
          </div>
        )}
        {/* Empty pinned list — no rows in v0 */}
      </div>

      {/* PROJECTS section */}
      <div className="mt-6">
        {!collapsed ? (
          <>
            <div className="flex items-center justify-between px-2 mb-1">
              <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
                Projects
              </p>
              <button
                aria-label="Add project"
                className="text-xs text-text-muted hover:text-text-primary hover:bg-surface-overlay rounded px-1 py-0.5 transition-colors duration-100"
                onClick={() => console.log('[projects] add project')}
              >
                +
              </button>
            </div>
            <p className="text-sm text-text-muted px-2">(coming soon)</p>
          </>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <span className="text-base text-text-muted select-none">╌</span>
            <button
              aria-label="Add project"
              className="text-xs text-text-muted hover:text-text-primary hover:bg-surface-overlay rounded px-1 py-0.5 transition-colors duration-100"
              onClick={() => console.log('[projects] add project')}
            >
              +
            </button>
          </div>
        )}
      </div>
    </aside>
  )
}
