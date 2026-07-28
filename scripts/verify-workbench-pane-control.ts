import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createWorkbenchCapabilities,
  isSafeRelativePath
} from '../src/main/controlPlane/workbenchCapabilities'
import { RuntimeControlGrantPolicy } from '../src/main/controlPlane/runtimeGrants'
import type { ClaudeRuntimeBinding } from '../src/main/controlPlane/runtimeLeases'
import { withWorkbenchControlPolicy } from '../src/main/controlPlane/workbenchPolicy'
import type { ControlContext, ControlDescription } from '../src/main/controlPlane/types'
import { WorkspaceOrchestrationError } from '../src/main/workspaceOrchestration/errors'
import { recursivelyRedact } from '../src/main/workspaceOrchestration/redaction'
import type { WorkspaceControlAuditRecord } from '../src/main/workspaceOrchestration/types'
import { isCanonicalWorkspacePath } from '../src/main/workbenchControl/pathSafety'
import {
  RendererCommandBroker,
  RendererCommandError
} from '../src/main/workbenchControl/rendererCommandBroker'
import { createMainPaneControlPort } from '../src/main/workbenchControl/mainPaneAdapter'
import {
  PaneManagementPortError,
  WorkbenchControlService
} from '../src/main/workbenchControl/service'
import { PaneProvisioningStoreError } from '../src/main/workbenchControl/paneManagementErrors'
import {
  layoutMutationReleasesAgentOwner,
  terminalMutationReleasesAgentOwner
} from '../src/main/workbenchControl/paneOwnership'
import { nextPaneRevision } from '../src/main/workbenchControl/revisions'
import { teardownPaneSurfaceStrict } from '../src/main/workbenchControl/paneSurfaceTeardown'
import type { PaneLayout, PaneTerminal, WorkspaceRecord } from '../src/shared/types'
import { rendererControlRequiresPresentation } from '../src/shared/workbenchControl'
import type {
  PaneLayoutDeletionStateV1,
  PaneStateV1,
  RendererControlCommand,
  RendererControlRequest,
  WorkbenchStateV1
} from '../src/shared/workbenchControl'

const runtime: ClaudeRuntimeBinding = {
  runtimeId: 'runtime-1',
  runtimeKind: 'claude',
  state: 'live',
  pid: 42,
  surfaceId: 'workspace-1',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  claudeConversationId: null,
  parentWorkspaceId: null,
  forkedFromConversationId: null,
  issuedAt: 1
}

assert.equal(
  rendererControlRequiresPresentation({
    kind: 'workbench.readState',
    workspaceId: 'workspace-1'
  }),
  false
)
assert.equal(
  rendererControlRequiresPresentation({
    kind: 'panes.validateTerminal',
    layoutId: 'layout-1',
    terminalId: 'terminal-1'
  }),
  false
)
assert.equal(
  rendererControlRequiresPresentation({
    kind: 'panes.presentTerminal',
    layoutId: 'layout-1',
    terminalId: 'terminal-1'
  }),
  true
)

const defaults = new RuntimeControlGrantPolicy()
assert.equal(defaults.permissionsFor(runtime).includes('ui.workbench.control'), true)
assert.equal(defaults.permissionsFor(runtime).includes('terminals.control'), true)
assert.equal(defaults.permissionsFor(runtime).includes('panes.manage'), true)
assert.deepEqual(defaults.scopeFor(runtime), { selfOnly: true, layoutIds: [], surfaceIds: [] })

const grants = new RuntimeControlGrantPolicy(() => ({
  permissions: ['ui.workbench.control', 'terminals.control', 'panes.manage'],
  maxRiskTier: 3,
  scope: {
    selfOnly: true,
    layoutIds: ['layout-1', 'layout-agent'],
    surfaceIds: ['pane:layout-1:terminal-1', 'pane:layout-agent:terminal-agent']
  }
}))
assert.deepEqual(grants.scopeFor(runtime).layoutIds, ['layout-1', 'layout-agent'])
assert.equal(grants.permissionsFor(runtime).includes('terminals.control'), true)
assert.equal(grants.permissionsFor(runtime).includes('panes.manage'), true)

assert.equal(isSafeRelativePath('src/main/index.ts'), true)
for (const unsafe of ['', '/tmp/a', '../a', 'a/../b', 'a//b', 'a\\b', 'a\0b']) {
  assert.equal(isSafeRelativePath(unsafe), false, unsafe)
}
assert.deepEqual(
  recursivelyRedact({
    apiKey: 'top-secret',
    nested: {
      authorization: 'Bearer abc123',
      path: 'token=also-secret',
      initialCommand: 'echo do-not-audit-me'
    }
  }),
  {
    apiKey: '[REDACTED]',
    nested: {
      authorization: '[REDACTED]',
      path: '[REDACTED]',
      initialCommand: {
        byteLength: 20,
        sha256: '169149a14d3b46f93f83f8bd7a7802e52a10d13dadf9a553aed1224899ce0cf7'
      }
    }
  }
)

const pathFixture = await fs.mkdtemp(path.join(os.tmpdir(), 'orpheus-phase4-path-'))
try {
  const workspaceRoot = path.join(pathFixture, 'workspace')
  const outsideRoot = path.join(pathFixture, 'outside')
  await fs.mkdir(workspaceRoot)
  await fs.mkdir(outsideRoot)
  await fs.writeFile(path.join(workspaceRoot, 'inside.txt'), 'inside')
  await fs.writeFile(path.join(outsideRoot, 'secret.txt'), 'secret')
  await fs.symlink(outsideRoot, path.join(workspaceRoot, 'escape'))
  await fs.symlink(path.join(pathFixture, 'missing-target'), path.join(workspaceRoot, 'dangling'))

  assert.equal(
    await isCanonicalWorkspacePath(workspaceRoot, 'inside.txt', { requireFile: true }),
    true
  )
  assert.equal(
    await isCanonicalWorkspacePath(workspaceRoot, 'deleted/nested.txt', { requireFile: false }),
    true
  )
  assert.equal(
    await isCanonicalWorkspacePath(workspaceRoot, 'deleted/nested.txt', { requireFile: true }),
    false
  )
  assert.equal(
    await isCanonicalWorkspacePath(workspaceRoot, 'escape/secret.txt', { requireFile: true }),
    false
  )
  assert.equal(
    await isCanonicalWorkspacePath(workspaceRoot, 'dangling/secret.txt', { requireFile: false }),
    false
  )
} finally {
  await fs.rm(pathFixture, { recursive: true, force: true })
}

let lastRequest: RendererControlRequest | null = null
let available = true
const broker = new RendererCommandBroker(
  {
    isAvailable: () => available,
    send: (request) => {
      lastRequest = request
      return true
    }
  },
  50
)

const pending = broker.execute('request-1', {
  kind: 'workbench.selectTab',
  workspaceId: 'workspace-1',
  tab: 'files'
})
assert.equal(
  broker.acknowledge({
    requestId: 'request-1',
    generation: 999,
    status: 'completed',
    observedAt: 1
  }),
  false
)
const sent = lastRequest as unknown as RendererControlRequest
assert.equal(
  broker.acknowledge({
    requestId: sent.requestId,
    generation: sent.generation,
    status: 'completed',
    observedAt: 2,
    value: { ok: true }
  }),
  true
)
assert.deepEqual((await pending).value, { ok: true })

const replaced = broker.execute('request-replaced', {
  kind: 'workbench.readState',
  workspaceId: 'workspace-1'
})
broker.rejectAll('Renderer was replaced.')
await assert.rejects(
  replaced,
  (error) => error instanceof RendererCommandError && error.code === 'unavailable'
)
assert.equal(
  broker.acknowledge({
    requestId: 'request-replaced',
    generation: (lastRequest as unknown as RendererControlRequest).generation,
    status: 'completed',
    observedAt: 2,
    value: {}
  }),
  false
)

available = false
await assert.rejects(
  broker.execute('request-2', { kind: 'workbench.readState', workspaceId: 'workspace-1' }),
  (error) => error instanceof RendererCommandError && error.code === 'unavailable'
)
available = true
for (const send of [
  () => false,
  () => {
    throw new Error('destroyed')
  }
]) {
  const racingBroker = new RendererCommandBroker({
    isAvailable: () => true,
    send
  })
  await assert.rejects(
    racingBroker.execute('request-send-race', {
      kind: 'workbench.readState',
      workspaceId: 'workspace-1'
    }),
    (error) => error instanceof RendererCommandError && error.code === 'unavailable'
  )
}

function context(requestId: string): ControlContext {
  return {
    principal: { type: 'workspace-agent', id: 'runtime-1' },
    consumer: 'mcp',
    workspaceId: 'ambient-wrong',
    projectId: 'ambient-wrong',
    requestId,
    trustedRuntime: {
      runtimeId: 'runtime-1',
      runtimeKind: 'claude',
      surfaceId: 'workspace-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      claudeConversationId: null,
      issuedAt: 1,
      permissions: grants.permissionsFor(runtime),
      resourceScope: grants.scopeFor(runtime)
    }
  }
}

function workbenchState(command: RendererControlCommand): WorkbenchStateV1 {
  const workspaceId = 'workspaceId' in command ? command.workspaceId : 'workspace-1'
  const tab =
    command.kind === 'workbench.selectTab'
      ? command.tab
      : command.kind === 'workbench.openFile'
        ? 'files'
        : command.kind === 'workbench.openDiff'
          ? 'git'
          : 'files'
  return {
    schemaVersion: 1,
    workspaceId,
    observedAt: 1,
    source: 'renderer-live',
    workbench: { state: 'open', activeTab: tab },
    file: command.kind === 'workbench.openFile' ? { path: command.path, mode: command.mode } : null,
    diff:
      command.kind !== 'workbench.openDiff'
        ? null
        : command.target.kind === 'working-tree-file'
          ? {
              kind: 'working-tree-file',
              path: command.target.path,
              reviewId: null
            }
          : {
              kind: 'local-review',
              path: 'src/review.ts',
              reviewId: command.target.reviewId
            }
  }
}

function paneState(command: RendererControlCommand): PaneStateV1 {
  const terminalId = 'terminalId' in command ? command.terminalId : 'terminal-1'
  const desiredState =
    command.kind === 'panes.commitTerminalState' ? command.desiredState : 'stopped'
  return {
    schemaVersion: 1,
    observedAt: 1,
    source: 'renderer-live',
    layoutId: 'layoutId' in command ? command.layoutId : 'layout-1',
    panelId: 'panel-1',
    selected:
      command.kind === 'panes.selectLayout' ||
      command.kind === 'panes.presentTerminal' ||
      command.kind === 'panes.presentCreatedTerminal',
    focusedTerminalId:
      command.kind === 'panes.presentTerminal' || command.kind === 'panes.presentCreatedTerminal'
        ? terminalId
        : null,
    terminals: [{ terminalId, selected: false, desiredState }]
  }
}

function rendererValue(
  command: RendererControlCommand
): WorkbenchStateV1 | PaneStateV1 | PaneLayoutDeletionStateV1 {
  if (command.kind === 'panes.reconcileDeletedLayout') {
    return {
      schemaVersion: 1,
      observedAt: 1,
      source: 'renderer-live',
      deletedLayoutId: command.layoutId,
      selectedLayoutId: 'layout-sibling'
    }
  }
  return command.kind.startsWith('panes.') ? paneState(command) : workbenchState(command)
}

const allowRevalidation = {
  revalidate: async (): Promise<'allow'> => 'allow' as const
}

const strictTeardownEvents: string[] = []
assert.equal(layoutMutationReleasesAgentOwner({}), false)
assert.equal(layoutMutationReleasesAgentOwner({ dir: '/repurposed' }), true)
assert.equal(layoutMutationReleasesAgentOwner({ splitTree: null }), true)
assert.equal(layoutMutationReleasesAgentOwner({ position: 1 }), true)
assert.equal(terminalMutationReleasesAgentOwner({}), false)
assert.equal(terminalMutationReleasesAgentOwner({ command: 'npm run watch' }), true)
assert.equal(terminalMutationReleasesAgentOwner({ position: 1 }), true)
assert.equal(nextPaneRevision(100, 90), 101)
assert.equal(nextPaneRevision(100, 150), 150)
assert.equal(
  teardownPaneSurfaceStrict({
    layoutId: 'layout-drifted',
    terminalId: 'terminal-drifted',
    getPhase: () => 'hidden',
    isRegistered: () => false,
    destroy: (surfaceId) => strictTeardownEvents.push(`destroy:${surfaceId}`),
    unregister: (layoutId, terminalId) =>
      strictTeardownEvents.push(`unregister:${layoutId}:${terminalId}`)
  }),
  'stopped'
)
assert.deepEqual(strictTeardownEvents, [
  'destroy:pane:layout-drifted:terminal-drifted',
  'unregister:layout-drifted:terminal-drifted'
])
let unregisteredAfterDestroyFailure = false
assert.throws(() =>
  teardownPaneSurfaceStrict({
    layoutId: 'layout-failure',
    terminalId: 'terminal-failure',
    getPhase: () => 'visible',
    isRegistered: () => true,
    destroy: () => {
      throw new Error('native destroy failed')
    },
    unregister: () => {
      unregisteredAfterDestroyFailure = true
    }
  })
)
assert.equal(unregisteredAfterDestroyFailure, false)
let teardownAfterPhaseFailure = false
assert.throws(() =>
  teardownPaneSurfaceStrict({
    layoutId: 'layout-query-failure',
    terminalId: 'terminal-query-failure',
    getPhase: () => {
      throw new Error('native phase query failed')
    },
    isRegistered: () => false,
    destroy: () => {
      teardownAfterPhaseFailure = true
    },
    unregister: () => {
      teardownAfterPhaseFailure = true
    }
  })
)
assert.equal(teardownAfterPhaseFailure, false)
const freeingEvents: string[] = []
assert.equal(
  teardownPaneSurfaceStrict({
    layoutId: 'layout-freeing',
    terminalId: 'terminal-freeing',
    getPhase: () => 'freeing',
    isRegistered: () => false,
    destroy: () => {
      throw new Error('must not destroy twice')
    },
    unregister: (layoutId, terminalId) => freeingEvents.push(`unregister:${layoutId}:${terminalId}`)
  }),
  'stopped'
)
assert.deepEqual(freeingEvents, ['unregister:layout-freeing:terminal-freeing'])
assert.throws(
  () =>
    teardownPaneSurfaceStrict({
      layoutId: 'layout-remounted',
      terminalId: 'terminal-remounted',
      getPhase: () => 'freeing',
      isRegistered: () => true,
      destroy: () => {
        throw new Error('must not destroy ambiguous remount')
      },
      unregister: () => {
        throw new Error('must not unregister live remount')
      }
    }),
  /remounted pane surface is live/
)

const managedTarget = {
  layoutId: 'layout-agent',
  panelId: 'panel-1',
  terminalId: 'terminal-agent',
  layoutUpdatedAt: 20,
  terminalUpdatedAt: 20,
  initialCommand: 'pwd'
}
const managedValue = {
  layoutId: managedTarget.layoutId,
  panelId: managedTarget.panelId,
  terminalId: managedTarget.terminalId,
  layoutUpdatedAt: managedTarget.layoutUpdatedAt,
  terminalUpdatedAt: managedTarget.terminalUpdatedAt
}
const managementStubs = {
  provision: async () => managedTarget,
  startProvisioned: async () => 'started' as const,
  deleteDedicated: async () => ({
    target: { ...managedTarget, initialCommand: '' },
    terminalState: 'stopped' as const,
    persistence: 'deleted' as const
  })
}

const sharedCwd = '/code/shared-project'
const workspaceRecord = (id: string): WorkspaceRecord => ({
  id,
  projectId: 'project-1',
  name: id,
  nameIsAuto: false,
  cwd: sharedCwd,
  pinnedAt: null,
  createdAt: 1,
  lastOpenedAt: null,
  archivedAt: null,
  closedAt: null,
  sortOrder: null,
  status: 'idle',
  claudeSessionId: null,
  forkedFromSessionId: null,
  lastTitle: null,
  parentWorkspaceId: null,
  worktreeParentCwd: null,
  worktreeBranch: null
})
const managedLayout: PaneLayout = {
  id: managedTarget.layoutId,
  panelId: managedTarget.panelId,
  name: 'Agent terminal',
  dir: sharedCwd,
  splitTree: { paneId: managedTarget.terminalId },
  position: 0,
  createdAt: 20,
  updatedAt: managedTarget.layoutUpdatedAt,
  autoStart: false
}
const managedTerminal: PaneTerminal = {
  id: managedTarget.terminalId,
  layoutId: managedTarget.layoutId,
  command: '',
  name: 'Bootstrap',
  position: 0,
  createdAt: 20,
  updatedAt: 20
}
const userLayout: PaneLayout = {
  ...managedLayout,
  id: 'layout-user',
  name: 'Persistent user layout',
  splitTree: { paneId: 'terminal-user' }
}
const userTerminal: PaneTerminal = {
  ...managedTerminal,
  id: 'terminal-user',
  layoutId: userLayout.id,
  command: 'npm run watch'
}
let capturedCreate:
  | {
      workspaceId: string
      dir: string
      layoutName: string
      terminalName: string
    }
  | undefined
const deleteOrder: string[] = []
const startedCommands: string[] = []
const adapter = createMainPaneControlPort({
  getLayout: (layoutId) =>
    layoutId === managedLayout.id ? managedLayout : layoutId === userLayout.id ? userLayout : null,
  listTerminals: (layoutId) =>
    layoutId === managedLayout.id
      ? [managedTerminal]
      : layoutId === userLayout.id
        ? [userTerminal]
        : [],
  getWorkspace: (workspaceId) =>
    workspaceId === 'workspace-1' || workspaceId === 'workspace-sibling'
      ? workspaceRecord(workspaceId)
      : null,
  createDedicated: (input) => {
    capturedCreate = input
    return { layout: managedLayout, terminal: managedTerminal }
  },
  deleteDedicated: (input, beforeDelete) => {
    if (input.workspaceId !== 'workspace-1') {
      throw new PaneProvisioningStoreError('not_found', 'Pane resource was not found.')
    }
    const teardown = beforeDelete(managedLayout, managedTerminal)
    deleteOrder.push('db-delete')
    return {
      layout: managedLayout,
      terminal: managedTerminal,
      teardown,
      persisted: 'deleted'
    }
  },
  startConfigured: (_layout, terminal) => {
    startedCommands.push(terminal.command)
    return 'started'
  },
  stopSurface: () => {
    deleteOrder.push('native-stop')
    return 'stopped'
  },
  focusSurface: async () => {}
})
assert.deepEqual(
  await adapter.provision('workspace-1', {
    layoutName: 'Agent terminal',
    terminalName: 'Bootstrap',
    initialCommand: 'pwd'
  }),
  managedTarget
)
assert.deepEqual(capturedCreate, {
  workspaceId: 'workspace-1',
  dir: sharedCwd,
  layoutName: 'Agent terminal',
  terminalName: 'Bootstrap'
})
assert.equal(managedTerminal.command, '')
await adapter.startProvisioned(managedLayout.id, managedTerminal.id, 'pwd')
await adapter.start(userLayout.id, userTerminal.id)
await adapter.start(userLayout.id, userTerminal.id)
assert.deepEqual(startedCommands, ['pwd', 'npm run watch', 'npm run watch'])
await assert.rejects(
  adapter.deleteDedicated('workspace-sibling', {
    layoutId: managedTarget.layoutId,
    terminalId: managedTarget.terminalId,
    expectedLayoutUpdatedAt: managedTarget.layoutUpdatedAt,
    expectedTerminalUpdatedAt: managedTarget.terminalUpdatedAt
  }),
  (error) => error instanceof PaneManagementPortError && error.code === 'not_found'
)
assert.deepEqual(deleteOrder, [])
await adapter.deleteDedicated('workspace-1', {
  layoutId: managedTarget.layoutId,
  terminalId: managedTarget.terminalId,
  expectedLayoutUpdatedAt: managedTarget.layoutUpdatedAt,
  expectedTerminalUpdatedAt: managedTarget.terminalUpdatedAt
})
assert.deepEqual(deleteOrder, ['native-stop', 'db-delete'])

const auditRecords: WorkspaceControlAuditRecord[] = []
const service = new WorkbenchControlService({
  renderer: {
    execute: async (requestId, command) => ({
      requestId,
      generation: 1,
      status: 'completed',
      observedAt: 1,
      value: rendererValue(command)
    })
  },
  authorization: allowRevalidation,
  paths: { isSafe: async (_workspaceId, relativePath) => relativePath !== 'escape/secret.txt' },
  panes: {
    resolve: (layoutId, terminalId) =>
      layoutId === 'layout-1' && (terminalId == null || terminalId === 'terminal-1')
        ? { layoutId, terminalId, panelId: 'panel-1' }
        : null,
    start: async () => 'started',
    stop: async () => 'stopped',
    focus: async () => {},
    ...managementStubs
  },
  audit: { append: (record) => auditRecords.push(record) },
  now: () => 10,
  generateId: () => `audit-${auditRecords.length + 1}`
})

const capabilities = createWorkbenchCapabilities(service)
assert.deepEqual(
  capabilities.map((capability) => capability.id),
  [
    'workbench.getState',
    'workbench.selectTab',
    'workbench.openFile',
    'workbench.openDiff',
    'panes.getState',
    'panes.selectLayout',
    'panes.startTerminal',
    'panes.stopTerminal',
    'panes.focusTerminal',
    'panes.createWorkspaceTerminal',
    'panes.deleteTerminalLayout'
  ]
)
assert.equal(
  capabilities
    .find((item) => item.id === 'workbench.openFile')
    ?.validateInput({ path: '../secret' }, {} as ControlContext),
  false
)
const createCapability = capabilities.find((item) => item.id === 'panes.createWorkspaceTerminal')
assert.equal(
  createCapability?.validateInput(
    {
      layoutName: 'Agent terminal',
      terminalName: 'Bootstrap',
      initialCommand: 'bun test'
    },
    {} as ControlContext
  ),
  true
)
assert.equal(
  createCapability?.validateInput({ initialCommand: `echo\0nope` }, {} as ControlContext),
  false
)
assert.equal(
  createCapability?.validateInput({ initialCommand: 'x'.repeat(8193) }, {} as ControlContext),
  false
)
assert.equal(
  createCapability?.validateInput({ initialCommand: '😀'.repeat(2_049) }, {} as ControlContext),
  false
)
assert.equal(
  createCapability?.validateInput({ panelId: 'panel-foreign' }, {} as ControlContext),
  false
)
const deleteCapability = capabilities.find((item) => item.id === 'panes.deleteTerminalLayout')
assert.equal(
  deleteCapability?.validateInput(
    {
      layoutId: managedTarget.layoutId,
      terminalId: managedTarget.terminalId,
      expectedLayoutUpdatedAt: Number.MAX_SAFE_INTEGER + 1,
      expectedTerminalUpdatedAt: managedTarget.terminalUpdatedAt
    },
    {} as ControlContext
  ),
  false
)
for (const capability of capabilities) {
  assert.equal(capability.inputSchema.additionalProperties, false, capability.id)
  const output = capability.outputSchema
  assert.equal(output.additionalProperties, false, `${capability.id} output`)
}

const tabReceipt = await service.selectTab('files', context('select-tab'))
assert.equal(tabReceipt.status, 'completed')
assert.deepEqual(
  tabReceipt.effects.map((effect) => effect.effect),
  ['ui.present']
)
assert.equal(auditRecords.at(-1)?.auditId, tabReceipt.auditId)
assert.equal(auditRecords.at(-1)?.result.code, 'completed')

await assert.rejects(
  service.openFile('escape/secret.txt', 'viewer', context('unsafe-file')),
  (error) => error instanceof WorkspaceOrchestrationError && error.code === 'not_found'
)
assert.equal(auditRecords.at(-1)?.result.code, 'not_found')
assert.deepEqual(auditRecords.at(-1)?.redactedParams, {
  path: 'escape/secret.txt',
  mode: 'viewer'
})

const started = await service.terminal('start', 'layout-1', 'terminal-1', context('start-terminal'))
assert.deepEqual(
  started.effects.map(({ effect, status }) => [effect, status]),
  [
    ['surface.mount', 'applied'],
    ['process.spawn', 'applied']
  ]
)
const stopped = await service.terminal('stop', 'layout-1', 'terminal-1', context('stop-terminal'))
assert.deepEqual(
  stopped.effects.map(({ effect, status }) => [effect, status]),
  [
    ['surface.destroy', 'applied'],
    ['process.terminate', 'applied']
  ]
)

const created = await service.createWorkspaceTerminal(
  {
    layoutName: 'Agent terminal',
    terminalName: 'Bootstrap',
    initialCommand: 'echo do-not-audit-me'
  },
  context('create-terminal-layout')
)
assert.equal(created.status, 'completed')
assert.deepEqual(created.value, managedValue)
assert.deepEqual(
  created.effects.map(({ effect, status }) => [effect, status]),
  [
    ['db.write', 'applied'],
    ['surface.mount', 'applied'],
    ['process.spawn', 'applied'],
    ['ui.present', 'applied'],
    ['ui.focus', 'skipped']
  ]
)
const createdAudit = auditRecords.at(-1)
assert.deepEqual(createdAudit?.redactedParams, {
  layoutName: 'Agent terminal',
  terminalName: 'Bootstrap',
  initialCommand: {
    sha256: '169149a14d3b46f93f83f8bd7a7802e52a10d13dadf9a553aed1224899ce0cf7',
    byteLength: 20
  }
})
assert.equal(JSON.stringify(createdAudit).includes('echo do-not-audit-me'), false)

const deleted = await service.deleteTerminalLayout(
  {
    layoutId: managedTarget.layoutId,
    terminalId: managedTarget.terminalId,
    expectedLayoutUpdatedAt: managedTarget.layoutUpdatedAt,
    expectedTerminalUpdatedAt: managedTarget.terminalUpdatedAt
  },
  context('delete-terminal-layout')
)
assert.equal(deleted.status, 'completed')
assert.deepEqual(deleted.value, managedValue)
assert.deepEqual(
  deleted.effects.map(({ effect, status }) => [effect, status]),
  [
    ['surface.destroy', 'applied'],
    ['process.terminate', 'skipped'],
    ['db.write', 'applied'],
    ['ui.reconcile', 'applied']
  ]
)

let retainedDeleteRendererCalled = false
const retainedDeleteService = new WorkbenchControlService({
  renderer: {
    execute: async () => {
      retainedDeleteRendererCalled = true
      throw new Error('renderer must not reconcile a retained layout')
    }
  },
  authorization: allowRevalidation,
  paths: { isSafe: async () => true },
  panes: {
    resolve: (layoutId, terminalId) => ({ layoutId, terminalId, panelId: 'panel-1' }),
    start: async () => 'started',
    startProvisioned: async () => 'started',
    stop: async () => 'stopped',
    focus: async () => {},
    provision: async () => managedTarget,
    deleteDedicated: async () => ({
      target: { ...managedTarget, initialCommand: '' },
      terminalState: 'stopped',
      persistence: 'retained'
    })
  }
})
const retainedDelete = await retainedDeleteService.deleteTerminalLayout(
  {
    layoutId: managedTarget.layoutId,
    terminalId: managedTarget.terminalId,
    expectedLayoutUpdatedAt: managedTarget.layoutUpdatedAt,
    expectedTerminalUpdatedAt: managedTarget.terminalUpdatedAt
  },
  context('retained-delete')
)
assert.equal(retainedDelete.status, 'partial')
assert.equal(retainedDeleteRendererCalled, false)
assert.deepEqual(
  retainedDelete.effects.map(({ effect, status }) => [effect, status]),
  [
    ['surface.destroy', 'applied'],
    ['process.terminate', 'skipped'],
    ['db.write', 'failed']
  ]
)

const invalidDeleteAckService = new WorkbenchControlService({
  renderer: {
    execute: async (requestId, command) => ({
      requestId,
      generation: 1,
      status: 'completed',
      observedAt: 1,
      value:
        command.kind === 'panes.reconcileDeletedLayout'
          ? {
              schemaVersion: 1,
              observedAt: 1,
              source: 'renderer-live',
              deletedLayoutId: 'wrong-layout',
              selectedLayoutId: command.layoutId
            }
          : rendererValue(command)
    })
  },
  authorization: allowRevalidation,
  paths: { isSafe: async () => true },
  panes: service['ports'].panes
})
const invalidDeleteAck = await invalidDeleteAckService.deleteTerminalLayout(
  {
    layoutId: managedTarget.layoutId,
    terminalId: managedTarget.terminalId,
    expectedLayoutUpdatedAt: managedTarget.layoutUpdatedAt,
    expectedTerminalUpdatedAt: managedTarget.terminalUpdatedAt
  },
  context('invalid-delete-ack')
)
assert.equal(invalidDeleteAck.status, 'partial')
assert.deepEqual(invalidDeleteAck.effects.at(-1), {
  effect: 'ui.reconcile',
  status: 'failed',
  resourceId: managedTarget.layoutId
})

const idempotentService = new WorkbenchControlService({
  renderer: {
    execute: async (requestId, command) => ({
      requestId,
      generation: 1,
      status: 'completed',
      observedAt: 1,
      value: rendererValue(command)
    })
  },
  authorization: allowRevalidation,
  paths: { isSafe: async () => true },
  panes: {
    resolve: (layoutId, terminalId) => ({ layoutId, terminalId, panelId: 'panel-1' }),
    start: async () => 'retained',
    stop: async () => 'absent',
    focus: async () => {
      throw new Error('surface absent')
    },
    ...managementStubs
  }
})
const retained = await idempotentService.terminal(
  'start',
  'layout-1',
  'terminal-1',
  context('retained-terminal')
)
assert.deepEqual(
  retained.effects.map(({ effect, status }) => [effect, status]),
  [['surface.mount', 'applied']]
)
const absent = await idempotentService.terminal(
  'stop',
  'layout-1',
  'terminal-1',
  context('absent-terminal')
)
assert.deepEqual(
  absent.effects.map(({ effect, status }) => [effect, status]),
  [
    ['surface.destroy', 'skipped'],
    ['process.terminate', 'skipped']
  ]
)
const failedFocus = await idempotentService.terminal(
  'focus',
  'layout-1',
  'terminal-1',
  context('failed-focus')
)
assert.equal(failedFocus.status, 'partial')
assert.deepEqual(
  failedFocus.effects.map(({ effect, status }) => [effect, status]),
  [
    ['ui.present', 'applied'],
    ['ui.focus', 'failed']
  ]
)

let releaseStart: (() => void) | null = null
const nativeOrder: string[] = []
const serialService = new WorkbenchControlService({
  renderer: {
    execute: async (requestId, command) => ({
      requestId,
      generation: 1,
      status: 'completed',
      observedAt: 1,
      value: rendererValue(command)
    })
  },
  authorization: allowRevalidation,
  paths: { isSafe: async () => true },
  panes: {
    resolve: (layoutId, terminalId) => ({ layoutId, terminalId, panelId: 'panel-1' }),
    start: () =>
      new Promise((resolve) => {
        nativeOrder.push('start')
        releaseStart = () => resolve('started')
      }),
    stop: async () => {
      nativeOrder.push('stop')
      return 'stopped'
    },
    focus: async () => {},
    ...managementStubs
  }
})
const serialStart = serialService.terminal(
  'start',
  'layout-1',
  'terminal-1',
  context('serial-start')
)
await new Promise((resolve) => setTimeout(resolve, 0))
const serialStop = serialService.terminal('stop', 'layout-1', 'terminal-1', context('serial-stop'))
await new Promise((resolve) => setTimeout(resolve, 0))
assert.deepEqual(nativeOrder, ['start'])
assert.ok(releaseStart)
releaseStart()
await Promise.all([serialStart, serialStop])
assert.deepEqual(nativeOrder, ['start', 'stop'])

const partialAudits: WorkspaceControlAuditRecord[] = []
const partialService = new WorkbenchControlService({
  renderer: {
    execute: async (requestId, command) => {
      if (
        command.kind === 'panes.commitTerminalState' ||
        command.kind === 'panes.presentCreatedTerminal'
      ) {
        throw new RendererCommandError('unavailable', 'sensitive renderer detail')
      }
      return {
        requestId,
        generation: 1,
        status: 'completed',
        observedAt: 1,
        value: rendererValue(command)
      }
    }
  },
  authorization: allowRevalidation,
  paths: { isSafe: async () => true },
  panes: {
    resolve: (layoutId, terminalId) => ({ layoutId, terminalId, panelId: 'panel-1' }),
    start: async () => 'started',
    stop: async () => 'stopped',
    focus: async () => {},
    ...managementStubs
  },
  audit: { append: (record) => partialAudits.push(record) }
})
const partial = await partialService.terminal(
  'start',
  'layout-1',
  'terminal-1',
  context('partial-start')
)
assert.equal(partial.status, 'partial')
assert.equal(partialAudits.at(-1)?.result.code, 'partial')
assert.equal(JSON.stringify(partialAudits).includes('sensitive renderer detail'), false)
const partialCreate = await partialService.createWorkspaceTerminal(
  { initialCommand: 'echo do-not-audit-me' },
  context('partial-create')
)
assert.equal(partialCreate.status, 'partial')
assert.deepEqual(partialCreate.value, managedValue)
assert.deepEqual(
  partialCreate.effects.map(({ effect, status }) => [effect, status]),
  [
    ['db.write', 'applied'],
    ['surface.mount', 'applied'],
    ['process.spawn', 'applied'],
    ['ui.present', 'failed']
  ]
)
assert.equal(JSON.stringify(partialAudits).includes('echo do-not-audit-me'), false)

const mismatchedService = new WorkbenchControlService({
  renderer: {
    execute: async (requestId, command) => ({
      requestId,
      generation: 1,
      status: 'completed',
      observedAt: 1,
      value: { ...workbenchState(command), workspaceId: 'workspace-other' }
    })
  },
  authorization: allowRevalidation,
  paths: { isSafe: async () => true },
  panes: service['ports'].panes
})
await assert.rejects(
  mismatchedService.getWorkbenchState(context('mismatched-state')),
  (error) => error instanceof WorkspaceOrchestrationError && error.code === 'failed'
)

let deniedNativeEffect = false
const deniedService = new WorkbenchControlService({
  renderer: {
    execute: async () => {
      throw new Error('renderer must not be reached after revalidation denial')
    }
  },
  authorization: {
    revalidate: async ({ layoutId }) => (layoutId == null ? 'forbidden' : 'not_found')
  },
  paths: { isSafe: async () => true },
  panes: {
    resolve: (layoutId, terminalId) => ({ layoutId, terminalId, panelId: 'panel-1' }),
    start: async () => {
      deniedNativeEffect = true
      return 'started'
    },
    stop: async () => {
      deniedNativeEffect = true
      return 'stopped'
    },
    focus: async () => {
      deniedNativeEffect = true
    },
    provision: async () => {
      deniedNativeEffect = true
      return managedTarget
    },
    deleteDedicated: async () => {
      deniedNativeEffect = true
      return {
        target: managedTarget,
        terminalState: 'stopped',
        persistence: 'deleted'
      }
    },
    startProvisioned: async () => {
      deniedNativeEffect = true
      return 'started'
    }
  }
})
await assert.rejects(
  deniedService.getWorkbenchState(context('revoked-runtime')),
  (error) => error instanceof WorkspaceOrchestrationError && error.code === 'forbidden'
)
await assert.rejects(
  deniedService.terminal('start', 'layout-1', 'terminal-1', context('revoked-pane-grant')),
  (error) => error instanceof WorkspaceOrchestrationError && error.code === 'not_found'
)
await assert.rejects(
  deniedService.createWorkspaceTerminal({}, context('revoked-pane-management')),
  (error) => error instanceof WorkspaceOrchestrationError && error.code === 'forbidden'
)
assert.equal(deniedNativeEffect, false)

const base = {
  canDiscover: () => false,
  authorize: () => ({ allowed: false, code: 'forbidden', error: 'base' }) as const
}
const policy = withWorkbenchControlPolicy(base)
const description = capabilities.find(
  (item) => item.id === 'panes.startTerminal'
) as ControlDescription
const policyContext = context('policy')
assert.deepEqual(
  await policy.authorize(
    description,
    { layoutId: 'layout-1', terminalId: 'terminal-1' },
    policyContext
  ),
  { allowed: true }
)
assert.equal(
  (
    await policy.authorize(
      description,
      { layoutId: 'layout-2', terminalId: 'terminal-1' },
      policyContext
    )
  ).code,
  'not_found'
)
const createDescription = capabilities.find(
  (item) => item.id === 'panes.createWorkspaceTerminal'
) as ControlDescription
assert.deepEqual(await policy.authorize(createDescription, {}, policyContext), { allowed: true })
const deleteDescription = capabilities.find(
  (item) => item.id === 'panes.deleteTerminalLayout'
) as ControlDescription
assert.deepEqual(
  await policy.authorize(
    deleteDescription,
    {
      layoutId: managedTarget.layoutId,
      terminalId: managedTarget.terminalId,
      expectedLayoutUpdatedAt: managedTarget.layoutUpdatedAt,
      expectedTerminalUpdatedAt: managedTarget.terminalUpdatedAt
    },
    policyContext
  ),
  { allowed: true }
)
assert.equal(
  (
    await policy.authorize(
      deleteDescription,
      {
        layoutId: 'layout-foreign',
        terminalId: managedTarget.terminalId,
        expectedLayoutUpdatedAt: managedTarget.layoutUpdatedAt,
        expectedTerminalUpdatedAt: managedTarget.terminalUpdatedAt
      },
      policyContext
    )
  ).code,
  'not_found'
)

console.log(
  'verify-workbench-pane-control: paths, schemas, grants, broker, provisioning, audit, receipts, serialization, and policy OK'
)
