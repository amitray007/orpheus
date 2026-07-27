import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { invoke as invokeAction, register } from '../src/main/actions/registry.ts'
import type {
  ActionAuditEntry,
  ActionInvocation,
  ProjectRecord,
  WorkspaceRecord
} from '../src/shared/types.ts'
import type {
  ControlInvocation,
  ControlInvoker,
  ControlResult
} from '../src/main/controlPlane/types.ts'
import {
  archiveWorkspaceForRenderer,
  closeWorkspaceForRenderer,
  reopenWorkspaceForRenderer,
  rendererWorkspaceContext,
  WorkspaceControlAdapter,
  WorkspaceControlAdapterError
} from '../src/main/workspaceControlAdapter.ts'
import type {
  ArchiveWorkspaceValue,
  CreateWorkspaceValue,
  WorkspaceOperationReceipt
} from '../src/main/workspaceOrchestration/types.ts'

const repoRoot = path.resolve(import.meta.dirname, '..')
const readRepoFile = (relativePath: string): string =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')

function project(id = 'project-1'): ProjectRecord {
  return {
    id,
    path: `/projects/${id}`,
    name: id,
    claudeEncodedName: null,
    addedAt: 1,
    lastOpenedAt: null,
    expandedInSidebar: true,
    sortOrder: null,
    pinnedAt: null,
    githubOwner: null,
    githubRepo: null,
    githubAvatarUrl: null,
    githubCheckedAt: null,
    classified: false,
    hidden: false
  }
}

function workspace(id: string, overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    id,
    projectId: 'project-1',
    name: id,
    nameIsAuto: false,
    cwd: `/projects/project-1/${id}`,
    pinnedAt: null,
    createdAt: 1,
    lastOpenedAt: null,
    archivedAt: null,
    closedAt: null,
    sortOrder: null,
    status: 'idle',
    claudeSessionId: `${id}-session`,
    forkedFromSessionId: null,
    lastTitle: null,
    parentWorkspaceId: null,
    worktreeParentCwd: null,
    worktreeBranch: null,
    ...overrides
  }
}

function receipt<T>(
  operationId: string,
  value: T,
  status: 'completed' | 'partial' = 'completed'
): WorkspaceOperationReceipt<T> {
  return {
    schemaVersion: 1,
    requestId: 'request-result',
    operationId,
    status,
    target: { projectId: 'project-1', workspaceId: null },
    value,
    effects: [],
    auditId: 'audit-control'
  }
}

const projects = new Map([['project-1', project()]])
const workspaces = new Map<string, WorkspaceRecord>([
  ['parent', workspace('parent', { name: 'Parent' })],
  [
    'dirty',
    workspace('dirty', {
      name: 'Dirty',
      worktreeParentCwd: '/projects/project-1',
      worktreeBranch: 'dirty-branch'
    })
  ]
])
const invocations: ControlInvocation[] = []
let controlAuditCount = 0
let nextInvoke: (
  invocation: ControlInvocation
) => ControlResult<unknown> | Promise<ControlResult<unknown>>

const invoke: ControlInvoker = async <T>(invocation: ControlInvocation) => {
  invocations.push(invocation)
  controlAuditCount++
  return (await nextInvoke(invocation)) as ControlResult<T>
}

const adapter = new WorkspaceControlAdapter({
  invoke,
  getProject: (projectId) => projects.get(projectId) ?? null,
  getWorkspace: (workspaceId) => workspaces.get(workspaceId) ?? null,
  isDirtyArchiveTarget: (workspaceId) => workspaceId === 'dirty',
  acknowledgeRendererOpen: (workspaceId) => {
    const current = workspaces.get(workspaceId)
    if (current == null) {
      throw new WorkspaceControlAdapterError('not_found', 'Requested resource was not found.')
    }
    current.closedAt = null
    current.lastOpenedAt = 50
  }
})

function createValue(record: WorkspaceRecord): CreateWorkspaceValue {
  return {
    workspace: {
      workspaceId: record.id,
      projectId: record.projectId,
      name: record.name,
      mode: record.worktreeParentCwd == null ? 'local' : 'worktree',
      cwd: record.cwd,
      parentWorkspaceId: record.parentWorkspaceId,
      closedAt: record.closedAt,
      archivedAt: record.archivedAt
    },
    lineage: {
      parentWorkspaceId: record.parentWorkspaceId,
      forkedFromConversationId: record.forkedFromSessionId
    },
    presentation: 'background'
  }
}

// Trusted renderer identity comes from the real webContents id and server-resolved scope.
{
  const context = rendererWorkspaceContext(17, 'project-1', 'parent')
  assert.deepEqual(context.principal, {
    type: 'renderer-user',
    id: 'webContents:17'
  })
  assert.equal(context.consumer, 'renderer-ipc')
  assert.equal(context.projectId, 'project-1')
  assert.equal(context.workspaceId, 'parent')
  assert.ok(context.requestId.length > 0)
}

// Renderer local create ignores the legacy caller cwd, invokes the canonical
// plural operation in the background, and reads back the full WorkspaceRecord.
{
  invocations.length = 0
  const created = workspace('local-created', {
    cwd: '/projects/project-1',
    name: 'Local created',
    pinnedAt: 99,
    claudeSessionId: 'full-session-id'
  })
  workspaces.set(created.id, created)
  nextInvoke = (invocation) => {
    assert.equal(invocation.id, 'workspaces.create')
    return { ok: true, value: receipt(invocation.id, createValue(created)) }
  }
  const result = await adapter.createLocal(21, {
    projectId: 'project-1',
    name: 'Local created',
    cwd: '/caller/controlled/path'
  })
  assert.strictEqual(result, created)
  assert.deepEqual(invocations[0]?.input, {
    mode: 'local',
    name: 'Local created',
    presentation: 'background'
  })
  assert.equal(invocations[0]?.context.projectId, 'project-1')
  assert.equal(invocations[0]?.context.workspaceId, null)
  assert.equal(invocations[0]?.context.principal.id, 'webContents:21')
}

// Worktree create keeps the legacy envelope but sends no path and omits a blank branch.
{
  invocations.length = 0
  const created = workspace('worktree-created', {
    name: 'Worktree',
    cwd: '/projects/project-1/.claude/worktrees/worktree-created',
    worktreeParentCwd: '/projects/project-1',
    worktreeBranch: 'worktree-created'
  })
  workspaces.set(created.id, created)
  nextInvoke = (invocation) => ({
    ok: true,
    value: receipt(invocation.id, createValue(created))
  })
  assert.strictEqual(
    await adapter.createWorktree(22, 'project-1', { name: 'Worktree', branch: '   ' }),
    created
  )
  assert.deepEqual(invocations[0]?.input, {
    mode: 'worktree',
    name: 'Worktree',
    presentation: 'background'
  })
  assert.equal('cwd' in (invocations[0]?.input as Record<string, unknown>), false)
}

// Busy close preserves the renderer's first response and performs zero control calls.
{
  invocations.length = 0
  assert.deepEqual(await closeWorkspaceForRenderer(adapter, 23, 'parent', 'in_progress'), {
    ok: false,
    error: 'busy'
  })
  assert.equal(invocations.length, 0)
}

// Missing/stale close and reopen preserve their exact legacy success envelopes,
// while the canonical adapter method retains its internal not_found result.
{
  invocations.length = 0
  assert.deepEqual(await closeWorkspaceForRenderer(adapter, 23, 'missing', 'idle'), {
    ok: true,
    workspace: null
  })
  assert.deepEqual(await reopenWorkspaceForRenderer(adapter, 23, 'missing'), {
    ok: true,
    workspace: null
  })
  await assert.rejects(
    () => adapter.close(23, 'missing'),
    (error: unknown) => error instanceof WorkspaceControlAdapterError && error.code === 'not_found'
  )
  assert.equal(invocations.length, 0)
}

// Normal close/reopen/rename use plural operations and return full records.
{
  for (const [operationId, run] of [
    ['workspaces.close', () => closeWorkspaceForRenderer(adapter, 24, 'parent', 'idle')],
    ['workspaces.reopen', () => adapter.reopen(24, 'parent')],
    ['workspaces.rename', () => adapter.rename(24, 'parent', 'Renamed')]
  ] as const) {
    invocations.length = 0
    nextInvoke = (invocation) => {
      const current = workspaces.get('parent')!
      if (operationId === 'workspaces.close') current.closedAt = 10
      if (operationId === 'workspaces.reopen') current.closedAt = null
      if (operationId === 'workspaces.rename') current.name = 'Renamed'
      return {
        ok: true,
        value: receipt(invocation.id, {
          workspace: {
            workspaceId: current.id,
            projectId: current.projectId,
            name: current.name,
            mode: 'local',
            cwd: current.cwd,
            parentWorkspaceId: current.parentWorkspaceId,
            closedAt: current.closedAt,
            archivedAt: current.archivedAt
          },
          ...(operationId === 'workspaces.close'
            ? { closed: true }
            : operationId === 'workspaces.reopen'
              ? { closed: false }
              : { previousName: 'Parent' })
        })
      }
    }
    await run()
    assert.equal(invocations[0]?.id, operationId)
    assert.equal(invocations[0]?.context.principal.id, 'webContents:24')
    assert.deepEqual(invocations[0]?.input, {
      workspaceId: 'parent',
      ...(operationId === 'workspaces.rename' ? { name: 'Renamed' } : {})
    })
  }
}

// Dirty archive is a canonical first leg; renderer-confirmed force is an
// injected legacy second leg and never adds force to the control invocation.
{
  invocations.length = 0
  let forcedCalls = 0
  nextInvoke = () => ({
    ok: false,
    code: 'conflict',
    error: 'Managed worktree is not safe to remove.'
  })
  assert.deepEqual(
    await archiveWorkspaceForRenderer(
      adapter,
      async () => {
        forcedCalls++
        return { archived: true, wasDirty: true }
      },
      25,
      'dirty',
      false
    ),
    { archived: false, wasDirty: true }
  )
  assert.equal(invocations.length, 1)
  assert.deepEqual(invocations[0]?.input, { workspaceId: 'dirty', recursive: false })
  assert.equal('force' in (invocations[0]?.input as Record<string, unknown>), false)
  assert.equal(forcedCalls, 0)

  invocations.length = 0
  assert.deepEqual(
    await archiveWorkspaceForRenderer(
      adapter,
      async (workspaceId) => {
        forcedCalls++
        assert.equal(workspaceId, 'dirty')
        return { archived: true, wasDirty: true }
      },
      25,
      'dirty',
      true
    ),
    { archived: true, wasDirty: true }
  )
  assert.equal(invocations.length, 0)
  assert.equal(forcedCalls, 1)
}

// Typed partial receipts are never collapsed into renderer or action success.
{
  invocations.length = 0
  const partialValue: ArchiveWorkspaceValue = {
    rootWorkspaceId: 'parent',
    recursive: false,
    order: ['parent'],
    workspaces: [
      {
        workspaceId: 'parent',
        status: 'failed',
        persistedRecord: 'retained'
      }
    ]
  }
  nextInvoke = (invocation) => ({
    ok: true,
    value: receipt(invocation.id, partialValue, 'partial')
  })
  await assert.rejects(
    () => adapter.archive(26, 'parent'),
    (error: unknown) =>
      error instanceof WorkspaceControlAdapterError &&
      error.code === 'failed' &&
      /completed partially/.test(error.message)
  )
}

// Fork explicitly carries lineage. Duplicate uses the same canonical create
// operation but intentionally has neither bound/default nor explicit parent.
{
  invocations.length = 0
  let createdIndex = 0
  nextInvoke = (invocation) => {
    const input = invocation.input as Record<string, unknown>
    const id = `action-created-${++createdIndex}`
    const parentId =
      typeof input['parentWorkspaceId'] === 'string' ? input['parentWorkspaceId'] : null
    const created = workspace(id, {
      name: String(input['name']),
      cwd: '/projects/project-1',
      parentWorkspaceId: parentId,
      forkedFromSessionId: input['fork'] === true ? 'parent-session' : null
    })
    workspaces.set(id, created)
    return { ok: true, value: receipt(invocation.id, createValue(created)) }
  }

  assert.deepEqual(await adapter.forkAction(31, { worktree: false }, 'parent'), {
    ok: true,
    value: { workspaceId: 'action-created-1' }
  })
  assert.equal(invocations[0]?.id, 'workspaces.create')
  assert.deepEqual(invocations[0]?.input, {
    mode: 'local',
    name: 'Renamed (fork)',
    parentWorkspaceId: 'parent',
    fork: true,
    presentation: 'background'
  })
  assert.equal(invocations[0]?.context.workspaceId, 'parent')

  assert.deepEqual(await adapter.duplicateAction(32, { nameSuffix: ' copy' }, 'parent'), {
    ok: true,
    value: { workspaceId: 'action-created-2' }
  })
  assert.deepEqual(invocations[1]?.input, {
    mode: 'local',
    name: 'Renamed copy',
    presentation: 'background'
  })
  assert.equal(invocations[1]?.context.workspaceId, null)
  assert.equal(workspaces.get('action-created-2')?.parentWorkspaceId, null)
  assert.equal(workspaces.get('action-created-2')?.forkedFromSessionId, null)
}

// Actual registry invocation preserves the ActionResult and writes its own
// Quick Actions audit in addition to the adapter's canonical control call.
{
  invocations.length = 0
  controlAuditCount = 0
  const actionAudits: Array<Omit<ActionAuditEntry, 'id'>> = []
  nextInvoke = (invocation) => {
    const current = workspaces.get('parent')!
    current.name = 'Registry rename'
    return {
      ok: true,
      value: receipt(invocation.id, {
        workspace: {
          workspaceId: current.id,
          projectId: current.projectId,
          name: current.name,
          mode: 'local',
          cwd: current.cwd,
          parentWorkspaceId: current.parentWorkspaceId,
          closedAt: current.closedAt,
          archivedAt: current.archivedAt
        },
        previousName: 'Renamed'
      })
    }
  }
  register({
    id: 'workspace.rename',
    kind: 'mutator',
    validate: () => true,
    handler: (params, workspaceId, context) =>
      adapter.renameAction(context.senderId!, params, workspaceId)
  })
  const invocation: ActionInvocation = {
    id: 'workspace.rename',
    params: { name: 'Registry rename' },
    workspaceId: 'parent'
  }
  assert.deepEqual(
    await invokeAction(invocation, {
      consumerHint: 'footer',
      senderId: 41,
      audit: (entry) => actionAudits.push(entry)
    }),
    { ok: true }
  )
  assert.equal(invocations[0]?.id, 'workspaces.rename')
  assert.equal(invocations[0]?.context.principal.id, 'webContents:41')
  assert.equal(controlAuditCount, 1)
  assert.equal(actionAudits.length, 1)
  assert.equal(actionAudits[0]?.actionId, 'workspace.rename')
  assert.equal(actionAudits[0]?.consumerHint, 'footer')
  assert.equal(actionAudits[0]?.resultCode, 'ok')
}

// A fork with no parent session retains the exact legacy invalid envelope,
// performs no canonical call, and is still audited by the action registry.
{
  workspaces.set('no-session', workspace('no-session', { claudeSessionId: null }))
  invocations.length = 0
  const actionAudits: Array<Omit<ActionAuditEntry, 'id'>> = []
  register({
    id: 'workspace.fork',
    kind: 'mutator',
    validate: () => true,
    handler: (params, workspaceId, context) =>
      adapter.forkAction(context.senderId!, params, workspaceId)
  })
  assert.deepEqual(
    await invokeAction(
      { id: 'workspace.fork', params: {}, workspaceId: 'no-session' },
      {
        consumerHint: 'footer',
        senderId: 42,
        audit: (entry) => actionAudits.push(entry)
      }
    ),
    {
      ok: false,
      code: 'invalid',
      error: 'Parent workspace has no session to fork from — use duplicate instead'
    }
  )
  assert.equal(invocations.length, 0)
  assert.equal(actionAudits.length, 1)
  assert.equal(actionAudits[0]?.resultCode, 'invalid')
}

// Static integration guards: renderer open uses the non-presenting
// acknowledgement, force is not sent to control, actions pass e.sender.id,
// and descriptors are renderer-live.
{
  const ipcSource = readRepoFile('src/main/ipc/workspaces.ts')
  assert.match(ipcSource, /handle\('workspaces:open',[\s\S]*?acknowledgeRendererOpen\(id\)/)
  assert.doesNotMatch(ipcSource, /workspaceControl\.open/)
  assert.match(ipcSource, /performForcedArchive/)

  const actionsIpcSource = readRepoFile('src/main/ipc/actions.ts')
  assert.match(actionsIpcSource, /senderId: e\.sender\.id/)

  const capabilitySource = readRepoFile('src/main/controlPlane/workspaceCapabilities.ts')
  assert.match(
    capabilitySource,
    /const MUTATION_SURFACES = \['renderer', 'command-socket', 'mcp'\] as const/
  )
  assert.doesNotMatch(capabilitySource, /properties:\s*\{[^}]*force/)

  const rendererSource = readRepoFile('src/renderer/src/components/dashboard/Dashboard.tsx')
  assert.match(rendererSource, /background mount: failed to resolve workspace cwd:[\s\S]*?return/)
}

console.log('workspace renderer/actions harness: ok')
