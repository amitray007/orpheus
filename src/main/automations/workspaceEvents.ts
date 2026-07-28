import { randomUUID } from 'node:crypto'
import type { WorkspaceRecord, WorkspaceStatus } from '../../shared/types'
import type { AutomationScheduler } from './scheduler'

export const WORKSPACE_COMPLETED_EVENT = 'workspace.completed'

type StatusObserver = (
  workspaceId: string,
  oldStatus: WorkspaceStatus | undefined,
  newStatus: WorkspaceStatus
) => void
type PersistingStatusObserver = (
  workspaceId: string,
  oldStatus: WorkspaceStatus,
  newStatus: WorkspaceStatus,
  workspace: WorkspaceRecord
) => void

type WorkspaceEventBridgeDeps = {
  scheduler: Pick<AutomationScheduler, 'persistEvent' | 'drainEvents'>
  subscribePersisting: (observer: PersistingStatusObserver) => () => void
  subscribeCommitted: (observer: StatusObserver) => () => void
  now?: () => number
  generateId?: () => string
  onError?: (error: unknown) => void
}

export function isWorkspaceCompletionTransition(
  oldStatus: WorkspaceStatus | undefined,
  newStatus: WorkspaceStatus
): boolean {
  return (
    (oldStatus === 'in_progress' || oldStatus === 'attention') && newStatus === 'awaiting_input'
  )
}

/**
 * Persist the allowlisted Phase 8 domain event inside the authoritative
 * workspace-status transaction, then only use the post-commit observer as a
 * prompt to drain the durable outbox.
 */
export function wireWorkspaceAutomationEvents(deps: WorkspaceEventBridgeDeps): () => void {
  const now = deps.now ?? Date.now
  const generateId = deps.generateId ?? randomUUID
  const unsubscribePersisting = deps.subscribePersisting(
    (workspaceId, oldStatus, newStatus, workspace) => {
      if (!isWorkspaceCompletionTransition(oldStatus, newStatus)) return
      if (workspace.id !== workspaceId || workspace.projectId.length === 0) return
      const eventId = `workspace.completed:${generateId()}`
      if (eventId.length > 128) {
        throw new Error('Workspace automation event id exceeds its bound.')
      }
      deps.scheduler.persistEvent({
        id: eventId,
        type: WORKSPACE_COMPLETED_EVENT,
        occurredAt: now(),
        projectId: workspace.projectId,
        workspaceId: workspace.id
      })
    }
  )
  const unsubscribeCommitted = deps.subscribeCommitted((_, oldStatus, newStatus) => {
    if (!isWorkspaceCompletionTransition(oldStatus, newStatus)) return
    void deps.scheduler.drainEvents().catch((error: unknown) => deps.onError?.(error))
  })
  return () => {
    unsubscribePersisting()
    unsubscribeCommitted()
  }
}
