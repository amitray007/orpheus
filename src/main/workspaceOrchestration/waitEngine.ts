import {
  getWorkspaceFileInfo,
  getWorkspaceFileStatusSync,
  reconcileSessionStateFresh
} from '../sessionState'
import { onWorkspaceStatusChange } from '../orpheusNotify'
import { getWorkspace } from '../workspaces'
import type { WorkspaceWaitObservation, WorkspaceWaitPort, WorkspaceWaitSession } from './types'
import { WaitLifecycleGeneration } from './waitState'
export { isWaitTerminal, legacyWaitReason } from './waitState'

const UNKNOWN_DEATH_GRACE_MS = 3_000
const MIN_BACKSTOP_MS = 125
const MAX_BACKSTOP_MS = 1_000

type ChangeWaiter = {
  workspaceIds: ReadonlySet<string>
  finish: (changed: boolean) => void
  timer: NodeJS.Timeout
}

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
  private readonly changeWaiters = new Set<ChangeWaiter>()
  private unsubscribeStatus: (() => void) | null = null

  createSession(workspaceIds: readonly string[]): WorkspaceWaitSession {
    void workspaceIds
    const generation = new WaitLifecycleGeneration()
    let backstopMs = MIN_BACKSTOP_MS
    return {
      observe: (workspaceId) => this.observe(workspaceId, generation),
      waitForChange: async (workspaceIds, deadlineAt) => {
        const changed = await this.waitForChange(workspaceIds, deadlineAt, backstopMs)
        backstopMs = changed
          ? MIN_BACKSTOP_MS
          : Math.min(MAX_BACKSTOP_MS, Math.max(MIN_BACKSTOP_MS, backstopMs * 2))
      },
      dispose: () => generation.dispose()
    }
  }

  private async observe(
    workspaceId: string,
    generation: WaitLifecycleGeneration
  ): Promise<WorkspaceWaitObservation | null> {
    await reconcileSessionStateFresh()
    const workspace = getWorkspace(workspaceId)
    if (workspace == null) return null
    if (workspace.archivedAt != null || workspace.closedAt != null) {
      return { status: workspace.status, outcome: 'died' }
    }

    const info = getWorkspaceFileInfo(workspaceId)
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

  private waitForChange(
    workspaceIds: readonly string[],
    deadlineAt: number,
    backstopMs: number
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (changed: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(waiter.timer)
        this.changeWaiters.delete(waiter)
        this.releaseStatusSubscriptionIfIdle()
        resolve(changed)
      }
      const remaining = Math.max(0, deadlineAt - Date.now())
      const waiter: ChangeWaiter = {
        workspaceIds: new Set(workspaceIds),
        finish,
        timer: setTimeout(() => finish(false), Math.min(backstopMs, remaining))
      }
      this.changeWaiters.add(waiter)
      this.ensureStatusSubscription()
      if (remaining === 0) finish(false)
    })
  }

  private ensureStatusSubscription(): void {
    if (this.unsubscribeStatus != null) return
    this.unsubscribeStatus = onWorkspaceStatusChange((workspaceId) => {
      for (const waiter of [...this.changeWaiters]) {
        if (waiter.workspaceIds.has(workspaceId)) waiter.finish(true)
      }
    })
  }

  private releaseStatusSubscriptionIfIdle(): void {
    if (this.changeWaiters.size !== 0 || this.unsubscribeStatus == null) return
    this.unsubscribeStatus()
    this.unsubscribeStatus = null
  }
}
