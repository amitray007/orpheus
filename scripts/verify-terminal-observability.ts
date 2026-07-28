import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { bootControlRegistry } from '../src/main/controlPlane/boot.ts'
import { createConfiguredControlRegistry } from '../src/main/controlPlane/configuredRegistry.ts'
import { createTrustedRuntimeReadPolicy } from '../src/main/controlPlane/readPolicy.ts'
import { RuntimeControlGrantPolicy } from '../src/main/controlPlane/runtimeGrants.ts'
import {
  TERMINALS_GET_CLAUDE_SESSION_CONTROL_ID,
  TERMINALS_GET_CONTROL_ID,
  TERMINALS_GET_OUTPUT_TAIL_CONTROL_ID,
  TERMINALS_LIST_CONTROL_ID,
  TERMINALS_SUBSCRIBE_CONTROL_ID
} from '../src/main/controlPlane/terminalObservationCapabilities.ts'
import type {
  ControlContext,
  ControlReadObservation,
  LastTurnReadModel,
  TranscriptReadModel,
  TrustedRuntimeBinding
} from '../src/main/controlPlane/types.ts'
import { TerminalObservationJournal } from '../src/main/terminalObservation/journal.ts'
import { createNativeOutputProvider } from '../src/main/terminalObservation/nativeOutputProvider.ts'
import type { ControlRegistry } from '../src/main/controlPlane/registry.ts'
import {
  createTerminalObservationHandlers,
  paneSurfaceId,
  TerminalObservationService,
  workbenchSurfaceId,
  type TerminalObservationServiceDeps
} from '../src/main/terminalObservation/service.ts'
import type { TerminalObservation } from '../src/main/terminalObservation/types.ts'
import type { WorkspaceRecord } from '../src/shared/types.ts'

const workspaceOne: WorkspaceRecord = {
  id: 'workspace-1',
  projectId: 'project-1',
  name: 'Workspace One',
  nameIsAuto: false,
  cwd: '/projects/one',
  pinnedAt: null,
  createdAt: 100,
  lastOpenedAt: 900,
  archivedAt: null,
  closedAt: null,
  sortOrder: null,
  status: 'in_progress',
  claudeSessionId: 'conversation-1',
  forkedFromSessionId: null,
  lastTitle: null,
  parentWorkspaceId: null,
  worktreeParentCwd: null,
  worktreeBranch: null
}

const workspaceTwo: WorkspaceRecord = {
  ...workspaceOne,
  id: 'workspace-2',
  projectId: 'project-2',
  name: 'Workspace Two',
  cwd: '/projects/two',
  claudeSessionId: 'conversation-2'
}

const workspaceById = new Map([
  [workspaceOne.id, workspaceOne],
  [workspaceTwo.id, workspaceTwo]
])
const phaseBySurface = new Map<string, 'none' | 'hidden' | 'attached' | 'visible' | 'freeing'>([
  [workspaceOne.id, 'visible'],
  [workbenchSurfaceId(workspaceOne.id, 7), 'hidden'],
  [paneSurfaceId('layout-1', 'pane-1'), 'visible']
])

const binding: TrustedRuntimeBinding = {
  runtimeId: 'runtime-1',
  runtimeKind: 'claude',
  surfaceId: workspaceOne.id,
  workspaceId: workspaceOne.id,
  projectId: workspaceOne.projectId,
  claudeConversationId: workspaceOne.claudeSessionId,
  issuedAt: 500,
  permissions: [
    'identity.read',
    'projects.read',
    'workspaces.read',
    'workspaces.wait',
    'terminals.read',
    'reviews.read'
  ]
}

const context: ControlContext = {
  principal: { type: 'workspace-agent', id: binding.runtimeId },
  consumer: 'mcp',
  workspaceId: workspaceTwo.id,
  projectId: workspaceTwo.projectId,
  requestId: 'request-1',
  trustedRuntime: binding
}

function controlObservation<T>(
  value: T,
  source: ControlReadObservation<T>['source']
): ControlReadObservation<T> {
  return {
    value,
    source,
    observedAt: 1_000,
    sourceUpdatedAt: 900,
    availability: 'available',
    stale: false
  }
}

const baseDeps: TerminalObservationServiceDeps = {
  now: () => 1_000,
  listWorkspaces: (projectId) =>
    [...workspaceById.values()].filter((workspace) => workspace.projectId === projectId),
  getWorkspace: (workspaceId) => workspaceById.get(workspaceId) ?? null,
  listWorkbenchTerminalIds: (workspaceId) => (workspaceId === workspaceOne.id ? [7] : []),
  hasWorkbenchTerminal: (workspaceId, terminalId) =>
    workspaceId === workspaceOne.id && terminalId === 7,
  getPaneTerminal: (layoutId, paneId) =>
    layoutId === 'layout-1' && paneId === 'pane-1'
      ? {
          layoutId,
          paneId,
          cwd: '/panes/one',
          command: 'bun test',
          updatedAt: 800
        }
      : null,
  getPaneTargetBySurfaceId: (surfaceId) =>
    surfaceId === paneSurfaceId('layout-1', 'pane-1')
      ? {
          layoutId: 'layout-1',
          paneId: 'pane-1',
          cwd: '/panes/one',
          command: 'bun test',
          updatedAt: 800
        }
      : null,
  hasPaneSurface: (layoutId, paneId) => layoutId === 'layout-1' && paneId === 'pane-1',
  getNativePhase: (surfaceId) => phaseBySurface.get(surfaceId) ?? 'none',
  getRuntimeBySurfaceId: (surfaceId) =>
    surfaceId === workspaceOne.id
      ? {
          runtimeId: binding.runtimeId,
          runtimeKind: 'claude',
          surfaceId,
          workspaceId: workspaceOne.id,
          projectId: workspaceOne.projectId,
          claudeConversationId: workspaceOne.claudeSessionId,
          parentWorkspaceId: null,
          forkedFromConversationId: null,
          issuedAt: binding.issuedAt,
          state: 'live',
          pid: 42
        }
      : null,
  getSessionInfo: (workspaceId) =>
    workspaceId === workspaceOne.id
      ? {
          claudeConversationId: workspaceOne.claudeSessionId,
          pid: 42,
          version: '2.1.220',
          cwd: workspaceOne.cwd,
          status: 'busy',
          waitingFor: null,
          statusUpdatedAt: 950,
          availability: 'available',
          stale: false
        }
      : {
          claudeConversationId: workspaceTwo.claudeSessionId,
          pid: null,
          version: null,
          cwd: null,
          status: 'unknown',
          waitingFor: null,
          statusUpdatedAt: null,
          availability: 'offline',
          stale: false,
          reason: 'Claude runtime is offline.'
        },
  isWorkspaceReady: (workspaceId) => workspaceId === workspaceOne.id,
  getWorkspaceActivity: (workspaceId) => workspaceById.get(workspaceId)?.status ?? 'idle',
  workspaceClaudeCommand: () => '/app/orpheus-claude.sh',
  workbenchCommand: () => '/bin/zsh',
  readTranscript: async (_workspaceId, options) =>
    controlObservation<TranscriptReadModel>(
      {
        turns: [
          {
            role: 'assistant',
            text: 'done',
            timestamp: 900,
            ...(options.includeToolActivity
              ? { toolActivity: [{ kind: 'tool_use', name: 'Read', summary: 'Used Read' }] }
              : {})
          }
        ].slice(0, options.limit),
        truncated: false,
        bytesRead: 128
      },
      'claude-jsonl'
    ),
  readLastTurn: async () =>
    controlObservation<LastTurnReadModel>(
      {
        userText: 'work',
        assistantText: 'done',
        userAt: 800,
        assistantAt: 900
      },
      'claude-jsonl'
    )
}

const defaultGrantPolicy = new RuntimeControlGrantPolicy()
const runtimeLeaseBinding = baseDeps.getRuntimeBySurfaceId(workspaceOne.id)
assert.ok(runtimeLeaseBinding)
assert.equal(
  defaultGrantPolicy.permissionsFor(runtimeLeaseBinding).includes('terminals.read'),
  true
)

function registryFor(service: TerminalObservationService): ControlRegistry {
  const registry = createConfiguredControlRegistry({
    authorization: createTrustedRuntimeReadPolicy({
      getWorkspaceProjectId: (workspaceId) => workspaceById.get(workspaceId)?.projectId ?? null
    }),
    terminalObservation: service
  })
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
    createTerminalObservationHandlers(service)
  )
  return registry
}

function assertStrictObjects(value: unknown, location = 'schema'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertStrictObjects(item, `${location}[${index}]`))
    return
  }
  if (value == null || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  if (record['type'] === 'object') {
    assert.equal(
      record['additionalProperties'],
      false,
      `${location} must reject additional properties`
    )
  }
  for (const [key, child] of Object.entries(record)) {
    assertStrictObjects(child, `${location}.${key}`)
  }
}

const service = new TerminalObservationService(baseDeps)
const registry = registryFor(service)
const expectedIds = [
  TERMINALS_GET_CLAUDE_SESSION_CONTROL_ID,
  TERMINALS_GET_CONTROL_ID,
  TERMINALS_GET_OUTPUT_TAIL_CONTROL_ID,
  TERMINALS_LIST_CONTROL_ID,
  TERMINALS_SUBSCRIBE_CONTROL_ID
].sort()
const terminalDescriptions = registry
  .listForContext(context)
  .filter((description) => description.permission === 'terminals.read')
assert.deepEqual(terminalDescriptions.map((description) => description.id).sort(), expectedIds)
for (const description of terminalDescriptions) {
  assert.equal(description.kind, 'query')
  assert.equal(description.risk.tier, 0)
  assert.deepEqual(description.allowedSurfaces, ['mcp'])
  assertStrictObjects(description.inputSchema, `${description.id}.input`)
  assertStrictObjects(description.outputSchema, `${description.id}.output`)
}

const listed = await registry.invoke<
  TerminalObservation<{ terminals: unknown[]; truncated: boolean }>
>({ id: TERMINALS_LIST_CONTROL_ID, input: {}, context })
assert.equal(listed.ok, true)
if (listed.ok) {
  assert.equal(listed.value.availability, 'available')
  assert.equal(listed.value.source, 'native-surface-registry')
  assert.equal(listed.value.observedAt, 1_000)
  assert.equal(listed.value.value?.terminals.length, 2)
}

const snapshotResult = await registry.invoke({
  id: TERMINALS_GET_CONTROL_ID,
  input: {},
  context
})
assert.equal(snapshotResult.ok, true)
if (snapshotResult.ok) {
  const snapshot = snapshotResult.value as {
    lifecycle: { value: { phase: string } }
    runtime: { value: { running: boolean; ready: boolean; pid: number } }
    configuration: { value: { command: string; cwd: string } }
    claudeSession: { value: { version: string } }
  }
  assert.equal(snapshot.lifecycle.value.phase, 'visible')
  assert.deepEqual(snapshot.runtime.value, {
    running: true,
    ready: true,
    runtimeId: 'runtime-1',
    pid: 42
  })
  assert.deepEqual(snapshot.configuration.value, {
    command: '/app/orpheus-claude.sh',
    cwd: '/projects/one'
  })
  assert.equal(snapshot.claudeSession.value.version, '2.1.220')
}

const workbenchResult = await registry.invoke({
  id: TERMINALS_GET_CONTROL_ID,
  input: {
    target: { kind: 'workbench', workspaceId: workspaceOne.id, terminalId: 7 }
  },
  context
})
assert.equal(workbenchResult.ok, true)
if (workbenchResult.ok) {
  const snapshot = workbenchResult.value as {
    lifecycle: { value: { phase: string } }
    activity: { availability: string }
    claudeSession: { availability: string }
  }
  assert.equal(snapshot.lifecycle.value.phase, 'hidden')
  assert.equal(snapshot.activity.availability, 'unsupported')
  assert.equal(snapshot.claudeSession.availability, 'unsupported')
}

const crossProject = await registry.invoke({
  id: TERMINALS_GET_CONTROL_ID,
  input: {
    target: { kind: 'workspace_claude', workspaceId: workspaceTwo.id }
  },
  context
})
assert.deepEqual(crossProject, {
  ok: false,
  code: 'not_found',
  error: 'Requested resource was not found.'
})

const paneDenied = await registry.invoke({
  id: TERMINALS_GET_CONTROL_ID,
  input: { target: { kind: 'pane', layoutId: 'layout-1', paneId: 'pane-1' } },
  context
})
assert.deepEqual(paneDenied, {
  ok: false,
  code: 'not_found',
  error: 'Requested resource was not found.'
})

// A managed Claude runtime with the exact server-issued Phase 4 pane scope can
// observe that mounted pane through every Phase 5 read. This models the
// startTerminal -> native registry -> observation integration state; ordinary
// same-project identity without the exact layout+surface grant remains denied.
const scopedPaneBinding: TrustedRuntimeBinding = {
  ...binding,
  resourceScope: {
    selfOnly: true,
    layoutIds: ['layout-1'],
    surfaceIds: [paneSurfaceId('layout-1', 'pane-1'), paneSurfaceId('layout-1', 'pane-1')]
  }
}
const scopedPaneContext: ControlContext = {
  ...context,
  trustedRuntime: scopedPaneBinding
}
const scopedPaneList = await registry.invoke<
  TerminalObservation<{
    terminals: Array<{
      kind: string
      layoutId: string | null
      paneId: string | null
      surfaceRegistered: boolean
    }>
    truncated: boolean
  }>
>({
  id: TERMINALS_LIST_CONTROL_ID,
  input: {},
  context: scopedPaneContext
})
assert.equal(scopedPaneList.ok, true)
if (scopedPaneList.ok) {
  assert.deepEqual(
    scopedPaneList.value.value?.terminals.filter(({ kind }) => kind === 'pane'),
    [
      {
        terminalId: 'pane-terminal/layout-1/pane-1',
        kind: 'pane',
        workspaceId: null,
        projectId: null,
        layoutId: 'layout-1',
        paneId: 'pane-1',
        surfaceRegistered: true
      }
    ]
  )
}

const scopedPaneGet = await registry.invoke({
  id: TERMINALS_GET_CONTROL_ID,
  input: { target: { kind: 'pane', layoutId: 'layout-1', paneId: 'pane-1' } },
  context: scopedPaneContext
})
assert.equal(scopedPaneGet.ok, true)
if (scopedPaneGet.ok) {
  const snapshot = scopedPaneGet.value as {
    lifecycle: { value: { registered: boolean; phase: string } }
    configuration: { value: { command: string; cwd: string } }
  }
  assert.deepEqual(snapshot.lifecycle.value, { registered: true, phase: 'visible' })
  assert.deepEqual(snapshot.configuration.value, {
    command: 'bun test',
    cwd: '/panes/one'
  })
}

const scopedPaneTail = await registry.invoke({
  id: TERMINALS_GET_OUTPUT_TAIL_CONTROL_ID,
  input: { target: { kind: 'pane', layoutId: 'layout-1', paneId: 'pane-1' } },
  context: scopedPaneContext
})
assert.equal(scopedPaneTail.ok, true)
if (scopedPaneTail.ok) {
  assert.equal((scopedPaneTail.value as { availability: string }).availability, 'unsupported')
}

const scopedPaneSubscription = await registry.invoke({
  id: TERMINALS_SUBSCRIBE_CONTROL_ID,
  input: { target: { kind: 'pane', layoutId: 'layout-1', paneId: 'pane-1' } },
  context: scopedPaneContext
})
assert.equal(scopedPaneSubscription.ok, true)
if (scopedPaneSubscription.ok) {
  const subscription = scopedPaneSubscription.value as {
    snapshots: Array<{
      terminalId: string
      snapshot: { lifecycle: { value: { registered: boolean; phase: string } } }
    }>
  }
  assert.equal(subscription.snapshots.length, 1)
  assert.equal(subscription.snapshots[0]?.terminalId, 'pane-terminal/layout-1/pane-1')
  assert.deepEqual(subscription.snapshots[0]?.snapshot.lifecycle.value, {
    registered: true,
    phase: 'visible'
  })
}

const paneBinding: TrustedRuntimeBinding = {
  ...binding,
  runtimeId: 'pane-runtime',
  runtimeKind: 'pane_shell',
  surfaceId: paneSurfaceId('layout-1', 'pane-1'),
  workspaceId: null,
  projectId: null,
  claudeConversationId: null
}
const paneContext: ControlContext = {
  ...context,
  principal: { type: 'workspace-agent', id: paneBinding.runtimeId },
  workspaceId: null,
  projectId: null,
  trustedRuntime: paneBinding
}
const paneAllowed = await registry.invoke({
  id: TERMINALS_GET_CONTROL_ID,
  input: { target: { kind: 'pane', layoutId: 'layout-1', paneId: 'pane-1' } },
  context: paneContext
})
assert.equal(paneAllowed.ok, true)
if (paneAllowed.ok) {
  const snapshot = paneAllowed.value as {
    configuration: { value: { command: string; cwd: string } }
  }
  assert.deepEqual(snapshot.configuration.value, {
    command: 'bun test',
    cwd: '/panes/one'
  })
}

const stalePaneRegistry = registryFor(
  new TerminalObservationService({
    ...baseDeps,
    hasPaneSurface: () => false
  })
)
const stalePaneDenied = await stalePaneRegistry.invoke({
  id: TERMINALS_GET_CONTROL_ID,
  input: { target: { kind: 'pane', layoutId: 'layout-1', paneId: 'pane-1' } },
  context: paneContext
})
assert.deepEqual(stalePaneDenied, {
  ok: false,
  code: 'not_found',
  error: 'Requested resource was not found.'
})
const staleScopedPaneDenied = await stalePaneRegistry.invoke({
  id: TERMINALS_GET_CONTROL_ID,
  input: { target: { kind: 'pane', layoutId: 'layout-1', paneId: 'pane-1' } },
  context: scopedPaneContext
})
assert.deepEqual(staleScopedPaneDenied, {
  ok: false,
  code: 'not_found',
  error: 'Requested resource was not found.'
})

const claudeSession = await registry.invoke({
  id: TERMINALS_GET_CLAUDE_SESSION_CONTROL_ID,
  input: { transcriptLimit: 1, includeToolActivity: true },
  context
})
assert.equal(claudeSession.ok, true)
if (claudeSession.ok) {
  const value = claudeSession.value as {
    session: { source: string; freshness: string }
    transcript: { value: { turns: unknown[]; bytesRead: number } }
    lastTurn: { value: { assistantText: string } }
  }
  assert.equal(value.session.source, 'claude-session-file')
  assert.equal(value.session.freshness, 'live')
  assert.equal(value.transcript.value.turns.length, 1)
  assert.equal(value.transcript.value.bytesRead, 128)
  assert.equal(value.lastTurn.value.assistantText, 'done')
}

const unsupportedTail = await registry.invoke({
  id: TERMINALS_GET_OUTPUT_TAIL_CONTROL_ID,
  input: {},
  context
})
assert.equal(unsupportedTail.ok, true)
if (unsupportedTail.ok) {
  assert.deepEqual(unsupportedTail.value, {
    value: null,
    source: 'authoritative-text-stream',
    observedAt: 1_000,
    sourceUpdatedAt: null,
    freshness: 'unknown',
    availability: 'unsupported',
    reason: 'The current native terminal backend does not expose an authoritative text stream.'
  })
}

const providerService = new TerminalObservationService({
  ...baseDeps,
  outputProvider: {
    readTail: (_target, _limits, observedAt) => ({
      value: {
        text: '1234567890\nline-two\nline-three',
        bytes: 999,
        lines: 999,
        truncated: false
      },
      source: 'authoritative-text-stream',
      observedAt,
      sourceUpdatedAt: observedAt,
      freshness: 'live',
      availability: 'available'
    })
  }
})
const boundedTail = await providerService.getOutputTail({ maxBytes: 20, maxLines: 2 }, context)
assert.ok((boundedTail.value?.bytes ?? 999) <= 20)
assert.ok((boundedTail.value?.lines ?? 999) <= 2)
assert.equal(boundedTail.value?.truncated, true)

const nativeReadCalls: Array<{
  surfaceId: string
  maxBytes: number
  maxLines: number
}> = []
const nativeOutputService = new TerminalObservationService({
  ...baseDeps,
  outputProvider: createNativeOutputProvider(() => ({
    readScreenTail: (surfaceId, maxBytes, maxLines) => {
      nativeReadCalls.push({ surfaceId, maxBytes, maxLines })
      return {
        available: true,
        text: 'screen line\n😀 tail',
        bytes: Buffer.byteLength('screen line\n😀 tail'),
        lines: 2,
        truncated: false,
        capturedAt: 975
      }
    }
  }))
})
const nativeTail = await nativeOutputService.getOutputTail({ maxBytes: 64, maxLines: 4 }, context)
assert.deepEqual(nativeReadCalls, [{ surfaceId: workspaceOne.id, maxBytes: 64, maxLines: 4 }])
assert.deepEqual(nativeTail, {
  value: {
    text: 'screen line\n😀 tail',
    bytes: Buffer.byteLength('screen line\n😀 tail'),
    lines: 2,
    truncated: false
  },
  source: 'authoritative-text-stream',
  observedAt: 1_000,
  sourceUpdatedAt: 975,
  freshness: 'live',
  availability: 'available'
})

const unavailableNativeOutputService = new TerminalObservationService({
  ...baseDeps,
  outputProvider: createNativeOutputProvider(() => ({
    readScreenTail: () => ({
      available: false,
      text: '',
      bytes: 0,
      lines: 0,
      truncated: false,
      capturedAt: null
    })
  }))
})
const unavailableNativeTail = await unavailableNativeOutputService.getOutputTail({}, context)
assert.deepEqual(unavailableNativeTail, {
  value: null,
  source: 'authoritative-text-stream',
  observedAt: 1_000,
  sourceUpdatedAt: null,
  freshness: 'unknown',
  availability: 'unavailable',
  reason: 'The requested terminal surface is unavailable.'
})

const raceServiceHolder: { value: TerminalObservationService | null } = { value: null }
const raceService = new TerminalObservationService({
  ...baseDeps,
  beforeSnapshot: () => raceServiceHolder.value?.recordWorkspaceLifecycle(workspaceOne.id, 'hidden')
})
raceServiceHolder.value = raceService
const raceInitial = await raceService.subscribe({}, context)
assert.equal(raceInitial.snapshots.length, 2)
assert.equal(raceInitial.events.length, 1)
assert.equal(raceInitial.events[0]?.kind, 'lifecycle')
assert.equal(raceInitial.events[0]?.state['phase'], 'hidden')

const longPoll = raceService.subscribe(
  {
    target: { kind: 'workspace_claude', workspaceId: workspaceOne.id },
    afterRevision: raceInitial.cursor,
    timeoutMs: 500
  },
  context
)
setTimeout(() => raceService.recordWorkspaceActivity(workspaceOne.id, 'attention'), 10)
const delivered = await longPoll
assert.equal(delivered.timedOut, false)
assert.equal(delivered.events[0]?.kind, 'activity')

const timeout = await raceService.subscribe(
  {
    target: { kind: 'workspace_claude', workspaceId: workspaceOne.id },
    afterRevision: delivered.cursor,
    timeoutMs: 1
  },
  context
)
assert.equal(timeout.timedOut, true)
assert.equal(timeout.events.length, 0)

const tinyJournal = new TerminalObservationJournal(() => 1_000, 3, 1)
const overflowService = new TerminalObservationService({ ...baseDeps, journal: tinyJournal })
for (let index = 0; index < 4; index++) {
  overflowService.recordWorkspaceActivity(workspaceOne.id, `status-${index}`)
}
assert.equal(tinyJournal.size(), 3)
const resync = await overflowService.subscribe(
  {
    target: { kind: 'workspace_claude', workspaceId: workspaceOne.id },
    afterRevision: 0,
    timeoutMs: 1
  },
  context
)
assert.equal(resync.resyncRequired, true)
assert.equal(resync.snapshots.length, 1)
const futureCursorResync = await overflowService.subscribe(
  {
    target: { kind: 'workspace_claude', workspaceId: workspaceOne.id },
    afterRevision: tinyJournal.currentRevision() + 100,
    timeoutMs: 1
  },
  context
)
assert.equal(futureCursorResync.resyncRequired, true)
assert.equal(futureCursorResync.snapshots.length, 1)

const dynamicWorkbenchIds: number[] = []
const dynamicService = new TerminalObservationService({
  ...baseDeps,
  listWorkbenchTerminalIds: () => dynamicWorkbenchIds,
  hasWorkbenchTerminal: (_workspaceId, terminalId) => dynamicWorkbenchIds.includes(terminalId)
})
const dynamicPoll = dynamicService.subscribe(
  { afterRevision: dynamicService.journal.currentRevision(), timeoutMs: 25 },
  context
)
setTimeout(() => {
  dynamicWorkbenchIds.push(9)
  dynamicService.recordWorkbenchLifecycle(workspaceOne.id, 9, 'visible')
}, 5)
const dynamicDelivery = await dynamicPoll
assert.equal(dynamicDelivery.timedOut, false)
assert.equal(dynamicDelivery.events[0]?.terminalId, 'workbench-terminal/workspace-1/9')

const disappearingWorkbenchIds = [7]
const disappearingService = new TerminalObservationService({
  ...baseDeps,
  listWorkbenchTerminalIds: () => disappearingWorkbenchIds,
  hasWorkbenchTerminal: (_workspaceId, terminalId) => disappearingWorkbenchIds.includes(terminalId)
})
const disappearingPoll = disappearingService.subscribe(
  { afterRevision: disappearingService.journal.currentRevision(), timeoutMs: 25 },
  context
)
setTimeout(() => {
  disappearingService.recordWorkbenchLifecycle(workspaceOne.id, 7, 'none')
  disappearingWorkbenchIds.length = 0
}, 5)
const disappearingDelivery = await disappearingPoll
assert.equal(disappearingDelivery.timedOut, false)
assert.equal(disappearingDelivery.events[0]?.terminalId, 'workbench-terminal/workspace-1/7')
assert.equal(disappearingDelivery.events[0]?.state['phase'], 'none')

const filteringService = new TerminalObservationService(baseDeps)
const filteredPoll = filteringService.subscribe(
  { afterRevision: filteringService.journal.currentRevision(), timeoutMs: 15 },
  context
)
setTimeout(() => filteringService.recordWorkspaceActivity(workspaceTwo.id, 'private'), 2)
const filteredDelivery = await filteredPoll
assert.equal(filteredDelivery.timedOut, true)
assert.equal(filteredDelivery.events.length, 0)

const offlineService = new TerminalObservationService({
  ...baseDeps,
  getNativePhase: () => 'none',
  getRuntimeBySurfaceId: () => null,
  getSessionInfo: () => ({
    claudeConversationId: workspaceOne.claudeSessionId,
    pid: null,
    version: '2.1.219',
    cwd: workspaceOne.cwd,
    status: 'idle',
    waitingFor: null,
    statusUpdatedAt: 800,
    availability: 'offline',
    stale: true,
    reason: 'Claude runtime is offline.'
  })
})
const offlineSnapshot = offlineService.get({}, context)
assert.equal(offlineSnapshot.runtime.availability, 'offline')
assert.equal(offlineSnapshot.runtime.freshness, 'stale')
assert.equal(offlineSnapshot.activity.availability, 'offline')
assert.equal(offlineSnapshot.configuration.availability, 'offline')
assert.equal(offlineSnapshot.claudeSession.availability, 'offline')
const offlineSession = await offlineService.getClaudeSession({}, context)
assert.equal(offlineSession.session.availability, 'offline')
assert.equal(offlineSession.session.freshness, 'stale')

const manyWorkspaces = Array.from(
  { length: 260 },
  (_, index): WorkspaceRecord => ({
    ...workspaceOne,
    id: `workspace-${index + 10}`,
    name: `Workspace ${index + 10}`,
    cwd: `/projects/${index + 10}`,
    claudeSessionId: `conversation-${index + 10}`
  })
)
const boundedListService = new TerminalObservationService({
  ...baseDeps,
  listWorkspaces: () => [...manyWorkspaces, workspaceOne],
  listWorkbenchTerminalIds: () => [],
  getNativePhase: () => 'none'
})
const boundedList = boundedListService.list(context)
assert.equal(boundedList.value?.terminals.length, 256)
assert.equal(boundedList.value?.truncated, true)
assert.equal(boundedList.value?.terminals[0]?.terminalId, 'workspace-claude/workspace-1')

function createScopedPaneBoundaryService(projectTargetCount: number): TerminalObservationService {
  const workspaces = [workspaceOne, ...manyWorkspaces.slice(0, projectTargetCount - 1)]
  const workspacesById = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
  return new TerminalObservationService({
    ...baseDeps,
    listWorkspaces: () => workspaces,
    getWorkspace: (workspaceId) => workspacesById.get(workspaceId) ?? null,
    listWorkbenchTerminalIds: () => [],
    getNativePhase: (surfaceId) =>
      surfaceId === paneSurfaceId('layout-1', 'pane-1') ? 'visible' : 'none'
  })
}

for (const projectTargetCount of [255, 256]) {
  const boundaryService = createScopedPaneBoundaryService(projectTargetCount)
  const boundaryList = boundaryService.list(scopedPaneContext)
  assert.equal(boundaryList.value?.terminals.length, 256)
  assert.equal(boundaryList.value?.truncated, projectTargetCount === 256)
  assert.equal(boundaryList.value?.terminals[0]?.terminalId, 'workspace-claude/workspace-1')
  assert.equal(boundaryList.value?.terminals[1]?.terminalId, 'pane-terminal/layout-1/pane-1')
  assert.equal(boundaryList.value?.terminals.filter(({ kind }) => kind === 'pane').length, 1)

  const boundarySubscription = await boundaryService.subscribe({}, scopedPaneContext)
  assert.equal(boundarySubscription.snapshots.length, 256)
  assert.equal(boundarySubscription.snapshots[0]?.terminalId, 'workspace-claude/workspace-1')
  assert.equal(boundarySubscription.snapshots[1]?.terminalId, 'pane-terminal/layout-1/pane-1')
  assert.equal(
    boundarySubscription.snapshots.filter(({ terminalId }) =>
      terminalId.startsWith('pane-terminal/')
    ).length,
    1
  )
}

const oneWaiterJournal = new TerminalObservationJournal(() => 1_000, 3, 1)
const pendingWait = oneWaiterJournal.waitForChange(0, null, 25)
assert.equal(await oneWaiterJournal.waitForChange(0, null, 1), 'capacity')
assert.equal(await pendingWait, 'timeout')

const scopedWaitJournal = new TerminalObservationJournal(() => 1_000)
const scopedWait = scopedWaitJournal.waitForChange(
  0,
  (terminalId) => terminalId === 'authorized',
  1_000
)
scopedWaitJournal.append('unrelated', 'activity', 'live', { activity: 'busy' })
assert.equal(scopedWaitJournal.waiterCount(), 1)
scopedWaitJournal.append('authorized', 'activity', 'live', { activity: 'busy' })
assert.equal(await scopedWait, 'changed')

const distinctJournal = new TerminalObservationJournal(() => 1_000)
assert.notEqual(
  distinctJournal.appendDistinct('terminal', 'readiness', 'claude-session-file', { ready: true }),
  null
)
assert.equal(
  distinctJournal.appendDistinct('terminal', 'readiness', 'claude-session-file', { ready: true }),
  null
)
assert.equal(distinctJournal.size(), 1)

const disposedJournal = new TerminalObservationJournal()
const disposedWait = disposedJournal.waitForChange(0, null, 1_000)
assert.equal(disposedJournal.waiterCount(), 1)
disposedJournal.dispose()
assert.equal(await disposedWait, 'changed')
assert.equal(disposedJournal.waiterCount(), 0)
assert.equal(await disposedJournal.waitForChange(0, null, 1_000), 'timeout')

const boundedJournal = new TerminalObservationJournal()
for (let index = 0; index < 600; index++) {
  boundedJournal.append('terminal', 'activity', 'live', { activity: String(index) })
}
assert.equal(boundedJournal.size(), 512)
assert.equal(boundedJournal.read(512, null, 1_000).events.length, 88)
assert.equal(boundedJournal.read(512, null, 1_000).events.length <= 100, true)

const invalidUnknownField = await registry.invoke({
  id: TERMINALS_GET_CONTROL_ID,
  input: { rendererSelector: '#terminal' },
  context
})
assert.equal(invalidUnknownField.ok, false)
if (!invalidUnknownField.ok) assert.equal(invalidUnknownField.code, 'invalid')

const invalidTailBound = await registry.invoke({
  id: TERMINALS_GET_OUTPUT_TAIL_CONTROL_ID,
  input: { maxBytes: 65_537 },
  context
})
assert.equal(invalidTailBound.ok, false)
if (!invalidTailBound.ok) assert.equal(invalidTailBound.code, 'invalid')

const repoRoot = path.resolve(import.meta.dirname, '..')
const nativeAddonSource = fs.readFileSync(
  path.join(repoRoot, 'packages/ghostty-surface/addon.mm'),
  'utf8'
)
const nativeReadStart = nativeAddonSource.indexOf('static Napi::Value ReadScreenTail')
const nativeReadEnd = nativeAddonSource.indexOf('static Napi::Value Destroy', nativeReadStart)
assert.ok(nativeReadStart >= 0)
assert.ok(nativeReadEnd > nativeReadStart)
const nativeReadSource = nativeAddonSource.slice(nativeReadStart, nativeReadEnd)
for (const required of [
  'ghostty_surface_read_text(surface, selection, &raw)',
  'ghostty_surface_free_text(surface, &raw)',
  'selection.top_left.tag = GHOSTTY_POINT_SCREEN',
  'selection.top_left.coord = GHOSTTY_POINT_COORD_TOP_LEFT',
  'selection.bottom_right.tag = GHOSTTY_POINT_SCREEN',
  'selection.bottom_right.coord = GHOSTTY_POINT_COORD_BOTTOM_RIGHT',
  'selection.rectangle = false',
  'kMaxScreenTailBytes = 2 * 1024 * 1024',
  'kScreenTailCacheTtl = std::chrono::milliseconds(500)'
]) {
  assert.ok(nativeAddonSource.includes(required), `native screen reader must include ${required}`)
}
assert.equal(nativeReadSource.includes('NSLog'), false, 'terminal text read path must not log')
assert.ok(
  nativeAddonSource.includes(
    'g_screenTailCache.erase(workspaceId);\n    g_surfaces[workspaceId] = entry;'
  ),
  'mount must clear cached text before inserting a replacement surface'
)
assert.ok(
  nativeAddonSource
    .slice(
      nativeAddonSource.indexOf('static Napi::Value Destroy'),
      nativeAddonSource.indexOf('static Napi::Value SendInput')
    )
    .includes('g_screenTailCache.erase(workspaceId)'),
  'destroy must clear the per-surface text cache'
)

for (const relativePath of [
  'src/main/terminalObservation/service.ts',
  'src/main/terminalObservation/journal.ts',
  'src/main/controlPlane/terminalObservationCapabilities.ts',
  'src/main/controlPlane/terminalObservationPolicy.ts'
]) {
  const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
  for (const forbidden of [
    'src/renderer',
    'ipcRenderer',
    'screenshot',
    'accessibility',
    'optical character recognition'
  ]) {
    assert.equal(
      source.toLowerCase().includes(forbidden),
      false,
      `${relativePath} must not depend on ${forbidden}`
    )
  }
}

console.log('terminal observability verification passed')
