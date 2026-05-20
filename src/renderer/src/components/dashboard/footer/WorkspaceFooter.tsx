import { useEffect, useState } from 'react'
import type React from 'react'
import type { AppUiState } from '@shared/types'
import { useFooterActions } from './useFooterActions'
import { ActionChip } from './ActionChip'
import { LiveChip } from './LiveChip'

interface WorkspaceFooterProps {
  workspaceId: string
  /** Navigates to a workspace after a fork action resolves. */
  onSelectWorkspace?: (workspaceId: string, projectId: string) => void
  /** projectId of the current workspace — needed for post-fork navigation. */
  projectId?: string
}

/**
 * Single-line footer strip rendered beneath the terminal surface.
 * Left zone: mutator action chips.
 * Right zone: live indicator chips (query / subscription).
 *
 * Hidden when uiState.showWorkspaceFooter is false.
 */
export function WorkspaceFooter({
  workspaceId,
  onSelectWorkspace,
  projectId
}: WorkspaceFooterProps): React.JSX.Element | null {
  const [uiState, setUiState] = useState<AppUiState | null>(null)
  const { items, loading } = useFooterActions(workspaceId)

  useEffect(() => {
    window.api.uiState.get().then(setUiState).catch(console.error)
  }, [])

  // Hide when toggled off (once uiState loads; during load render nothing)
  if (uiState && !uiState.showWorkspaceFooter) return null
  // Don't render the bar at all during initial uiState load to avoid flicker
  if (!uiState) return null

  const mutators = items.filter((it) => it.kind === 'mutator')
  const displays = items.filter((it) => it.kind !== 'mutator')

  const handleForkSuccess = (newWorkspaceId: string): void => {
    if (onSelectWorkspace && projectId) {
      onSelectWorkspace(newWorkspaceId, projectId)
    }
  }

  return (
    <div
      className={[
        'flex items-center justify-between',
        'h-9 px-3 flex-shrink-0',
        'bg-surface-raised/80 backdrop-blur-sm',
        'border-t border-border-default/60',
        'gap-1'
      ].join(' ')}
      aria-label="Workspace footer actions"
    >
      {/* Left zone — mutator chips */}
      <div className="flex items-center gap-1 min-w-0 flex-1 overflow-x-auto no-scrollbar">
        {!loading &&
          mutators.map((item) => (
            <ActionChip
              key={item.id}
              actionId={item.actionId}
              label={item.label}
              icon={item.icon}
              params={item.params}
              workspaceId={workspaceId}
              onForkSuccess={handleForkSuccess}
            />
          ))}
      </div>

      {/* Divider — only when both zones have content */}
      {mutators.length > 0 && displays.length > 0 && (
        <span className="w-px h-4 bg-border-default/40 flex-shrink-0" aria-hidden="true" />
      )}

      {/* Right zone — live indicator chips */}
      <div className="flex items-center gap-0.5 flex-shrink-0">
        {!loading &&
          displays.map((item) => (
            <LiveChip
              key={item.id}
              actionId={item.actionId}
              label={item.label}
              icon={item.icon}
              params={item.params}
              workspaceId={workspaceId}
              kind={item.kind}
            />
          ))}
      </div>
    </div>
  )
}
