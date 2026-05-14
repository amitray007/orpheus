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
      {/* Traffic-light spacer — macOS lights center is at y=14 from window top. */}
      <div className="w-[78px] h-11 flex-shrink-0" data-tauri-drag-region />

      {/* Sidebar toggle — translated up so its center sits at y=14 (matches the traffic lights). */}
      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-label="Toggle sidebar"
        title="Toggle sidebar"
        data-tauri-drag-region="false"
        className="w-6 h-6 flex items-center justify-center rounded-md text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 -translate-y-[8px]"
      >
        <SidebarSimple size={14} />
      </button>

      <div className="flex-1 h-11" data-tauri-drag-region />
    </header>
  )
}
