import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { createAutomationAuditStore } from '../src/main/automations/audit.ts'
import { AutomationService } from '../src/main/automations/service.ts'
import { createAutomationStore } from '../src/main/automations/store.ts'
import type {
  AutomationChangedEvent,
  AutomationDefinitionDraft,
  AutomationManagementContext,
  AutomationRegistry,
  AutomationRun
} from '../src/main/automations/types.ts'
import { AutomationGrantPolicy } from '../src/main/controlPlane/automationPolicy.ts'
import { AUTOMATION_MANAGEMENT_OPERATION_IDS } from '../src/main/controlPlane/automationManagementCapabilities.ts'
import { AutomationManagementService } from '../src/main/controlPlane/automationManagementService.ts'
import { bootControlRegistry } from '../src/main/controlPlane/boot.ts'
import { createConfiguredControlRegistry } from '../src/main/controlPlane/configuredRegistry.ts'
import { categoryForOperation } from '../src/main/controlPlane/controlToolExposure.ts'
import type { ControlRegistry } from '../src/main/controlPlane/registry.ts'
import type {
  ControlContext,
  ControlDescriptor,
  ControlResult
} from '../src/main/controlPlane/types.ts'
import { runMigrations } from '../src/main/db/cutover.ts'

const db = new Database(':memory:')
db.exec('PRAGMA foreign_keys = ON')
runMigrations(db, { dbPath: ':memory:' })
const store = createAutomationStore(db)

const registryRef: { current: ControlRegistry | null } = { current: null }
function activeRegistry(): ControlRegistry {
  if (registryRef.current == null) throw new Error('Control registry has not booted')
  return registryRef.current
}
const forwardingRegistry: AutomationRegistry = {
  describe: (id) => activeRegistry().describe(id),
  validateInput: (id, input, context) => activeRegistry().validateInput(id, input, context),
  invoke: (invocation) => activeRegistry().invoke(invocation)
}
let sequence = 0
let now = 10_000
const generateId = (): string => `automation-mcp-${++sequence}`
const automationService = new AutomationService({
  store,
  registry: forwardingRegistry,
  grants: new AutomationGrantPolicy(
    Object.assign(
      () => ({
        permissions: ['reviews.resolve'] as const,
        maxRiskTier: 2 as const,
        scopes: [
          {
            kind: 'workspace' as const,
            projectId: 'project-1',
            workspaceId: 'workspace-1'
          },
          {
            kind: 'workspace' as const,
            projectId: 'project-1',
            workspaceId: 'workspace-2'
          }
        ]
      }),
      {
        supports: (description: ControlDescriptor<unknown, unknown>) =>
          description.id === 'test.workspaceMutation'
      }
    )
  ),
  audit: createAutomationAuditStore(db),
  allowedEventTypes: new Set(['workspace.completed']),
  now: () => now,
  generateId
})
const changedEvents: AutomationChangedEvent[] = []
let throwFromBroadcaster = false
const adapter = new AutomationManagementService({
  service: automationService,
  listOperations: () => activeRegistry().list(),
  broadcastChanged: (event) => {
    changedEvents.push(event)
    if (throwFromBroadcaster) throw new Error('synthetic broadcaster failure')
  }
})

const disabledTools = new Set<string>()
const registry = createConfiguredControlRegistry({
  authorization: {
    canDiscover: () => true,
    authorize: () => ({ allowed: true as const })
  },
  automationManagement: adapter,
  toolExposure: {
    isEnabled: (operationId) => !disabledTools.has(operationId)
  }
})
registryRef.current = registry

const underlying: ControlDescriptor<{ text: string }, { ok: true }> = {
  id: 'test.workspaceMutation',
  version: 1,
  kind: 'mutation',
  description: 'Automation-eligible exact-workspace verifier operation.',
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
  scope: { kind: 'self' },
  risk: { tier: 2, label: 'write' },
  declaredEffects: ['db.write'],
  idempotency: 'keyed',
  validateInput: (input): input is { text: string } =>
    input != null &&
    typeof input === 'object' &&
    !Array.isArray(input) &&
    Object.keys(input).length === 1 &&
    typeof (input as Record<string, unknown>)['text'] === 'string',
  handler: () => ({ ok: true })
}
registry.register(underlying)
bootControlRegistry(
  registry,
  {
    listByWorkspace: () => [],
    setResolved: () => {
      throw new Error('not used')
    }
  },
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  adapter
)

function context(
  workspaceId = 'workspace-1',
  options: { trusted?: boolean; permission?: boolean } = {}
): ControlContext {
  const runtimeId = `runtime:${workspaceId}`
  return {
    principal: { type: 'workspace-agent', id: runtimeId },
    consumer: 'mcp',
    workspaceId,
    projectId: 'project-1',
    requestId: generateId(),
    trustedRuntime:
      options.trusted === false
        ? null
        : {
            runtimeId,
            runtimeKind: 'claude',
            surfaceId: workspaceId,
            workspaceId,
            projectId: 'project-1',
            claudeConversationId: `conversation:${workspaceId}`,
            issuedAt: 1,
            permissions: options.permission === false ? [] : ['automations.manage']
          }
  }
}

function draft(
  workspaceId = 'workspace-1',
  overrides: Partial<AutomationDefinitionDraft> = {}
): AutomationDefinitionDraft {
  return {
    name: 'MCP workspace automation',
    trigger: { kind: 'event', eventType: 'workspace.completed' },
    operationId: underlying.id,
    params: { text: 'must-not-appear-in-management-audit' },
    scope: { kind: 'workspace', projectId: 'project-1', workspaceId },
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
    rollingBudget: { windowMs: 1_000, maxStarts: 10 },
    ...overrides
  }
}

async function invoke<T>(
  id: string,
  input: unknown,
  invocationContext = context()
): Promise<ControlResult<T>> {
  return registry.invoke<T>({ id, input, context: invocationContext })
}

const managementDescriptions = registry.list().filter(({ id }) => id.startsWith('automations.'))
assert.equal(managementDescriptions.length, 9)
assert.deepEqual(
  managementDescriptions.map(({ id }) => id).sort(),
  [...AUTOMATION_MANAGEMENT_OPERATION_IDS].sort()
)
assert.ok(
  managementDescriptions.every(
    ({ allowedSurfaces, permission }) =>
      allowedSurfaces.length === 1 &&
      allowedSurfaces[0] === 'mcp' &&
      permission === 'automations.manage'
  )
)
assert.equal(categoryForOperation('automations.create'), 'automations')

// The descriptor schema is self-contained enough for an agent to construct a
// valid draft without consulting renderer code or prose documentation.
const createDescription = registry.describe('automations.create')!
const createProperties = createDescription.inputSchema['properties'] as Record<string, unknown>
const draftSchema = createProperties['draft'] as Record<string, unknown>
const draftProperties = draftSchema['properties'] as Record<string, unknown>
assert.deepEqual(draftSchema['required'], [
  'name',
  'trigger',
  'operationId',
  'params',
  'scope',
  'idempotency',
  'timeoutMs',
  'concurrencyLimit',
  'retry',
  'rollingBudget'
])
assert.ok((draftProperties['trigger'] as Record<string, unknown>)['oneOf'])
assert.ok((draftProperties['scope'] as Record<string, unknown>)['properties'])
assert.ok((draftProperties['retry'] as Record<string, unknown>)['properties'])
assert.ok((draftProperties['rollingBudget'] as Record<string, unknown>)['properties'])
assert.equal(
  (draftProperties['operationId'] as Record<string, unknown>)['pattern'],
  '^[A-Za-z0-9._:-]+$'
)

const catalog = await invoke<{
  operations: Array<{ id: string }>
  eventTypes: string[]
}>('automations.catalog', {})
assert.equal(catalog.ok, true)
if (!catalog.ok) throw new Error(catalog.error)
assert.deepEqual(catalog.value.eventTypes, ['workspace.completed'])
assert.deepEqual(
  catalog.value.operations.map(({ id }) => id),
  [underlying.id]
)

// Same-workspace create succeeds but is always disabled even when the caller
// supplies enabled=true.
const createdResult = await invoke<Awaited<ReturnType<AutomationService['createDefinition']>>>(
  'automations.create',
  { draft: draft() }
)
assert.equal(createdResult.ok, true)
if (!createdResult.ok) throw new Error(createdResult.error)
const created = createdResult.value
assert.equal(created.enabled, false)
assert.equal(created.scope.kind, 'workspace')
assert.equal(created.scope.workspaceId, 'workspace-1')
assert.deepEqual(changedEvents, [
  {
    kind: 'created',
    definitionId: created.id,
    updatedAt: created.updatedAt
  }
])

const listResult = await invoke<Array<{ id: string }>>('automations.list', {})
assert.equal(listResult.ok, true)
if (!listResult.ok) throw new Error(listResult.error)
assert.deepEqual(
  listResult.value.map(({ id }) => id),
  [created.id]
)

// Successful MCP mutations publish the same canonical renderer invalidation
// event as renderer IPC mutations. Failed mutations below must not publish.
now++
const updatedResult = await invoke<typeof created>('automations.update', {
  id: created.id,
  expectedUpdatedAt: created.updatedAt,
  draft: draft('workspace-1', { name: 'Updated MCP workspace automation' })
})
assert.equal(updatedResult.ok, true)
if (!updatedResult.ok) throw new Error(updatedResult.error)
const updated = updatedResult.value
assert.equal(updated.name, 'Updated MCP workspace automation')

// Create cannot escape self scope. ID-based cross-workspace access collapses
// to not_found instead of confirming that another workspace owns the ID.
const crossCreate = await invoke('automations.create', { draft: draft('workspace-2') })
assert.deepEqual(crossCreate.ok ? null : crossCreate.code, 'forbidden')
const internalManagement = (): AutomationManagementContext => ({
  requestId: generateId(),
  principal: { type: 'cli', id: 'test-cli' },
  consumer: 'command-socket'
})
const foreign = await automationService.createDefinition(
  draft('workspace-2', { enabled: false }),
  internalManagement()
)
for (const [operationId, input] of [
  ['automations.get', { id: foreign.id }],
  [
    'automations.update',
    { id: foreign.id, expectedUpdatedAt: foreign.updatedAt, draft: draft('workspace-2') }
  ],
  [
    'automations.setEnabled',
    { id: foreign.id, expectedUpdatedAt: foreign.updatedAt, enabled: true }
  ],
  ['automations.delete', { id: foreign.id, expectedUpdatedAt: foreign.updatedAt }],
  ['automations.listRuns', { automationId: foreign.id }]
] as const) {
  const result = await invoke(operationId, input)
  assert.equal(result.ok, false)
  if (result.ok) throw new Error(`${operationId} unexpectedly succeeded`)
  assert.equal(result.code, 'not_found')
}

// An invalid or under-permissioned trusted runtime cannot discover or invoke
// the management vocabulary. Exposure settings independently hide and deny.
for (const invalidContext of [
  context('workspace-1', { trusted: false }),
  context('workspace-1', { permission: false })
]) {
  assert.equal(
    registry.listForContext(invalidContext).some(({ id }) => id.startsWith('automations.')),
    false
  )
  const result = await invoke('automations.list', {}, invalidContext)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'forbidden')
}
disabledTools.add('automations.create')
assert.equal(
  registry.listForContext(context()).some(({ id }) => id === 'automations.create'),
  false
)
const disabledExposure = await invoke('automations.create', { draft: draft() })
assert.equal(disabledExposure.ok, false)
if (!disabledExposure.ok) assert.equal(disabledExposure.code, 'forbidden')
disabledTools.clear()

now++
const deletable = await automationService.createDefinition(
  draft('workspace-1', { enabled: false, name: 'Delete through MCP' }),
  internalManagement()
)
now++
const deletedResult = await invoke<typeof deletable>('automations.delete', {
  id: deletable.id,
  expectedUpdatedAt: deletable.updatedAt
})
assert.equal(deletedResult.ok, true)
if (!deletedResult.ok) throw new Error(deletedResult.error)

// The existing CAS and disabled-only invariants remain authoritative through
// MCP; the adapter does not implement an alternate mutation path.
now++
const enabledResult = await invoke<typeof updated>('automations.setEnabled', {
  id: updated.id,
  expectedUpdatedAt: updated.updatedAt,
  enabled: true
})
assert.equal(enabledResult.ok, true)
if (!enabledResult.ok) throw new Error(enabledResult.error)
const enabled = enabledResult.value
const updateWhileEnabled = await invoke('automations.update', {
  id: enabled.id,
  expectedUpdatedAt: enabled.updatedAt,
  draft: draft()
})
assert.equal(updateWhileEnabled.ok, false)
if (!updateWhileEnabled.ok) assert.equal(updateWhileEnabled.code, 'conflict')
const deleteWhileEnabled = await invoke('automations.delete', {
  id: enabled.id,
  expectedUpdatedAt: enabled.updatedAt
})
assert.equal(deleteWhileEnabled.ok, false)
if (!deleteWhileEnabled.ok) assert.equal(deleteWhileEnabled.code, 'conflict')

// Run history is explicitly summarized and redacted; retry preserves lineage
// and delegates eligibility/concurrency enforcement to AutomationService.
const source: AutomationRun = {
  id: generateId(),
  automationId: enabled.id,
  trigger: { kind: 'event', key: 'secret-trigger-key', occurredAt: now },
  idempotencyKey: 'secret-logical-key',
  retryGeneration: 0,
  retryOfRunId: null,
  status: 'failed',
  attempt: 1,
  queuedAt: now,
  startedAt: now,
  finishedAt: now,
  nextAttemptAt: null,
  resultCode: 'failed',
  result: { secret: 'hidden-result' },
  error: { secret: 'hidden-error' },
  requestId: 'hidden-request',
  auditId: 'hidden-audit'
}
assert.equal(store.insertRun(source), true)
const runsResult = await invoke<Array<Record<string, unknown>>>('automations.listRuns', {
  automationId: enabled.id
})
assert.equal(runsResult.ok, true)
if (!runsResult.ok) throw new Error(runsResult.error)
assert.equal(runsResult.value.length, 1)
const runSummary = runsResult.value[0]!
for (const forbiddenField of ['result', 'error', 'requestId', 'auditId', 'idempotencyKey']) {
  assert.equal(forbiddenField in runSummary, false)
}
assert.deepEqual(runSummary['manualRetry'], { eligible: true, reason: 'eligible' })
const retryResult = await invoke<Record<string, unknown>>('automations.retryRun', {
  runId: source.id
})
assert.equal(retryResult.ok, true)
if (!retryResult.ok) throw new Error(retryResult.error)
assert.equal(retryResult.value['retryGeneration'], 1)
assert.equal(retryResult.value['retryOfRunId'], source.id)
assert.deepEqual(
  changedEvents.map(({ kind, definitionId, runId }) => [kind, definitionId, runId ?? null]),
  [
    ['created', created.id, null],
    ['updated', updated.id, null],
    ['deleted', deletable.id, null],
    ['enabled', enabled.id, null],
    ['run-retried', enabled.id, retryResult.value['id']]
  ]
)
assert.equal(changedEvents[0]?.updatedAt, created.updatedAt)
assert.equal(changedEvents[1]?.updatedAt, updated.updatedAt)
assert.ok(Number.isSafeInteger(changedEvents[2]?.updatedAt))
assert.equal(changedEvents[3]?.updatedAt, enabled.updatedAt)
assert.equal(changedEvents[4]?.updatedAt, retryResult.value['queuedAt'])

// Window teardown can make delivery throw after the database mutation commits.
// That must remain a successful MCP result and must not invite a duplicate retry.
const definitionCountBeforeThrow = automationService.listDefinitions().length
const eventCountBeforeThrow = changedEvents.length
throwFromBroadcaster = true
now++
const committedDespiteBroadcastFailure = await invoke<typeof created>('automations.create', {
  draft: draft('workspace-1', { name: 'Committed despite broadcast failure' })
})
throwFromBroadcaster = false
assert.equal(committedDespiteBroadcastFailure.ok, true)
if (!committedDespiteBroadcastFailure.ok) {
  throw new Error(committedDespiteBroadcastFailure.error)
}
assert.equal(automationService.listDefinitions().length, definitionCountBeforeThrow + 1)
assert.equal(
  automationService
    .listDefinitions()
    .filter(({ id }) => id === committedDespiteBroadcastFailure.value.id).length,
  1
)
assert.equal(changedEvents.length, eventCountBeforeThrow + 1)

// Mutation audits retain the server-derived MCP/runtime identity and never
// persist operation params.
const auditRows = db
  .prepare(
    `SELECT consumer, principal_kind, runtime_id, redacted_params_json
     FROM control_audit WHERE operation_id LIKE 'automations.%'`
  )
  .all() as Array<{
  consumer: string
  principal_kind: string
  runtime_id: string | null
  redacted_params_json: string
}>
assert.ok(auditRows.length > 0)
assert.ok(
  auditRows.some(
    ({ consumer, principal_kind, runtime_id }) =>
      consumer === 'mcp' &&
      principal_kind === 'workspace-agent' &&
      runtime_id === 'runtime:workspace-1'
  )
)
assert.ok(
  auditRows.every(
    ({ redacted_params_json }) =>
      !redacted_params_json.includes('must-not-appear-in-management-audit')
  )
)

console.log('MCP automation management verifier passed.')
