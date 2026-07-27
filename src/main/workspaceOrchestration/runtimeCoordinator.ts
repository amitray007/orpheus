import { orchestrationError } from './errors'
import type { EffectReceipt, WorkspaceRuntimePort, WorkspaceSnapshot } from './types'

const POLL_INTERVAL_MS = 100
const SUBMIT_DELAY_MS = 150
const DEFAULT_OPEN_TIMEOUT_MS = 25_000

type SurfacePhase = 'none' | 'hidden' | 'attached' | 'visible' | 'freeing'

export type RuntimeCoordinatorDeps = {
  now?: () => number
  openTimeoutMs?: number
  requestOpen: (workspaceId: string) => void
  getSurfacePhase: (workspaceId: string) => SurfacePhase
  isSessionReady: (workspaceId: string) => boolean
  canInject: (workspaceId: string) => boolean
  sendInput: (
    workspaceId: string,
    text: string
  ) => {
    ok: boolean
    code?: string
    error?: string
  }
  submit: (workspaceId: string) => { ok: boolean; code?: string; error?: string }
  withInjectLock: <T>(workspaceId: string, action: () => Promise<T>) => Promise<T>
  destroyRuntime: (workspaceId: string) => void | Promise<void>
}

function mounted(phase: SurfacePhase): boolean {
  return phase === 'hidden' || phase === 'attached' || phase === 'visible'
}

function effect(name: string, status: EffectReceipt['status'], workspaceId: string): EffectReceipt {
  return { effect: name, status, workspaceId }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Serializes native surface start/teardown per workspace. Renderer requests
 * remain the actual mount mechanism, but callers observe one atomic lifecycle:
 * teardown waits for an in-flight ensure, and a concurrent ensure shares the
 * same readiness promise instead of racing a second mount.
 */
export class WorkspaceRuntimeCoordinator implements WorkspaceRuntimePort {
  private readonly now: () => number
  private readonly transitions = new Map<string, Promise<unknown>>()

  constructor(private readonly deps: RuntimeCoordinatorDeps) {
    this.now = deps.now ?? Date.now
  }

  ensureOpen(
    workspace: WorkspaceSnapshot
  ): Promise<{ runtimeState: 'retained' | 'started'; effects: EffectReceipt[] }> {
    return this.serialized(workspace.workspaceId, async () => {
      const initialPhase = this.safePhase(workspace.workspaceId)
      const wasMounted = mounted(initialPhase)
      if (!wasMounted) this.deps.requestOpen(workspace.workspaceId)
      const deadlineAt = this.now() + (this.deps.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS)
      while (
        this.now() < deadlineAt &&
        (!mounted(this.safePhase(workspace.workspaceId)) ||
          !this.deps.isSessionReady(workspace.workspaceId))
      ) {
        await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadlineAt - this.now())))
      }
      if (
        !mounted(this.safePhase(workspace.workspaceId)) ||
        !this.deps.isSessionReady(workspace.workspaceId)
      ) {
        throw orchestrationError('timeout', 'Workspace runtime was not ready in time.')
      }
      return {
        runtimeState: wasMounted ? 'retained' : 'started',
        effects: [
          effect('surface.mount', wasMounted ? 'skipped' : 'applied', workspace.workspaceId),
          effect('process.spawn', wasMounted ? 'skipped' : 'applied', workspace.workspaceId)
        ]
      }
    })
  }

  async waitUntilReady(workspaceId: string, deadlineAt: number): Promise<boolean> {
    while (this.now() < deadlineAt) {
      if (
        mounted(this.safePhase(workspaceId)) &&
        this.deps.isSessionReady(workspaceId) &&
        this.deps.canInject(workspaceId)
      ) {
        return true
      }
      await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadlineAt - this.now())))
    }
    return false
  }

  async sendText(workspaceId: string, text: string, submit: boolean): Promise<void> {
    await this.deps.withInjectLock(workspaceId, async () => {
      const input = this.deps.sendInput(workspaceId, text)
      if (!input.ok) {
        throw orchestrationError(
          input.code === 'busy' ? 'busy' : input.code === 'not_found' ? 'not_found' : 'failed',
          input.error ?? 'Workspace input could not be sent.'
        )
      }
      if (!submit) return
      await delay(SUBMIT_DELAY_MS)
      const submitted = this.deps.submit(workspaceId)
      if (!submitted.ok && submitted.code !== 'busy') {
        throw orchestrationError(
          submitted.code === 'not_found' ? 'not_found' : 'failed',
          submitted.error ?? 'Workspace input could not be submitted.'
        )
      }
    })
  }

  canTeardown(workspaceId: string): boolean {
    return this.safePhase(workspaceId) !== 'freeing'
  }

  teardown(workspaceId: string): Promise<{ effects: EffectReceipt[] }> {
    return this.serialized(workspaceId, async () => {
      const phase = this.safePhase(workspaceId)
      const wasMounted = mounted(phase) || phase === 'freeing'
      await this.deps.destroyRuntime(workspaceId)
      return {
        effects: [
          effect('surface.destroy', wasMounted ? 'applied' : 'skipped', workspaceId),
          effect('process.terminate', wasMounted ? 'applied' : 'skipped', workspaceId)
        ]
      }
    })
  }

  private safePhase(workspaceId: string): SurfacePhase {
    try {
      return this.deps.getSurfacePhase(workspaceId)
    } catch {
      return 'none'
    }
  }

  private serialized<T>(workspaceId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.transitions.get(workspaceId) ?? Promise.resolve()
    const next = previous.then(action, action)
    const settled = next.then(
      () => undefined,
      () => undefined
    )
    this.transitions.set(workspaceId, settled)
    void settled.finally(() => {
      if (this.transitions.get(workspaceId) === settled) this.transitions.delete(workspaceId)
    })
    return next
  }
}
