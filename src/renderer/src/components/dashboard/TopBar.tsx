import type React from 'react'
import { SidebarSimple } from '@phosphor-icons/react'

interface TopBarProps {
  onToggleCollapsed: () => void
}

export function TopBar({ onToggleCollapsed }: TopBarProps): React.JSX.Element {
  return (
    <header
      className="h-11 flex items-center bg-surface-raised border-b border-border-default flex-shrink-0"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Traffic-light spacer — reserves 80px on the left */}
      <div className="w-[80px] flex-shrink-0" />

      {/* Sidebar collapse toggle */}
      <button
        onClick={onToggleCollapsed}
        aria-label="Toggle sidebar"
        title="Toggle sidebar"
        className="w-8 h-8 flex items-center justify-center rounded-md text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <SidebarSimple size={16} />
      </button>

      {/* Drag region fills remainder */}
      <div className="flex-1" />
    </header>
  )
}
