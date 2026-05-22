import { useEffect, useState } from 'react'
import type React from 'react'
import type { AppUiState, FooterActionVisibility, WorkspaceActivityDetail } from '@shared/types'
import { useFooterActions } from './useFooterActions'
import { ActionChip } from './ActionChip'
import { LiveChip } from './LiveChip'

interface WorkspaceFooterProps {
  workspaceId: string
  /** Claude session id for placeholder expansion in terminal.sendInput params. */
  sessionId?: string | null
  /** Working directory for placeholder expansion in terminal.sendInput params. */
  cwd?: string
  /** Navigates to a workspace after a fork action resolves. */
  onSelectWorkspace?: (workspaceId: string, projectId: string) => void
  /** projectId of the current workspace — needed for post-fork navigation. */
  projectId?: string
  /** Current workspace name — for {workspaceName} placeholder expansion in prompts. */
  workspaceName?: string
  /** Live activity detail for visibleWhen filtering. Provided by WorkspaceView. */
  activityDetail?: WorkspaceActivityDetail
}

/**
 * Whether a chip should be shown given the current activity detail.
 * - 'always'        → always visible
 * - 'idle'          → idle or awaiting_input (ready to receive input)
 * - 'awaitingInput' → awaiting_input, asking, or attention (blocked / needs user)
 */
function isVisible(
  when: FooterActionVisibility,
  detail: WorkspaceActivityDetail | undefined
): boolean {
  if (when === 'always') return true
  if (!detail) return when === 'always'
  if (when === 'idle') return detail === 'idle' || detail === 'ready'
  if (when === 'awaitingInput')
    return detail === 'ready' || detail === 'asking' || detail === 'attention'
  return true
}

/**
 * Single-line footer strip rendered beneath the terminal surface.
 * Left zone: mutator action chips.
 * Right zone: live indicator chips (query / subscription).
 *
 * Hidden when uiState.showWorkspaceFooter is false.
 * Chips are filtered by their visibleWhen field vs the workspace activity detail.
 */
export function WorkspaceFooter({
  workspaceId,
  sessionId = null,
  cwd = '',
  onSelectWorkspace,
  projectId,
  workspaceName = '',
  activityDetail
}: WorkspaceFooterProps): React.JSX.Element | null {
  const [uiState, setUiState] = useState<AppUiState | null>(null)
  const { items, loading } = useFooterActions(workspaceId)

  useEffect(() => {
    // Fetch initial state
    window.api.uiState.get().then(setUiState).catch(console.error)
    // Subscribe to changes so toggling showWorkspaceFooter is immediately reactive
    return window.api.uiState.onChanged(setUiState)
  }, [])

  // Hide when toggled off (once uiState loads; during load render nothing)
  if (uiState && !uiState.showWorkspaceFooter) return null
  // Don't render the bar at all during initial uiState load to avoid flicker
  if (!uiState) return null

  const mutators = items.filter(
    (it) => it.kind === 'mutator' && isVisible(it.visibleWhen, activityDetail)
  )
  const displays = items.filter(
    (it) => it.kind !== 'mutator' && isVisible(it.visibleWhen, activityDetail)
  )

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
        'bg-surface-raised',
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
              prompts={item.prompts}
              workspaceId={workspaceId}
              sessionId={sessionId}
              cwd={cwd}
              workspaceName={workspaceName}
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
