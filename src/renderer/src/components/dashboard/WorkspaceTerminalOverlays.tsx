import { memo } from 'react'
import type React from 'react'
import { Moon } from '@phosphor-icons/react'

interface WorkspaceTerminalOverlaysProps {
  sleeping: boolean
  isClosed: boolean
  /** Stable callback — call terminal.focus for this workspace. */
  onFocusTerminal: () => void
}

/**
 * Purely presentational overlays rendered inside the terminal host div.
 * Contains no terminal lifecycle logic — mount/hide/resize effects all live
 * in WorkspaceView. Only rendered when the workspace is active (caller's
 * responsibility).
 */
export const WorkspaceTerminalOverlays = memo(function WorkspaceTerminalOverlays({
  sleeping,
  isClosed,
  onFocusTerminal
}: WorkspaceTerminalOverlaysProps): React.JSX.Element {
  return (
    <>
      {sleeping && (
        <button
          type="button"
          onClick={onFocusTerminal}
          title="Click to wake the terminal"
          className="absolute top-2 right-2 z-20 flex items-center gap-1 bg-surface-overlay/90 border border-border-default rounded-md px-2 py-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
        >
          <Moon size={12} weight="fill" />
          Asleep
        </button>
      )}
      {isClosed && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-surface-overlay/90">
          <p className="text-sm text-text-secondary">
            This workspace is closed to free resources. Select it again to reopen.
          </p>
        </div>
      )}
    </>
  )
})
