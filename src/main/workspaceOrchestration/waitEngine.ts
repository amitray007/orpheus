import { forceReconcile, getWorkspaceFileInfo, getWorkspaceFileStatusSync } from '../sessionState'
import { onWorkspaceStatusChange } from '../orpheusNotify'
import { getWorkspace } from '../workspaces'
import type { WorkspaceWaitObservation, WorkspaceWaitPort, WorkspaceWaitSession } from './types'
import { WaitLifecycleGeneration } from './waitState'
export { isWaitTerminal, legacyWaitReason } from './waitState'

const UNKNOWN_DEATH_GRACE_MS = 3_000

function liveObservation(
  status: 'busy' | 'idle' | 'waiting',
  waitingFor: string | undefined
): WorkspaceWaitObservation {
  if (status === 'busy') return { status }
  if (status === 'idle') return { status, outcome: 'done' }
  return {
    status,
    outcome: waitingFor?.toLowerCase().includes('permission')
      ? 'blocked_permission'
      : 'blocked_input'
  }
}

/**
 * One authoritative main-process wait vocabulary for MCP and the legacy
 * NDJSON subscription. The engine uses file state first, persisted state as
 * a torn-read fallback, and only reports death after a runtime was observed
 * alive and then remained absent beyond a short grace window.
 */
export class MainWorkspaceWaitEngine implements WorkspaceWaitPort {
  createSession(workspaceIds: readonly string[]): WorkspaceWaitSession {
    void workspaceIds
    const generation = new WaitLifecycleGeneration()
    return {
      observe: (workspaceId) => this.observe(workspaceId, generation),
      waitForChange: (workspaceIds, deadlineAt) => this.waitForChange(workspaceIds, deadlineAt),
      dispose: () => generation.dispose()
    }
  }

  private async observe(
    workspaceId: string,
    generation: WaitLifecycleGeneration
  ): Promise<WorkspaceWaitObservation | null> {
    const workspace = getWorkspace(workspaceId)
    if (workspace == null) return null
    if (workspace.archivedAt != null || workspace.closedAt != null) {
      return { status: workspace.status, outcome: 'died' }
    }

    let info = getWorkspaceFileInfo(workspaceId)
    if (info.status === 'busy' || info.status === 'idle' || info.status === 'waiting') {
      generation.markAlive(workspaceId, Date.now())
      return liveObservation(info.status, info.waitingFor)
    }

    if (workspace.status === 'awaiting_input' || workspace.status === 'idle') {
      return { status: workspace.status, outcome: 'done' }
    }
    if (workspace.status === 'attention') {
      return { status: workspace.status, outcome: 'blocked_input' }
    }
    if (workspace.status === 'in_progress') {
      return { status: workspace.status }
    }

    await forceReconcile()
    info = getWorkspaceFileInfo(workspaceId)
    if (info.status === 'busy' || info.status === 'idle' || info.status === 'waiting') {
      generation.markAlive(workspaceId, Date.now())
      return liveObservation(info.status, info.waitingFor)
    }

    const syncStatus = getWorkspaceFileStatusSync(workspaceId)
    if (syncStatus === 'busy' || syncStatus === 'idle' || syncStatus === 'waiting') {
      generation.markAlive(workspaceId, Date.now())
      return liveObservation(syncStatus, undefined)
    }

    if (generation.shouldReportDied(workspaceId, Date.now(), UNKNOWN_DEATH_GRACE_MS)) {
      return { status: 'unknown', outcome: 'died' }
    }
    return { status: 'unknown' }
  }

  waitForChange(workspaceIds: readonly string[], deadlineAt: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false
      let timer: NodeJS.Timeout | null = null
      const finish = (): void => {
        if (settled) return
        settled = true
        unsubscribe()
        if (timer != null) clearTimeout(timer)
        resolve()
      }
      // Observer is installed before the next service snapshot. A short polling
      // backstop also covers status-file changes that do not emit a DB transition.
      const unsubscribe = onWorkspaceStatusChange((workspaceId) => {
        if (workspaceIds.includes(workspaceId)) finish()
      })
      const remaining = Math.max(0, deadlineAt - Date.now())
      timer = setTimeout(finish, Math.min(250, remaining))
      if (remaining === 0) finish()
    })
  }
}
