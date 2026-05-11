import type React from 'react'
import { List, Gear } from '@phosphor-icons/react'

interface TopbarProps {
  onToggleSidebar: () => void
}

export function Topbar({ onToggleSidebar }: TopbarProps): React.JSX.Element {
  return (
    <header
      className="h-12 flex items-center px-3 relative bg-surface-base border-b border-border-default/40 shrink-0"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Left cluster — hamburger. pl-20 reserves ~80px for traffic lights (x:16 + width ~60px) */}
      <div className="flex items-center pl-20">
        <button
          aria-label="Toggle sidebar"
          className="p-1.5 text-text-secondary hover:text-text-primary hover:bg-surface-raised rounded-md transition-colors duration-150"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onClick={onToggleSidebar}
        >
          <List size={20} weight="bold" />
        </button>
      </div>

      {/* Center wordmark — absolutely centered, no-interaction (stays in drag region) */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <span className="text-lg font-semibold tracking-tight text-text-primary select-none">
          Orpheus<span className="text-accent">.</span>
        </span>
      </div>

      {/* Right cluster — settings gear */}
      <div className="flex items-center ml-auto">
        <button
          aria-label="Settings"
          className="p-1.5 text-text-secondary hover:text-text-primary hover:bg-surface-raised rounded-md transition-colors duration-150"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onClick={() => console.log('[settings] not wired yet')}
        >
          <Gear size={20} weight="bold" />
        </button>
      </div>
    </header>
  )
}
