import type React from 'react'
import { SidebarSimple, Terminal as TerminalIcon, Folder, Gear } from '@phosphor-icons/react'
import type { WorkspaceRecord } from '@shared/types'

interface TopBarProps {
  onToggleCollapsed: () => void
  sidebarCollapsed: boolean
  sidebarWidth: number
  workspace?: WorkspaceRecord
  terminalTitle: string | null
  isDirty: boolean
  drawerTab: null | 'status' | 'overrides'
  onSetDrawerTab: (tab: null | 'status' | 'overrides') => void
  onRestart: () => void | Promise<void>
}

// Pixel width of the "[traffic-light spacer] [sidebar toggle]" cluster on
// the left of the TopBar (88 + 28 = 116). When the sidebar is expanded we
// pad this cluster out to match the sidebar's width below, so the vertical
// divider lines up with the sidebar's right edge.
const LEFT_CLUSTER_PX = 116

export function TopBar({
  onToggleCollapsed,
  sidebarCollapsed,
  sidebarWidth,
  workspace,
  terminalTitle,
  isDirty,
  drawerTab,
  onSetDrawerTab,
  onRestart
}: TopBarProps): React.JSX.Element {
  // When the sidebar is expanded and wider than the left cluster, pad so the
  // divider aligns with the sidebar's right edge. When collapsed, the
  // workspace info flows right after the toggle with no divider.
  const padToSidebarEdge = !sidebarCollapsed && sidebarWidth > LEFT_CLUSTER_PX
  const padPx = padToSidebarEdge ? sidebarWidth - LEFT_CLUSTER_PX : 0

  const displayName = workspace
    ? workspace.nameIsAuto
      ? (terminalTitle || workspace.name)
      : workspace.name
    : null

  return (
    <header
      className="h-11 flex items-center bg-surface-raised border-b border-border-default flex-shrink-0 select-none"
      data-tauri-drag-region
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Left cluster — traffic-light spacer + sidebar toggle */}
      <div className="w-[88px] h-11 flex-shrink-0" data-tauri-drag-region />

      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-label="Toggle sidebar"
        title="Toggle sidebar"
        data-tauri-drag-region="false"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        className="w-7 h-7 flex items-center justify-center rounded-md text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
      >
        <SidebarSimple size={18} />
      </button>

      {/* Spacer that extends the left cluster to the sidebar's right edge when expanded */}
      {padPx > 0 && (
        <div className="h-11 flex-shrink-0" style={{ width: `${padPx}px` }} data-tauri-drag-region />
      )}

      {/* Divider that lines up with the sidebar / main-content boundary below */}
      {padToSidebarEdge && (
        <div className="self-stretch w-px bg-border-default flex-shrink-0" aria-hidden="true" />
      )}

      {/* Right region — workspace info when a workspace is open, otherwise just drag area */}
      {workspace ? (
        <div
          className="flex-1 h-11 flex items-center gap-2 px-3 min-w-0"
          data-tauri-drag-region
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <TerminalIcon size={13} className="text-text-muted flex-shrink-0" />
          <span
            className="text-xs font-medium text-text-primary truncate"
            title={
              workspace.nameIsAuto && terminalTitle && terminalTitle !== workspace.name
                ? `${workspace.name} — ${terminalTitle}`
                : workspace.name
            }
          >
            {displayName}
          </span>

          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => onSetDrawerTab(drawerTab === 'overrides' ? null : 'overrides')}
            title="Workspace overrides"
            aria-label="Workspace overrides"
            data-tauri-drag-region="false"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            className="flex-shrink-0 opacity-60 hover:opacity-100 text-text-muted hover:text-text-primary transition-opacity duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded"
          >
            <Gear size={14} />
          </button>

          <span className="text-text-muted text-xs" data-tauri-drag-region>·</span>
          <span
            className="text-xs text-text-muted truncate flex items-center gap-1 min-w-0"
            title={workspace.cwd}
            data-tauri-drag-region
          >
            <Folder size={10} className="flex-shrink-0" />
            {workspace.cwd}
          </span>

          {isDirty && (
            <span className="flex items-center gap-1.5 ml-auto flex-shrink-0 text-[10px] font-mono text-amber-400">
              Settings changed
              <button
                onClick={() => {
                  Promise.resolve(onRestart()).catch((e) =>
                    console.error('[topbar] restart failed:', e)
                  )
                }}
                data-tauri-drag-region="false"
                style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                className="text-[10px] font-sans font-medium text-amber-300 hover:text-amber-100 underline underline-offset-2 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400/40"
              >
                Restart to apply
              </button>
            </span>
          )}
        </div>
      ) : (
        <div className="flex-1 h-11" data-tauri-drag-region />
      )}
    </header>
  )
}
