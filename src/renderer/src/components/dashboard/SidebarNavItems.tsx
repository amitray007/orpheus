import type React from 'react'
import { memo } from 'react'
import type { Icon } from '@phosphor-icons/react'

// ---------------------------------------------------------------------------
// Nav primitives (shared by Sidebar top/bottom nav slots)
// ---------------------------------------------------------------------------

interface NavItemProps {
  Icon: Icon
  label: string
  active?: boolean
  collapsed: boolean
  flushTop?: boolean
  onClick?: () => void
}

export const NavItem = memo(function NavItem({
  Icon,
  label,
  active = false,
  collapsed,
  flushTop = false,
  onClick
}: NavItemProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={[
        'w-full flex items-center transition-colors duration-150',
        flushTop ? 'rounded-b-md' : 'rounded-md',
        collapsed ? 'justify-center px-2 py-2' : 'px-3 py-2 gap-3',
        active
          ? 'bg-accent/15 text-text-primary font-medium'
          : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
        'cursor-pointer'
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
})

interface SectionHeaderProps {
  label: string
  action?: React.ReactNode
}

export const SectionHeader = memo(function SectionHeader({
  label,
  action
}: SectionHeaderProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between px-3 mb-1">
      <p className="text-xs font-medium uppercase tracking-wider text-text-muted">{label}</p>
      {action}
    </div>
  )
})
