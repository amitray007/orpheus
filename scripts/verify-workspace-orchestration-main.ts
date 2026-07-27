import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { bootControlRegistry } from '../src/main/controlPlane/boot.ts'
import { createConfiguredControlRegistry } from '../src/main/controlPlane/configuredRegistry.ts'
import { createTrustedRuntimeReadPolicy } from '../src/main/controlPlane/readPolicy.ts'
import { RuntimeControlGrantPolicy } from '../src/main/controlPlane/runtimeGrants.ts'
import type {
  ControlContext,
  ControlPermission,
  ReadCapabilityHandlers
} from '../src/main/controlPlane/types.ts'
import type { WorkspaceOrchestrationService } from '../src/main/workspaceOrchestration/service.ts'
import { WorkspaceRuntimeCoordinator } from '../src/main/workspaceOrchestration/runtimeCoordinator.ts'
import { WorkspaceOpenRequestQueue } from '../src/main/workspaceOrchestration/openRequestQueue.ts'
import { WaitLifecycleGeneration } from '../src/main/workspaceOrchestration/waitState.ts'

const ALL_RUNTIME_PERMISSIONS = [
  'identity.read',
  'projects.read',
  'workspaces.read',
  'workspaces.create',
  'workspaces.open',
  'workspaces.send',
  'workspaces.wait',
  'workspaces.close',
  'workspaces.rename',
  'workspaces.archive',
  'reviews.read'
] as const satisfies readonly ControlPermission[]

const binding = {
  runtimeId: 'runtime-1',
  runtimeKind: 'claude' as const,
  surfaceId: 'workspace-1',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  claudeConversationId: 'conversation-1',
  issuedAt: 1,
  permissions: ALL_RUNTIME_PERMISSIONS
}
const context: ControlContext = {
  principal: { type: 'workspace-agent', id: binding.runtimeId },
  consumer: 'mcp',
  workspaceId: 'hostile-ambient-workspace',
  projectId: 'hostile-ambient-project',
  requestId: 'request-1',
  trustedRuntime: binding
}

const leaseBinding = {
  runtimeId: 'runtime-1',
  runtimeKind: 'claude' as const,
  surfaceId: 'workspace-1',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  claudeConversationId: 'conversation-1',
  parentWorkspaceId: null,
  forkedFromConversationId: null,
  issuedAt: 1,
  state: 'live' as const,
  pid: 42
}

const observation = <T>(
  value: T
): {
  value: T
  source: 'sqlite'
  observedAt: number
  sourceUpdatedAt: number
  availability: 'available'
  stale: false
} => ({
  value,
  source: 'sqlite' as const,
  observedAt: 1,
  sourceUpdatedAt: 1,
  availability: 'available' as const,
  stale: false
})
const reads = {
  getSelf: () => observation(null),
  listProjects: () => observation([]),
  getProject: () => observation(null),
  listWorkspaces: () => observation([]),
  getWorkspace: () => observation(null),
  getWorkspaceStatus: () => observation(null),
  getWorkspaceTranscript: () => observation(null),
  getWorkspaceLastTurn: () => observation(null),
  listReviewsByWorkspace: () => []
} as unknown as ReadCapabilityHandlers

let lineageCalls = 0
let waitCalls = 0
const workspaceService = {
  auditRejected: () => undefined,
  getLineage: () => {
    lineageCalls++
    return {
      workspace: {
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        name: 'One',
        mode: 'local',
        cwd: '/project',
        parentWorkspaceId: null,
        closedAt: null,
        archivedAt: null
      },
      ancestors: [],
      children: []
    }
  },
  create: () => {
    throw new Error('not used')
  },
  startTask: () => {
    throw new Error('not used')
  },
  open: () => {
    throw new Error('not used')
  },
  send: () => {
    throw new Error('not used')
  },
  wait: () => {
    waitCalls++
    return {
      schemaVersion: 1,
      requestedUntil: 'done',
      timedOut: false,
      results: []
    }
  },
  close: () => {
    throw new Error('not used')
  },
  reopen: () => {
    throw new Error('not used')
  },
  rename: () => {
    throw new Error('not used')
  },
  archive: () => {
    throw new Error('not used')
  }
} as unknown as WorkspaceOrchestrationService

const registry = createConfiguredControlRegistry({
  authorization: createTrustedRuntimeReadPolicy({
    getWorkspaceProjectId: (workspaceId) => (workspaceId === 'workspace-1' ? 'project-1' : null)
  }),
  workspaceOrchestration: workspaceService
})
bootControlRegistry(
  registry,
  {
    listByWorkspace: reads.listReviewsByWorkspace,
    setResolved: () => {
      throw new Error('not exposed')
    }
  },
  reads,
  workspaceService
)

const toolIds = registry.listForContext(context).map((description) => description.id)
assert.equal(toolIds.length, 19)
assert.deepEqual(
  toolIds.filter((id) => id.startsWith('workspaces.')),
  [
    'workspaces.archive',
    'workspaces.close',
    'workspaces.create',
    'workspaces.get',
    'workspaces.getLastTurn',
    'workspaces.getLineage',
    'workspaces.getStatus',
    'workspaces.getTranscript',
    'workspaces.list',
    'workspaces.open',
    'workspaces.rename',
    'workspaces.reopen',
    'workspaces.send',
    'workspaces.startTask',
    'workspaces.wait'
  ]
)
assert.equal(
  (
    await registry.invoke({
      id: 'workspaces.getLineage',
      input: {},
      context
    })
  ).ok,
  true
)
assert.equal(lineageCalls, 1)

const overBoundWait = await registry.invoke({
  id: 'workspaces.wait',
  input: { timeoutMs: 25_001 },
  context
})
assert.equal(overBoundWait.ok ? null : overBoundWait.code, 'invalid')
assert.equal(waitCalls, 0)

const contextWithPermissions = (permissions: readonly ControlPermission[]): ControlContext => ({
  ...context,
  trustedRuntime: { ...binding, permissions }
})
const defaultGrantPolicy = new RuntimeControlGrantPolicy()
const defaultToolIds = registry
  .listForContext(contextWithPermissions(defaultGrantPolicy.permissionsFor(leaseBinding)))
  .map(({ id }) => id)
assert.equal(defaultToolIds.length, 11)
assert.ok(defaultToolIds.includes('workspaces.getLineage'))
assert.ok(defaultToolIds.includes('workspaces.wait'))
assert.equal(defaultToolIds.includes('workspaces.create'), false)
assert.equal(defaultToolIds.includes('workspaces.archive'), false)

const tier2GrantPolicy = new RuntimeControlGrantPolicy(() => ({
  permissions: ALL_RUNTIME_PERMISSIONS,
  maxRiskTier: 2
}))
const tier2ToolIds = registry
  .listForContext(contextWithPermissions(tier2GrantPolicy.permissionsFor(leaseBinding)))
  .map(({ id }) => id)
assert.ok(tier2ToolIds.includes('workspaces.create'))
assert.ok(tier2ToolIds.includes('workspaces.send'))
assert.equal(tier2ToolIds.includes('workspaces.archive'), false)

const tier3GrantPolicy = new RuntimeControlGrantPolicy(() => ({
  permissions: ['workspaces.archive'],
  maxRiskTier: 3
}))
const tier3ToolIds = registry
  .listForContext(contextWithPermissions(tier3GrantPolicy.permissionsFor(leaseBinding)))
  .map(({ id }) => id)
assert.ok(tier3ToolIds.includes('workspaces.archive'))

for (const description of registry
  .listForContext(context)
  .filter(({ id }) => id === 'workspaces.getLineage' || id === 'workspaces.wait')) {
  assert.equal(description.allowedSurfaces.includes('renderer'), true)
}

const phase = { value: 'none' as 'none' | 'attached' }
let openRequests = 0
let sentText = ''
let submitCount = 0
let destroyCount = 0
const runtime = new WorkspaceRuntimeCoordinator({
  requestOpen: () => {
    openRequests++
    phase.value = 'attached'
  },
  getSurfacePhase: () => phase.value,
  isSessionReady: () => phase.value === 'attached',
  canInject: () => true,
  sendInput: (_workspaceId, text) => {
    sentText = text
    return { ok: true }
  },
  submit: () => {
    submitCount++
    return { ok: true }
  },
  withInjectLock: async (_workspaceId, action) => action(),
  destroyRuntime: () => {
    destroyCount++
    phase.value = 'none'
  }
})
const snapshot = {
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  name: 'One',
  mode: 'local' as const,
  cwd: '/project',
  parentWorkspaceId: null,
  closedAt: null,
  archivedAt: null,
  revision: '1',
  claudeConversationId: 'conversation-1',
  forkedFromConversationId: null,
  worktreeParentCwd: null,
  worktreeBranch: null
}
const started = await runtime.ensureOpen(snapshot)
assert.equal(started.runtimeState, 'started')
assert.equal(openRequests, 1)
assert.equal(await runtime.waitUntilReady(snapshot.workspaceId, Date.now() + 10), true)
await runtime.sendText(snapshot.workspaceId, 'ship it', true)
assert.equal(sentText, 'ship it')
assert.equal(submitCount, 1)
assert.equal((await runtime.ensureOpen(snapshot)).runtimeState, 'retained')
await runtime.teardown(snapshot.workspaceId)
assert.equal(destroyCount, 1)

const openQueue = new WorkspaceOpenRequestQueue()
const deliveredOpenRequests: Array<{ workspaceId: string; focus: boolean }> = []
let rendererReady = false
const deliverOpenRequest = (request: { workspaceId: string; focus: boolean }): boolean => {
  if (!rendererReady) return false
  deliveredOpenRequests.push(request)
  return true
}
openQueue.request('cold-workspace', false, deliverOpenRequest)
openQueue.request('cold-workspace', true, deliverOpenRequest)
openQueue.request('cancelled-workspace', false, deliverOpenRequest)
assert.equal(openQueue.cancel('cancelled-workspace'), true)
assert.equal(openQueue.cancel('cancelled-workspace'), false)
assert.equal(openQueue.size, 1)
assert.deepEqual(deliveredOpenRequests, [])
rendererReady = true
assert.equal(openQueue.flush(deliverOpenRequest), 1)
assert.deepEqual(deliveredOpenRequests, [{ workspaceId: 'cold-workspace', focus: true }])
assert.equal(openQueue.flush(deliverOpenRequest), 0)

const closedGeneration = new WaitLifecycleGeneration()
closedGeneration.markAlive('reopened-workspace', 0)
assert.equal(closedGeneration.shouldReportDied('reopened-workspace', 3_000, 3_000), true)
closedGeneration.dispose()
const reopenedGeneration = new WaitLifecycleGeneration()
assert.equal(reopenedGeneration.shouldReportDied('reopened-workspace', 3_000, 3_000), false)

const repoRoot = path.resolve(import.meta.dirname, '..')
const commandServerSource = fs.readFileSync(
  path.join(repoRoot, 'src/main/commandServer.ts'),
  'utf8'
)
assert.match(commandServerSource, /workspaceOrchestration\.create/)
assert.match(commandServerSource, /workspaceOrchestration\.startTask/)
assert.match(commandServerSource, /workspaceOrchestration\.open/)
assert.match(commandServerSource, /workspaceOrchestration\.send/)
assert.match(commandServerSource, /workspaceOrchestration\.close/)
assert.match(commandServerSource, /workspaceOrchestration\.reopen/)
assert.match(commandServerSource, /workspaceOrchestration\.rename/)
assert.match(commandServerSource, /workspaceOrchestration\.archive/)
assert.match(
  commandServerSource,
  /if \(taskText == null\) \{[\s\S]*?deps\.requestOpenWorkspace\(workspaceId, focus\)[\s\S]*?\} else if \(submit\)/
)
assert.match(commandServerSource, /key != null \|\| text == null/)
assert.match(commandServerSource, /SERVER_MAX_TIMEOUT_MS = 60 \* 60 \* 1000/)
assert.match(commandServerSource, /req\.socket\.setTimeout\(0\)/)
assert.match(commandServerSource, /JSON\.stringify\(frame\) \+ '\\n'/)
assert.match(commandServerSource, /legacyWaitReason\(until, observation\)/)
assert.match(commandServerSource, /cannot close the workspace running this command/)
assert.match(commandServerSource, /collectWorkspaceSubtreeIds/)
assert.match(commandServerSource, /targets\.includes\(context\.workspaceId\)/)
const mainAdapterSource = fs.readFileSync(
  path.join(repoRoot, 'src/main/workspaceOrchestration/mainAdapter.ts'),
  'utf8'
)
assert.match(mainAdapterSource, /lastTerminalTitles\.set\(workspaceId, getTitle\(workspaceId\)/)
assert.match(mainAdapterSource, /closeWorkspace\(workspaceId, takeLastTitle\(workspaceId\)\)/)

console.log('Workspace orchestration main integration verification passed.')
