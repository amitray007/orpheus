import type React from 'react'
import { SidebarSimple } from '@phosphor-icons/react'

interface TopBarProps {
  onToggleCollapsed: () => void
  sidebarCollapsed: boolean
  sidebarWidth: number
}

// macOS traffic lights + toggle button need at least this much room before
// the workspace content starts.
const MIN_LEFT_WIDTH = 112

export function TopBar({
  onToggleCollapsed,
  sidebarCollapsed,
  sidebarWidth
}: TopBarProps): React.JSX.Element {
  // Left section aligns with the sidebar's right edge when expanded so the
  // workspace title bar lines up with the content area below it.
  const leftWidth = sidebarCollapsed ? MIN_LEFT_WIDTH : Math.max(MIN_LEFT_WIDTH, sidebarWidth)

  return (
    <header
      className="h-11 flex items-stretch bg-surface-raised border-b border-border-default flex-shrink-0"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div
        className="flex items-center flex-shrink-0"
        style={{ width: leftWidth }}
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

        <div className="flex-1" />
      </div>

      {/* Workspace title bar gets portaled into here when in workspace view */}
      <div
        id="topbar-workspace-slot"
        className="flex-1 flex items-center min-w-0"
      />
    </header>
  )
}
