import assert from 'node:assert/strict'
import { ControlRegistry } from '../src/main/controlPlane/registry.ts'
import { bootControlRegistry } from '../src/main/controlPlane/boot.ts'
import { createConfiguredControlRegistry } from '../src/main/controlPlane/configuredRegistry.ts'
import {
  createWorkspaceCapabilities,
  createWorkspaceRejectionAuditor,
  WORKSPACE_OPERATION_IDS
} from '../src/main/controlPlane/workspaceCapabilities.ts'
import { withWorkspaceMutationPolicy } from '../src/main/controlPlane/workspacePolicy.ts'
import { WorkspaceOrchestrationService } from '../src/main/workspaceOrchestration/service.ts'
import { recursivelyRedact } from '../src/main/workspaceOrchestration/redaction.ts'
import type {
  CloseWorkspaceValue,
  WorkspaceControlAuditRecord,
  WorkspaceMutationLease,
  WorkspaceMutationLeasePort,
  WorkspaceCreateRecord,
  WorkspaceOperationActor,
  WorkspaceOperationReceipt,
  WorkspaceOrchestrationPorts,
  WorkspaceSnapshot
} from '../src/main/workspaceOrchestration/types.ts'
import type {
  ControlAuthorizationPolicy,
  ControlContext,
  ControlPermission
} from '../src/main/controlPlane/types.ts'

const permissions: ControlPermission[] = [
  'workspaces.read',
  'workspaces.create',
  'workspaces.open',
  'workspaces.send',
  'workspaces.wait',
  'workspaces.close',
  'workspaces.rename',
  'workspaces.archive'
]

let now = 1_000
let id = 0
const audits: WorkspaceControlAuditRecord[] = []
const effectLog: string[] = []
const leaseKeys: string[] = []
const createRecords: WorkspaceCreateRecord[] = []
const workspaces = new Map<string, WorkspaceSnapshot>()
const project = { projectId: 'project-1', cwd: '/repo', revision: 'p1' }

function workspace(
  workspaceId: string,
  overrides: Partial<WorkspaceSnapshot> = {}
): WorkspaceSnapshot {
  return {
    workspaceId,
    projectId: 'project-1',
    name: workspaceId,
    mode: 'local',
    cwd: '/repo',
    parentWorkspaceId: null,
    closedAt: null,
    archivedAt: null,
    revision: `${workspaceId}:1`,
    claudeConversationId: `${workspaceId}:conversation`,
    forkedFromConversationId: null,
    worktreeParentCwd: null,
    worktreeBranch: null,
    ...overrides
  }
}

workspaces.set('self', workspace('self'))
workspaces.set(
  'other-project',
  workspace('other-project', { projectId: 'project-2', cwd: '/other' })
)

function update(
  workspaceId: string,
  expectedRevision: string,
  changes: Partial<WorkspaceSnapshot>
): WorkspaceSnapshot | null {
  const current = workspaces.get(workspaceId)
  if (current == null || current.revision !== expectedRevision) return null
  const next = {
    ...current,
    ...changes,
    revision: `${workspaceId}:${Number(current.revision.split(':')[1] ?? 0) + 1}`
  }
  workspaces.set(workspaceId, next)
  return next
}

let failRemoveId: string | null = null
let failCreate = false
let rollbackCreateSucceeds = true
let rollbackCreateThrows = false
let auditAppendThrows = false
let auditAppendAttempts = 0
const ports: WorkspaceOrchestrationPorts = {
  store: {
    getProject: (projectId) => (projectId === project.projectId ? project : null),
    getWorkspace: (workspaceId) => workspaces.get(workspaceId) ?? null,
    listChildren: (workspaceId) =>
      [...workspaces.values()].filter((candidate) => candidate.parentWorkspaceId === workspaceId),
    create: (record) => {
      if (failCreate) {
        failCreate = false
        throw new Error('injected db create failure')
      }
      createRecords.push({ ...record })
      const created = workspace(record.workspaceId, {
        projectId: record.projectId,
        name: record.name,
        cwd: record.cwd,
        mode: record.worktreeParentCwd == null ? 'local' : 'worktree',
        parentWorkspaceId: record.parentWorkspaceId,
        forkedFromConversationId: record.forkedFromConversationId,
        worktreeParentCwd: record.worktreeParentCwd,
        worktreeBranch: record.worktreeBranch
      })
      workspaces.set(created.workspaceId, created)
      effectLog.push(`db.create:${created.workspaceId}`)
      return created
    },
    markOpened: (workspaceId, revision) => update(workspaceId, revision, {}),
    close: (workspaceId, revision) => update(workspaceId, revision, { closedAt: now }),
    reopen: (workspaceId, revision) => update(workspaceId, revision, { closedAt: null }),
    rename: (workspaceId, name, revision) => update(workspaceId, revision, { name }),
    remove: (workspaceId, revision) => {
      const current = workspaces.get(workspaceId)
      if (current?.revision !== revision || workspaceId === failRemoveId) return false
      effectLog.push(`db.remove:${workspaceId}`)
      return workspaces.delete(workspaceId)
    }
  },
  runtime: {
    ensureOpen: (target) => {
      effectLog.push(`ensureOpen:${target.workspaceId}`)
      return {
        runtimeState: 'started',
        effects: [
          { effect: 'surface.mount', status: 'applied', workspaceId: target.workspaceId },
          { effect: 'process.spawn', status: 'applied', workspaceId: target.workspaceId }
        ]
      }
    },
    waitUntilReady: () => true,
    sendText: (workspaceId) => {
      effectLog.push(`send:${workspaceId}`)
    },
    canTeardown: () => true,
    teardown: (workspaceId) => ({
      effects: [
        { effect: 'process.terminate', status: 'skipped', workspaceId },
        { effect: 'surface.destroy', status: 'skipped', workspaceId }
      ]
    })
  },
  worktrees: {
    derivePath: ({ workspaceId }) => `/managed/${workspaceId}`,
    create: ({ path, branch }) => ({
      path: `${path}-collision-2`,
      branch: branch ?? 'managed-branch'
    }),
    rollbackCreate: () => {
      if (rollbackCreateThrows) throw new Error('injected rollback failure')
      return rollbackCreateSucceeds
    },
    preflightRemove: () => ({ safe: true, dirty: false }),
    remove: () => true
  },
  presentation: {
    focus: (workspaceId) => {
      effectLog.push(`focus:${workspaceId}`)
    }
  },
  waits: {
    createSession: () => ({
      observe: () => ({ status: 'idle', outcome: 'done' }),
      waitForChange: () => {
        now += 1
      },
      dispose: () => {}
    })
  },
  authorization: {
    revalidate: () => 'allow',
    isRuntimeLeaseActive: () => true
  },
  leases: {
    acquire: (key) => {
      leaseKeys.push(key)
      return { release: () => {} }
    },
    acquireWhenAvailable: (key) => {
      leaseKeys.push(key)
      return { release: () => {} }
    }
  },
  audit: {
    append: (record) => {
      auditAppendAttempts++
      if (auditAppendThrows) throw new Error('injected audit persistence failure')
      audits.push(record)
    }
  },
  onAuditFailure: () => {
    throw new Error('injected audit failure reporter failure')
  },
  now: () => now,
  generateId: () => `generated-${++id}`
}

const service = new WorkspaceOrchestrationService(ports)
const allowLocal: ControlAuthorizationPolicy = {
  canDiscover: () => true,
  authorize: () => ({ allowed: true })
}
const registry = new ControlRegistry(
  withWorkspaceMutationPolicy(allowLocal),
  createWorkspaceRejectionAuditor(service)
)
for (const capability of createWorkspaceCapabilities(service)) registry.register(capability)

const context: ControlContext = {
  principal: { type: 'workspace-agent', id: 'ignored-ambient-principal' },
  consumer: 'mcp',
  workspaceId: 'hostile-ambient-workspace',
  projectId: 'hostile-ambient-project',
  requestId: 'request-1',
  trustedRuntime: {
    runtimeId: 'runtime-1',
    runtimeKind: 'claude',
    surfaceId: 'surface-1',
    workspaceId: 'self',
    projectId: 'project-1',
    claudeConversationId: 'self:conversation',
    issuedAt: now,
    permissions
  }
}

const descriptions = registry
  .listForContext(context)
  .filter(({ id }) => id.startsWith('workspaces.'))
assert.equal(descriptions.length, 10)
for (const description of descriptions) {
  assert.equal(description.version, 1)
  assert.equal(description.inputSchema['additionalProperties'], false)
  assert.ok(Array.isArray(description.declaredEffects))
  assert.equal(description.outputSchema['additionalProperties'], false)
  if (description.id !== 'workspaces.getLineage' && description.id !== 'workspaces.wait') {
    const outputProperties = description.outputSchema['properties'] as
      | Record<string, Record<string, unknown>>
      | undefined
    assert.equal(outputProperties?.['value']?.['additionalProperties'], false)
  }
}
const createDescription = descriptions.find(
  ({ id: operationId }) => operationId === 'workspaces.create'
)
assert.ok(Array.isArray(createDescription?.inputSchema['oneOf']))
assert.deepEqual(descriptions.find(({ id }) => id === 'workspaces.archive')?.declaredEffects, [
  'surface.destroy',
  'process.terminate',
  'git.worktree.remove',
  'filesystem.delete',
  'workspace.delete',
  'db.write'
])

// Configuring workspace orchestration composes mutation authorization and
// rejection auditing automatically; boot registers every frozen descriptor.
const bootRegistry = createConfiguredControlRegistry({
  authorization: allowLocal,
  workspaceOrchestration: service
})
bootControlRegistry(
  bootRegistry,
  {
    listByWorkspace: () => [],
    setResolved: () => {
      throw new Error('not used')
    }
  },
  undefined,
  service
)
assert.deepEqual(
  bootRegistry
    .listForContext(context)
    .map(({ id: operationId }) => operationId)
    .filter((operationId) => operationId.startsWith('workspaces.')),
  [...WORKSPACE_OPERATION_IDS].sort()
)
for (const operationId of WORKSPACE_OPERATION_IDS) {
  const result = await bootRegistry.invoke({
    id: operationId,
    input: { unexpected: true },
    context: { ...context, requestId: `boot-${operationId}` }
  })
  assert.equal(result.ok ? null : result.code, 'invalid')
}

// Tier 2 invalid input is audited once and task text is hashed, never retained.
const invalidAuditBefore = audits.length
const invalidWithText = await registry.invoke({
  id: 'workspaces.send',
  input: { text: 'schema-secret-task', unexpected: true },
  context: { ...context, requestId: 'invalid-audit-once' }
})
assert.equal(invalidWithText.ok ? null : invalidWithText.code, 'invalid')
const invalidAudits = audits.filter(({ requestId }) => requestId === 'invalid-audit-once')
assert.equal(invalidAudits.length, 1)
assert.equal(audits.length, invalidAuditBefore + 1)
assert.equal(JSON.stringify(invalidAudits[0]).includes('schema-secret-task'), false)
assert.equal(invalidAudits[0]?.result.code, 'invalid')

// A policy denial is likewise audited once without entering the service.
if (context.trustedRuntime == null) throw new Error('test runtime binding missing')
const deniedContext: ControlContext = {
  ...context,
  requestId: 'policy-denied-once',
  trustedRuntime: {
    ...context.trustedRuntime,
    permissions: permissions.filter((permission) => permission !== 'workspaces.send')
  }
}
const deniedBefore = audits.length
const denied = await registry.invoke({
  id: 'workspaces.send',
  input: { text: 'policy-secret-task' },
  context: deniedContext
})
assert.equal(denied.ok ? null : denied.code, 'forbidden')
const deniedAudits = audits.filter(({ requestId }) => requestId === 'policy-denied-once')
assert.equal(deniedAudits.length, 1)
assert.equal(audits.length, deniedBefore + 1)
assert.equal(JSON.stringify(deniedAudits[0]).includes('policy-secret-task'), false)

for (const [operationId, input] of [
  ['workspaces.create', { mode: 'local', cwd: '/caller-controlled' }],
  ['workspaces.send', { text: 'hello', bytes: [1, 2] }],
  ['workspaces.archive', { workspaceId: 'self', force: true }],
  ['workspaces.wait', { timeoutMs: 25_001 }]
] as const) {
  const result = await registry.invoke({ id: operationId, input, context })
  assert.equal(result.ok ? null : result.code, 'invalid')
}

const created = await registry.invoke<Awaited<ReturnType<typeof service.create>>>({
  id: 'workspaces.create',
  input: { mode: 'local', fork: true },
  context
})
assert.equal(created.ok, true)
if (!created.ok) throw new Error('create unexpectedly failed')
assert.equal(created.value.value.workspace.cwd, '/repo')
assert.equal(created.value.value.presentation, 'background')
assert.equal(created.value.value.lineage.parentWorkspaceId, 'self')
assert.equal(created.value.value.lineage.forkedFromConversationId, 'self:conversation')
assert.equal(
  createRecords.find(({ workspaceId }) => workspaceId === created.value.value.workspace.workspaceId)
    ?.nameIsAuto,
  true
)
assert.equal(
  effectLog.some((effect) => effect.startsWith('ensureOpen:')),
  false
)

const createdId = created.value.value.workspace.workspaceId
const namedFork = await registry.invoke<Awaited<ReturnType<typeof service.create>>>({
  id: 'workspaces.create',
  input: { mode: 'local', fork: true, name: 'Named fork' },
  context: { ...context, requestId: 'named-fork' }
})
assert.equal(namedFork.ok, true)
if (!namedFork.ok) throw new Error('named fork unexpectedly failed')
assert.equal(
  createRecords.find(
    ({ workspaceId }) => workspaceId === namedFork.value.value.workspace.workspaceId
  )?.nameIsAuto,
  false
)

// Background open, startTask, and send all request a started runtime without
// asking the presentation port to focus it. This models the unmounted path
// used by command-socket --background operations.
context.requestId = 'request-background-open'
const effectsBeforeBackgroundOpen = effectLog.length
const openedInBackground = await registry.invoke({
  id: 'workspaces.open',
  input: { workspaceId: createdId, presentation: 'background' },
  context
})
assert.equal(openedInBackground.ok, true)
assert.deepEqual(effectLog.slice(effectsBeforeBackgroundOpen), [`ensureOpen:${createdId}`])

context.requestId = 'request-2'
const effectsBeforeStartTask = effectLog.length
const started = await registry.invoke({
  id: 'workspaces.startTask',
  input: { workspaceId: createdId, text: 'top secret task text' },
  context
})
assert.equal(started.ok, true)
assert.deepEqual(effectLog.slice(effectsBeforeStartTask), [
  `ensureOpen:${createdId}`,
  `send:${createdId}`
])
const startAudit = audits.find((record) => record.requestId === 'request-2')
assert.ok(startAudit)
assert.equal(JSON.stringify(startAudit).includes('top secret task text'), false)
assert.equal(
  typeof (startAudit.redactedParams['text'] as Record<string, unknown>)['sha256'],
  'string'
)

context.requestId = 'request-background-send'
const effectsBeforeSend = effectLog.length
const sentInBackground = await registry.invoke({
  id: 'workspaces.send',
  input: { workspaceId: createdId, text: 'background send', submit: false },
  context
})
assert.equal(sentInBackground.ok, true)
assert.deepEqual(effectLog.slice(effectsBeforeSend), [
  `ensureOpen:${createdId}`,
  `send:${createdId}`
])
assert.equal(
  effectLog.slice(effectsBeforeBackgroundOpen).some((effect) => effect === `focus:${createdId}`),
  false
)

context.requestId = 'request-3'
const leasesBeforeCrossProject = leaseKeys.length
const crossProject = await registry.invoke({
  id: 'workspaces.rename',
  input: { workspaceId: 'other-project', name: 'leak' },
  context
})
assert.deepEqual(crossProject, {
  ok: false,
  code: 'not_found',
  error: 'Requested resource was not found.'
})
assert.equal(leaseKeys.length, leasesBeforeCrossProject)

// Explicit and trusted-default targets serialize on the same project lease.
await registry.invoke({
  id: 'workspaces.rename',
  input: { workspaceId: createdId, name: 'Explicit target' },
  context: { ...context, requestId: 'lock-explicit' }
})
await registry.invoke({
  id: 'workspaces.rename',
  input: { name: 'Trusted default target' },
  context: { ...context, requestId: 'lock-default' }
})
assert.deepEqual(leaseKeys.slice(-2), ['project:project-1', 'project:project-1'])

context.requestId = 'request-4'
const selfClose = await registry.invoke({
  id: 'workspaces.close',
  input: { workspaceId: 'self' },
  context
})
assert.equal(selfClose.ok ? null : selfClose.code, 'forbidden')

workspaces.set('renderer-self', workspace('renderer-self'))
const rendererClose = await registry.invoke({
  id: 'workspaces.close',
  input: { workspaceId: 'renderer-self' },
  context: {
    principal: { type: 'renderer-user', id: 'local-user' },
    consumer: 'renderer-ipc',
    workspaceId: 'renderer-self',
    projectId: 'project-1',
    requestId: 'renderer-self-close'
  }
})
assert.equal(rendererClose.ok, true)
assert.equal(
  rendererClose.ok
    ? (rendererClose.value as WorkspaceOperationReceipt<CloseWorkspaceValue>).value.closed
    : null,
  true
)
const rendererServiceClose = await service.close(
  { workspaceId: 'renderer-self' },
  {
    requestId: 'renderer-service-self-close',
    consumer: 'renderer-ipc',
    principal: { kind: 'renderer-user', runtimeId: null },
    boundProjectId: 'project-1',
    boundWorkspaceId: 'renderer-self',
    permissions: ['workspaces.close']
  }
)
assert.equal(rendererServiceClose.value.closed, true)

// Collision resolution is owned by the worktree adapter and its actual managed
// path is persisted and returned.
const collisionCreate = await registry.invoke<Awaited<ReturnType<typeof service.create>>>({
  id: 'workspaces.create',
  input: { mode: 'worktree', name: 'Collision' },
  context: { ...context, requestId: 'worktree-collision' }
})
assert.equal(collisionCreate.ok, true)
if (!collisionCreate.ok) throw new Error('collision create unexpectedly failed')
assert.match(collisionCreate.value.value.workspace.cwd, /-collision-2$/)

// A DB failure rolls a created worktree back. If rollback itself fails, the
// operation returns and audits an explicit partial receipt.
failCreate = true
rollbackCreateSucceeds = true
rollbackCreateThrows = false

failCreate = true
rollbackCreateThrows = true
const rollbackThrew = await registry.invoke<Awaited<ReturnType<typeof service.create>>>({
  id: 'workspaces.create',
  input: { mode: 'worktree', name: 'Rollback throws' },
  context: { ...context, requestId: 'rollback-threw' }
})
assert.equal(rollbackThrew.ok, true)
if (!rollbackThrew.ok) throw new Error('throwing rollback did not return a partial receipt')
assert.equal(rollbackThrew.value.status, 'partial')
assert.ok(
  rollbackThrew.value.effects.some(
    ({ effect, status }) => effect === 'git.worktree.remove' && status === 'failed'
  )
)
assert.equal(audits.filter(({ requestId }) => requestId === 'rollback-threw').length, 1)
rollbackCreateThrows = false

const auditAttemptsBeforeFailure = auditAppendAttempts
auditAppendThrows = true
const mutationWithAuditFailure = await service.rename(
  { workspaceId: createdId, name: 'Audit persistence failed' },
  {
    requestId: 'audit-write-failure',
    consumer: 'command-socket',
    principal: { kind: 'cli', runtimeId: null },
    boundProjectId: 'project-1',
    boundWorkspaceId: null,
    permissions: ['workspaces.rename']
  }
)
auditAppendThrows = false
assert.equal(mutationWithAuditFailure.status, 'completed')
assert.equal(mutationWithAuditFailure.value.workspace.name, 'Audit persistence failed')
assert.equal(auditAppendAttempts, auditAttemptsBeforeFailure + 1)
failCreate = true
const rolledBack = await registry.invoke({
  id: 'workspaces.create',
  input: { mode: 'worktree', name: 'Rollback succeeds' },
  context: { ...context, requestId: 'rollback-success' }
})
assert.equal(rolledBack.ok ? null : rolledBack.code, 'failed')
const rollbackSuccessAudit = audits.find(({ requestId }) => requestId === 'rollback-success')
assert.equal(rollbackSuccessAudit?.result.code, 'partial')
assert.ok(
  rollbackSuccessAudit?.receipts.some(
    ({ effect, status }) => effect === 'git.worktree.remove' && status === 'applied'
  )
)

failCreate = true
rollbackCreateSucceeds = false
const rollbackFailed = await registry.invoke<Awaited<ReturnType<typeof service.create>>>({
  id: 'workspaces.create',
  input: { mode: 'worktree', name: 'Rollback fails' },
  context: { ...context, requestId: 'rollback-failed' }
})
assert.equal(rollbackFailed.ok, true)
if (!rollbackFailed.ok) throw new Error('rollback failure did not return a partial receipt')
assert.equal(rollbackFailed.value.status, 'partial')
assert.ok(
  rollbackFailed.value.effects.some(
    ({ effect, status }) => effect === 'filesystem.delete' && status === 'failed'
  )
)
assert.equal(audits.filter(({ requestId }) => requestId === 'rollback-failed').length, 1)
rollbackCreateSucceeds = true

workspaces.set('limit-parent', workspace('limit-parent'))
workspaces.set('limit-child', workspace('limit-child', { parentWorkspaceId: 'limit-parent' }))
const limitedService = new WorkspaceOrchestrationService({
  ...ports,
  maxChildrenPerWorkspace: 1,
  maxLineageDepth: 1
})
const limitedRegistry = new ControlRegistry(
  withWorkspaceMutationPolicy(allowLocal),
  createWorkspaceRejectionAuditor(limitedService)
)
for (const capability of createWorkspaceCapabilities(limitedService)) {
  limitedRegistry.register(capability)
}
const effectsBeforeLimit = effectLog.length
const childLimit = await limitedRegistry.invoke({
  id: 'workspaces.create',
  input: { mode: 'local', parentWorkspaceId: 'limit-parent' },
  context: { ...context, requestId: 'child-limit' }
})
assert.equal(childLimit.ok ? null : childLimit.code, 'conflict')
assert.equal(effectLog.length, effectsBeforeLimit)

workspaces.set('depth-parent', workspace('depth-parent', { parentWorkspaceId: 'self' }))
const depthLimit = await limitedRegistry.invoke({
  id: 'workspaces.create',
  input: { mode: 'local', parentWorkspaceId: 'depth-parent' },
  context: { ...context, requestId: 'depth-limit' }
})
assert.equal(depthLimit.ok ? null : depthLimit.code, 'conflict')
assert.equal(effectLog.length, effectsBeforeLimit)

workspaces.set('root', workspace('root'))
workspaces.set('child', workspace('child', { parentWorkspaceId: 'root' }))
context.requestId = 'request-5'
const nonrecursive = await registry.invoke({
  id: 'workspaces.archive',
  input: { workspaceId: 'root' },
  context
})
assert.equal(nonrecursive.ok ? null : nonrecursive.code, 'conflict')
assert.ok(workspaces.has('root'))
assert.ok(workspaces.has('child'))

failRemoveId = 'root'
context.requestId = 'request-6'
const partial = await registry.invoke<Awaited<ReturnType<typeof service.archive>>>({
  id: 'workspaces.archive',
  input: { workspaceId: 'root', recursive: true },
  context
})
assert.equal(partial.ok, true)
if (!partial.ok) throw new Error('recursive archive unexpectedly failed')
assert.equal(partial.value.status, 'partial')
assert.deepEqual(partial.value.value.order, ['child', 'root'])
assert.equal(workspaces.has('child'), false)
assert.equal(workspaces.has('root'), true)
assert.deepEqual(
  partial.value.value.workspaces.map(({ status }) => status),
  ['archived', 'failed']
)
assert.ok(
  partial.value.effects.some(
    ({ effect, status, workspaceId }) =>
      effect === 'workspace.delete' && status === 'failed' && workspaceId === 'root'
  )
)
assert.equal(
  partial.value.effects.some(
    ({ effect, status, workspaceId }) =>
      effect === 'git.worktree.remove' && status === 'failed' && workspaceId === 'root'
  ),
  false
)

const deeplyRedacted = recursivelyRedact({
  nested: {
    token: 'raw-token',
    task: 'raw task',
    values: [{ environment: { API_KEY: 'raw-key' } }]
  }
})
const serialized = JSON.stringify(deeplyRedacted)
assert.equal(serialized.includes('raw-token'), false)
assert.equal(serialized.includes('raw task'), false)
assert.equal(serialized.includes('raw-key'), false)

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function queuedLeases(): WorkspaceMutationLeasePort {
  const owners = new Map<string, string>()
  const waiters = new Map<
    string,
    Array<{ requestId: string; resolve: (lease: WorkspaceMutationLease) => void }>
  >()
  const createLease = (key: string, requestId: string): WorkspaceMutationLease => ({
    release: () => {
      if (owners.get(key) !== requestId) return
      owners.delete(key)
      const queue = waiters.get(key)
      const next = queue?.shift()
      if (queue?.length === 0) waiters.delete(key)
      if (next == null) return
      owners.set(key, next.requestId)
      next.resolve(createLease(key, next.requestId))
    }
  })
  const acquire = (key: string, requestId: string): WorkspaceMutationLease | null => {
    if (owners.has(key)) return null
    owners.set(key, requestId)
    return createLease(key, requestId)
  }
  return {
    acquire,
    acquireWhenAvailable: (key, requestId) => {
      const lease = acquire(key, requestId)
      if (lease != null) return lease
      return new Promise((resolve) => {
        const queue = waiters.get(key) ?? []
        queue.push({ requestId, resolve })
        waiters.set(key, queue)
      })
    }
  }
}

const rendererActor: WorkspaceOperationActor = {
  requestId: 'renderer-race',
  consumer: 'renderer-ipc',
  principal: { kind: 'renderer-user', runtimeId: null },
  boundProjectId: 'project-1',
  boundWorkspaceId: null,
  permissions: ['workspaces.close', 'workspaces.archive']
}

// A renderer acknowledgement arriving after close teardown waits for the same
// project lease. It cannot revise the row inside close's critical section; once
// close completes, acknowledgement reopens/marks it and the renderer mount
// restores the runtime for the open row.
{
  const rows = new Map<string, WorkspaceSnapshot>([['close-race', workspace('close-race')]])
  const teardownReached = deferred()
  const continueClose = deferred()
  let runtimeAlive = true
  let markOpenedCalls = 0
  const updateRaceRow = (
    workspaceId: string,
    revision: string,
    changes: Partial<WorkspaceSnapshot>
  ): WorkspaceSnapshot | null => {
    const current = rows.get(workspaceId)
    if (current?.revision !== revision) return null
    const updated = {
      ...current,
      ...changes,
      revision: `${workspaceId}:${Number(current.revision.split(':').at(-1) ?? 0) + 1}`
    }
    rows.set(workspaceId, updated)
    return updated
  }
  const raceService = new WorkspaceOrchestrationService({
    ...ports,
    store: {
      ...ports.store,
      getWorkspace: (workspaceId) => rows.get(workspaceId) ?? null,
      listChildren: () => [],
      markOpened: (workspaceId, revision) => {
        markOpenedCalls++
        return updateRaceRow(workspaceId, revision, {
          lastOpenedAt: 9
        } as Partial<WorkspaceSnapshot>)
      },
      close: (workspaceId, revision) => updateRaceRow(workspaceId, revision, { closedAt: 8 }),
      reopen: (workspaceId, revision) => updateRaceRow(workspaceId, revision, { closedAt: null }),
      remove: (workspaceId, revision) => {
        if (rows.get(workspaceId)?.revision !== revision) return false
        return rows.delete(workspaceId)
      }
    },
    runtime: {
      ...ports.runtime,
      teardown: async (workspaceId) => {
        runtimeAlive = false
        teardownReached.resolve()
        await continueClose.promise
        return {
          effects: [
            { effect: 'surface.destroy', status: 'applied', workspaceId },
            { effect: 'process.terminate', status: 'applied', workspaceId }
          ]
        }
      }
    },
    leases: queuedLeases()
  })
  const closePromise = raceService.close({ workspaceId: 'close-race' }, rendererActor)
  await teardownReached.promise
  const acknowledgePromise = raceService.acknowledgeRendererOpen('close-race')
  let acknowledged = false
  void acknowledgePromise.then(() => {
    acknowledged = true
  })
  await Promise.resolve()
  assert.equal(acknowledged, false)
  assert.equal(markOpenedCalls, 0)
  continueClose.resolve()
  await closePromise
  const acknowledgedWorkspace = await acknowledgePromise
  runtimeAlive = true // renderer terminal.mount after the acknowledgement response
  assert.equal(acknowledgedWorkspace.closedAt, null)
  assert.equal(rows.get('close-race')?.closedAt, null)
  assert.equal(runtimeAlive, true)
}

// A renderer acknowledgement arriving after worktree removal also waits. The
// archive finishes its record delete before acknowledgement rereads, so the
// acknowledgement is not_found and no retained row points at the deleted cwd.
{
  const rows = new Map<string, WorkspaceSnapshot>([
    [
      'archive-race',
      workspace('archive-race', {
        mode: 'worktree',
        cwd: '/managed/archive-race',
        worktreeParentCwd: '/repo',
        worktreeBranch: 'archive-race'
      })
    ]
  ])
  const worktreeRemoved = deferred()
  const continueArchive = deferred()
  let cwdExists = true
  let markOpenedCalls = 0
  const raceService = new WorkspaceOrchestrationService({
    ...ports,
    store: {
      ...ports.store,
      getWorkspace: (workspaceId) => rows.get(workspaceId) ?? null,
      listChildren: () => [],
      markOpened: (workspaceId, revision) => {
        markOpenedCalls++
        const current = rows.get(workspaceId)
        if (current?.revision !== revision) return null
        const updated = { ...current, revision: `${workspaceId}:opened` }
        rows.set(workspaceId, updated)
        return updated
      },
      remove: (workspaceId, revision) => {
        if (rows.get(workspaceId)?.revision !== revision) return false
        return rows.delete(workspaceId)
      }
    },
    runtime: {
      ...ports.runtime,
      teardown: (workspaceId) => ({
        effects: [
          { effect: 'surface.destroy', status: 'applied', workspaceId },
          { effect: 'process.terminate', status: 'applied', workspaceId }
        ]
      })
    },
    worktrees: {
      ...ports.worktrees,
      remove: async () => {
        cwdExists = false
        worktreeRemoved.resolve()
        await continueArchive.promise
        return true
      }
    },
    leases: queuedLeases()
  })
  const archivePromise = raceService.archive(
    { workspaceId: 'archive-race', recursive: false },
    rendererActor
  )
  await worktreeRemoved.promise
  const acknowledgePromise = raceService.acknowledgeRendererOpen('archive-race')
  let acknowledged = false
  void acknowledgePromise.then(
    () => {
      acknowledged = true
    },
    () => {}
  )
  await Promise.resolve()
  assert.equal(acknowledged, false)
  assert.equal(markOpenedCalls, 0)
  continueArchive.resolve()
  const archived = await archivePromise
  assert.equal(archived.status, 'completed')
  await assert.rejects(
    acknowledgePromise,
    (error: unknown) =>
      error instanceof Error && 'code' in error && (error as { code: string }).code === 'not_found'
  )
  assert.equal(rows.has('archive-race'), false)
  assert.equal(cwdExists, false)
}

console.log('Workspace orchestration foundation verification passed.')
