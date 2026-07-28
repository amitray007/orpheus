import type { WorkspaceWaitObservation, WorkspaceWaitUntil } from './types'

export type LegacyWaitReason =
  | 'done'
  | 'blocked-permission'
  | 'blocked-input'
  | 'died'
  | 'not-found'
  | 'timeout'

export function isWaitTerminal(
  until: WorkspaceWaitUntil,
  observation: WorkspaceWaitObservation
): boolean {
  if (observation.outcome === 'died') return true
  if (observation.outcome === 'blocked_input' || observation.outcome === 'blocked_permission') {
    return true
  }
  if (until === 'done') return observation.outcome === 'done'
  if (until === 'idle') return observation.status === 'idle'
  return false
}

export function legacyWaitReason(
  until: WorkspaceWaitUntil,
  observation: WorkspaceWaitObservation
): LegacyWaitReason | null {
  if (!isWaitTerminal(until, observation)) return null
  if (observation.outcome === 'blocked_permission') return 'blocked-permission'
  if (observation.outcome === 'blocked_input') return 'blocked-input'
  if (observation.outcome === 'died') return 'died'
  return 'done'
}
export class WaitLifecycleGeneration {
  private readonly seenAliveAt = new Map<string, number>()

  markAlive(workspaceId: string, observedAt: number): void {
    this.seenAliveAt.set(workspaceId, observedAt)
  }

  shouldReportDied(workspaceId: string, observedAt: number, graceMs: number): boolean {
    const lastSeenAt = this.seenAliveAt.get(workspaceId)
    return lastSeenAt != null && observedAt - lastSeenAt >= graceMs
  }

  dispose(): void {
    this.seenAliveAt.clear()
  }
}
