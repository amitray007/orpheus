import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { AutomationGrantPolicy } from '../src/main/controlPlane/automationPolicy.ts'
import type { AutomationGrantRequest } from '../src/main/controlPlane/automationPolicy.ts'
import { createSafeAutomationGrantSource } from '../src/main/controlPlane/safeAutomationGrants.ts'
import { withAutomationPolicy } from '../src/main/controlPlane/automationPolicy.ts'
import { ControlRegistry } from '../src/main/controlPlane/registry.ts'
import type {
  ControlContext,
  ControlDescriptor,
  ControlPermission
} from '../src/main/controlPlane/types.ts'
import {
  RESOURCES_LIST_PROJECT_METADATA_ID,
  SETTINGS_GET_EFFECTIVE_ID
} from '../src/main/controlPlane/settingsResourceService.ts'
import { createAutomationAuditStore } from '../src/main/automations/audit.ts'
import {
  capturePhase8QaConfig,
  createPhase8QaController,
  parsePhase8QaArgs,
  phase8QaCredentialMatches, // gitleaks:allow -- symbol name, not a credential
  phase8QaGateEnabled
} from '../src/main/automations/phase8Qa.ts'
import { AutomationScheduler } from '../src/main/automations/scheduler.ts'
import { AutomationService } from '../src/main/automations/service.ts'
import { createAutomationStore } from '../src/main/automations/store.ts'
import type {
  AutomationAuditPort,
  AutomationClock,
  AutomationDefinition,
  AutomationDefinitionDraft,
  AutomationManagementContext,
  AutomationRun,
  AutomationStore
} from '../src/main/automations/types.ts'
import {
  wireWorkspaceAutomationEvents,
  WORKSPACE_COMPLETED_EVENT
} from '../src/main/automations/workspaceEvents.ts'
import { runMigrations } from '../src/main/db/cutover.ts'
import type { WorkspaceRecord, WorkspaceStatus } from '../src/shared/types.ts'

const db = new Database(':memory:')
db.exec('PRAGMA foreign_keys = ON')
runMigrations(db, { dbPath: ':memory:' })
const store = createAutomationStore(db)

let now = 10_000
let generated = 0
let timeoutNext = false
const clock: AutomationClock = {
  now: () => now,
  withTimeout: async (promise, _timeoutMs, controller) => {
    if (timeoutNext) {
      timeoutNext = false
      controller.abort()
      return { timedOut: true }
    }
    return new Promise((resolve, reject) => {
      const onAbort = (): void => resolve({ timedOut: true })
      if (controller.signal.aborted) {
        resolve({ timedOut: true })
        return
      }
      controller.signal.addEventListener('abort', onAbort, { once: true })
      promise.then(
        (value) => {
          controller.signal.removeEventListener('abort', onAbort)
          resolve({ timedOut: false, value })
        },
        (error: unknown) => {
          controller.signal.removeEventListener('abort', onAbort)
          reject(error)
        }
      )
    })
  }
}
const generateId = (): string => `automation-generated-${++generated}`

const basePolicy = {
  canDiscover: () => true,
  authorize: () => ({ allowed: true as const })
}
const registry = new ControlRegistry(withAutomationPolicy(basePolicy))
const invocations: ControlContext[] = []
let activeHandlers = 0
let maxActiveHandlers = 0
let releaseBlocked: (() => void) | null = null
let blockNext = false

const descriptor: ControlDescriptor<{ text: string }, Record<string, unknown>> = {
  id: 'test.projectMutation',
  version: 1,
  kind: 'mutation',
  description: 'Deterministic automation test mutation.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: { text: { type: 'string', minLength: 1 } }
  },
  outputSchema: { type: 'object' },
  allowedSurfaces: ['automation'],
  permission: 'reviews.resolve',
  scope: { kind: 'project', inputField: 'projectId' },
  risk: { tier: 2, label: 'write' },
  declaredEffects: ['db.write'],
  idempotency: 'keyed',
  validateInput: (input): input is { text: string } =>
    input != null &&
    typeof input === 'object' &&
    !Array.isArray(input) &&
    Object.keys(input).length === 1 &&
    typeof (input as Record<string, unknown>)['text'] === 'string',
  handler: async (_input, context) => {
    invocations.push(context)
    activeHandlers++
    maxActiveHandlers = Math.max(maxActiveHandlers, activeHandlers)
    try {
      if (blockNext) {
        blockNext = false
        await new Promise<void>((resolve) => {
          releaseBlocked = resolve
        })
      }
      return {
        token: 'must-not-appear-in-history',
        text: 'sensitive task result'
      }
    } finally {
      activeHandlers--
    }
  }
}
registry.register(descriptor)

const naturalDescriptor: ControlDescriptor<{ text: string }, { ok: true }> = {
  ...descriptor,
  id: 'test.naturalMutation',
  idempotency: 'natural',
  handler: async (_input, context) => {
    invocations.push(context)
    return { ok: true }
  }
}
registry.register(naturalDescriptor)

const noneDescriptor: ControlDescriptor<{ text: string }, { ok: true }> = {
  ...descriptor,
  id: 'test.nonIdempotentMutation',
  idempotency: 'none',
  handler: async (_input, context) => {
    invocations.push(context)
    return { ok: true }
  }
}
registry.register(noneDescriptor)

const permissions: ControlPermission[] = ['reviews.resolve']
const grantRequests: AutomationGrantRequest[] = []
const grants = new AutomationGrantPolicy((request) => {
  grantRequests.push(request)
  return {
    permissions,
    maxRiskTier: 2,
    scopes: [{ kind: 'project', projectId: 'project-1' }]
  }
})
const auditStore = createAutomationAuditStore(db)
let managementRequest = 0
const managementContext = (): AutomationManagementContext =>
  ({
    requestId: `management-request-${++managementRequest}`,
    principal: { type: 'renderer-user' as const, id: 'renderer-user-1' },
    consumer: 'renderer-ipc' as const
  }) satisfies AutomationManagementContext
const service = new AutomationService({
  store,
  registry,
  grants,
  audit: auditStore,
  allowedEventTypes: new Set(['workspace.completed']),
  now: () => now,
  generateId
})
const scheduler = new AutomationScheduler({
  store,
  service,
  registry,
  audit: auditStore,
  clock,
  generateId
})

// A failed recover/tick must not strand the scheduler in a false "started"
// state. The same instance can be started again after the transient failure.
let retryableStartRecoveries = 0
const retryableStartStore: AutomationStore = {
  ...store,
  markRunningInterrupted(recoveryNow) {
    retryableStartRecoveries++
    if (retryableStartRecoveries === 1) throw new Error('injected startup recovery failure')
    return store.markRunningInterrupted(recoveryNow)
  }
}
const retryableStartScheduler = new AutomationScheduler({
  store: retryableStartStore,
  service,
  registry,
  audit: auditStore,
  clock,
  generateId
})
await assert.rejects(() => retryableStartScheduler.start(), /startup recovery failure/)
await retryableStartScheduler.start()
retryableStartScheduler.stop()
assert.ok(retryableStartRecoveries >= 2)

function draft(overrides: Partial<AutomationDefinitionDraft> = {}): AutomationDefinitionDraft {
  return {
    name: 'Automation test',
    trigger: { kind: 'event', eventType: 'workspace.completed' },
    operationId: 'test.projectMutation',
    params: { text: 'sensitive task input' },
    scope: { kind: 'project', projectId: 'project-1' },
    enabled: true,
    idempotency: 'keyed',
    timeoutMs: 1_000,
    concurrencyLimit: 1,
    retry: {
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      maxElapsedMs: 10_000
    },
    rollingBudget: { windowMs: 1_000, maxStarts: 100 },
    ...overrides
  }
}

async function create(
  overrides: Partial<AutomationDefinitionDraft> = {}
): Promise<AutomationDefinition> {
  return service.createDefinition(draft(overrides), managementContext())
}

function persistedRun(automationId: string, index = 0): AutomationRun {
  const run = store.listRuns({ automationId, limit: 100 })[index]
  assert.ok(run)
  return run
}

// Declarative migration created the durable definitions, runs, and event
// outbox tables plus their critical indexes.
{
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name IN (
         'automation_definitions', 'automation_event_occurrences', 'automation_runs'
       ) ORDER BY name`
    )
    .all() as Array<{ name: string }>
  assert.deepEqual(
    tables.map(({ name }) => name),
    ['automation_definitions', 'automation_event_occurrences', 'automation_runs']
  )
  const indexes = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index'
       AND name LIKE 'idx_automation_%' ORDER BY name`
    )
    .all() as Array<{ name: string }>
  assert.ok(indexes.some(({ name }) => name === 'idx_automation_runs_idempotency'))
  assert.ok(indexes.some(({ name }) => name === 'idx_automation_event_occurrences_pending'))
}

// Strict definition validation rejects unknown events, extra operation params,
// descriptor/idempotency mismatch, and absence of a server-owned grant.
await assert.rejects(
  () => create({ trigger: { kind: 'event', eventType: 'external.webhook' } }),
  /not allowlisted/
)
const grantsBeforeInvalidParams = grantRequests.length
await assert.rejects(() => create({ params: { text: 'ok', shell: 'no' } }), /operation schema/)
assert.equal(
  grantRequests.length,
  grantsBeforeInvalidParams,
  'grant source must receive only schema-validated params'
)
await assert.rejects(
  () => create({ params: { text: 'ok', authToken: 'must-not-persist' } }),
  /secret-bearing/
)
await assert.rejects(() => create({ params: { text: 'token=must-not-persist' } }), /secret-bearing/)
await assert.rejects(() => create({ idempotency: 'natural' }), /must match/)
const deniedService = new AutomationService({
  store,
  registry,
  grants: new AutomationGrantPolicy(),
  audit: auditStore,
  allowedEventTypes: new Set(['workspace.completed']),
  now: () => now,
  generateId
})
await assert.rejects(
  () => deniedService.createDefinition(draft(), managementContext()),
  /No server-owned grant/
)

const workspaceOnlyGrant = new AutomationGrantPolicy(() => ({
  permissions,
  maxRiskTier: 2,
  scopes: [{ kind: 'workspace', projectId: 'project-1', workspaceId: 'workspace-1' }]
}))
assert.equal(
  await workspaceOnlyGrant.resolve(
    'scope-test',
    { kind: 'project', projectId: 'project-1' },
    registry.describe(descriptor.id)!
  ),
  null
)
const projectOnlyGrant = new AutomationGrantPolicy(() => ({
  permissions,
  maxRiskTier: 2,
  scopes: [{ kind: 'project', projectId: 'project-1' }]
}))
assert.equal(
  await projectOnlyGrant.resolve('scope-test', { kind: 'app' }, registry.describe(descriptor.id)!),
  null
)

const corruptedDefinition = await create({ enabled: false })
db.prepare('UPDATE automation_definitions SET timeout_ms = 1 WHERE id = ?').run(
  corruptedDefinition.id
)
await assert.rejects(
  () => service.setEnabled(corruptedDefinition.id, true, managementContext()),
  /timeout is outside/
)

const cleanupDefinition = await create({ enabled: false })
for (let index = 0; index < 3; index++) {
  assert.equal(
    store.insertRun({
      id: generateId(),
      automationId: cleanupDefinition.id,
      trigger: { kind: 'event', key: `cleanup-${index}`, occurredAt: index },
      idempotencyKey: `cleanup-key-${index}`,
      status: 'succeeded',
      attempt: 1,
      queuedAt: index,
      startedAt: index,
      finishedAt: index,
      nextAttemptAt: null,
      resultCode: 'completed',
      result: null,
      error: null,
      requestId: `cleanup-request-${index}`,
      auditId: null
    }),
    true
  )
}
store.pruneTerminalRuns(-1, 2)
assert.equal(store.listRuns({ automationId: cleanupDefinition.id, limit: 100 }).length, 2)

// One overdue schedule occurrence is enqueued per reconciliation; the next due
// time jumps past now instead of replaying every missed interval.
const scheduled = await create({
  trigger: { kind: 'schedule', intervalMs: 1_000, startAt: now - 10_000 }
})
await scheduler.tick()
assert.equal(store.listRuns({ automationId: scheduled.id, limit: 100 }).length, 1)
assert.equal(persistedRun(scheduled.id).status, 'succeeded')
assert.ok((store.getDefinition(scheduled.id)?.nextRunAt ?? 0) > now)
const firstContext = invocations.at(-1)
assert.equal(firstContext?.principal.type, 'automation')
assert.equal(firstContext?.trustedAutomation?.automationId, scheduled.id)
assert.equal(firstContext?.automationRunId, persistedRun(scheduled.id).id)
assert.equal(firstContext?.idempotencyKey, persistedRun(scheduled.id).idempotencyKey)

// A failed INSERT is only a dedupe win when the stable-key lookup finds the
// persisted winner. Never return or advance a schedule with a fabricated run.
const lostInsertDefinition = await create({
  trigger: { kind: 'schedule', intervalMs: 1_000, startAt: now }
})
const lostInsertStore: AutomationStore = {
  ...store,
  insertRun(run) {
    return run.automationId === lostInsertDefinition.id ? false : store.insertRun(run)
  },
  getRunByIdempotencyKey(automationId, idempotencyKey) {
    return automationId === lostInsertDefinition.id
      ? null
      : store.getRunByIdempotencyKey(automationId, idempotencyKey)
  }
}
const lostInsertScheduler = new AutomationScheduler({
  store: lostInsertStore,
  service,
  registry,
  audit: auditStore,
  clock,
  generateId
})
await assert.rejects(() => lostInsertScheduler.tick(), /not persisted and no idempotent winner/)
assert.equal(store.listRuns({ automationId: lostInsertDefinition.id, limit: 100 }).length, 0)
assert.equal(store.getDefinition(lostInsertDefinition.id)?.nextRunAt, now)
await scheduler.setEnabled(lostInsertDefinition.id, false, managementContext())

// Event scope filtering and stable-key dedupe: cross-project events do not run,
// and replaying the same server event id produces one logical run.
const eventDefinition = await create()
await scheduler.emitEvent({
  id: 'event-cross-project',
  type: 'workspace.completed',
  occurredAt: now,
  projectId: 'project-2'
})
assert.equal(store.listRuns({ automationId: eventDefinition.id, limit: 100 }).length, 0)
const event = {
  id: 'event-1',
  type: 'workspace.completed',
  occurredAt: now,
  projectId: 'project-1'
}
await scheduler.emitEvent(event)
await scheduler.emitEvent(event)
assert.equal(store.listRuns({ automationId: eventDefinition.id, limit: 100 }).length, 1)
await scheduler.setEnabled(eventDefinition.id, false, managementContext())

// The event occurrence is a real outbox: a source transaction rollback removes
// it, a delivery failure leaves it pending with bounded backoff, and a fresh
// scheduler replays it exactly once before invoking the handler.
const rolledBackEvent = {
  id: 'event-source-rollback',
  type: 'workspace.completed',
  occurredAt: now,
  projectId: 'project-1'
}
assert.throws(
  () =>
    store.transaction(() => {
      scheduler.persistEvent(rolledBackEvent)
      throw new Error('source write failed')
    }),
  /source write failed/
)
assert.equal(store.getEventOccurrence(rolledBackEvent.id), null)

const replayDefinition = await create()
const replayEvent = {
  id: 'event-crash-replay',
  type: 'workspace.completed',
  occurredAt: now,
  projectId: 'project-1'
}
scheduler.persistEvent(replayEvent)
let rejectFirstOutboxInsert = true
const failOnceStore: AutomationStore = {
  ...store,
  insertRun(run) {
    if (rejectFirstOutboxInsert) {
      rejectFirstOutboxInsert = false
      throw new Error('injected run materialization failure')
    }
    return store.insertRun(run)
  }
}
const failingDispatcher = new AutomationScheduler({
  store: failOnceStore,
  service,
  registry,
  audit: auditStore,
  clock,
  generateId
})
await failingDispatcher.drainEvents()
const deferredOccurrence = store.getEventOccurrence(replayEvent.id)
assert.equal(deferredOccurrence?.deliveredAt, null)
assert.equal(deferredOccurrence?.deliveryAttempts, 1)
assert.equal(store.listRuns({ automationId: replayDefinition.id, limit: 100 }).length, 0)
now = deferredOccurrence?.nextAttemptAt ?? now
const restartedScheduler = new AutomationScheduler({
  store,
  service,
  registry,
  audit: auditStore,
  clock,
  generateId
})
await restartedScheduler.start()
restartedScheduler.stop()
assert.ok(store.getEventOccurrence(replayEvent.id)?.deliveredAt != null)
assert.equal(store.listRuns({ automationId: replayDefinition.id, limit: 100 }).length, 1)
assert.equal(persistedRun(replayDefinition.id).status, 'succeeded')
await scheduler.setEnabled(replayDefinition.id, false, managementContext())
store.pruneDeliveredEventOccurrences(-1, 2)
const retainedDeliveredEvents = db
  .prepare(
    `SELECT COUNT(*) AS count FROM automation_event_occurrences
     WHERE delivered_at IS NOT NULL`
  )
  .get() as { count: number }
assert.ok(retainedDeliveredEvents.count <= 2)

// Timeout retry retains one logical run and one idempotency key. The second
// attempt succeeds after deterministic exponential backoff.
const retryDefinition = await create({
  operationId: 'test.naturalMutation',
  idempotency: 'natural'
})
timeoutNext = true
await scheduler.emitEvent({
  id: 'event-retry',
  type: 'workspace.completed',
  occurredAt: now,
  projectId: 'project-1'
})
let retryRun = persistedRun(retryDefinition.id)
assert.equal(retryRun.status, 'retry_wait')
assert.equal(retryRun.attempt, 1)
const stableRetryKey = retryRun.idempotencyKey
now = retryRun.nextAttemptAt ?? now
await scheduler.tick()
retryRun = persistedRun(retryDefinition.id)
assert.equal(retryRun.status, 'succeeded')
assert.equal(retryRun.attempt, 2)
assert.equal(retryRun.idempotencyKey, stableRetryKey)
await scheduler.setEnabled(retryDefinition.id, false, managementContext())

// Per-run attempt budget terminates retries deterministically.
const exhaustedDefinition = await create({
  operationId: 'test.naturalMutation',
  idempotency: 'natural',
  retry: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 100, maxElapsedMs: 1_000 }
})
timeoutNext = true
await scheduler.emitEvent({
  id: 'event-exhausted',
  type: 'workspace.completed',
  occurredAt: now,
  projectId: 'project-1'
})
assert.equal(persistedRun(exhaustedDefinition.id).status, 'budget_exhausted')
await scheduler.setEnabled(exhaustedDefinition.id, false, managementContext())

// Rolling budget defers the second distinct occurrence without consuming an
// attempt, then executes it after the persisted window.
const rollingDefinition = await create({
  rollingBudget: { windowMs: 1_000, maxStarts: 1 }
})
await scheduler.emitEvent({
  id: 'event-budget-1',
  type: 'workspace.completed',
  occurredAt: now,
  projectId: 'project-1'
})
await scheduler.emitEvent({
  id: 'event-budget-2',
  type: 'workspace.completed',
  occurredAt: now,
  projectId: 'project-1'
})
let rollingRuns = store.listRuns({ automationId: rollingDefinition.id, limit: 100 })
assert.equal(rollingRuns[1]?.status, 'retry_wait')
assert.equal(rollingRuns[1]?.attempt, 0)
now += 1_001
await scheduler.tick()
rollingRuns = store.listRuns({ automationId: rollingDefinition.id, limit: 100 })
assert.equal(rollingRuns[1]?.status, 'succeeded')
await scheduler.setEnabled(rollingDefinition.id, false, managementContext())

// A timed-out non-cooperative handler blocks a retry of the same logical run
// until the prior invocation actually settles.
const lingeringDefinition = await create()
blockNext = true
releaseBlocked = null
timeoutNext = true
await scheduler.emitEvent({
  id: 'event-lingering-timeout',
  type: 'workspace.completed',
  occurredAt: now,
  projectId: 'project-1'
})
let lingeringRun = persistedRun(lingeringDefinition.id)
assert.equal(lingeringRun.status, 'retry_wait')
now = lingeringRun.nextAttemptAt ?? now
await scheduler.tick()
lingeringRun = persistedRun(lingeringDefinition.id)
assert.equal(lingeringRun.attempt, 1)
assert.ok(releaseBlocked)
releaseBlocked()
await new Promise<void>((resolve) => setImmediate(resolve))
await scheduler.tick()
assert.equal(persistedRun(lingeringDefinition.id).status, 'succeeded')
await scheduler.setEnabled(lingeringDefinition.id, false, managementContext())

// A concurrent tick cannot exceed a definition's concurrency limit. The second
// event stays queued until the first handler releases.
const concurrentDefinition = await create()
blockNext = true
releaseBlocked = null
const firstEventPromise = scheduler.emitEvent({
  id: 'event-concurrency-1',
  type: 'workspace.completed',
  occurredAt: now,
  projectId: 'project-1'
})
await Promise.resolve()
const secondEventPromise = scheduler.emitEvent({
  id: 'event-concurrency-2',
  type: 'workspace.completed',
  occurredAt: now,
  projectId: 'project-1'
})
for (let spin = 0; spin < 20 && releaseBlocked == null; spin++) {
  await new Promise<void>((resolve) => setImmediate(resolve))
}
assert.equal(maxActiveHandlers, 1)
assert.ok(releaseBlocked)
releaseBlocked()
await Promise.all([firstEventPromise, secondEventPromise])
await scheduler.tick()
assert.equal(maxActiveHandlers, 1)
assert.deepEqual(
  store.listRuns({ automationId: concurrentDefinition.id, limit: 100 }).map(({ status }) => status),
  ['succeeded', 'succeeded']
)
await scheduler.setEnabled(concurrentDefinition.id, false, managementContext())

// Disable aborts a running attempt and records cancellation, then also cancels
// persisted pending/retry work. It does not fabricate rollback.
const runningDisableDefinition = await create()
blockNext = true
releaseBlocked = null
const runningDisable = scheduler.emitEvent({
  id: 'event-disable-running',
  type: 'workspace.completed',
  occurredAt: now,
  projectId: 'project-1'
})
for (let spin = 0; spin < 20 && releaseBlocked == null; spin++) {
  await new Promise<void>((resolve) => setImmediate(resolve))
}
assert.ok(releaseBlocked)
await scheduler.setEnabled(runningDisableDefinition.id, false, managementContext())
await runningDisable
assert.equal(persistedRun(runningDisableDefinition.id).status, 'cancelled')
releaseBlocked()
await new Promise<void>((resolve) => setImmediate(resolve))

const disableDefinition = await create({
  operationId: 'test.naturalMutation',
  idempotency: 'natural'
})
timeoutNext = true
await scheduler.emitEvent({
  id: 'event-disable',
  type: 'workspace.completed',
  occurredAt: now,
  projectId: 'project-1'
})
assert.equal(persistedRun(disableDefinition.id).status, 'retry_wait')
await scheduler.setEnabled(disableDefinition.id, false, managementContext())
assert.equal(persistedRun(disableDefinition.id).status, 'cancelled')

// Enabled state, next schedule, and pending cancellation are one transaction;
// a stale compare-and-swap cannot overwrite the transition.
const atomicDisableDefinition = await create({
  trigger: { kind: 'schedule', intervalMs: 1_000, startAt: now + 10_000 }
})
assert.equal(
  store.insertRun({
    id: generateId(),
    automationId: atomicDisableDefinition.id,
    trigger: { kind: 'schedule', key: String(now + 10_000), occurredAt: now + 10_000 },
    idempotencyKey: 'atomic-disable-key',
    status: 'queued',
    attempt: 0,
    queuedAt: now,
    startedAt: null,
    finishedAt: null,
    nextAttemptAt: null,
    resultCode: null,
    result: null,
    error: null,
    requestId: null,
    auditId: null
  }),
  true
)
await scheduler.setEnabled(atomicDisableDefinition.id, false, managementContext())
assert.equal(store.getDefinition(atomicDisableDefinition.id)?.nextRunAt, null)
assert.equal(persistedRun(atomicDisableDefinition.id).status, 'cancelled')
assert.equal(
  store.setDefinitionEnabled(
    atomicDisableDefinition.id,
    true,
    atomicDisableDefinition.updatedAt,
    true,
    now,
    now + 1_000
  ),
  false
)

// Restart recovery never replays non-idempotent interrupted work. Natural and
// keyed work is retryable only with the original stable key and remaining
// budgets.
const noneDefinition = await create({
  operationId: 'test.nonIdempotentMutation',
  idempotency: 'none'
})
const keyedRecoveryDefinition = await create()
const interruptedNone: AutomationRun = {
  id: generateId(),
  automationId: noneDefinition.id,
  trigger: { kind: 'event', key: 'restart-none', occurredAt: now },
  idempotencyKey: 'stable-none-key',
  status: 'running',
  attempt: 1,
  queuedAt: now - 100,
  startedAt: now - 50,
  finishedAt: null,
  nextAttemptAt: null,
  resultCode: null,
  result: null,
  error: null,
  requestId: 'old-request-none',
  auditId: null
}
const interruptedKeyed: AutomationRun = {
  ...interruptedNone,
  id: generateId(),
  automationId: keyedRecoveryDefinition.id,
  trigger: { kind: 'event', key: 'restart-keyed', occurredAt: now },
  idempotencyKey: 'stable-keyed-key',
  requestId: 'old-request-keyed'
}
assert.equal(store.insertRun(interruptedNone), true)
assert.equal(store.insertRun(interruptedKeyed), true)
await scheduler.recover()
assert.equal(store.getRun(interruptedNone.id)?.status, 'interrupted')
assert.equal(store.getRun(interruptedKeyed.id)?.status, 'retry_wait')
now = store.getRun(interruptedKeyed.id)?.nextAttemptAt ?? now
await scheduler.tick()
assert.equal(store.getRun(interruptedKeyed.id)?.status, 'succeeded')
assert.equal(store.getRun(interruptedKeyed.id)?.idempotencyKey, 'stable-keyed-key')

// Audit and run history correlate each attempt while recursively redacting
// params/results. No raw task text or token survives.
const auditRows = db
  .prepare(
    `SELECT redacted_params_json, correlation_json FROM control_audit
     WHERE consumer = 'automation'`
  )
  .all() as Array<{ redacted_params_json: string; correlation_json: string }>
assert.ok(auditRows.length >= 1)
for (const row of auditRows) {
  assert.doesNotMatch(row.redacted_params_json, /sensitive task input/)
  assert.doesNotMatch(row.correlation_json, /must-not-appear-in-history|sensitive task result/)
  const correlation = JSON.parse(row.correlation_json) as Record<string, unknown>
  assert.equal(typeof correlation['automationId'], 'string')
  assert.equal(typeof correlation['runId'], 'string')
  assert.equal(typeof correlation['idempotencyKey'], 'string')
}
const storedResultJson = db
  .prepare(`SELECT result_json FROM automation_runs WHERE result_json IS NOT NULL LIMIT 1`)
  .get() as { result_json: string }
assert.doesNotMatch(
  storedResultJson.result_json,
  /must-not-appear-in-history|sensitive task result/
)

// Definition creation and enable/disable changes emit durable management audit
// rows with truthful outcome and request/definition/principal correlation.
const managementRows = db
  .prepare(
    `SELECT operation_id, request_id, decision, result_code,
            redacted_params_json, receipts_json, correlation_json
     FROM control_audit
     WHERE operation_id IN ('automations.createDefinition', 'automations.setEnabled')
     ORDER BY occurred_at ASC, rowid ASC`
  )
  .all() as Array<{
  operation_id: string
  request_id: string
  decision: string
  result_code: string
  redacted_params_json: string
  receipts_json: string
  correlation_json: string
}>
assert.ok(
  managementRows.some(
    ({ operation_id, decision, result_code }) =>
      operation_id === 'automations.createDefinition' &&
      decision === 'allow' &&
      result_code === 'completed'
  )
)
assert.ok(
  managementRows.some(
    ({ operation_id, decision, result_code, receipts_json }) =>
      operation_id === 'automations.createDefinition' &&
      decision === 'deny' &&
      result_code === 'invalid' &&
      receipts_json.includes('"status":"skipped"')
  )
)
assert.ok(
  managementRows.some(
    ({ operation_id, result_code, receipts_json }) =>
      operation_id === 'automations.setEnabled' &&
      result_code === 'completed' &&
      receipts_json.includes('"status":"applied"')
  )
)
for (const row of managementRows) {
  assert.match(row.request_id, /^management-request-/)
  assert.doesNotMatch(row.redacted_params_json, /must-not-persist|sensitive task input/)
  const correlation = JSON.parse(row.correlation_json) as Record<string, unknown>
  assert.equal(correlation['requestId'], row.request_id)
  assert.equal(typeof correlation['definitionId'], 'string')
  assert.equal(correlation['principalId'], 'renderer-user-1')
  assert.equal(correlation['principalType'], 'renderer-user')
}

// State and completed audit share one SQLite transaction. An audit write
// failure rolls creation or enablement back rather than leaving unaudited state.
let rejectManagementAudit = false
const injectedAudit: AutomationAuditPort = {
  appendAttempt: (input) => auditStore.appendAttempt(input),
  appendManagement: (input) => {
    if (rejectManagementAudit) throw new Error('injected management audit failure')
    auditStore.appendManagement(input)
  }
}
const rollbackService = new AutomationService({
  store,
  registry,
  grants,
  audit: injectedAudit,
  allowedEventTypes: new Set(['workspace.completed']),
  now: () => now,
  generateId
})
const definitionsBeforeAuditFailure = store.listDefinitions().length
rejectManagementAudit = true
await assert.rejects(
  () => rollbackService.createDefinition(draft({ enabled: false }), managementContext()),
  /audit could not be persisted/
)
assert.equal(store.listDefinitions().length, definitionsBeforeAuditFailure)
rejectManagementAudit = false
const rollbackEnableDefinition = await rollbackService.createDefinition(
  draft({ enabled: false }),
  managementContext()
)
rejectManagementAudit = true
await assert.rejects(
  () => rollbackService.setEnabled(rollbackEnableDefinition.id, true, managementContext()),
  /audit could not be persisted/
)
assert.equal(store.getDefinition(rollbackEnableDefinition.id)?.enabled, false)
rejectManagementAudit = false

// The Phase 8 seam exposes only the two fixed Tier-0 Phase 6 reads, and the
// authenticated Dev fixture can create/manage only its bounded definitions.
const fixedReadDescriptor = (
  id: typeof SETTINGS_GET_EFFECTIVE_ID | typeof RESOURCES_LIST_PROJECT_METADATA_ID
): ControlDescriptor<Record<string, string>, Record<string, unknown>> => ({
  id,
  version: 1,
  kind: 'query',
  description: 'Fixed Phase 8 read.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: { type: 'object', additionalProperties: false, properties: {} },
  allowedSurfaces: ['mcp', 'automation'],
  permission: id === SETTINGS_GET_EFFECTIVE_ID ? 'settings.read' : 'resources.read',
  scope:
    id === SETTINGS_GET_EFFECTIVE_ID
      ? { kind: 'workspace', inputField: 'workspaceId' }
      : { kind: 'project', inputField: 'projectId' },
  risk: { tier: 0, label: 'read' },
  declaredEffects: [],
  idempotency: 'natural',
  validateInput: (input): input is Record<string, string> => {
    if (input == null || typeof input !== 'object' || Array.isArray(input)) return false
    const record = input as Record<string, unknown>
    const field = id === SETTINGS_GET_EFFECTIVE_ID ? 'workspaceId' : 'projectId'
    return (
      Object.keys(record).length === 1 && typeof record[field] === 'string' && record[field] !== ''
    )
  },
  handler: (_input, context) => ({
    operationId: id,
    requestId: context.requestId
  })
})
registry.register(fixedReadDescriptor(SETTINGS_GET_EFFECTIVE_ID))
registry.register(fixedReadDescriptor(RESOURCES_LIST_PROJECT_METADATA_ID))
const qaWorkspace = {
  id: 'workspace-1',
  projectId: 'project-1',
  name: 'QA',
  cwd: '/qa'
} as WorkspaceRecord
const otherQaWorkspace = {
  ...qaWorkspace,
  id: 'workspace-2',
  name: 'Other QA'
} as WorkspaceRecord
const qaGrants = new AutomationGrantPolicy(
  createSafeAutomationGrantSource({
    getProject: (projectId) => (projectId === qaWorkspace.projectId ? { id: projectId } : null),
    getWorkspace: (workspaceId) =>
      [qaWorkspace, otherQaWorkspace].find(({ id }) => id === workspaceId) ?? null
  })
)
const qaService = new AutomationService({
  store,
  registry,
  grants: qaGrants,
  audit: auditStore,
  allowedEventTypes: new Set([WORKSPACE_COMPLETED_EVENT]),
  now: () => now,
  generateId
})
const qaScheduler = new AutomationScheduler({
  store,
  service: qaService,
  registry,
  audit: auditStore,
  clock,
  generateId
})
const qaCredential = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijk'
const qaEnv: Record<string, string | undefined> = {
  ORPHEUS_PHASE8_QA: '1',
  ORPHEUS_PHASE8_QA_WORKSPACE_ID: qaWorkspace.id,
  ORPHEUS_PHASE8_QA_TOKEN: qaCredential
}
const qaConfig = capturePhase8QaConfig(qaEnv, 'Orpheus Dev')
assert.ok(qaConfig)
assert.deepEqual(qaEnv, {})
assert.equal(qaConfig.workspaceId, qaWorkspace.id)
assert.match(qaConfig.principalId, /^phase8-qa:[a-f0-9]{16}$/)
assert.doesNotMatch(qaConfig.principalId, new RegExp(qaCredential))
assert.equal(phase8QaCredentialMatches(qaCredential, qaCredential), true)
assert.equal(phase8QaCredentialMatches('wrong', qaCredential), false)
assert.equal(phase8QaCredentialMatches(undefined, qaCredential), false)
const weakQaEnv: Record<string, string | undefined> = {
  ORPHEUS_PHASE8_QA: '1',
  ORPHEUS_PHASE8_QA_WORKSPACE_ID: qaWorkspace.id,
  ORPHEUS_PHASE8_QA_TOKEN: 'too-short'
}
assert.equal(capturePhase8QaConfig(weakQaEnv, 'Orpheus Dev'), null)
assert.deepEqual(weakQaEnv, {})

const qa = createPhase8QaController({
  service: qaService,
  scheduler: qaScheduler,
  getWorkspace: (workspaceId) =>
    [qaWorkspace, otherQaWorkspace].find(({ id }) => id === workspaceId) ?? null,
  targetWorkspaceId: qaConfig.workspaceId,
  principalId: qaConfig.principalId,
  generateId
})
assert.equal(phase8QaGateEnabled('1', 'Orpheus Dev'), true)
assert.equal(phase8QaGateEnabled('1', 'Orpheus'), false)
assert.equal(phase8QaGateEnabled(undefined, 'Orpheus Dev'), false)
assert.equal(
  parsePhase8QaArgs({
    fixtureAction: 'createSchedule',
    workspaceId: qaWorkspace.id
  }),
  null
)
assert.equal(parsePhase8QaArgs({ fixtureAction: 'enable', definitionId: 'qa', params: {} }), null)

const [qaSchedule, reusedQaSchedule] = await Promise.all([
  qa.execute({ fixtureAction: 'createSchedule' }),
  qa.execute({ fixtureAction: 'createSchedule' })
])
assert.ok(qaSchedule.definition)
const qaScheduleId = qaSchedule.definition.id
assert.equal(qaSchedule.definition.workspaceId, qaWorkspace.id)
assert.equal(qaSchedule.definition.operationId, SETTINGS_GET_EFFECTIVE_ID)
assert.equal(qaSchedule.definition.enabled, false)
assert.equal(reusedQaSchedule.definition?.id, qaScheduleId)
assert.equal(reusedQaSchedule.reused, true)
assert.equal(
  qaService
    .listDefinitions()
    .filter(
      (definition) =>
        definition.operationId === SETTINGS_GET_EFFECTIVE_ID &&
        definition.scope.kind === 'workspace' &&
        definition.scope.workspaceId === qaWorkspace.id
    ).length,
  1
)
const enabledQaSchedule = await qa.execute({
  fixtureAction: 'enable',
  definitionId: qaScheduleId
})
assert.equal(enabledQaSchedule.definition?.enabled, true)
now += 1_001
await qaScheduler.tick()
now += 1_001
await qaScheduler.tick()
const qaScheduleStatus = await qa.execute({
  fixtureAction: 'status',
  definitionId: qaScheduleId
})
assert.equal(qaScheduleStatus.runs?.length, 2)
assert.equal(qaScheduleStatus.runs?.[0]?.status, 'succeeded')
const recentScheduleRuns = store.listRuns({
  automationId: qaScheduleId,
  order: 'recent',
  limit: 50
})
assert.deepEqual(
  qaScheduleStatus.runs?.map(({ id }) => id),
  recentScheduleRuns.map(({ id }) => id)
)
await qa.execute({
  fixtureAction: 'disable',
  definitionId: qaScheduleId
})

const otherQa = createPhase8QaController({
  service: qaService,
  scheduler: qaScheduler,
  getWorkspace: (workspaceId) =>
    [qaWorkspace, otherQaWorkspace].find(({ id }) => id === workspaceId) ?? null,
  targetWorkspaceId: otherQaWorkspace.id,
  principalId: 'phase8-qa:otherprincipal',
  generateId
})
const otherFixture = await otherQa.execute({ fixtureAction: 'createSchedule' })
assert.ok(otherFixture.definition)
await assert.rejects(
  () => qa.execute({ fixtureAction: 'status', definitionId: otherFixture.definition!.id }),
  /not a fixed Phase 8 QA fixture/
)

const qaEvent = await qa.execute({ fixtureAction: 'createEvent' })
assert.ok(qaEvent.definition)
const qaEventId = qaEvent.definition.id
await qa.execute({ fixtureAction: 'enable', definitionId: qaEventId })
let committedObserver:
  | ((
      workspaceId: string,
      oldStatus: WorkspaceStatus | undefined,
      newStatus: WorkspaceStatus
    ) => void)
  | null = null
let persistingObserver:
  | ((
      workspaceId: string,
      oldStatus: WorkspaceStatus,
      newStatus: WorkspaceStatus,
      workspace: WorkspaceRecord
    ) => void)
  | null = null
const disposeWorkspaceEvents = wireWorkspaceAutomationEvents({
  scheduler: qaScheduler,
  subscribePersisting: (observer) => {
    persistingObserver = observer
    return () => {
      persistingObserver = null
    }
  },
  subscribeCommitted: (observer) => {
    committedObserver = observer
    return () => {
      committedObserver = null
    }
  },
  now: () => now,
  generateId
})
assert.ok(persistingObserver)
assert.ok(committedObserver)
persistingObserver(qaWorkspace.id, 'idle', 'awaiting_input', qaWorkspace)
committedObserver(qaWorkspace.id, 'idle', 'awaiting_input')
await new Promise<void>((resolve) => setImmediate(resolve))
assert.equal(qaService.listRuns(qaEventId).length, 0)
store.transaction(() => {
  persistingObserver?.(qaWorkspace.id, 'in_progress', 'awaiting_input', qaWorkspace)
})
const pendingQaOccurrence = db
  .prepare(
    `SELECT id, delivered_at FROM automation_event_occurrences
     WHERE workspace_id = ? AND delivered_at IS NULL
     ORDER BY created_at DESC LIMIT 1`
  )
  .get(qaWorkspace.id) as { id: string; delivered_at: number | null }
assert.equal(pendingQaOccurrence.delivered_at, null)
committedObserver(qaWorkspace.id, 'in_progress', 'awaiting_input')
await new Promise<void>((resolve) => setImmediate(resolve))
await qaScheduler.tick()
assert.equal(qaService.listRuns(qaEventId).length, 1)
disposeWorkspaceEvents()
const qaEventStatus = await qa.execute({ fixtureAction: 'status', definitionId: qaEventId })
const correlatedRun = qaEventStatus.runs?.[0]
assert.ok(correlatedRun?.auditId)
const correlatedAudit = db
  .prepare('SELECT correlation_json FROM control_audit WHERE audit_id = ?')
  .get(correlatedRun.auditId) as { correlation_json: string }
assert.equal(
  (JSON.parse(correlatedAudit.correlation_json) as Record<string, unknown>)['runId'],
  correlatedRun.id
)
await qa.execute({ fixtureAction: 'disable', definitionId: qaEventId })
const cleanupResult = await qa.execute({ fixtureAction: 'cleanup' })
assert.deepEqual(new Set(cleanupResult.cleanedDefinitionIds), new Set([qaScheduleId, qaEventId]))
assert.equal(store.getDefinition(qaScheduleId), null)
assert.equal(store.getDefinition(qaEventId), null)
assert.ok(store.getDefinition(otherFixture.definition.id))

const qaManagementRows = db
  .prepare(
    `SELECT operation_id, principal_kind, consumer, decision, result_code, correlation_json
     FROM control_audit
     WHERE operation_id IN (
       'automations.createDefinition', 'automations.setEnabled', 'automations.deleteDefinition'
     )
       AND principal_kind = 'cli'`
  )
  .all() as Array<{
  operation_id: string
  principal_kind: string
  consumer: string
  decision: string
  result_code: string
  correlation_json: string
}>
assert.ok(qaManagementRows.length >= 6)
assert.ok(
  qaManagementRows.some(
    ({ operation_id, decision, result_code, correlation_json }) =>
      operation_id === 'automations.deleteDefinition' &&
      decision === 'allow' &&
      result_code === 'completed' &&
      cleanupResult.cleanedDefinitionIds?.includes(
        String((JSON.parse(correlation_json) as Record<string, unknown>)['definitionId'])
      ) === true
  ),
  'Phase 8 cleanup must persist an exact successful delete-definition audit'
)
for (const row of qaManagementRows) {
  assert.equal(row.consumer, 'cli')
  const correlation = JSON.parse(row.correlation_json) as Record<string, unknown>
  if (correlation['principalId'] !== 'phase8-qa:otherprincipal') {
    assert.equal(correlation['principalId'], qaConfig.principalId)
  }
  assert.equal(typeof correlation['definitionId'], 'string')
  assert.equal(typeof correlation['requestId'], 'string')
}

// Static architectural guard: the subsystem has no child-process, command
// socket, renderer selector, click, or key-simulation dependency.
const moduleNames = [
  '../src/main/automations/service.ts',
  '../src/main/automations/scheduler.ts',
  '../src/main/automations/store.ts'
]
for (const moduleName of moduleNames) {
  const source = await import('node:fs/promises').then(({ readFile }) =>
    readFile(new URL(moduleName, import.meta.url), 'utf8')
  )
  assert.doesNotMatch(
    source,
    /child_process|commandServer|querySelector|webContents|sendKeys|click\(/
  )
}

console.log('✓ durable automations')
