import { createHash, randomUUID } from 'node:crypto'
import { AutomationDefinitionError, AutomationService } from './service'
import { persistableAutomationResult } from './resultPersistence'
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
const MAX_BUDGET_DEFERRALS_PER_RECONCILE = 200
const BUDGET_DEFERRAL_YIELD_MS = 25
const CLEANUP_INTERVAL_MS = 60 * 60 * 1_000
const MAX_WAKE_DELAY_MS = 2_147_483_647
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
  if (result == null || typeof result !== 'object') return null
  let auditId: unknown
  try {
    if (Array.isArray(result)) return null
    const descriptor = Object.getOwnPropertyDescriptor(result, 'auditId')
    auditId =
      descriptor != null && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
  } catch {
    return null
  }
  return typeof auditId === 'string' && SAFE_AUDIT_ID.test(auditId) ? auditId : null
}

export type AutomationSchedulerPorts = {
  store: AutomationStore
  service: AutomationService
  registry: AutomationRegistry
  audit: AutomationAuditPort
  clock?: AutomationClock
  generateId?: () => string
  maxGlobalConcurrency?: number
  scheduleWake?: (callback: () => void, delayMs: number) => AutomationWakeHandle
  cancelWake?: (handle: AutomationWakeHandle) => void
}

export type AutomationWakeHandle = Readonly<{ unref?: () => void }>

type AttemptOutcome = {
  resultCode: string
  result: unknown
  error: unknown
  decision: 'allow' | 'deny'
  description: ReturnType<AutomationRegistry['describe']>
}

type RunSelection = { definition: AutomationDefinition; run: AutomationRun }
type BudgetDeferralWork = { remaining: number }

export class AutomationScheduler {
  private readonly clock: AutomationClock
  private readonly generateId: () => string
  private readonly maxGlobalConcurrency: number
  private readonly scheduleWake: NonNullable<AutomationSchedulerPorts['scheduleWake']>
  private readonly cancelWake: NonNullable<AutomationSchedulerPorts['cancelWake']>
  private readonly activeByAutomation = new Map<string, number>()
  private readonly activeTasks = new Set<Promise<void>>()
  private readonly occupiedSlots = new Set<symbol>()
  private readonly lingeringTasks = new Set<Promise<void>>()
  private readonly controllers = new Map<string, Set<AbortController>>()
  private readonly lingeringRunIds = new Set<string>()
  private automationCursor = 0
  private timer: AutomationWakeHandle | null = null
  private scheduledWakeAt: number | null = null
  private tickInFlight: Promise<readonly Promise<void>[]> | null = null
  private unsubscribeMutations: (() => void) | null = null
  private wakeRequested = false
  private started = false
  private lastCleanupAt: number | null = null
  private budgetDeferralYieldUntil: number | null = null

  constructor(private readonly ports: AutomationSchedulerPorts) {
    this.clock = ports.clock ?? { now: Date.now, withTimeout: defaultWithTimeout }
    this.generateId = ports.generateId ?? randomUUID
    this.maxGlobalConcurrency = ports.maxGlobalConcurrency ?? AUTOMATION_LIMITS.maxGlobalConcurrency
    this.scheduleWake =
      ports.scheduleWake ??
      ((callback, delayMs) => {
        return setTimeout(callback, delayMs)
      })
    this.cancelWake =
      ports.cancelWake ??
      ((handle) => {
        clearTimeout(handle as NodeJS.Timeout)
      })
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.unsubscribeMutations = this.ports.service.subscribeMutations(() => this.requestWake())
    try {
      await this.recover()
      if (!this.started) return
      await this.tick(false, true)
    } catch (error) {
      this.cancelScheduledWake()
      this.unsubscribeMutations?.()
      this.unsubscribeMutations = null
      this.started = false
      throw error
    }
  }

  stop(): void {
    this.started = false
    this.wakeRequested = false
    this.cancelScheduledWake()
    this.unsubscribeMutations?.()
    this.unsubscribeMutations = null
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

  deleteDefinition(id: string, management: AutomationManagementContext): AutomationDefinition {
    for (const controller of this.controllers.get(id) ?? []) controller.abort('disabled')
    return this.ports.service.deleteDefinition(id, management)
  }

  /**
   * Persist one validated domain occurrence. This is intentionally
   * synchronous so callers can invoke it inside the transaction that commits
   * the source-of-truth domain mutation.
   */
  persistEvent(event: AutomationEvent): void {
    this.ports.service.validateEvent(event)
    if (this.ports.store.insertEventOccurrence(event, this.clock.now())) {
      this.requestWake()
      return
    }
    const existing = this.ports.store.getEventOccurrence(event.id)
    if (
      existing == null ||
      existing.type !== event.type ||
      existing.occurredAt !== event.occurredAt ||
      existing.projectId !== event.projectId ||
      existing.workspaceId !== event.workspaceId
    ) {
      throw new AutomationDefinitionError(
        'conflict',
        'Automation event id is already bound to a different occurrence.'
      )
    }
  }

  drainEvents(): Promise<void> {
    return Promise.resolve().then(() => {
      this.enqueuePendingEvents(this.clock.now())
      this.requestWake()
    })
  }

  async emitEvent(event: AutomationEvent): Promise<AutomationRun[]> {
    const definitions = this.ports.service.matchingEventDefinitions(event)
    this.persistEvent(event)
    await this.drainEvents()
    await this.tick()
    return definitions.flatMap((definition) => {
      const occurrence: AutomationTriggerOccurrence = {
        kind: 'event',
        key: event.id,
        occurredAt: event.occurredAt
      }
      const run = this.ports.store.getRunByIdempotencyKey(
        definition.id,
        stableKey(definition.id, occurrence)
      )
      return run == null ? [] : [run]
    })
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

  async tick(waitForExecutions = true, requireStarted = false): Promise<void> {
    if (this.tickInFlight == null) {
      this.cancelScheduledWake()
      this.tickInFlight = Promise.resolve()
        .then(() => (requireStarted && !this.started ? [] : this.reconcile()))
        .finally(() => {
          this.tickInFlight = null
          this.rescheduleWake()
        })
    }
    const dispatched = await this.tickInFlight
    if (waitForExecutions) await Promise.all(dispatched)
  }

  async waitForIdle(): Promise<void> {
    while (this.activeTasks.size > 0 || this.lingeringTasks.size > 0) {
      await Promise.allSettled([...this.activeTasks, ...this.lingeringTasks])
    }
  }

  private requestWake(): void {
    if (!this.started) return
    if (this.tickInFlight != null) {
      this.wakeRequested = true
      return
    }
    this.wakeRequested = false
    this.armWakeAt(this.clock.now())
  }

  private rescheduleWake(): void {
    if (!this.started) {
      this.cancelScheduledWake()
      return
    }
    if (this.wakeRequested) {
      this.wakeRequested = false
      this.armWakeAt(this.clock.now())
      return
    }
    const now = this.clock.now()
    // Retention maintenance is itself a low-frequency deadline. This keeps an
    // otherwise idle app bounded without restoring the old one-second poller.
    const cleanupWakeAt = (this.lastCleanupAt ?? now) + CLEANUP_INTERVAL_MS
    if (this.occupiedSlots.size >= this.maxGlobalConcurrency) {
      this.armWakeAt(cleanupWakeAt)
      return
    }
    let nextWakeAt = this.ports.store.getNextWakeAt()
    if (
      nextWakeAt != null &&
      nextWakeAt <= now &&
      this.budgetDeferralYieldUntil != null &&
      this.budgetDeferralYieldUntil > now
    ) {
      // A bounded deferral pass can intentionally leave ready rows behind.
      // Yield briefly instead of scheduling another zero-delay reconciliation,
      // but preserve any unrelated persisted deadline that arrives sooner.
      const futureWakeAt = this.ports.store.getNextWakeAt(now)
      nextWakeAt =
        futureWakeAt == null
          ? this.budgetDeferralYieldUntil
          : Math.min(futureWakeAt, this.budgetDeferralYieldUntil)
    }
    if (nextWakeAt != null && nextWakeAt <= now && this.occupiedSlots.size > 0) {
      // Ready rows can belong to a definition whose concurrency is already
      // occupied. Ignore those rows for timer purposes without losing a
      // different schedule or retry that becomes due while it is running.
      nextWakeAt = this.ports.store.getNextWakeAt(now)
    }
    this.armWakeAt(nextWakeAt == null ? cleanupWakeAt : Math.min(nextWakeAt, cleanupWakeAt))
  }

  private armWakeAt(wakeAt: number): void {
    if (!this.started) return
    if (this.timer != null && this.scheduledWakeAt != null && this.scheduledWakeAt <= wakeAt) {
      return
    }
    this.cancelScheduledWake()
    const delayMs = Math.min(MAX_WAKE_DELAY_MS, Math.max(0, wakeAt - this.clock.now()))
    const timer = this.scheduleWake(() => {
      if (this.timer !== timer) return
      this.timer = null
      this.scheduledWakeAt = null
      void this.tick(false, true)
    }, delayMs)
    this.timer = timer
    this.scheduledWakeAt = wakeAt
    timer.unref?.()
  }

  private cancelScheduledWake(): void {
    if (this.timer != null) this.cancelWake(this.timer)
    this.timer = null
    this.scheduledWakeAt = null
  }

  private dispatch(definition: AutomationDefinition, run: AutomationRun): Promise<void> {
    const slot = Symbol(run.id)
    this.occupiedSlots.add(slot)
    let slotTransferred = false
    const holdSlotUntilSettled = (invocation: Promise<unknown>): void => {
      slotTransferred = true
      const lingering = invocation.then(
        () => undefined,
        () => undefined
      )
      this.lingeringTasks.add(lingering)
      void lingering.finally(() => {
        this.lingeringTasks.delete(lingering)
        this.occupiedSlots.delete(slot)
        this.requestWake()
      })
    }
    const task = this.execute(definition, run, holdSlotUntilSettled).finally(() => {
      this.activeTasks.delete(task)
      if (!slotTransferred) this.occupiedSlots.delete(slot)
      this.requestWake()
    })
    this.activeTasks.add(task)
    void task.catch(() => {
      // A timer-driven reconciliation has no awaiting caller. Run state and
      // audit persistence remain authoritative; avoid an unhandled rejection.
    })
    return task
  }

  // Execution is tracked separately from reconciliation so one long-running
  // automation cannot stop unrelated due work from being discovered.
  private reconcile(): readonly Promise<void>[] {
    const now = this.clock.now()
    this.budgetDeferralYieldUntil = null
    this.enqueuePendingEvents(now)
    if (this.lastCleanupAt == null || now - this.lastCleanupAt >= CLEANUP_INTERVAL_MS) {
      this.ports.store.pruneTerminalRuns(
        now - AUTOMATION_LIMITS.runRetentionMs,
        AUTOMATION_LIMITS.maxRetainedRunsPerAutomation
      )
      this.ports.store.pruneDeliveredEventOccurrences(
        now - AUTOMATION_LIMITS.eventRetentionMs,
        AUTOMATION_LIMITS.maxRetainedDeliveredEvents
      )
      this.lastCleanupAt = now
    }
    this.enqueueDueSchedules(now)
    const availableGlobalSlots = Math.max(0, this.maxGlobalConcurrency - this.occupiedSlots.size)
    if (availableGlobalSlots === 0) return []

    const runnableAutomationIds = this.ports.store.listRunnableAutomationIds(
      now,
      AUTOMATION_LIMITS.maxDefinitions
    )
    if (runnableAutomationIds.length === 0) {
      this.automationCursor = 0
      return []
    }
    const definitions = new Map(
      this.ports.store
        .listDefinitionsByIds(runnableAutomationIds)
        .map((definition) => [definition.id, definition])
    )
    const starts = this.ports.store.countStartsSinceMany(
      [...definitions.values()].map((definition) => ({
        automationId: definition.id,
        since: now - definition.rollingBudget.windowMs
      }))
    )

    const cursor = this.automationCursor % runnableAutomationIds.length
    const orderedAutomationIds = [
      ...runnableAutomationIds.slice(cursor),
      ...runnableAutomationIds.slice(0, cursor)
    ]
    const selected = this.selectFairRuns({
      now,
      orderedAutomationIds,
      definitions,
      starts,
      availableGlobalSlots,
      budgetDeferralWork: { remaining: MAX_BUDGET_DEFERRALS_PER_RECONCILE }
    })
    const lastSelectedId = selected.at(-1)?.definition.id
    const lastSelectedIndex =
      lastSelectedId == null ? -1 : orderedAutomationIds.lastIndexOf(lastSelectedId)
    this.automationCursor =
      lastSelectedIndex < 0
        ? (cursor + 1) % runnableAutomationIds.length
        : (cursor + lastSelectedIndex + 1) % runnableAutomationIds.length
    return selected.map(({ definition, run }) => this.dispatch(definition, run))
  }

  private selectFairRuns(input: {
    now: number
    orderedAutomationIds: readonly string[]
    definitions: ReadonlyMap<string, AutomationDefinition>
    starts: ReadonlyMap<string, number>
    availableGlobalSlots: number
    budgetDeferralWork: BudgetDeferralWork
  }): RunSelection[] {
    const selected: RunSelection[] = []
    const reserved = new Map<string, number>()
    const candidates = new Map<string, AutomationRun[]>()
    const blocked = new Set<string>()

    while (selected.length < input.availableGlobalSlots) {
      let progressed = false
      for (const automationId of input.orderedAutomationIds) {
        if (selected.length >= input.availableGlobalSlots) break
        if (automationId == null || blocked.has(automationId)) continue
        const definition = input.definitions.get(automationId)
        if (definition == null || !definition.enabled) {
          blocked.add(automationId)
          continue
        }
        const alreadyReserved = reserved.get(definition.id) ?? 0
        const run = this.nextFairRun({
          now: input.now,
          definition,
          alreadyReserved,
          starts: input.starts,
          candidates,
          globalSlotsRemaining: input.availableGlobalSlots - selected.length,
          budgetDeferralWork: input.budgetDeferralWork
        })
        if (run == null) {
          blocked.add(automationId)
          continue
        }
        reserved.set(definition.id, alreadyReserved + 1)
        selected.push({ definition, run })
        progressed = true
      }
      if (!progressed) break
    }
    return selected
  }

  private nextFairRun(input: {
    now: number
    definition: AutomationDefinition
    alreadyReserved: number
    starts: ReadonlyMap<string, number>
    candidates: Map<string, AutomationRun[]>
    globalSlotsRemaining: number
    budgetDeferralWork: BudgetDeferralWork
  }): AutomationRun | null {
    const { definition, alreadyReserved } = input
    const active = this.activeByAutomation.get(definition.id) ?? 0
    const definitionSlots = definition.concurrencyLimit - active - alreadyReserved
    const budgetSlots =
      definition.rollingBudget.maxStarts - (input.starts.get(definition.id) ?? 0) - alreadyReserved
    if (definitionSlots <= 0) return null
    if (budgetSlots <= 0) {
      if (input.budgetDeferralWork.remaining <= 0) {
        this.budgetDeferralYieldUntil = input.now + BUDGET_DEFERRAL_YIELD_MS
        return null
      }
      // Move a globally bounded backlog together. The shared work budget keeps
      // one reconciliation from updating maxDefinitions * maxListLimit rows,
      // while the yield deadline prevents larger backlogs from immediately
      // spinning through another SQLite pass.
      const limit = Math.min(AUTOMATION_LIMITS.maxListLimit, input.budgetDeferralWork.remaining)
      const runs = this.listRunnableNonLingeringRuns(definition.id, input.now, limit)
      if (runs.length > 0) {
        input.budgetDeferralWork.remaining -= runs.length
        this.ports.store.deferRuns(
          runs.map((run) => run.id),
          input.now,
          input.now + definition.rollingBudget.windowMs,
          'rolling_budget'
        )
        if (input.budgetDeferralWork.remaining === 0) {
          this.budgetDeferralYieldUntil = input.now + BUDGET_DEFERRAL_YIELD_MS
        }
      }
      return null
    }
    let definitionCandidates = input.candidates.get(definition.id)
    if (definitionCandidates == null) {
      definitionCandidates = this.listRunnableNonLingeringRuns(
        definition.id,
        input.now,
        Math.min(definitionSlots, budgetSlots, input.globalSlotsRemaining)
      )
      input.candidates.set(definition.id, definitionCandidates)
    }
    const run = definitionCandidates[alreadyReserved]
    return run ?? null
  }

  private listRunnableNonLingeringRuns(
    automationId: string,
    now: number,
    limit: number
  ): AutomationRun[] {
    if (limit <= 0) return []
    const fetchLimit = Math.min(AUTOMATION_LIMITS.maxListLimit, limit + this.lingeringRunIds.size)
    return this.ports.store
      .listRunnableRunsForAutomation(automationId, now, fetchLimit)
      .filter((run) => !this.lingeringRunIds.has(run.id))
      .slice(0, limit)
  }

  private enqueuePendingEvents(now: number): void {
    const occurrences = this.ports.store.listPendingEventOccurrences(now, MAX_RECONCILE_ITEMS)
    if (occurrences.length === 0) return
    const enabledDefinitions = this.ports.store.listDefinitions(true)
    for (const occurrence of occurrences) {
      try {
        this.ports.store.transaction(() => {
          for (const definition of this.ports.service.matchingEventDefinitions(
            occurrence,
            enabledDefinitions
          )) {
            this.enqueue(definition, {
              kind: 'event',
              key: occurrence.id,
              occurredAt: occurrence.occurredAt
            })
          }
          if (!this.ports.store.markEventDelivered(occurrence.id, now)) {
            throw new Error('Automation event delivery changed concurrently.')
          }
        })
      } catch {
        const multiplier = 2 ** Math.min(occurrence.deliveryAttempts, 12)
        const retryDelayMs = Math.min(AUTOMATION_LIMITS.maxEventRetryDelayMs, 1_000 * multiplier)
        this.ports.store.recordEventDeliveryFailure(occurrence.id, now, now + retryDelayMs)
      }
    }
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
    const winner = this.ports.store.getRunByIdempotencyKey(definition.id, idempotencyKey)
    if (winner != null) return winner
    throw new Error('Automation run was not persisted and no idempotent winner exists.')
  }

  private async execute(
    definition: AutomationDefinition,
    pending: AutomationRun,
    holdSlotUntilSettled: (invocation: Promise<unknown>) => void
  ): Promise<void> {
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
    let activeTransferred = false
    const holdAttemptUntilSettled = (invocation: Promise<unknown>): void => {
      activeTransferred = true
      holdSlotUntilSettled(invocation)
      void invocation.then(
        () => this.releaseActiveAutomation(definition.id),
        () => this.releaseActiveAutomation(definition.id)
      )
    }

    try {
      await this.invokeAttempt(definition, run, requestId, controller, holdAttemptUntilSettled)
    } finally {
      automationControllers.delete(controller)
      if (automationControllers.size === 0) this.controllers.delete(definition.id)
      if (!activeTransferred) this.releaseActiveAutomation(definition.id)
    }
  }

  private releaseActiveAutomation(automationId: string): void {
    const active = (this.activeByAutomation.get(automationId) ?? 1) - 1
    if (active <= 0) this.activeByAutomation.delete(automationId)
    else this.activeByAutomation.set(automationId, active)
  }

  private async invokeAttempt(
    definition: AutomationDefinition,
    run: AutomationRun,
    requestId: string,
    controller: AbortController,
    holdSlotUntilSettled: (invocation: Promise<unknown>) => void
  ): Promise<void> {
    const auditId = this.generateId()
    const currentDefinition = this.ports.store.getDefinition(definition.id)
    const definitionForAttempt =
      currentDefinition?.enabled === true ? currentDefinition : definition
    const { result, error, resultCode, decision, description } = await this.runInvocation(
      definitionForAttempt,
      run,
      requestId,
      controller,
      holdSlotUntilSettled
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
        result: persistableAutomationResult(result),
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
    controller: AbortController,
    holdSlotUntilSettled: (invocation: Promise<unknown>) => void
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
        if (!invocationSettled) {
          this.lingeringRunIds.add(run.id)
          holdSlotUntilSettled(invocation)
        }
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
