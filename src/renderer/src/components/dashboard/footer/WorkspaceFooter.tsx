import type React from 'react'
import type { FooterActionVisibility, WorkspaceActivityDetail } from '@shared/types'
import { useFooterActions } from './useFooterActions'
import { ActionChip } from './ActionChip'
import { LiveChip } from './LiveChip'
import { DropdownChip } from './DropdownChip'
import { useUiState } from '@/lib/uiStateStore'

// The footer's fixed root height (`h-9` below, in px) — exported so
// WorkspaceView can derive how much of the terminal column's available height
// to subtract when quantizing the terminal host div to a whole cell-row
// multiple, without hardcoding a second copy of this constant.
export const WORKSPACE_FOOTER_HEIGHT_PX = 36

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
  /** Restarts the workspace (destroy + remount) — threaded down from
   *  WorkspaceView's handleRestart, the SAME mechanism the "Restart to
   *  apply" dirty chip (DetailsCard/WorkspaceDrawer) already uses. Passed to
   *  DropdownChip so a model switch that requires a new process (any switch
   *  involving a routed model — see isLiveApplicableModelChange) can trigger
   *  it directly instead of leaving the user to hunt for the chip. */
  onRestart?: () => void
  /** Whether to render the root's top border. Defaults to true. WorkspaceView
   *  passes false when this footer renders inside the footer-absorb wrapper
   *  (the quantized-terminal layout) — that wrapper draws the seam border on
   *  itself instead, so it sits exactly at the terminal/footer boundary
   *  rather than floating mid-wrapper above vertically centered content. */
  seamBorder?: boolean
}

// actionIds that render as a DropdownChip (opens a chipDropdown popover)
// instead of an ActionChip — the built-in Model/Effort selectors plus the
// fully custom author-configured "Dropdown menu" action type.
const DROPDOWN_ACTION_IDS = new Set([
  'footer.modelSelect',
  'footer.effortSelect',
  'footer.dropdown'
])

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
  // No detail yet (workspace not yet active) — show only 'always' chips
  if (!detail) return false
  if (when === 'idle') return detail === 'idle' || detail === 'ready'
  if (when === 'awaitingInput') return detail === 'ready' || detail === 'attention'
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
  activityDetail,
  onRestart,
  seamBorder = true
}: WorkspaceFooterProps): React.JSX.Element | null {
  const uiState = useUiState()
  const { items, loading } = useFooterActions(workspaceId)

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
        'bg-surface-raised',
        seamBorder ? 'border-t border-border-default/60' : '',
        'gap-1'
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label="Workspace footer actions"
    >
      {/* Left zone — mutator chips */}
      <div className="flex items-center gap-1 min-w-0 flex-1 overflow-x-auto no-scrollbar">
        {!loading &&
          mutators.map((item) =>
            DROPDOWN_ACTION_IDS.has(item.actionId) ? (
              <DropdownChip
                key={item.id}
                item={item}
                workspaceId={workspaceId}
                enabled={isVisible(item.visibleWhen, activityDetail)}
                activityDetail={activityDetail}
                onRestart={onRestart}
              />
            ) : (
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
                enabled={isVisible(item.visibleWhen, activityDetail)}
              />
            )
          )}
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
              enabled={isVisible(item.visibleWhen, activityDetail)}
            />
          ))}
      </div>
    </div>
  )
}
