import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { AutomationGrantPolicy } from '../src/main/controlPlane/automationPolicy.ts'
import type { AutomationGrantRequest } from '../src/main/controlPlane/automationPolicy.ts'
import { withAutomationPolicy } from '../src/main/controlPlane/automationPolicy.ts'
import { ControlRegistry } from '../src/main/controlPlane/registry.ts'
import type {
  ControlContext,
  ControlDescriptor,
  ControlPermission
} from '../src/main/controlPlane/types.ts'
import { createAutomationAuditStore } from '../src/main/automations/audit.ts'
import { persistableAutomationResult } from '../src/main/automations/resultPersistence.ts'
import { AutomationScheduler } from '../src/main/automations/scheduler.ts'
import { AutomationService } from '../src/main/automations/service.ts'
import { createAutomationStore } from '../src/main/automations/store.ts'
import {
  AUTOMATION_LIMITS,
  type AutomationAuditPort,
  type AutomationClock,
  type AutomationDefinition,
  type AutomationDefinitionDraft,
  type AutomationManagementContext,
  type AutomationRun,
  type AutomationStore
} from '../src/main/automations/types.ts'
import { wireWorkspaceAutomationEvents } from '../src/main/automations/workspaceEvents.ts'
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

const oversizedPayload = {
  rows: Array.from({ length: 256 }, (_, index) => ({
    index,
    payload: 'x'.repeat(512)
  }))
}
const oversizedDescriptor: ControlDescriptor<{ text: string }, typeof oversizedPayload> = {
  ...descriptor,
  id: 'test.oversizedResult',
  idempotency: 'natural',
  handler: async (_input, context) => {
    invocations.push(context)
    return oversizedPayload
  }
}
registry.register(oversizedDescriptor)

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

// Successful results are redacted before measurement and persisted within a
// strict byte ceiling. Oversized values produce deterministic metadata rather
// than invalid, partially sliced JSON.
const boundedResult = persistableAutomationResult(oversizedPayload)
assert.ok(
  Buffer.byteLength(JSON.stringify(boundedResult), 'utf8') <=
    AUTOMATION_LIMITS.maxPersistedResultBytes
)
assert.deepEqual(boundedResult, persistableAutomationResult(oversizedPayload))
const boundedReceipt = boundedResult['value'] as Record<string, unknown>
assert.equal(boundedReceipt['truncated'], true)
assert.equal(boundedReceipt['reason'], 'persisted_result_safety_limit')
assert.equal(boundedReceipt['stoppedBy'], 'container_item_limit')
assert.equal(boundedReceipt['maxBytes'], AUTOMATION_LIMITS.maxPersistedResultBytes - 10)
assert.match(String(boundedReceipt['sha256']), /^[a-f0-9]{64}$/)
assert.deepEqual(persistableAutomationResult({ token: 'secret', ok: true }), {
  value: { token: '[REDACTED]', ok: true }
})
const secretBearingKeyResult = persistableAutomationResult({
  'token=must-never-persist': 'hidden'
})
assert.equal(
  (secretBearingKeyResult['value'] as Record<string, unknown>)['stoppedBy'],
  'secret_bearing_key'
)
assert.doesNotMatch(JSON.stringify(secretBearingKeyResult), /must-never-persist/)

const hugeStringSecret = `token=must-never-persist ${'x'.repeat(2 * 1_024 * 1_024)}`
const hugeStringResult = persistableAutomationResult({ payload: hugeStringSecret })
assert.equal(
  (hugeStringResult['value'] as Record<string, unknown>)['stoppedBy'],
  'string_length_limit'
)
assert.doesNotMatch(JSON.stringify(hugeStringResult), /must-never-persist/)

const hugeSparseArray: unknown[] = []
hugeSparseArray.length = 1_000_000_000
assert.equal(
  (persistableAutomationResult(hugeSparseArray)['value'] as Record<string, unknown>)['stoppedBy'],
  'container_item_limit'
)

const highCardinality: Record<string, number> = {}
for (let index = 0; index < 1_000; index++) highCardinality[`field-${index}`] = index
const highCardinalityResult = persistableAutomationResult(highCardinality)
assert.equal(
  (highCardinalityResult['value'] as Record<string, unknown>)['stoppedBy'],
  'container_item_limit'
)
assert.deepEqual(highCardinalityResult, persistableAutomationResult(highCardinality))

const deepResult: Record<string, unknown> = {}
let deepCursor = deepResult
for (let depth = 0; depth < 32; depth++) {
  const next: Record<string, unknown> = {}
  deepCursor['next'] = next
  deepCursor = next
}
assert.equal(
  (persistableAutomationResult(deepResult)['value'] as Record<string, unknown>)['stoppedBy'],
  'depth_limit'
)

const cyclicResult: Record<string, unknown> = { ok: true }
cyclicResult['self'] = cyclicResult
assert.deepEqual(persistableAutomationResult(cyclicResult), {
  value: { ok: true, self: '[CIRCULAR]' }
})
assert.deepEqual(persistableAutomationResult({ count: 2n ** 4_096n }), {
  value: { count: '[bigint]' }
})

let getterReads = 0
const accessorResult: Record<string, unknown> = {}
Object.defineProperty(accessorResult, 'payload', {
  enumerable: true,
  get() {
    getterReads++
    return hugeStringSecret
  }
})
const boundedAccessorResult = persistableAutomationResult(accessorResult)
assert.equal(getterReads, 0, 'result persistence must never invoke accessors')
assert.equal(
  (boundedAccessorResult['value'] as Record<string, unknown>)['stoppedBy'],
  'accessor_property'
)
assert.doesNotMatch(JSON.stringify(boundedAccessorResult), /must-never-persist/)

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
  assert.ok(indexes.some(({ name }) => name === 'idx_automation_runs_automation_started'))
  assert.ok(indexes.some(({ name }) => name === 'idx_automation_runs_automation_runnable'))
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
const cappedDefinitionService = new AutomationService({
  store: {
    ...store,
    countDefinitions: () => AUTOMATION_LIMITS.maxDefinitions
  },
  registry,
  grants,
  audit: auditStore,
  allowedEventTypes: new Set(['workspace.completed']),
  now: () => now,
  generateId
})
await assert.rejects(
  () => cappedDefinitionService.createDefinition(draft(), managementContext()),
  /definition limit reached/
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

// Future retries cannot consume the reconciliation LIMIT ahead of ready work.
// This guards the due predicate's placement inside SQL rather than filtering
// an already-limited result set in memory.
const starvationDefinition = await create({ enabled: false })
for (let index = 0; index < 200; index++) {
  assert.equal(
    store.insertRun({
      id: generateId(),
      automationId: starvationDefinition.id,
      trigger: { kind: 'event', key: `future-${index}`, occurredAt: index },
      idempotencyKey: `future-key-${index}`,
      status: 'retry_wait',
      attempt: 1,
      queuedAt: index,
      startedAt: index,
      finishedAt: null,
      nextAttemptAt: now + 1_000_000_000,
      resultCode: 'timeout',
      result: null,
      error: null,
      requestId: `future-request-${index}`,
      auditId: null
    }),
    true
  )
}
const readyRunId = generateId()
assert.equal(
  store.insertRun({
    id: readyRunId,
    automationId: starvationDefinition.id,
    trigger: { kind: 'event', key: 'ready', occurredAt: now },
    idempotencyKey: 'ready-key',
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
assert.deepEqual(
  store.listRunnableRunsForAutomation(starvationDefinition.id, now, 10).map(({ id }) => id),
  [readyRunId]
)
db.prepare('DELETE FROM automation_runs WHERE automation_id = ?').run(starvationDefinition.id)

// Candidate selection is fair across definitions. More than one full legacy
// reconciliation page of old work from one definition cannot hide another
// definition's ready run indefinitely.
const noisyDefinition = await create()
const quietDefinition = await create()
for (let index = 0; index < 201; index++) {
  assert.equal(
    store.insertRun({
      id: generateId(),
      automationId: noisyDefinition.id,
      trigger: { kind: 'event', key: `noisy-${index}`, occurredAt: index },
      idempotencyKey: `noisy-key-${index}`,
      status: 'queued',
      attempt: 0,
      queuedAt: index,
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
}
const quietRunId = generateId()
assert.equal(
  store.insertRun({
    id: quietRunId,
    automationId: quietDefinition.id,
    trigger: { kind: 'event', key: 'quiet', occurredAt: now },
    idempotencyKey: 'quiet-key',
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
const fairScheduler = new AutomationScheduler({
  store,
  service,
  registry,
  audit: auditStore,
  clock,
  generateId,
  maxGlobalConcurrency: 1
})
await fairScheduler.tick()
await fairScheduler.tick()
assert.equal(store.getRun(quietRunId)?.status, 'succeeded')
await fairScheduler.setEnabled(noisyDefinition.id, false, managementContext())
await fairScheduler.setEnabled(quietDefinition.id, false, managementContext())

// A scheduled reconciliation queued just before shutdown must re-check the
// scheduler lifecycle inside its microtask. stop() is a hard dispatch boundary:
// it cannot mark current work interrupted and then launch a fresh effect.
const shutdownDefinition = await create()
const shutdownScheduler = new AutomationScheduler({
  store,
  service,
  registry,
  audit: auditStore,
  clock,
  generateId
})
await shutdownScheduler.start()
const shutdownRunId = generateId()
assert.equal(
  store.insertRun({
    id: shutdownRunId,
    automationId: shutdownDefinition.id,
    trigger: { kind: 'event', key: 'shutdown-boundary', occurredAt: now },
    idempotencyKey: 'shutdown-boundary-key',
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
const shutdownTick = shutdownScheduler.tick(false, true)
shutdownScheduler.stop()
await shutdownTick
assert.equal(store.getRun(shutdownRunId)?.status, 'queued')
await shutdownScheduler.setEnabled(shutdownDefinition.id, false, managementContext())

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
await scheduler.setEnabled(scheduled.id, false, managementContext())

const oversizedDefinition = await create({
  operationId: oversizedDescriptor.id,
  idempotency: 'natural',
  trigger: { kind: 'schedule', intervalMs: 1_000, startAt: now }
})
await scheduler.tick()
const oversizedRun = persistedRun(oversizedDefinition.id)
assert.equal(oversizedRun.status, 'succeeded')
assert.deepEqual(oversizedRun.result, boundedResult)
assert.ok(
  Buffer.byteLength(JSON.stringify(oversizedRun.result), 'utf8') <=
    AUTOMATION_LIMITS.maxPersistedResultBytes
)
assert.ok(oversizedRun.auditId)
const oversizedAudit = db
  .prepare(
    `SELECT correlation_json, receipts_json FROM control_audit
     WHERE audit_id = ?`
  )
  .get(oversizedRun.auditId) as {
  correlation_json: string
  receipts_json: string
}
assert.ok(
  Buffer.byteLength(oversizedAudit.correlation_json, 'utf8') <=
    AUTOMATION_LIMITS.maxPersistedResultBytes
)
assert.ok(
  Buffer.byteLength(oversizedAudit.receipts_json, 'utf8') <=
    AUTOMATION_LIMITS.maxPersistedResultBytes
)
assert.doesNotMatch(oversizedAudit.correlation_json, /must-never-persist/)
assert.equal(
  (
    (JSON.parse(oversizedAudit.correlation_json) as Record<string, unknown>)['outcome'] as Record<
      string,
      unknown
    >
  )['truncated'],
  true
)

Object.defineProperties(accessorResult, {
  auditId: {
    enumerable: true,
    get() {
      getterReads++
      return 'must-never-persist'
    }
  },
  effects: {
    enumerable: true,
    get() {
      getterReads++
      return [{ token: 'must-never-persist' }]
    }
  }
})
auditStore.appendAttempt({
  auditId: 'adversarial-result-audit',
  requestId: 'adversarial-result-request',
  occurredAt: now,
  definition: oversizedDefinition,
  run: oversizedRun,
  description: registry.describe(oversizedDescriptor.id)!,
  decision: 'allow',
  resultCode: 'completed',
  result: accessorResult,
  error: null
})
assert.equal(getterReads, 0, 'audit persistence must never invoke result accessors')
const adversarialAudit = db
  .prepare(
    `SELECT correlation_json, receipts_json FROM control_audit
     WHERE audit_id = 'adversarial-result-audit'`
  )
  .get() as { correlation_json: string; receipts_json: string }
assert.ok(
  Buffer.byteLength(adversarialAudit.correlation_json, 'utf8') <=
    AUTOMATION_LIMITS.maxPersistedResultBytes
)
assert.ok(
  Buffer.byteLength(adversarialAudit.receipts_json, 'utf8') <=
    AUTOMATION_LIMITS.maxPersistedResultBytes
)
assert.doesNotMatch(
  `${adversarialAudit.correlation_json}${adversarialAudit.receipts_json}`,
  /must-never-persist/
)
await scheduler.setEnabled(oversizedDefinition.id, false, managementContext())

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
await restartedScheduler.waitForIdle()
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
const sameDefinitionQueuedId = generateId()
assert.equal(
  store.insertRun({
    id: sameDefinitionQueuedId,
    automationId: lingeringDefinition.id,
    trigger: { kind: 'event', key: 'same-definition-queued', occurredAt: now },
    idempotencyKey: 'same-definition-queued-key',
    status: 'queued',
    attempt: 0,
    queuedAt: now + 1,
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
await scheduler.tick(false)
assert.equal(
  store.getRun(sameDefinitionQueuedId)?.status,
  'queued',
  'a lingering invocation must retain its per-definition concurrency slot'
)
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

// A lingering retry must not hide later runnable work when the definition still
// has another concurrency slot. The oldest retry remains protected from
// duplicate execution while the later queued run uses the free slot.
const lingeringCandidateDefinition = await create({ concurrencyLimit: 2 })
const lingeringCandidateRunId = generateId()
assert.equal(
  store.insertRun({
    id: lingeringCandidateRunId,
    automationId: lingeringCandidateDefinition.id,
    trigger: { kind: 'event', key: 'lingering-candidate', occurredAt: now },
    idempotencyKey: 'lingering-candidate-key',
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
blockNext = true
releaseBlocked = null
timeoutNext = true
await scheduler.tick()
const lingeringCandidateRun = store.getRun(lingeringCandidateRunId)
assert.equal(lingeringCandidateRun?.status, 'retry_wait')
const runnableBehindLingeringId = generateId()
assert.equal(
  store.insertRun({
    id: runnableBehindLingeringId,
    automationId: lingeringCandidateDefinition.id,
    trigger: { kind: 'event', key: 'behind-lingering', occurredAt: now },
    idempotencyKey: 'behind-lingering-key',
    status: 'queued',
    attempt: 0,
    queuedAt: now + 1,
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
now = lingeringCandidateRun?.nextAttemptAt ?? now
await scheduler.tick()
assert.equal(
  store.getRun(runnableBehindLingeringId)?.status,
  'succeeded',
  'a lingering oldest run must not block a later candidate when concurrency remains'
)
assert.equal(store.getRun(lingeringCandidateRunId)?.attempt, 1)
assert.ok(releaseBlocked)
releaseBlocked()
await scheduler.waitForIdle()
await scheduler.setEnabled(lingeringCandidateDefinition.id, false, managementContext())
maxActiveHandlers = 0

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

// Global concurrency is bounded independently of each definition's limit, and
// reconciliation remains responsive while a dispatched handler is still live.
const globallyCappedDefinitions = [await create(), await create()]
const globallyCappedRunIds = globallyCappedDefinitions.map((definition, index) => {
  const id = generateId()
  assert.equal(
    store.insertRun({
      id,
      automationId: definition.id,
      trigger: { kind: 'event', key: `global-cap-${index}`, occurredAt: now },
      idempotencyKey: `global-cap-key-${index}`,
      status: 'queued',
      attempt: 0,
      queuedAt: now + index,
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
  return id
})
const globallyCappedScheduler = new AutomationScheduler({
  store,
  service,
  registry,
  audit: auditStore,
  clock,
  generateId,
  maxGlobalConcurrency: 1
})
blockNext = true
releaseBlocked = null
await globallyCappedScheduler.tick(false)
for (let spin = 0; spin < 20 && releaseBlocked == null; spin++) {
  await new Promise<void>((resolve) => setImmediate(resolve))
}
assert.ok(releaseBlocked)
await globallyCappedScheduler.tick(false)
assert.deepEqual(
  globallyCappedRunIds.map((id) => store.getRun(id)?.status),
  ['running', 'queued']
)
releaseBlocked()
await globallyCappedScheduler.waitForIdle()
await globallyCappedScheduler.tick()
assert.deepEqual(
  globallyCappedRunIds.map((id) => store.getRun(id)?.status),
  ['succeeded', 'succeeded']
)
for (const definition of globallyCappedDefinitions) {
  await globallyCappedScheduler.setEnabled(definition.id, false, managementContext())
}

// A timed-out handler that ignores AbortSignal still owns its global execution
// slot until its underlying invocation settles. The persisted attempt may move
// to retry_wait, but unrelated work cannot accumulate live handlers behind it.
const lingeringCapDefinitions = [await create(), await create()]
const lingeringCapRunIds = lingeringCapDefinitions.map((definition, index) => {
  const id = generateId()
  assert.equal(
    store.insertRun({
      id,
      automationId: definition.id,
      trigger: { kind: 'event', key: `lingering-cap-${index}`, occurredAt: now },
      idempotencyKey: `lingering-cap-key-${index}`,
      status: 'queued',
      attempt: 0,
      queuedAt: now + index,
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
  return id
})
let saturatedSelectionQueries = 0
const saturatedStore: AutomationStore = {
  ...store,
  listRunnableAutomationIds: (...args) => {
    saturatedSelectionQueries++
    return store.listRunnableAutomationIds(...args)
  },
  listDefinitionsByIds: (...args) => {
    saturatedSelectionQueries++
    return store.listDefinitionsByIds(...args)
  },
  countStartsSinceMany: (...args) => {
    saturatedSelectionQueries++
    return store.countStartsSinceMany(...args)
  },
  listRunnableRunsForAutomation: (...args) => {
    saturatedSelectionQueries++
    return store.listRunnableRunsForAutomation(...args)
  }
}
const lingeringCapScheduler = new AutomationScheduler({
  store: saturatedStore,
  service,
  registry,
  audit: auditStore,
  clock,
  generateId,
  maxGlobalConcurrency: 1
})
blockNext = true
releaseBlocked = null
timeoutNext = true
await lingeringCapScheduler.tick()
assert.ok(releaseBlocked)
const selectionQueriesBeforeSaturatedTick = saturatedSelectionQueries
await lingeringCapScheduler.tick(false)
assert.equal(store.getRun(lingeringCapRunIds[1]!)?.status, 'queued')
assert.equal(
  saturatedSelectionQueries,
  selectionQueriesBeforeSaturatedTick,
  'a saturated scheduler must skip runnable selection queries until a slot is free'
)
releaseBlocked()
await lingeringCapScheduler.waitForIdle()
await lingeringCapScheduler.tick()
assert.equal(store.getRun(lingeringCapRunIds[1]!)?.status, 'succeeded')
for (const definition of lingeringCapDefinitions) {
  await lingeringCapScheduler.setEnabled(definition.id, false, managementContext())
}

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

// The production workspace-event bridge persists only the authoritative
// transition inside the source transaction, then delivers it after commit.
const eventWorkspace = {
  id: 'workspace-1',
  projectId: 'project-1',
  name: 'Event workspace',
  cwd: '/event-workspace'
} as WorkspaceRecord
const bridgedDefinition = await create()
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
  scheduler,
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
persistingObserver(eventWorkspace.id, 'idle', 'awaiting_input', eventWorkspace)
committedObserver(eventWorkspace.id, 'idle', 'awaiting_input')
await new Promise<void>((resolve) => setImmediate(resolve))
assert.equal(service.listRuns(bridgedDefinition.id).length, 0)
store.transaction(() => {
  persistingObserver?.(eventWorkspace.id, 'in_progress', 'awaiting_input', eventWorkspace)
})
const pendingOccurrence = db
  .prepare(
    `SELECT id, delivered_at FROM automation_event_occurrences
     WHERE workspace_id = ? AND delivered_at IS NULL
     ORDER BY created_at DESC LIMIT 1`
  )
  .get(eventWorkspace.id) as { id: string; delivered_at: number | null }
assert.equal(pendingOccurrence.delivered_at, null)
committedObserver(eventWorkspace.id, 'in_progress', 'awaiting_input')
await new Promise<void>((resolve) => setImmediate(resolve))
await scheduler.tick()
assert.equal(service.listRuns(bridgedDefinition.id).length, 1)
disposeWorkspaceEvents()
const correlatedRun = service.listRuns(bridgedDefinition.id)[0]
assert.ok(correlatedRun?.auditId)
const correlatedAudit = db
  .prepare('SELECT correlation_json FROM control_audit WHERE audit_id = ?')
  .get(correlatedRun.auditId) as { correlation_json: string }
assert.equal(
  (JSON.parse(correlatedAudit.correlation_json) as Record<string, unknown>)['runId'],
  correlatedRun.id
)
await scheduler.setEnabled(bridgedDefinition.id, false, managementContext())

// The production scheduler parks on one low-frequency maintenance deadline
// when no persisted work exists, wakes promptly for service/event mutations,
// and arms exactly one timeout for the next schedule, retry, or cleanup.
{
  const wakeDb = new Database(':memory:')
  wakeDb.exec('PRAGMA foreign_keys = ON')
  runMigrations(wakeDb, { dbPath: ':memory:' })
  const durableWakeStore = createAutomationStore(wakeDb)
  let nextWakeQueries = 0
  let runCleanupCalls = 0
  let eventCleanupCalls = 0
  let budgetDeferralBatches: number[] = []
  const wakeStore: AutomationStore = {
    ...durableWakeStore,
    getNextWakeAt: (...args) => {
      nextWakeQueries++
      return durableWakeStore.getNextWakeAt(...args)
    },
    pruneTerminalRuns: (...args) => {
      runCleanupCalls++
      durableWakeStore.pruneTerminalRuns(...args)
    },
    pruneDeliveredEventOccurrences: (...args) => {
      eventCleanupCalls++
      durableWakeStore.pruneDeliveredEventOccurrences(...args)
    },
    deferRuns: (ids, readyAt, nextAttemptAt, resultCode) => {
      budgetDeferralBatches.push(ids.length)
      return durableWakeStore.deferRuns(ids, readyAt, nextAttemptAt, resultCode)
    }
  }
  const wakeAudit = createAutomationAuditStore(wakeDb)
  let wakeNow = 50_000
  const maintenanceIntervalMs = 60 * 60 * 1_000
  let maintenanceWakeAt = wakeNow + maintenanceIntervalMs
  let wakeId = 0
  let wakeTimeoutNext = false
  const wakeService = new AutomationService({
    store: wakeStore,
    registry,
    grants,
    audit: wakeAudit,
    allowedEventTypes: new Set(['workspace.completed']),
    now: () => wakeNow,
    generateId: () => `wake-generated-${++wakeId}`
  })
  const scheduledWakes: Array<{
    callback: () => void
    delayMs: number
    cancelled: boolean
    fired: boolean
    unref: () => void
  }> = []
  const liveWake = (): (typeof scheduledWakes)[number] | null => {
    const live = scheduledWakes.filter((wake) => !wake.cancelled && !wake.fired)
    assert.ok(live.length <= 1, 'the scheduler must retain at most one live wake timer')
    return live[0] ?? null
  }
  const wakeScheduler = new AutomationScheduler({
    store: wakeStore,
    service: wakeService,
    registry,
    audit: wakeAudit,
    clock: {
      now: () => wakeNow,
      withTimeout: async (promise, _timeoutMs, controller) => {
        if (wakeTimeoutNext) {
          wakeTimeoutNext = false
          controller.abort()
          return { timedOut: true }
        }
        return { timedOut: false, value: await promise }
      }
    },
    generateId: () => `wake-generated-${++wakeId}`,
    scheduleWake: (callback, delayMs) => {
      const wake = {
        callback,
        delayMs,
        cancelled: false,
        fired: false,
        unref: () => undefined
      }
      scheduledWakes.push(wake)
      return wake
    },
    cancelWake: (handle) => {
      const wake = handle as (typeof scheduledWakes)[number]
      wake.cancelled = true
    }
  })
  const fireWake = async (waitForExecutions = true): Promise<void> => {
    const wake = liveWake()
    assert.ok(wake)
    wake.fired = true
    wake.callback()
    await new Promise<void>((resolve) => setImmediate(resolve))
    if (waitForExecutions) await wakeScheduler.waitForIdle()
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  const flushImmediateWakes = async (waitForExecutions = true): Promise<void> => {
    for (let remaining = 20; remaining > 0; remaining--) {
      const wake = liveWake()
      if (wake == null || wake.delayMs > 0) return
      await fireWake(waitForExecutions)
    }
    assert.fail('automation scheduler did not finish its immediate wakeup work')
  }
  const assertMaintenanceWake = (): void => {
    assert.equal(
      liveWake()?.delayMs,
      maintenanceWakeAt - wakeNow,
      'an otherwise idle scheduler must retain only its hourly maintenance deadline'
    )
  }

  await wakeScheduler.start()
  assertMaintenanceWake()
  assert.equal(runCleanupCalls, 1)
  assert.equal(eventCleanupCalls, 1)
  const parkedWakeQueries = nextWakeQueries
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(nextWakeQueries, parkedWakeQueries, 'an idle scheduler must not poll SQLite')

  const wakeSchedule = await wakeService.createDefinition(
    draft({
      name: 'Deadline wake schedule',
      trigger: { kind: 'schedule', intervalMs: 1_000, startAt: wakeNow + 1_000 }
    }),
    managementContext()
  )
  assert.equal(liveWake()?.delayMs, 0, 'a definition mutation must request a prompt reschedule')
  await flushImmediateWakes()
  assert.equal(liveWake()?.delayMs, 1_000)
  assert.equal(wakeStore.getNextWakeAt(), wakeNow + 1_000)

  wakeNow += 1_000
  await fireWake()
  await flushImmediateWakes()
  assert.equal(
    wakeStore.listRuns({ automationId: wakeSchedule.id, limit: 10 })[0]?.status,
    'succeeded'
  )
  assert.equal(liveWake()?.delayMs, 1_000, 'a schedule must re-arm at its next actual deadline')

  await wakeService.setEnabled(wakeSchedule.id, false, managementContext())
  await flushImmediateWakes()
  assertMaintenanceWake()
  const wakeEventDefinition = await wakeService.createDefinition(draft(), managementContext())
  await flushImmediateWakes()
  assertMaintenanceWake()

  wakeScheduler.persistEvent({
    id: 'wake-event',
    type: 'workspace.completed',
    occurredAt: wakeNow,
    projectId: 'project-1'
  })
  assert.equal(liveWake()?.delayMs, 0, 'a persisted event must wake the parked scheduler')
  await flushImmediateWakes()
  assert.equal(
    wakeStore.listRuns({ automationId: wakeEventDefinition.id, limit: 10 })[0]?.status,
    'succeeded'
  )
  assertMaintenanceWake()

  const scheduleBehindBlockedRun = await wakeService.createDefinition(
    draft({
      name: 'Independent deadline wake',
      trigger: { kind: 'schedule', intervalMs: 1_000, startAt: wakeNow + 150 }
    }),
    managementContext()
  )
  await flushImmediateWakes()
  assert.equal(liveWake()?.delayMs, 150)
  blockNext = true
  releaseBlocked = null
  wakeTimeoutNext = true
  wakeScheduler.persistEvent({
    id: 'wake-retry-event',
    type: 'workspace.completed',
    occurredAt: wakeNow,
    projectId: 'project-1'
  })
  await flushImmediateWakes(false)
  const retryWakeRun = wakeStore.listRuns({
    automationId: wakeEventDefinition.id,
    order: 'recent',
    limit: 10
  })[0]
  assert.equal(retryWakeRun?.status, 'retry_wait')
  assert.equal(liveWake()?.delayMs, 100, 'a retry must sleep until its persisted deadline')
  assert.equal(wakeStore.getNextWakeAt(), retryWakeRun?.nextAttemptAt)
  wakeNow += 100
  await fireWake(false)
  await flushImmediateWakes(false)
  assert.equal(
    liveWake()?.delayMs,
    50,
    'a concurrency-blocked ready row must not hide another definition deadline'
  )
  wakeNow += 50
  await fireWake(false)
  await flushImmediateWakes(false)
  assert.equal(
    wakeStore.listRuns({ automationId: scheduleBehindBlockedRun.id, limit: 10 })[0]?.status,
    'succeeded'
  )
  assert.equal(wakeStore.getRun(retryWakeRun!.id)?.status, 'retry_wait')
  assert.ok(releaseBlocked)
  releaseBlocked()
  await wakeScheduler.waitForIdle()
  await flushImmediateWakes()
  assert.equal(wakeStore.getRun(retryWakeRun!.id)?.status, 'succeeded')
  assert.equal(liveWake()?.delayMs, 1_000)

  await wakeService.setEnabled(wakeEventDefinition.id, false, managementContext())
  await wakeService.setEnabled(scheduleBehindBlockedRun.id, false, managementContext())
  await flushImmediateWakes()
  assertMaintenanceWake()

  const budgetWakeDefinition = await wakeService.createDefinition(
    draft({
      name: 'Bulk rolling-budget wake',
      rollingBudget: { windowMs: 1_000, maxStarts: 1 }
    }),
    managementContext()
  )
  wakeScheduler.persistEvent({
    id: 'wake-budget-seed',
    type: 'workspace.completed',
    occurredAt: wakeNow,
    projectId: 'project-1'
  })
  await flushImmediateWakes()
  assert.equal(
    wakeStore.listRuns({ automationId: budgetWakeDefinition.id, limit: 10 })[0]?.status,
    'succeeded'
  )

  for (let index = 0; index < 3; index++) {
    wakeScheduler.persistEvent({
      id: `wake-budget-backlog-${index}`,
      type: 'workspace.completed',
      occurredAt: wakeNow,
      projectId: 'project-1'
    })
  }
  assert.equal(liveWake()?.delayMs, 0)
  await fireWake()
  const budgetBacklog = wakeStore.listRuns({
    automationId: budgetWakeDefinition.id,
    order: 'recent',
    limit: 10
  })
  assert.deepEqual(
    budgetBacklog.slice(0, 3).map(({ status }) => status),
    ['retry_wait', 'retry_wait', 'retry_wait']
  )
  assert.deepEqual(
    new Set(budgetBacklog.slice(0, 3).map(({ nextAttemptAt }) => nextAttemptAt)),
    new Set([wakeNow + 1_000])
  )
  assert.equal(
    liveWake()?.delayMs,
    1_000,
    'a budget-blocked backlog must bulk-defer behind one future wake without zero-delay churn'
  )

  budgetDeferralBatches = []
  for (let index = 0; index < AUTOMATION_LIMITS.maxListLimit + 5; index++) {
    assert.equal(
      wakeStore.insertRun({
        id: `wake-large-budget-run-${index}`,
        automationId: budgetWakeDefinition.id,
        trigger: {
          kind: 'event',
          key: `wake-large-budget-${index}`,
          occurredAt: wakeNow
        },
        idempotencyKey: `wake-large-budget-key-${index}`,
        status: 'queued',
        attempt: 0,
        queuedAt: wakeNow + index,
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
  }
  await wakeScheduler.tick(false)
  assert.deepEqual(
    budgetDeferralBatches,
    [AUTOMATION_LIMITS.maxListLimit],
    'one reconciliation must never defer more than its global row-work budget'
  )
  assert.equal(
    liveWake()?.delayMs,
    25,
    'ready rows beyond one deferral batch must yield instead of rearming at zero delay'
  )
  assert.equal(
    wakeStore
      .listRuns({
        automationId: budgetWakeDefinition.id,
        statuses: ['queued'],
        limit: AUTOMATION_LIMITS.maxListLimit + 10
      })
      .filter(({ id }) => id.startsWith('wake-large-budget-run-')).length,
    5
  )
  wakeNow += 25
  await fireWake()
  assert.deepEqual(budgetDeferralBatches, [AUTOMATION_LIMITS.maxListLimit, 5])
  const largeBudgetRuns = wakeStore
    .listRuns({
      automationId: budgetWakeDefinition.id,
      statuses: ['retry_wait'],
      limit: AUTOMATION_LIMITS.maxListLimit + 10
    })
    .filter(({ id }) => id.startsWith('wake-large-budget-run-'))
  assert.equal(largeBudgetRuns.length, AUTOMATION_LIMITS.maxListLimit + 5)
  assert.ok(
    largeBudgetRuns.every(({ nextAttemptAt }) => nextAttemptAt != null && nextAttemptAt > wakeNow),
    'yielded budget work must remain durably pending at a future deadline'
  )
  assert.ok((liveWake()?.delayMs ?? 0) > 0, 'draining the overflow batch must not spin at zero')

  await wakeService.setEnabled(budgetWakeDefinition.id, false, managementContext())
  await flushImmediateWakes()
  assertMaintenanceWake()

  const manyBudgetDefinitions: AutomationDefinition[] = []
  const manyBudgetRunIds: string[] = []
  for (let index = 0; index < AUTOMATION_LIMITS.maxListLimit + 5; index++) {
    const definition = await wakeService.createDefinition(
      draft({
        name: `Globally bounded budget ${index}`,
        rollingBudget: { windowMs: 1_000, maxStarts: 1 }
      }),
      managementContext()
    )
    manyBudgetDefinitions.push(definition)
    assert.equal(
      wakeStore.insertRun({
        id: `wake-many-budget-seed-${index}`,
        automationId: definition.id,
        trigger: { kind: 'event', key: `wake-many-budget-seed-${index}`, occurredAt: wakeNow },
        idempotencyKey: `wake-many-budget-seed-key-${index}`,
        status: 'succeeded',
        attempt: 1,
        queuedAt: wakeNow,
        startedAt: wakeNow,
        finishedAt: wakeNow,
        nextAttemptAt: null,
        resultCode: 'completed',
        result: null,
        error: null,
        requestId: `wake-many-budget-seed-request-${index}`,
        auditId: null
      }),
      true
    )
    const runId = `wake-many-budget-run-${index}`
    manyBudgetRunIds.push(runId)
    assert.equal(
      wakeStore.insertRun({
        id: runId,
        automationId: definition.id,
        trigger: { kind: 'event', key: runId, occurredAt: wakeNow },
        idempotencyKey: `wake-many-budget-key-${index}`,
        status: 'queued',
        attempt: 0,
        queuedAt: wakeNow + index,
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
  }
  budgetDeferralBatches = []
  await wakeScheduler.tick(false)
  assert.equal(
    budgetDeferralBatches.reduce((total, count) => total + count, 0),
    AUTOMATION_LIMITS.maxListLimit,
    'many blocked definitions must share one global deferral-work budget'
  )
  assert.ok(
    budgetDeferralBatches.every((count) => count === 1),
    'one-row definitions must not be combined across automation boundaries'
  )
  assert.equal(manyBudgetRunIds.filter((id) => wakeStore.getRun(id)?.status === 'queued').length, 5)
  assert.equal(liveWake()?.delayMs, 25)
  wakeNow += 25
  await fireWake()
  assert.equal(
    budgetDeferralBatches.reduce((total, count) => total + count, 0),
    AUTOMATION_LIMITS.maxListLimit + 5
  )
  assert.ok(
    manyBudgetRunIds.every((id) => wakeStore.getRun(id)?.status === 'retry_wait'),
    'bounded multi-definition deferral must preserve every pending run'
  )
  assert.ok((liveWake()?.delayMs ?? 0) > 0)
  for (const definition of manyBudgetDefinitions) {
    await wakeService.setEnabled(definition.id, false, managementContext())
  }
  await flushImmediateWakes()
  assertMaintenanceWake()

  const cleanupCallsBeforeMaintenance = {
    runs: runCleanupCalls,
    events: eventCleanupCalls
  }
  wakeNow = maintenanceWakeAt
  await fireWake()
  assert.equal(runCleanupCalls, cleanupCallsBeforeMaintenance.runs + 1)
  assert.equal(eventCleanupCalls, cleanupCallsBeforeMaintenance.events + 1)
  maintenanceWakeAt = wakeNow + maintenanceIntervalMs
  assertMaintenanceWake()

  const stoppedSchedule = await wakeService.createDefinition(
    draft({
      name: 'Cancelled deadline wake',
      trigger: { kind: 'schedule', intervalMs: 1_000, startAt: wakeNow + 1_000 }
    }),
    managementContext()
  )
  await flushImmediateWakes()
  const wakeCancelledByStop = liveWake()
  assert.equal(wakeCancelledByStop?.delayMs, 1_000)
  wakeScheduler.stop()
  assert.equal(wakeCancelledByStop?.cancelled, true, 'stop must cancel the pending deadline wake')
  await wakeService.setEnabled(stoppedSchedule.id, false, managementContext())
  wakeDb.close()
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
  assert.doesNotMatch(source, /setInterval/, 'durable automations must not use interval polling')
}

console.log('✓ durable automations')
