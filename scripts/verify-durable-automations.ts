import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { AutomationGrantPolicy } from '../src/main/controlPlane/automationPolicy.ts'
import { withAutomationPolicy } from '../src/main/controlPlane/automationPolicy.ts'
import { ControlRegistry } from '../src/main/controlPlane/registry.ts'
import type {
  ControlContext,
  ControlDescriptor,
  ControlPermission
} from '../src/main/controlPlane/types.ts'
import { createAutomationAuditStore } from '../src/main/automations/audit.ts'
import { AutomationScheduler } from '../src/main/automations/scheduler.ts'
import { AutomationService } from '../src/main/automations/service.ts'
import { createAutomationStore } from '../src/main/automations/store.ts'
import type {
  AutomationAuditPort,
  AutomationClock,
  AutomationDefinition,
  AutomationDefinitionDraft,
  AutomationManagementContext,
  AutomationRun
} from '../src/main/automations/types.ts'
import { runMigrations } from '../src/main/db/cutover.ts'

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
const grants = new AutomationGrantPolicy(() => ({
  permissions,
  maxRiskTier: 2,
  scopes: [{ kind: 'project', projectId: 'project-1' }]
}))
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

// Declarative migration created both durable tables and their critical indexes.
{
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name IN ('automation_definitions', 'automation_runs') ORDER BY name`
    )
    .all() as Array<{ name: string }>
  assert.deepEqual(
    tables.map(({ name }) => name),
    ['automation_definitions', 'automation_runs']
  )
  const indexes = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index'
       AND name LIKE 'idx_automation_%' ORDER BY name`
    )
    .all() as Array<{ name: string }>
  assert.ok(indexes.some(({ name }) => name === 'idx_automation_runs_idempotency'))
}

// Strict definition validation rejects unknown events, extra operation params,
// descriptor/idempotency mismatch, and absence of a server-owned grant.
await assert.rejects(
  () => create({ trigger: { kind: 'event', eventType: 'external.webhook' } }),
  /not allowlisted/
)
await assert.rejects(() => create({ params: { text: 'ok', shell: 'no' } }), /operation schema/)
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
