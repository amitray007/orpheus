import { useEffect, useState } from 'react'
import type React from 'react'
import { Terminal as TerminalIcon, Folder, Gear } from '@phosphor-icons/react'
import type { WorkspaceRecord } from '@shared/types'

interface WorkspaceTitleBarProps {
  workspace: WorkspaceRecord
  drawer: null | 'status' | 'overrides'
  onSetDrawer: (drawer: null | 'status' | 'overrides') => void
  onRestart: () => void
}

export function WorkspaceTitleBar({
  workspace,
  drawer,
  onSetDrawer,
  onRestart
}: WorkspaceTitleBarProps): React.JSX.Element {
  const [isDirty, setIsDirty] = useState(false)
  const [terminalTitle, setTerminalTitle] = useState<string | null>(null)

  useEffect(() => {
    const workspaceId = workspace.id
    window.api.workspaces
      .isDirty(workspaceId)
      .then(setIsDirty)
      .catch(() => setIsDirty(false))
    return window.api.workspaces.onDirtyChanged((e) => {
      if (e.workspaceId === workspaceId) setIsDirty(e.dirty)
    })
  }, [workspace.id])

  useEffect(() => {
    const workspaceId = workspace.id
    window.api.workspaces
      .getTitle(workspaceId)
      .then(setTerminalTitle)
      .catch(() => {})
    return window.api.workspaces.onTitleChanged((e) => {
      if (e.workspaceId === workspaceId) setTerminalTitle(e.title || null)
    })
  }, [workspace.id])

  return (
    <div
      className="flex items-center gap-2 min-w-0 flex-1 px-3"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
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
        {workspace.nameIsAuto ? terminalTitle || workspace.name : workspace.name}
      </span>

      <button
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => onSetDrawer(drawer === 'overrides' ? null : 'overrides')}
        title="Workspace overrides"
        className="flex-shrink-0 opacity-60 hover:opacity-100 text-text-muted hover:text-text-primary transition-opacity duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded"
      >
        <Gear size={14} />
      </button>

      <span className="text-text-muted text-xs">·</span>
      <span
        className="text-xs text-text-muted truncate flex items-center gap-1 min-w-0"
        title={workspace.cwd}
      >
        <Folder size={10} className="flex-shrink-0" />
        {workspace.cwd}
      </span>

      {isDirty && (
        <span className="flex items-center gap-1.5 ml-auto flex-shrink-0 text-[10px] font-mono text-amber-400">
          Settings changed
          <button
            onClick={onRestart}
            className="text-[10px] font-sans font-medium text-amber-300 hover:text-amber-100 underline underline-offset-2 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400/40"
          >
            Restart to apply
          </button>
        </span>
      )}
    </div>
  )
}
