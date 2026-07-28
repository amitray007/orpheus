import { orchestrationError } from './errors'
import type { EffectReceipt, WorkspaceRuntimePort, WorkspaceSnapshot } from './types'

const POLL_INTERVAL_MS = 100
const SUBMIT_DELAY_MS = 150
const DEFAULT_OPEN_TIMEOUT_MS = 25_000

type SurfacePhase = 'none' | 'hidden' | 'attached' | 'visible' | 'freeing'

export type RuntimeCoordinatorDeps = {
  now?: () => number
  openTimeoutMs?: number
  requestOpen: (workspace: WorkspaceSnapshot) => void
  getSurfacePhase: (workspaceId: string) => SurfacePhase
  refreshSessionState?: () => void | Promise<void>
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

export type RuntimeTextResult =
  | { ok: true }
  | {
      ok: false
      stage: 'send' | 'submit'
      code?: string
      error?: string
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
      if (!wasMounted) this.deps.requestOpen(workspace)
      const deadlineAt = this.now() + (this.deps.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS)
      while (this.now() < deadlineAt) {
        await this.refreshSessionState()
        if (
          mounted(this.safePhase(workspace.workspaceId)) &&
          this.deps.isSessionReady(workspace.workspaceId)
        ) {
          break
        }
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
      await this.refreshSessionState()
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
    const result = await this.stageText(workspaceId, text, submit)
    if (result.ok) return
    if (result.stage === 'submit' && result.code === 'busy') return
    throw orchestrationError(
      result.code === 'busy' ? 'busy' : result.code === 'not_found' ? 'not_found' : 'failed',
      result.error ??
        (result.stage === 'send'
          ? 'Workspace input could not be sent.'
          : 'Workspace input could not be submitted.')
    )
  }

  /**
   * Shared stage/optional-submit primitive for both semantic orchestration and
   * the legacy CLI envelope. It preserves the lower-level error stage so the
   * CLI can retain its historical warning strings without duplicating native
   * readiness and injection logic in index.ts.
   */
  async stageText(workspaceId: string, text: string, submit: boolean): Promise<RuntimeTextResult> {
    let result: RuntimeTextResult = { ok: true }
    await this.deps.withInjectLock(workspaceId, async () => {
      const input = this.deps.sendInput(workspaceId, text)
      if (!input.ok) {
        result = {
          ok: false,
          stage: 'send',
          ...(input.code == null ? {} : { code: input.code }),
          ...(input.error == null ? {} : { error: input.error })
        }
        return
      }
      if (!submit) return
      await delay(SUBMIT_DELAY_MS)
      const submitted = this.deps.submit(workspaceId)
      if (!submitted.ok) {
        result = {
          ok: false,
          stage: 'submit',
          ...(submitted.code == null ? {} : { code: submitted.code }),
          ...(submitted.error == null ? {} : { error: submitted.error })
        }
      }
    })
    return result
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

  private async refreshSessionState(): Promise<void> {
    await this.deps.refreshSessionState?.()
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
