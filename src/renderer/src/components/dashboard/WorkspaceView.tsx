import type React from 'react'
import { Terminal as TerminalIcon, Folder } from '@phosphor-icons/react'
import type { WorkspaceRecord } from '@shared/types'

interface WorkspaceViewProps {
  workspace: WorkspaceRecord
}

export function WorkspaceView({ workspace }: WorkspaceViewProps): React.JSX.Element {
  return (
    <div className="flex flex-col h-full">
      {/* Tab title bar — thin strip, eventually populated by libghostty terminal title */}
      <div className="h-8 flex items-center gap-2 px-3 border-b border-border-default bg-surface-raised flex-shrink-0">
        <TerminalIcon size={13} className="text-text-muted flex-shrink-0" />
        <span className="text-xs font-medium text-text-primary truncate">{workspace.name}</span>
        <span className="text-text-muted text-xs">·</span>
        <span
          className="text-xs text-text-muted truncate flex items-center gap-1 min-w-0"
          title={workspace.cwd}
        >
          <Folder size={10} className="flex-shrink-0" />
          {workspace.cwd}
        </span>
      </div>

      {/* Terminal area — full-bleed, fills remaining space. libghostty surface mounts here. */}
      <div className="flex-1 bg-black flex items-center justify-center min-h-0">
        <div className="flex flex-col items-center gap-2 opacity-20">
          <TerminalIcon size={32} />
          <p className="text-xs">Terminal</p>
        </div>
      </div>
    </div>
  )
}
