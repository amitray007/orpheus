import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import { AutomationGrantPolicy } from '../src/main/controlPlane/automationPolicy.ts'
import { withAutomationPolicy } from '../src/main/controlPlane/automationPolicy.ts'
import { ControlRegistry } from '../src/main/controlPlane/registry.ts'
import type { ControlDescriptor } from '../src/main/controlPlane/types.ts'
import { createAutomationAuditStore } from '../src/main/automations/audit.ts'
import { AutomationService } from '../src/main/automations/service.ts'
import { createAutomationStore } from '../src/main/automations/store.ts'
import type {
  AutomationDefinitionDraft,
  AutomationManagementContext,
  AutomationRun
} from '../src/main/automations/types.ts'
import { automationCatalogEntry } from '../src/main/automations/validation.ts'
import { runMigrations } from '../src/main/db/cutover.ts'

const db = new Database(':memory:')
db.exec('PRAGMA foreign_keys = ON')
runMigrations(db, { dbPath: ':memory:' })

const registry = new ControlRegistry(
  withAutomationPolicy({
    canDiscover: () => true,
    authorize: () => ({ allowed: true as const })
  })
)
const descriptor: ControlDescriptor<{ text: string }, { ok: true }> = {
  id: 'test.keyedMutation',
  version: 1,
  kind: 'mutation',
  description: 'A keyed automation management verifier operation.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: { text: { type: 'string', minLength: 1 } }
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['ok'],
    properties: { ok: { const: true } }
  },
  allowedSurfaces: ['automation'],
  permission: 'reviews.resolve',
  scope: { kind: 'project', inputField: 'projectId' },
  risk: { tier: 2, label: 'write' },
  declaredEffects: ['db.write'],
  idempotency: 'keyed',
  validateInput: (value): value is { text: string } =>
    value != null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as Record<string, unknown>)['text'] === 'string',
  handler: () => ({ ok: true })
}
registry.register(descriptor)
registry.register({
  ...descriptor,
  id: 'test.noneMutation',
  idempotency: 'none'
})

let idSequence = 0
let now = 1_000
const generateId = (): string => `automation-management-${++idSequence}`
const store = createAutomationStore(db)
const service = new AutomationService({
  store,
  registry,
  grants: new AutomationGrantPolicy(
    Object.assign(
      () => ({
        permissions: ['reviews.resolve'] as const,
        maxRiskTier: 2 as const,
        scopes: [{ kind: 'project' as const, projectId: 'project-1' }]
      }),
      { supports: () => true }
    )
  ),
  audit: createAutomationAuditStore(db),
  allowedEventTypes: new Set(['workspace.completed']),
  now: () => now,
  generateId
})

let requestSequence = 0
function management(): AutomationManagementContext {
  return {
    requestId: `automation-management-request-${++requestSequence}`,
    principal: { type: 'renderer-user', id: 'webContents:7' },
    consumer: 'renderer-ipc'
  }
}

function draft(overrides: Partial<AutomationDefinitionDraft> = {}): AutomationDefinitionDraft {
  return {
    name: 'Managed automation',
    trigger: { kind: 'event', eventType: 'workspace.completed' },
    operationId: 'test.keyedMutation',
    params: { text: 'must-not-appear-in-management-audit' },
    scope: { kind: 'project', projectId: 'project-1' },
    enabled: false,
    idempotency: 'keyed',
    timeoutMs: 1_000,
    concurrencyLimit: 1,
    retry: {
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      maxElapsedMs: 10_000
    },
    rollingBudget: { windowMs: 1_000, maxStarts: 10 },
    ...overrides
  }
}

function failedRun(automationId: string, key: string): AutomationRun {
  return {
    id: generateId(),
    automationId,
    trigger: { kind: 'event', key: `event:${key}`, occurredAt: now },
    idempotencyKey: key,
    retryGeneration: 0,
    retryOfRunId: null,
    status: 'failed',
    attempt: 1,
    queuedAt: now,
    startedAt: now,
    finishedAt: now,
    nextAttemptAt: null,
    resultCode: 'failed',
    result: null,
    error: { code: 'failed' },
    requestId: null,
    auditId: null
  }
}

// Disabled definitions support optimistic replacement. The revision advances
// even when the injected clock has not, so stale forms always lose their CAS.
const editable = await service.createDefinition(draft(), management())
now = editable.updatedAt
const updated = await service.updateDefinition(
  editable.id,
  editable.updatedAt,
  draft({ name: 'Updated automation' }),
  management()
)
assert.equal(updated.name, 'Updated automation')
assert.equal(updated.enabled, false)
assert.ok(updated.updatedAt > editable.updatedAt)
await assert.rejects(
  service.updateDefinition(editable.id, editable.updatedAt, draft(), management()),
  /changed concurrently/
)

// Enabled definitions must be disabled before update or delete.
const enabled = await service.setEnabled(updated.id, true, management(), updated.updatedAt)
await assert.rejects(
  service.updateDefinition(enabled.id, enabled.updatedAt, draft(), management()),
  /Disable the automation/
)
assert.throws(
  () => service.deleteDefinition(enabled.id, management(), enabled.updatedAt),
  /Disable the automation/
)
const disabled = await service.setEnabled(enabled.id, false, management(), enabled.updatedAt)
assert.equal(
  service.deleteDefinition(disabled.id, management(), disabled.updatedAt).id,
  disabled.id
)

// A manual retry appends a generation while preserving the scheduler-owned
// generation-zero row and its logical idempotency key.
const retryDefinition = await service.createDefinition(draft({ enabled: true }), management())
const source = failedRun(retryDefinition.id, 'logical-occurrence')
assert.equal(store.insertRun(source), true)
assert.equal(store.insertRun({ ...source, id: generateId() }), false)
const retry = await service.retryRun(source.id, management())
assert.equal(retry.idempotencyKey, source.idempotencyKey)
assert.equal(retry.retryGeneration, 1)
assert.equal(retry.retryOfRunId, source.id)
assert.equal(retry.status, 'queued')
assert.equal(store.getRun(source.id)?.status, 'failed')
assert.equal(
  store.getRunByIdempotencyKey(retryDefinition.id, source.idempotencyKey)?.id,
  source.id,
  'scheduler dedupe must continue resolving generation zero'
)
await assert.rejects(service.retryRun(source.id, management()), /latest run generation/)

// Concurrent retry requests serialize through BEGIN IMMEDIATE. Exactly one
// generation is created; the other caller observes the new latest row.
const concurrentSource = failedRun(retryDefinition.id, 'concurrent-logical-occurrence')
assert.equal(store.insertRun(concurrentSource), true)
const concurrentResults = await Promise.allSettled([
  service.retryRun(concurrentSource.id, management()),
  service.retryRun(concurrentSource.id, management())
])
assert.equal(concurrentResults.filter(({ status }) => status === 'fulfilled').length, 1)
assert.equal(
  store
    .listRuns({ automationId: retryDefinition.id, limit: 100 })
    .filter(({ idempotencyKey }) => idempotencyKey === concurrentSource.idempotencyKey).length,
  2
)

// Retry requires a current enabled definition and keyed/natural idempotency.
const disabledRetryDefinition = await service.createDefinition(draft(), management())
const disabledSource = failedRun(disabledRetryDefinition.id, 'disabled-occurrence')
assert.equal(store.insertRun(disabledSource), true)
await assert.rejects(service.retryRun(disabledSource.id, management()), /disabled/)

const noneDefinition = await service.createDefinition(
  draft({
    operationId: 'test.noneMutation',
    idempotency: 'none',
    enabled: true
  }),
  management()
)
const noneSource = failedRun(noneDefinition.id, 'none-occurrence')
assert.equal(store.insertRun(noneSource), true)
await assert.rejects(service.retryRun(noneSource.id, management()), /keyed or natural/)

// The catalog is a handler-free, JSON-cloned projection and excludes tools
// that are not explicitly automation eligible.
const catalogEntry = automationCatalogEntry(registry.describe(descriptor.id)!)
assert.ok(catalogEntry)
assert.equal(catalogEntry.id, descriptor.id)
assert.deepEqual(catalogEntry.inputSchema, descriptor.inputSchema)
assert.notEqual(catalogEntry.inputSchema, descriptor.inputSchema)
assert.equal(
  automationCatalogEntry({
    ...registry.describe(descriptor.id)!,
    allowedSurfaces: ['renderer']
  }),
  null
)
assert.equal(
  automationCatalogEntry({
    ...registry.describe(descriptor.id)!,
    scope: { kind: 'resource', inputField: 'text' }
  }),
  null
)
assert.equal(
  automationCatalogEntry({
    ...registry.describe(descriptor.id)!,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        nested: {
          type: 'object',
          additionalProperties: false,
          properties: { value: { type: 'string' } }
        }
      }
    }
  }),
  null
)
assert.equal(
  automationCatalogEntry({
    ...registry.describe(descriptor.id)!,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      oneOf: [{ properties: { text: { type: 'string' } } }],
      properties: { text: { type: 'string' } }
    }
  }),
  null
)
assert.ok(service.catalogEntry(registry.describe(descriptor.id)!))
assert.equal(
  new AutomationGrantPolicy().supports(registry.describe(descriptor.id)!),
  false,
  'catalog publication must fail closed without a policy support declaration'
)
const editorConfiguration = service.editorConfiguration()
assert.deepEqual(editorConfiguration.eventTypes, ['workspace.completed'])
assert.equal(editorConfiguration.limits.intervalMs.min, 1_000)
assert.equal(editorConfiguration.limits.timeoutMs.max, 5 * 60 * 1_000)
assert.equal(editorConfiguration.defaults.concurrencyLimit, 1)
assert.equal(editorConfiguration.defaults.retry.maxAttempts, 3)

assert.deepEqual(await service.manualRetryEligibility(source), {
  eligible: false,
  reason: 'not_latest_generation'
})
assert.deepEqual(await service.manualRetryEligibility(disabledSource), {
  eligible: false,
  reason: 'definition_disabled'
})

// Management audit params contain metadata only, never persisted operation
// params. Both successful and denied management decisions are retained.
const auditRows = db
  .prepare(
    `SELECT operation_id, decision, redacted_params_json
     FROM control_audit
     WHERE operation_id LIKE 'automations.%'`
  )
  .all() as Array<{
  operation_id: string
  decision: 'allow' | 'deny'
  redacted_params_json: string
}>
assert.ok(auditRows.some(({ operation_id }) => operation_id === 'automations.updateDefinition'))
assert.ok(auditRows.some(({ operation_id }) => operation_id === 'automations.retryRun'))
assert.ok(auditRows.some(({ decision }) => decision === 'allow'))
assert.ok(auditRows.some(({ decision }) => decision === 'deny'))
assert.ok(
  auditRows.every(
    ({ redacted_params_json }) =>
      !redacted_params_json.includes('must-not-appear-in-management-audit')
  )
)

// IPC is intentionally not registered by the verifier (that needs Electron's
// ipcMain), but the boundary contract is checked at source: renderer identity
// and request IDs are main-created, and renderer create/update force disabled.
const ipcSource = readFileSync(new URL('../src/main/ipc/automations.ts', import.meta.url), 'utf8')
assert.match(ipcSource, /principal: \{ type: 'renderer-user', id: `webContents:\$\{senderId\}` \}/)
assert.match(ipcSource, /requestId: randomUUID\(\)/)
assert.ok((ipcSource.match(/\{ \.\.\.request\.draft, enabled: false \}/g) ?? []).length >= 2)
assert.match(ipcSource, /broadcastChanged\(\{/)
assert.match(ipcSource, /return service\.summarizeRuns\(runs\)/)
const serviceSource = readFileSync(
  new URL('../src/main/automations/service.ts', import.meta.url),
  'utf8'
)
const publicRunBody = serviceSource.slice(
  serviceSource.indexOf('async summarizeRuns('),
  serviceSource.indexOf('editorConfiguration()')
)
assert.doesNotMatch(publicRunBody, /\.\.\.run/)
assert.doesNotMatch(publicRunBody, /result: run\.result/)
assert.doesNotMatch(publicRunBody, /error: run\.error/)
assert.match(publicRunBody, /hasResult: run\.result != null/)
assert.match(publicRunBody, /hasError: run\.error != null/)

console.log('Automation management verifier passed.')
