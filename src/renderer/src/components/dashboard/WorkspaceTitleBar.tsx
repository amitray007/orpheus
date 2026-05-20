import { useEffect, useState } from 'react'
import type React from 'react'
import { Terminal as TerminalIcon, Folder, Gear, ArrowBendUpLeft } from '@phosphor-icons/react'
import type { GhPullRequest, WorkspaceRecord } from '@shared/types'
import { PrChip } from '../github/PrChip'

interface WorkspaceTitleBarProps {
  workspace: WorkspaceRecord
  drawer: null | 'status' | 'overrides'
  onSetDrawer: (drawer: null | 'status' | 'overrides') => void
  pr?: GhPullRequest | null
  /** All workspaces — used to resolve the parent workspace name for forked-from chip. */
  allWorkspaces?: WorkspaceRecord[]
}

export function WorkspaceTitleBar({
  workspace,
  drawer,
  onSetDrawer,
  pr,
  allWorkspaces
}: WorkspaceTitleBarProps): React.JSX.Element {
  const [terminalTitle, setTerminalTitle] = useState<string | null>(null)

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

  // Resolve parent name for the "forked from" chip
  const forkedFromSessionId = workspace.forkedFromSessionId ?? null
  let forkedFromName: string | null = null
  if (forkedFromSessionId && allWorkspaces) {
    const parent = allWorkspaces.find((w) => w.claudeSessionId === forkedFromSessionId)
    forkedFromName = parent ? parent.name : null
  }

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

      {/* PR chip appears next to the workspace name when the current branch
          has a PR on GitHub. Hides cleanly when no PR. */}
      {pr && (
        <span className="flex-shrink-0">
          <PrChip pr={pr} variant="chip" />
        </span>
      )}

      {/* Forked-from chip — shown when this workspace was forked from another session */}
      {forkedFromSessionId && (
        <span
          className="flex-shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-text-muted bg-surface-overlay/50 border border-border-default/40"
          title={
            forkedFromName ? `Forked from: ${forkedFromName}` : 'Forked from another workspace'
          }
        >
          <ArrowBendUpLeft size={9} className="flex-shrink-0" />
          {forkedFromName ? `forked from ${forkedFromName}` : 'forked'}
        </span>
      )}

      <span className="text-text-muted text-xs">·</span>
      <span
        className="text-xs text-text-muted truncate flex items-center gap-1 min-w-0"
        title={workspace.cwd}
      >
        <Folder size={10} className="flex-shrink-0" />
        {workspace.cwd}
      </span>

      <button
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => onSetDrawer(drawer === 'overrides' ? null : 'overrides')}
        title="Workspace Settings"
        aria-label="Workspace Settings"
        className={[
          'ml-auto flex items-center gap-1.5 px-2 py-1 rounded-md text-xs flex-shrink-0',
          'transition-colors duration-150',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
          drawer === 'overrides'
            ? 'bg-surface-overlay text-text-primary'
            : 'text-text-muted hover:text-text-primary hover:bg-surface-overlay'
        ].join(' ')}
      >
        <Gear size={14} />
        <span>Workspace Settings</span>
      </button>
    </div>
  )
}
