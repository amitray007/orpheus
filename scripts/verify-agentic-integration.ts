import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootControlRegistry } from '../src/main/controlPlane/boot'
import { createConfiguredControlRegistry } from '../src/main/controlPlane/configuredRegistry'
import { createReadCapabilities } from '../src/main/controlPlane/readCapabilities'
import { createTrustedRuntimeReadPolicy } from '../src/main/controlPlane/readPolicy'
import { ControlRegistry } from '../src/main/controlPlane/registry'
import { createReviewCapabilities } from '../src/main/controlPlane/reviewCapabilities'
import { ReviewMutationService } from '../src/main/controlPlane/reviewMutation'
import {
  BASE_RUNTIME_CONTROL_PERMISSIONS,
  DEFAULT_RUNTIME_CONTROL_PERMISSIONS
} from '../src/main/controlPlane/runtimeGrants'
import { createSettingsResourceCapabilities } from '../src/main/controlPlane/settingsResourceCapabilities'
import {
  SETTINGS_RESOURCE_OPERATION_IDS,
  SettingsResourceError,
  type SettingsResourceService
} from '../src/main/controlPlane/settingsResourceService'
import { createTerminalObservationCapabilities } from '../src/main/controlPlane/terminalObservationCapabilities'
import type {
  ControlAuthorizationPolicy,
  ControlContext,
  ControlDescriptor,
  ControlPermission,
  ReadCapabilityHandlers,
  ReviewCapabilityHandlers,
  TrustedRuntimeBinding
} from '../src/main/controlPlane/types'
import { createWorkbenchCapabilities } from '../src/main/controlPlane/workbenchCapabilities'
import { WORKSPACE_OPERATION_IDS } from '../src/main/controlPlane/workspaceCapabilities'
import { terminalObservationError } from '../src/main/terminalObservation/errors'
import type { TerminalObservationService } from '../src/main/terminalObservation/service'
import type { TerminalObservationHandlers } from '../src/main/terminalObservation/types'
import type { WorkbenchControlService } from '../src/main/workbenchControl/service'
import { orchestrationError } from '../src/main/workspaceOrchestration/errors'
import { recursivelyRedact } from '../src/main/workspaceOrchestration/redaction'
import type { WorkspaceOrchestrationService } from '../src/main/workspaceOrchestration/service'

function unreachable(): never {
  throw new Error('Integration inventory unexpectedly invoked a service handler.')
}

const reviewHandlers = {
  listByWorkspace: unreachable,
  setResolved: unreachable
} as unknown as ReviewCapabilityHandlers
const readHandlers = {
  getSelf: unreachable,
  listProjects: unreachable,
  getProject: unreachable,
  listWorkspaces: unreachable,
  getWorkspace: unreachable,
  getWorkspaceStatus: unreachable,
  getWorkspaceTranscript: unreachable,
  getWorkspaceLastTurn: unreachable,
  listReviewsByWorkspace: unreachable
} as unknown as ReadCapabilityHandlers
const workbenchService = {
  getWorkbenchState: unreachable,
  selectTab: unreachable,
  openFile: unreachable,
  openDiff: unreachable,
  getPaneState: unreachable,
  selectLayout: unreachable,
  terminal: unreachable
} as unknown as WorkbenchControlService
const terminalHandlers = {
  list: unreachable,
  get: unreachable,
  getClaudeSession: unreachable,
  getOutputTail: unreachable,
  subscribe: unreachable
} as unknown as TerminalObservationHandlers

type Rejection = {
  id: string
  code: string
}
const workspaceRejections: Rejection[] = []
const settingsRejections: Rejection[] = []
const workspaceService = {
  getLineage: unreachable,
  create: unreachable,
  startTask: unreachable,
  open: unreachable,
  send: unreachable,
  wait: unreachable,
  close: unreachable,
  reopen: unreachable,
  rename: unreachable,
  archive: unreachable,
  auditRejected: (meta: { id: string }, _params: unknown, _actor: unknown, code: string) => {
    workspaceRejections.push({ id: meta.id, code })
  }
} as unknown as WorkspaceOrchestrationService
const settingsService = {
  getEffective: unreachable,
  patchWorkspace: unreachable,
  listProjectMetadata: unreachable,
  targetAllowed: () => true,
  auditRejected: (input: { meta: { id: string }; code: string }) => {
    settingsRejections.push({ id: input.meta.id, code: input.code })
  }
} as unknown as SettingsResourceService
const terminalService = {
  isInputAuthorized: () => true
} as unknown as TerminalObservationService
const reviewMutationService = new ReviewMutationService({
  resolveOwnership: unreachable,
  getWorkspaceProjectId: unreachable,
  setResolved: unreachable,
  audit: { append: unreachable }
})

const basePolicy = createTrustedRuntimeReadPolicy({
  getWorkspaceProjectId: () => 'project-1'
})
const registry = createConfiguredControlRegistry({
  authorization: basePolicy,
  workspaceOrchestration: workspaceService,
  workbenchControl: workbenchService,
  terminalObservation: terminalService,
  settingsResources: settingsService,
  reviewMutations: reviewMutationService
})
bootControlRegistry(
  registry,
  reviewHandlers,
  readHandlers,
  workspaceService,
  workbenchService,
  terminalHandlers,
  settingsService,
  reviewMutationService
)

const reviewIds = createReviewCapabilities(reviewHandlers, {
  mcpRead: true,
  mcpMutation: reviewMutationService
}).map(({ id }) => id)
const readIds = createReadCapabilities(readHandlers).map(({ id }) => id)
const workbenchIds = createWorkbenchCapabilities(workbenchService).map(({ id }) => id)
const terminalIds = createTerminalObservationCapabilities(terminalHandlers).map(({ id }) => id)
const settingsIds = createSettingsResourceCapabilities(settingsService).map(({ id }) => id)
assert.deepEqual(settingsIds, [...SETTINGS_RESOURCE_OPERATION_IDS])

const expectedIds = [
  ...reviewIds,
  ...readIds,
  ...WORKSPACE_OPERATION_IDS,
  ...workbenchIds,
  ...terminalIds,
  ...settingsIds
]
assert.equal(new Set(expectedIds).size, expectedIds.length, 'control operation IDs must be unique')
assert.deepEqual(
  registry.list().map(({ id }) => id),
  [...expectedIds].sort(),
  'boot must register every cross-phase descriptor exactly once'
)

function binding(permissions: readonly ControlPermission[]): TrustedRuntimeBinding {
  return {
    runtimeId: 'runtime-1',
    runtimeKind: 'claude',
    surfaceId: 'workspace-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    claudeConversationId: 'conversation-1',
    issuedAt: 1,
    permissions,
    resourceScope: {
      selfOnly: true,
      layoutIds: ['layout-1'],
      surfaceIds: ['pane:layout-1:terminal-1']
    }
  }
}
function context(permissions: readonly ControlPermission[]): ControlContext {
  return {
    principal: { type: 'workspace-agent', id: 'runtime-1' },
    consumer: 'mcp',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    requestId: 'request-1',
    trustedRuntime: binding(permissions)
  }
}

const allDescriptions = registry.list()
const mcpIds = allDescriptions
  .filter(({ allowedSurfaces }) => allowedSurfaces.includes('mcp'))
  .map(({ id }) => id)
assert.equal(mcpIds.length, expectedIds.length, 'every registered operation is MCP-exposed')

const defaultIds = registry
  .listForContext(context(DEFAULT_RUNTIME_CONTROL_PERMISSIONS))
  .map(({ id }) => id)
assert.deepEqual(defaultIds, [...mcpIds].sort(), 'live runtimes receive the complete MCP surface')
assert.ok(
  [...workbenchIds, ...terminalIds, ...settingsIds].every((id) => defaultIds.includes(id)),
  'Workbench, pane, terminal, and settings tools are enabled by default'
)

const phase456Permissions = [
  ...DEFAULT_RUNTIME_CONTROL_PERMISSIONS,
  'ui.workbench.control',
  'terminals.control',
  'terminals.read',
  'settings.read',
  'settings.workspace.patch',
  'resources.read'
] satisfies ControlPermission[]
const explicitlyGrantedIds = registry
  .listForContext(context(phase456Permissions))
  .map(({ id }) => id)
for (const id of [...workbenchIds, ...terminalIds, ...settingsIds]) {
  assert.ok(explicitlyGrantedIds.includes(id), `explicit grant must discover ${id}`)
}

function assertStrictObjectSchemas(value: unknown, path: string): void {
  if (value == null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertStrictObjectSchemas(item, `${path}[${index}]`))
    return
  }
  const record = value as Record<string, unknown>
  if (record.type === 'object') {
    assert.equal(record.additionalProperties, false, `${path} must reject unknown properties`)
  }
  for (const [key, child] of Object.entries(record)) {
    assertStrictObjectSchemas(child, `${path}.${key}`)
  }
}
for (const description of allDescriptions) {
  assertStrictObjectSchemas(description.inputSchema, `${description.id}.inputSchema`)
  assertStrictObjectSchemas(description.outputSchema, `${description.id}.outputSchema`)
  assert.equal(
    description.allowedSurfaces.includes('automation'),
    description.idempotency != null,
    `${description.id} automation exposure and idempotency metadata must be paired`
  )
}
assert.ok(
  workbenchIds.every((id) => {
    const description = registry.describe(id)
    return (
      description?.permission ===
        (id.startsWith('panes.') && id.endsWith('Terminal')
          ? 'terminals.control'
          : 'ui.workbench.control') && description.allowedSurfaces.join(',') === 'renderer,mcp'
    )
  }),
  'Phase 4 permissions and surfaces must stay explicit'
)
assert.ok(
  terminalIds.every((id) => {
    const description = registry.describe(id)
    return (
      description?.kind === 'query' &&
      description.risk.tier === 0 &&
      description.permission === 'terminals.read' &&
      description.allowedSurfaces.join(',') === 'mcp'
    )
  }),
  'Phase 5 must remain read-only, Tier 0, and MCP-only'
)
assert.equal(
  registry.describe('settings.getEffective')?.allowedSurfaces.join(','),
  'mcp,automation'
)
assert.equal(
  registry.describe('resources.listProjectMetadata')?.allowedSurfaces.join(','),
  'mcp,automation'
)
assert.equal(registry.describe('settings.patchWorkspace')?.allowedSurfaces.join(','), 'mcp')
assert.equal(registry.describe('settings.getEffective')?.idempotency, 'natural')
assert.equal(registry.describe('resources.listProjectMetadata')?.idempotency, 'natural')

const settingsInvalid = await registry.invoke({
  id: 'settings.patchWorkspace',
  input: { patch: {} },
  context: context(phase456Permissions)
})
assert.equal(settingsInvalid.ok, false)
if (!settingsInvalid.ok) assert.equal(settingsInvalid.code, 'invalid')
assert.deepEqual(settingsRejections, [{ id: 'settings.patchWorkspace', code: 'invalid' }])
assert.deepEqual(workspaceRejections, [])

const paneInvalid = await registry.invoke({
  id: 'panes.startTerminal',
  input: { layoutId: 'layout-1' },
  context: context(phase456Permissions)
})
assert.equal(paneInvalid.ok, false)
if (!paneInvalid.ok) assert.equal(paneInvalid.code, 'invalid')
assert.deepEqual(workspaceRejections, [{ id: 'panes.startTerminal', code: 'invalid' }])
assert.equal(settingsRejections.length, 1, 'rejections must be routed to exactly one auditor')

const defaultForbidden = await registry.invoke({
  id: 'workspaces.rename',
  input: { workspaceId: 'workspace-1', name: 'Renamed' },
  context: context(BASE_RUNTIME_CONTROL_PERMISSIONS)
})
assert.equal(defaultForbidden.ok, false)
if (!defaultForbidden.ok) assert.equal(defaultForbidden.code, 'forbidden')
assert.deepEqual(workspaceRejections.at(-1), { id: 'workspaces.rename', code: 'forbidden' })

const allowAll: ControlAuthorizationPolicy = {
  canDiscover: () => true,
  authorize: () => ({ allowed: true })
}
const errorRegistry = new ControlRegistry(allowAll)
const errorDescriptor = (
  id: string,
  handler: () => never
): ControlDescriptor<Record<string, never>, never> => ({
  id,
  version: 1,
  kind: 'query',
  description: 'Exercise cross-domain error mapping.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: { type: 'object', additionalProperties: false, properties: {} },
  allowedSurfaces: ['mcp'],
  permission: 'identity.read',
  scope: { kind: 'self' },
  risk: { tier: 0, label: 'read' },
  declaredEffects: [],
  validateInput: (input): input is Record<string, never> =>
    input != null &&
    typeof input === 'object' &&
    !Array.isArray(input) &&
    Object.keys(input).length === 0,
  handler
})
errorRegistry.register(errorDescriptor('test.workspaceError', () => unreachableOrchestration()))
errorRegistry.register(errorDescriptor('test.terminalError', () => unreachableTerminal()))
errorRegistry.register(errorDescriptor('test.settingsError', () => unreachableSettings()))
const errorContext = context(DEFAULT_RUNTIME_CONTROL_PERMISSIONS)
for (const [id, code] of [
  ['test.workspaceError', 'conflict'],
  ['test.terminalError', 'unavailable'],
  ['test.settingsError', 'not_found']
] as const) {
  const result = await errorRegistry.invoke({ id, input: {}, context: errorContext })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, code)
}
function unreachableOrchestration(): never {
  throw orchestrationError('conflict', 'workspace conflict')
}
function unreachableTerminal(): never {
  throw terminalObservationError('unavailable', 'terminal unavailable')
}
function unreachableSettings(): never {
  throw new SettingsResourceError('not_found', 'settings target missing')
}

const redacted = recursivelyRedact({
  authorization: 'Bearer secret-value',
  nested: { token: 'github_pat_123456789', message: 'safe' }
})
assert.doesNotMatch(JSON.stringify(redacted), /secret-value|github_pat_123456789/)
assert.match(JSON.stringify(redacted), /safe/)

const root = join(import.meta.dir, '..')
const mainSource = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
const schemaSource = readFileSync(join(root, 'src/main/db/schema.ts'), 'utf8')
const workspacesSource = readFileSync(join(root, 'src/main/workspaces.ts'), 'utf8')
const phase8QaSource = readFileSync(join(root, 'src/main/automations/phase8Qa.ts'), 'utf8')
const notifySource = readFileSync(join(root, 'src/main/orpheusNotify.ts'), 'utf8')
const commandServerSource = readFileSync(join(root, 'src/main/commandServer.ts'), 'utf8')
for (const marker of [
  'new RendererCommandBroker(',
  'createMainTerminalObservation({',
  'createMainSettingsResourceService()',
  'createPhase456QaGrantSource({',
  'createAutomationRuntime({',
  'automationScheduler.start()',
  'automationScheduler?.stop()',
  'terminalObservationCleanup?.()'
]) {
  assert.equal(
    mainSource.split(marker).length - 1,
    1,
    `main lifecycle marker must occur once: ${marker}`
  )
}
for (const marker of [
  'recordWorkspaceLifecycle(',
  'recordWorkbenchLifecycle(',
  'recordPaneLifecycle('
]) {
  assert.ok(mainSource.includes(marker), `main must publish terminal lifecycle events: ${marker}`)
}
for (const table of [
  'automation_definitions:',
  'automation_runs:',
  'automation_event_occurrences:'
]) {
  assert.ok(schemaSource.includes(table), `desired DB schema must include ${table}`)
}
assert.ok(
  notifySource.indexOf('setWorkspaceStatus(workspaceId, status,') <
    notifySource.indexOf('committedStatusObservers.forEach'),
  'committed workspace observers must run only after the transactional status write'
)
const notifyDispatchSource = notifySource.slice(
  notifySource.indexOf('function dispatch('),
  notifySource.indexOf('// Permission-prompt messages')
)
assert.ok(notifyDispatchSource.includes('const cachedOldStatus = activityMap.get(workspaceId)'))
assert.ok(
  notifyDispatchSource.indexOf('observer(workspaceId, oldStatus, status, workspace)') <
    notifyDispatchSource.indexOf('committedStatusObservers.forEach'),
  'the transactional outbox must receive the persisted old status'
)
assert.ok(
  notifyDispatchSource.indexOf('committedStatusObservers.forEach') <
    notifyDispatchSource.indexOf('if (cachedOldStatus === status) return'),
  'post-commit outbox draining must use persistence state before cache gating'
)
assert.ok(
  notifyDispatchSource.includes('obs(workspaceId, cachedOldStatus, status)') &&
    notifyDispatchSource.includes('notifyForTransition(workspaceId, cachedOldStatus, status)'),
  'in-memory observers and notifications must retain cached-old transition semantics'
)
const clearActivitySource = notifySource.slice(
  notifySource.indexOf('export function clearWorkspaceActivity('),
  notifySource.indexOf('export function getWorkspaceActivity(')
)
assert.ok(
  clearActivitySource.indexOf('activityMap.delete(workspaceId)') <
    clearActivitySource.indexOf("dispatch(workspaceId, 'idle')"),
  'clearing activity must force a fresh cached idle transition'
)
assert.ok(workspacesSource.includes("db.exec('BEGIN IMMEDIATE')"))
assert.ok(
  workspacesSource.indexOf('beforeCommit?.(existing.status, workspace)') <
    workspacesSource.indexOf("db.exec('COMMIT')"),
  'the event outbox hook must run inside the workspace status transaction'
)
assert.ok(mainSource.includes('subscribePersisting: onWorkspaceStatusPersisting'))
assert.ok(mainSource.includes('capturePhase8QaConfig(process.env, APP_NAME)'))
for (const key of [
  'ORPHEUS_PHASE8_QA',
  'ORPHEUS_PHASE8_QA_WORKSPACE_ID',
  'ORPHEUS_PHASE8_QA_TOKEN'
]) {
  assert.ok(phase8QaSource.includes(key))
}
assert.ok(mainSource.includes("process.env['ORPHEUS_PHASE456_QA']"))
assert.ok(mainSource.includes("process.env['ORPHEUS_PHASE456_QA_SCOPE']"))
assert.ok(mainSource.includes("delete process.env['ORPHEUS_PHASE456_QA']"))
assert.ok(mainSource.includes("delete process.env['ORPHEUS_PHASE456_QA_SCOPE']"))
assert.ok(
  mainSource.includes('getRuntimeBinding: (runtimeId) => runtimeLeases.getByRuntimeId(runtimeId)')
)
assert.ok(mainSource.includes('APP_NAME'))
assert.ok(commandServerSource.includes('if (phase8Qa != null)'))

const automationDescriptions = allDescriptions.filter(({ allowedSurfaces }) =>
  allowedSurfaces.includes('automation')
)
assert.deepEqual(
  automationDescriptions.map(({ id }) => id),
  ['resources.listProjectMetadata', 'settings.getEffective']
)
console.log(
  JSON.stringify({
    registered: allDescriptions.length,
    mcp: mcpIds.length,
    defaults: defaultIds.length,
    explicitPhase456: explicitlyGrantedIds.length,
    automationEligible: automationDescriptions.length
  })
)
console.log('Agentic integration verification passed.')
