import { createHash, randomUUID } from 'node:crypto'
import { recursivelyRedact } from '../workspaceOrchestration/redaction'
import { AutomationDefinitionError, AutomationService } from './service'
import {
  AUTOMATION_LIMITS,
  type AutomationAuditPort,
  type AutomationClock,
  type AutomationDefinition,
  type AutomationEvent,
  type AutomationManagementContext,
  type AutomationRegistry,
  type AutomationRun,
  type AutomationStore,
  type AutomationTimeoutResult,
  type AutomationTriggerOccurrence
} from './types'

const MAX_RECONCILE_ITEMS = 200
const DEFAULT_TICK_MS = 1_000
const CLEANUP_INTERVAL_MS = 60 * 60 * 1_000
const RETRYABLE_CODES = new Set(['busy', 'unavailable', 'timeout', 'failed'])
const SAFE_AUDIT_ID = /^[A-Za-z0-9._:-]{1,128}$/

function defaultWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController
): Promise<AutomationTimeoutResult<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort('timeout')
      resolve({ timedOut: true })
    }, timeoutMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve({ timedOut: true })
    }
    controller.signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', onAbort)
        resolve({ timedOut: false, value })
      },
      (error: unknown) => {
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}

function stableKey(automationId: string, occurrence: AutomationTriggerOccurrence): string {
  return createHash('sha256')
    .update(`${automationId}\0${occurrence.kind}\0${occurrence.key}`, 'utf8')
    .digest('hex')
}

function nextScheduleTime(dueAt: number, intervalMs: number, now: number): number {
  const missed = Math.max(1, Math.floor((now - dueAt) / intervalMs) + 1)
  return dueAt + missed * intervalMs
}

function retryDelay(definition: AutomationDefinition, completedAttempt: number): number {
  const multiplier = 2 ** Math.max(0, completedAttempt - 1)
  return Math.min(definition.retry.maxDelayMs, definition.retry.baseDelayMs * multiplier)
}

function safeError(code: string): Record<string, unknown> {
  return { code, message: 'Automation attempt did not complete.' }
}

function terminalStatus(
  code: string
): 'failed' | 'timed_out' | 'interrupted' | 'cancelled' | 'budget_exhausted' {
  if (code === 'cancelled') return 'cancelled'
  if (code === 'interrupted') return 'interrupted'
  if (code === 'budget_exhausted') return 'budget_exhausted'
  return code === 'timeout' ? 'timed_out' : 'failed'
}

function abortedCode(controller: AbortController): string {
  if (controller.signal.reason === 'disabled') return 'cancelled'
  if (controller.signal.reason === 'shutdown') return 'interrupted'
  return 'timeout'
}

function resultAuditId(result: unknown): string | null {
  if (result == null || typeof result !== 'object' || Array.isArray(result)) return null
  const auditId = (result as Record<string, unknown>)['auditId']
  return typeof auditId === 'string' && SAFE_AUDIT_ID.test(auditId) ? auditId : null
}

export type AutomationSchedulerPorts = {
  store: AutomationStore
  service: AutomationService
  registry: AutomationRegistry
  audit: AutomationAuditPort
  clock?: AutomationClock
  generateId?: () => string
  tickMs?: number
}

type AttemptOutcome = {
  resultCode: string
  result: unknown
  error: unknown
  decision: 'allow' | 'deny'
  description: ReturnType<AutomationRegistry['describe']>
}

export class AutomationScheduler {
  private readonly clock: AutomationClock
  private readonly generateId: () => string
  private readonly tickMs: number
  private readonly activeByAutomation = new Map<string, number>()
  private readonly controllers = new Map<string, Set<AbortController>>()
  private readonly lingeringRunIds = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private tickInFlight: Promise<void> | null = null
  private started = false
  private lastCleanupAt: number | null = null

  constructor(private readonly ports: AutomationSchedulerPorts) {
    this.clock = ports.clock ?? { now: Date.now, withTimeout: defaultWithTimeout }
    this.generateId = ports.generateId ?? randomUUID
    this.tickMs = ports.tickMs ?? DEFAULT_TICK_MS
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    await this.recover()
    if (!this.started) return
    await this.tick()
    if (!this.started) return
    this.timer = setInterval(() => void this.tick(), this.tickMs)
    this.timer.unref?.()
  }

  stop(): void {
    this.started = false
    if (this.timer != null) clearInterval(this.timer)
    this.timer = null
    for (const controllers of this.controllers.values()) {
      for (const controller of controllers) controller.abort('shutdown')
    }
    this.ports.store.markRunningInterrupted(this.clock.now())
  }

  async setEnabled(
    id: string,
    enabled: boolean,
    management: AutomationManagementContext
  ): Promise<AutomationDefinition> {
    const definition = await this.ports.service.setEnabled(id, enabled, management)
    if (!enabled) {
      for (const controller of this.controllers.get(id) ?? []) controller.abort('disabled')
    }
    return definition
  }

  async emitEvent(event: AutomationEvent): Promise<AutomationRun[]> {
    const runs = this.ports.service.matchingEventDefinitions(event).map((definition) =>
      this.enqueue(definition, {
        kind: 'event',
        key: event.id,
        occurredAt: event.occurredAt
      })
    )
    await this.tick()
    return runs
  }

  async recover(): Promise<void> {
    const now = this.clock.now()
    for (const interrupted of this.ports.store.markRunningInterrupted(now)) {
      const definition = this.ports.store.getDefinition(interrupted.automationId)
      if (
        definition == null ||
        !definition.enabled ||
        definition.idempotency === 'none' ||
        interrupted.attempt >= definition.retry.maxAttempts ||
        now - interrupted.queuedAt >= definition.retry.maxElapsedMs
      ) {
        continue
      }
      try {
        await this.ports.service.resolveBinding(definition)
        const nextAttemptAt = now + retryDelay(definition, interrupted.attempt)
        if (nextAttemptAt - interrupted.queuedAt > definition.retry.maxElapsedMs) {
          continue
        }
        this.ports.store.scheduleRetry({
          id: interrupted.id,
          expected: 'interrupted',
          nextAttemptAt,
          resultCode: 'interrupted',
          error: safeError('interrupted'),
          auditId: interrupted.auditId
        })
      } catch {
        // Failed grant/descriptor revalidation leaves the run terminally
        // interrupted. A later enable action can create a new occurrence; it
        // cannot silently resurrect a possibly committed effect.
      }
    }
  }

  tick(): Promise<void> {
    if (this.tickInFlight != null) return this.tickInFlight
    this.tickInFlight = this.reconcile().finally(() => {
      this.tickInFlight = null
    })
    return this.tickInFlight
  }

  private async reconcile(): Promise<void> {
    const now = this.clock.now()
    if (this.lastCleanupAt == null || now - this.lastCleanupAt >= CLEANUP_INTERVAL_MS) {
      this.ports.store.pruneTerminalRuns(
        now - AUTOMATION_LIMITS.runRetentionMs,
        AUTOMATION_LIMITS.maxRetainedRunsPerAutomation
      )
      this.lastCleanupAt = now
    }
    this.enqueueDueSchedules(now)
    const runnable = this.ports.store
      .listRuns({
        statuses: ['queued', 'retry_wait'],
        limit: MAX_RECONCILE_ITEMS
      })
      .filter((run) => run.nextAttemptAt == null || run.nextAttemptAt <= now)

    const selected: Array<{ definition: AutomationDefinition; run: AutomationRun }> = []
    const reserved = new Map<string, number>()
    for (const run of runnable) {
      const definition = this.ports.store.getDefinition(run.automationId)
      if (definition == null || !definition.enabled) continue
      if (this.lingeringRunIds.has(run.id)) continue
      const active = this.activeByAutomation.get(definition.id) ?? 0
      const alreadyReserved = reserved.get(definition.id) ?? 0
      if (active + alreadyReserved >= definition.concurrencyLimit) continue
      const starts = this.ports.store.countStartsSince(
        definition.id,
        now - definition.rollingBudget.windowMs
      )
      if (starts + alreadyReserved >= definition.rollingBudget.maxStarts) {
        this.ports.store.deferRun(
          run.id,
          run.status as 'queued' | 'retry_wait',
          now + definition.rollingBudget.windowMs,
          'rolling_budget'
        )
        continue
      }
      reserved.set(definition.id, alreadyReserved + 1)
      selected.push({ definition, run })
    }
    await Promise.all(selected.map(({ definition, run }) => this.execute(definition, run)))
  }

  private enqueueDueSchedules(now: number): void {
    for (const definition of this.ports.store.listDueSchedules(now, MAX_RECONCILE_ITEMS)) {
      if (definition.trigger.kind !== 'schedule' || definition.nextRunAt == null) continue
      const dueAt = definition.nextRunAt
      this.enqueue(definition, {
        kind: 'schedule',
        key: String(dueAt),
        occurredAt: dueAt
      })
      this.ports.store.updateNextRunAt(
        definition.id,
        dueAt,
        nextScheduleTime(dueAt, definition.trigger.intervalMs, now)
      )
    }
  }

  private enqueue(
    definition: AutomationDefinition,
    occurrence: AutomationTriggerOccurrence
  ): AutomationRun {
    const idempotencyKey = stableKey(definition.id, occurrence)
    const existing = this.ports.store.getRunByIdempotencyKey(definition.id, idempotencyKey)
    if (existing != null) return existing
    const run: AutomationRun = {
      id: this.generateId(),
      automationId: definition.id,
      trigger: occurrence,
      idempotencyKey,
      status: 'queued',
      attempt: 0,
      queuedAt: this.clock.now(),
      startedAt: null,
      finishedAt: null,
      nextAttemptAt: null,
      resultCode: null,
      result: null,
      error: null,
      requestId: null,
      auditId: null
    }
    if (this.ports.store.insertRun(run)) return run
    return this.ports.store.getRunByIdempotencyKey(definition.id, idempotencyKey) ?? run
  }

  private async execute(definition: AutomationDefinition, pending: AutomationRun): Promise<void> {
    const requestId = `automation:${definition.id}:${pending.id}:${pending.attempt + 1}`
    const expected = pending.status as 'queued' | 'retry_wait'
    const startedAt = this.clock.now()
    if (!this.ports.store.claimRun(pending.id, expected, startedAt, requestId)) return
    const run = this.ports.store.getRun(pending.id)
    if (run == null) return
    this.activeByAutomation.set(
      definition.id,
      (this.activeByAutomation.get(definition.id) ?? 0) + 1
    )
    const controller = new AbortController()
    const automationControllers = this.controllers.get(definition.id) ?? new Set()
    automationControllers.add(controller)
    this.controllers.set(definition.id, automationControllers)

    try {
      await this.invokeAttempt(definition, run, requestId, controller)
    } finally {
      automationControllers.delete(controller)
      if (automationControllers.size === 0) this.controllers.delete(definition.id)
      const active = (this.activeByAutomation.get(definition.id) ?? 1) - 1
      if (active <= 0) this.activeByAutomation.delete(definition.id)
      else this.activeByAutomation.set(definition.id, active)
    }
  }

  private async invokeAttempt(
    definition: AutomationDefinition,
    run: AutomationRun,
    requestId: string,
    controller: AbortController
  ): Promise<void> {
    const auditId = this.generateId()
    const currentDefinition = this.ports.store.getDefinition(definition.id)
    const definitionForAttempt =
      currentDefinition?.enabled === true ? currentDefinition : definition
    const { result, error, resultCode, decision, description } = await this.runInvocation(
      definitionForAttempt,
      run,
      requestId,
      controller
    )

    let persistedAuditId: string | null = null
    if (description != null) {
      try {
        await this.ports.audit.appendAttempt({
          auditId,
          requestId,
          occurredAt: this.clock.now(),
          definition: definitionForAttempt,
          run,
          description,
          decision,
          resultCode,
          result,
          error
        })
        persistedAuditId = auditId
      } catch {
        persistedAuditId = resultAuditId(result)
      }
    }

    if (resultCode === 'completed') {
      this.ports.store.finishRun({
        id: run.id,
        status: 'succeeded',
        finishedAt: this.clock.now(),
        resultCode,
        result: recursivelyRedact({ value: result }),
        error: null,
        auditId: persistedAuditId
      })
      return
    }

    const now = this.clock.now()
    const retryAt = now + retryDelay(definitionForAttempt, run.attempt)
    const stillEnabled =
      currentDefinition?.enabled === true &&
      this.ports.store.getDefinition(definition.id)?.enabled === true
    const canRetry =
      RETRYABLE_CODES.has(resultCode) &&
      definitionForAttempt.idempotency !== 'none' &&
      run.attempt < definitionForAttempt.retry.maxAttempts &&
      retryAt - run.queuedAt <= definitionForAttempt.retry.maxElapsedMs &&
      stillEnabled
    if (canRetry) {
      this.ports.store.scheduleRetry({
        id: run.id,
        expected: 'running',
        nextAttemptAt: retryAt,
        resultCode,
        error: safeError(resultCode),
        auditId: persistedAuditId
      })
      return
    }

    const exhausted =
      RETRYABLE_CODES.has(resultCode) &&
      definitionForAttempt.idempotency !== 'none' &&
      (run.attempt >= definitionForAttempt.retry.maxAttempts ||
        retryAt - run.queuedAt > definitionForAttempt.retry.maxElapsedMs)
    this.ports.store.finishRun({
      id: run.id,
      status: exhausted ? 'budget_exhausted' : terminalStatus(resultCode),
      finishedAt: now,
      resultCode,
      result: null,
      error: safeError(resultCode),
      auditId: persistedAuditId
    })
  }

  private async runInvocation(
    definition: AutomationDefinition,
    run: AutomationRun,
    requestId: string,
    controller: AbortController
  ): Promise<AttemptOutcome> {
    let description = this.ports.registry.describe(definition.operationId)
    try {
      const persisted = this.ports.store.getDefinition(definition.id)
      if (persisted == null || !persisted.enabled) {
        throw new AutomationDefinitionError('forbidden', 'Automation definition is disabled.')
      }
      const resolved = await this.ports.service.resolveBinding(definition)
      description = resolved.description
      const remainingElapsedMs = definition.retry.maxElapsedMs - (this.clock.now() - run.queuedAt)
      if (remainingElapsedMs <= 0) {
        return {
          resultCode: 'budget_exhausted',
          result: null,
          error: safeError('budget_exhausted'),
          decision: 'allow',
          description
        }
      }
      const attemptTimeoutMs = Math.min(definition.timeoutMs, remainingElapsedMs)
      const context = {
        principal: { type: 'automation' as const, id: definition.id },
        consumer: 'automation' as const,
        workspaceId: definition.scope.kind === 'workspace' ? definition.scope.workspaceId : null,
        projectId: definition.scope.kind === 'app' ? null : definition.scope.projectId,
        requestId,
        trustedAutomation: resolved.binding,
        automationRunId: run.id,
        idempotencyKey: run.idempotencyKey,
        deadlineAt: this.clock.now() + attemptTimeoutMs,
        signal: controller.signal
      }
      if (!this.ports.registry.validateInput(definition.operationId, definition.params, context)) {
        throw new AutomationDefinitionError(
          'invalid',
          'Persisted automation params no longer match the operation schema.'
        )
      }
      let invocationSettled = false
      let attemptTimedOut = false
      const invocation = this.ports.registry
        .invoke({
          id: definition.operationId,
          input: definition.params,
          context
        })
        .finally(() => {
          invocationSettled = true
          if (attemptTimedOut) this.lingeringRunIds.delete(run.id)
        })
      const timed = await this.clock.withTimeout(invocation, attemptTimeoutMs, controller)
      if (timed.timedOut) {
        attemptTimedOut = true
        if (!invocationSettled) this.lingeringRunIds.add(run.id)
        const resultCode = abortedCode(controller)
        return {
          resultCode,
          result: null,
          error: safeError(resultCode),
          decision: 'allow',
          description
        }
      }
      if (timed.value.ok) {
        return {
          resultCode: 'completed',
          result: timed.value.value,
          error: null,
          decision: 'allow',
          description
        }
      }
      return {
        resultCode: timed.value.code,
        result: null,
        error: safeError(timed.value.code),
        decision: 'allow',
        description
      }
    } catch (caught) {
      const definitionError = caught instanceof AutomationDefinitionError ? caught : null
      return {
        resultCode:
          definitionError?.code ?? (controller.signal.aborted ? abortedCode(controller) : 'failed'),
        result: null,
        error: caught,
        decision: definitionError?.code === 'forbidden' ? 'deny' : 'allow',
        description
      }
    }
  }
}
