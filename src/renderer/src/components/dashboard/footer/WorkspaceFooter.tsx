import type React from 'react'
import type { FooterActionVisibility, WorkspaceActivityDetail } from '@shared/types'
import { useFooterActions } from './useFooterActions'
import { ActionChip } from './ActionChip'
import { LiveChip } from './LiveChip'
import { DropdownChip } from './DropdownChip'
import { useUiState } from '@/lib/uiStateStore'

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
  activityDetail
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
        'border-t border-border-default/60',
        'gap-1'
      ].join(' ')}
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
