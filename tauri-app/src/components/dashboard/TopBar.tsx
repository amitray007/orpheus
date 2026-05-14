import type React from 'react'
import { SidebarSimple } from '@phosphor-icons/react'

interface TopBarProps {
  onToggleCollapsed: () => void
}

export function TopBar({ onToggleCollapsed }: TopBarProps): React.JSX.Element {
  return (
    <header
      className="h-11 flex items-center bg-surface-raised border-b border-border-default flex-shrink-0 select-none"
      data-tauri-drag-region
    >
      {/* Traffic lights are pinned at (20, 15) via tauri.conf.json
          trafficLightPosition, giving them a center at y=22. The h-11 (44px)
          header with items-center puts everything else at y=22 naturally. */}
      <div className="w-[88px] h-11 flex-shrink-0" data-tauri-drag-region />

      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-label="Toggle sidebar"
        title="Toggle sidebar"
        data-tauri-drag-region="false"
        className="w-7 h-7 flex items-center justify-center rounded-md text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
      >
        <SidebarSimple size={18} />
      </button>

      <div className="flex-1 h-11" data-tauri-drag-region />
    </header>
  )
}
