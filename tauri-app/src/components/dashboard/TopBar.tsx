import type React from 'react'
import { SidebarSimple } from '@phosphor-icons/react'

interface TopBarProps {
  onToggleCollapsed: () => void
}

// Always-visible app top bar with overlay-style title bar.
// 80px left padding reserves space for the macOS traffic lights.
// Workspace view portals its contextual content into #topbar-slot.
export function TopBar({ onToggleCollapsed }: TopBarProps): React.JSX.Element {
  return (
    <div
      data-tauri-drag-region
      className="h-11 flex items-center bg-surface-raised border-b border-border-default flex-shrink-0 select-none"
    >
      <div data-tauri-drag-region className="w-[78px] flex-shrink-0" />

      <button
        type="button"
        data-tauri-drag-region="false"
        onClick={onToggleCollapsed}
        aria-label="Toggle sidebar"
        title="Toggle sidebar"
        className="w-8 h-8 flex items-center justify-center rounded-md text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
      >
        <SidebarSimple size={16} />
      </button>

      <div
        id="topbar-slot"
        data-tauri-drag-region
        className="flex-1 flex items-center gap-2 px-3 min-w-0 h-full"
      />
    </div>
  )
}
