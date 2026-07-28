import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { FLAG_DELIMITER } from '../src/shared/cliFlags.ts'
import type {
  ClaudeGlobalSettings,
  ClaudeProjectSettings,
  ClaudeWorkspaceSettings,
  ClaudeWorkspaceSettingsOverrides,
  ProjectRecord,
  WorkspaceRecord
} from '../src/shared/types.ts'
import type { ClaudeLaunch } from '../src/main/claudeSettings.ts'
import { createAutomationRuntime } from '../src/main/automations/index.ts'
import type {
  AutomationDefinitionDraft,
  AutomationManagementContext
} from '../src/main/automations/types.ts'
import { bootControlRegistry } from '../src/main/controlPlane/boot.ts'
import { createConfiguredControlRegistry } from '../src/main/controlPlane/configuredRegistry.ts'
import { createControlAuditStore } from '../src/main/controlPlane/controlAudit.ts'
import { createSafeAutomationGrantSource } from '../src/main/controlPlane/safeAutomationGrants.ts'
import {
  SettingsResourceService,
  type SettingsResourceServiceDeps
} from '../src/main/controlPlane/settingsResourceService.ts'
import type {
  ControlAuthorizationPolicy,
  ReviewCapabilityHandlers
} from '../src/main/controlPlane/types.ts'
import { runMigrations } from '../src/main/db/cutover.ts'
import { WorkspaceOrchestrationService } from '../src/main/workspaceOrchestration/service.ts'
import type {
  WorkspaceMutationLease,
  WorkspaceOrchestrationPorts,
  WorkspaceSnapshot
} from '../src/main/workspaceOrchestration/types.ts'

const PROJECT_ID = 'project-production-path'
const WORKSPACE_ID = 'workspace-production-path'
const SIBLING_ID = 'workspace-production-sibling'
const EVENT_TYPE = 'workspace.completed'
const OPERATION_IDS = [
  'settings.getEffective',
  'settings.patchWorkspace',
  'workspaces.getLineage',
  'workspaces.rename',
  'workspaces.reopen'
] as const

let sequence = 0
let now = 10_000
const generateId = (): string => `production-automation-${++sequence}`
const db = new Database(':memory:')
db.exec('PRAGMA foreign_keys = ON')
runMigrations(db, { dbPath: ':memory:' })
const controlAudit = createControlAuditStore(db)

function workspace(
  workspaceId: string,
  overrides: Partial<WorkspaceSnapshot> = {}
): WorkspaceSnapshot {
  return {
    workspaceId,
    projectId: PROJECT_ID,
    name: workspaceId === WORKSPACE_ID ? 'Original workspace' : 'Sibling workspace',
    mode: 'local',
    cwd: '/repo',
    parentWorkspaceId: null,
    closedAt: workspaceId === WORKSPACE_ID ? 9_000 : null,
    archivedAt: null,
    revision: `${workspaceId}:1`,
    claudeConversationId: null,
    forkedFromConversationId: null,
    worktreeParentCwd: null,
    worktreeBranch: null,
    ...overrides
  }
}

const workspaceSnapshots = new Map<string, WorkspaceSnapshot>([
  [WORKSPACE_ID, workspace(WORKSPACE_ID)],
  [SIBLING_ID, workspace(SIBLING_ID)]
])
const originalWorkspace = { ...workspaceSnapshots.get(WORKSPACE_ID)! }

function workspaceRecord(workspaceId: string): WorkspaceRecord | null {
  const snapshot = workspaceSnapshots.get(workspaceId)
  if (snapshot == null) return null
  return {
    id: snapshot.workspaceId,
    projectId: snapshot.projectId,
    name: snapshot.name,
    nameIsAuto: false,
    cwd: snapshot.cwd,
    pinnedAt: null,
    createdAt: 1,
    lastOpenedAt: null,
    archivedAt: snapshot.archivedAt,
    closedAt: snapshot.closedAt,
    sortOrder: null,
    status: snapshot.archivedAt == null ? 'idle' : 'archived',
    claudeSessionId: null,
    forkedFromSessionId: null,
    lastTitle: null,
    parentWorkspaceId: snapshot.parentWorkspaceId,
    worktreeParentCwd: snapshot.worktreeParentCwd,
    worktreeBranch: snapshot.worktreeBranch
  }
}

function updateWorkspace(
  workspaceId: string,
  expectedRevision: string,
  changes: Partial<WorkspaceSnapshot>
): WorkspaceSnapshot | null {
  const current = workspaceSnapshots.get(workspaceId)
  if (current == null || current.revision !== expectedRevision) return null
  const revision = Number(current.revision.split(':').at(-1) ?? 0) + 1
  const updated = { ...current, ...changes, revision: `${workspaceId}:${revision}` }
  workspaceSnapshots.set(workspaceId, updated)
  return updated
}

let pendingLease = Promise.resolve()
function acquireWorkspaceLease(): Promise<WorkspaceMutationLease> {
  const previous = pendingLease
  let release!: () => void
  pendingLease = new Promise<void>((resolve) => {
    release = resolve
  })
  return previous.then(() => ({ release }))
}

let renameWrites = 0
let reopenWrites = 0
const workspacePorts: WorkspaceOrchestrationPorts = {
  store: {
    getProject: (projectId) =>
      projectId === PROJECT_ID ? { projectId, cwd: '/repo', revision: 'project:1' } : null,
    getWorkspace: (workspaceId) => workspaceSnapshots.get(workspaceId) ?? null,
    listChildren: () => [],
    create: () => {
      throw new Error('Workspace creation is outside this verifier.')
    },
    markOpened: (workspaceId, revision) => updateWorkspace(workspaceId, revision, {}),
    close: (workspaceId, revision) => updateWorkspace(workspaceId, revision, { closedAt: now }),
    reopen: (workspaceId, revision) => {
      reopenWrites++
      return updateWorkspace(workspaceId, revision, { closedAt: null })
    },
    rename: (workspaceId, name, revision) => {
      renameWrites++
      return updateWorkspace(workspaceId, revision, { name })
    },
    remove: () => {
      throw new Error('Workspace removal is outside this verifier.')
    }
  },
  runtime: {
    ensureOpen: () => ({ runtimeState: 'retained', effects: [] }),
    waitUntilReady: () => true,
    sendText: () => {},
    canTeardown: () => true,
    teardown: () => ({ effects: [] })
  },
  worktrees: {
    derivePath: () => '/unused',
    create: () => {
      throw new Error('Worktree creation is outside this verifier.')
    },
    rollbackCreate: () => true,
    preflightRemove: () => ({ safe: true, dirty: false }),
    remove: () => true
  },
  presentation: { focus: () => {} },
  waits: {
    createSession: () => ({
      observe: () => ({ status: 'idle', outcome: 'done' }),
      waitForChange: () => {},
      dispose: () => {}
    })
  },
  authorization: {
    revalidate: () => 'allow',
    isRuntimeLeaseActive: () => true
  },
  leases: {
    acquire: () => acquireWorkspaceLease(),
    acquireWhenAvailable: () => acquireWorkspaceLease()
  },
  audit: controlAudit,
  now: () => now,
  generateId
}
const workspaceService = new WorkspaceOrchestrationService(workspacePorts)

const project = {
  id: PROJECT_ID,
  path: '/repo',
  name: 'Production path project'
} as ProjectRecord
const globalSettings = {
  model: 'global-model',
  effort: 'auto',
  maxWorkspaceDepth: 4,
  maxWorkspaceChildren: 8,
  updatedAt: 100
} as ClaudeGlobalSettings & {
  maxWorkspaceDepth: number
  maxWorkspaceChildren: number
  updatedAt: number
}
const projectSettings: ClaudeProjectSettings = {
  projectId: PROJECT_ID,
  overrides: {},
  updatedAt: 200
}
let workspaceSettings: ClaudeWorkspaceSettings = {
  workspaceId: WORKSPACE_ID,
  overrides: { effort: 'high' },
  updatedAt: 300
}
const originalWorkspaceSettings = {
  ...workspaceSettings,
  overrides: { ...workspaceSettings.overrides }
}
let settingsWrites = 0
let dirty = false

function composeLaunch(projectId?: string, workspaceId?: string): ClaudeLaunch {
  assert.equal(projectId, PROJECT_ID)
  assert.equal(workspaceId, WORKSPACE_ID)
  const effort =
    workspaceSettings.overrides.effort ?? projectSettings.overrides.effort ?? globalSettings.effort
  return {
    flags: effort === 'auto' ? '' : ['--effort', effort].join(FLAG_DELIMITER),
    settingsJson: '',
    env: {},
    model: workspaceSettings.overrides.model ?? globalSettings.model
  }
}

const settingsDeps = {
  getWorkspace: workspaceRecord,
  getProject: (projectId) => (projectId === PROJECT_ID ? project : null),
  getGlobalSettings: () => globalSettings,
  getProjectSettings: () => projectSettings,
  getWorkspaceSettings: () => workspaceSettings,
  composeLaunch,
  updateWorkspaceSettings: (workspaceId, patch) => {
    assert.equal(workspaceId, WORKSPACE_ID)
    settingsWrites++
    const overrides = { ...workspaceSettings.overrides }
    for (const [key, value] of Object.entries(patch)) {
      if (value == null) delete overrides[key as keyof ClaudeWorkspaceSettingsOverrides]
      else overrides[key as keyof ClaudeWorkspaceSettingsOverrides] = value
    }
    workspaceSettings = {
      workspaceId,
      overrides,
      updatedAt: workspaceSettings.updatedAt + 1
    }
    return workspaceSettings
  },
  reconcileEffort: (patch) => patch,
  recomputeDirty: () => {
    dirty = true
  },
  isDirty: () => dirty,
  listProjectMcpServers: () => [],
  listProjectHooks: () => [],
  listProjectSlashCommands: () => [],
  listProjectSubagents: () => [],
  audit: controlAudit,
  now: () => now,
  generateId
} satisfies SettingsResourceServiceDeps
const settingsService = new SettingsResourceService(settingsDeps)

const rejectBase: ControlAuthorizationPolicy = {
  canDiscover: () => false,
  authorize: () => ({
    allowed: false,
    code: 'forbidden',
    error: 'Only the automation policy is exercised by this verifier.'
  })
}
const registry = createConfiguredControlRegistry({
  authorization: rejectBase,
  workspaceOrchestration: workspaceService,
  settingsResources: settingsService
})
const reviewHandlers: ReviewCapabilityHandlers = {
  listByWorkspace: () => [],
  setResolved: () => {
    throw new Error('Reviews are outside this verifier.')
  }
}
bootControlRegistry(
  registry,
  reviewHandlers,
  undefined,
  workspaceService,
  undefined,
  undefined,
  settingsService
)

const safeGrants = createSafeAutomationGrantSource({
  getProject: (projectId) => (projectId === PROJECT_ID ? project : null),
  getWorkspace: workspaceRecord
})
const automation = createAutomationRuntime({
  db,
  registry,
  grants: safeGrants,
  allowedEventTypes: new Set([EVENT_TYPE]),
  now: () => now,
  generateId
})
let managementRequest = 0
const managementContext = (): AutomationManagementContext => ({
  requestId: `production-management-${++managementRequest}`,
  principal: { type: 'renderer-user', id: 'production-verifier' },
  consumer: 'renderer-ipc'
})

const scope = { kind: 'workspace' as const, projectId: PROJECT_ID, workspaceId: WORKSPACE_ID }
const operationParams: Record<(typeof OPERATION_IDS)[number], unknown> = {
  'settings.getEffective': { workspaceId: WORKSPACE_ID },
  'settings.patchWorkspace': { workspaceId: WORKSPACE_ID, patch: { effort: 'low' } },
  'workspaces.getLineage': { workspaceId: WORKSPACE_ID },
  'workspaces.rename': { workspaceId: WORKSPACE_ID, name: 'Automated workspace' },
  'workspaces.reopen': { workspaceId: WORKSPACE_ID }
}
const siblingParams: Record<(typeof OPERATION_IDS)[number], unknown> = {
  'settings.getEffective': { workspaceId: SIBLING_ID },
  'settings.patchWorkspace': { workspaceId: SIBLING_ID, patch: { effort: 'low' } },
  'workspaces.getLineage': { workspaceId: SIBLING_ID },
  'workspaces.rename': { workspaceId: SIBLING_ID, name: 'Denied sibling rename' },
  'workspaces.reopen': { workspaceId: SIBLING_ID }
}

function definitionDraft(
  operationId: (typeof OPERATION_IDS)[number],
  params: unknown
): AutomationDefinitionDraft {
  return {
    name: `Production ${operationId}`,
    trigger: { kind: 'event', eventType: EVENT_TYPE },
    operationId,
    params,
    scope,
    enabled: true,
    idempotency: 'natural',
    timeoutMs: 1_000,
    concurrencyLimit: 1,
    retry: {
      maxAttempts: 2,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      maxElapsedMs: 10_000
    },
    rollingBudget: { windowMs: 1_000, maxStarts: 100 }
  }
}

assert.deepEqual(
  OPERATION_IDS.filter((operationId) => {
    const description = registry.describe(operationId)
    return description != null && automation.service.catalogEntry(description) != null
  }),
  [...OPERATION_IDS]
)
for (const operationId of OPERATION_IDS) {
  await assert.rejects(
    () =>
      automation.service.createDefinition(
        definitionDraft(operationId, siblingParams[operationId]),
        managementContext()
      ),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      (error as Error & { code: string }).code === 'forbidden'
  )
}

const definitions = []
for (const operationId of OPERATION_IDS) {
  definitions.push(
    await automation.service.createDefinition(
      definitionDraft(operationId, operationParams[operationId]),
      managementContext()
    )
  )
}
assert.equal(automation.service.listDefinitions().length, OPERATION_IDS.length)

const firstEvent = {
  id: 'production-event-1',
  type: EVENT_TYPE,
  occurredAt: now,
  projectId: PROJECT_ID,
  workspaceId: WORKSPACE_ID
}
const firstRuns = await automation.scheduler.emitEvent(firstEvent)
assert.equal(firstRuns.length, OPERATION_IDS.length)
assert.ok(
  firstRuns.every(({ status, resultCode }) => status === 'succeeded' && resultCode === 'completed'),
  JSON.stringify(
    firstRuns.map(({ automationId, status, resultCode }) => ({ automationId, status, resultCode }))
  )
)
assert.deepEqual(
  firstRuns
    .map(({ automationId }) => definitions.find(({ id }) => id === automationId)?.operationId)
    .sort(),
  [...OPERATION_IDS].sort()
)
assert.equal(workspaceSnapshots.get(WORKSPACE_ID)?.name, 'Automated workspace')
assert.equal(workspaceSnapshots.get(WORKSPACE_ID)?.closedAt, null)
assert.equal(workspaceSettings.overrides.effort, 'low')
assert.equal(renameWrites, 1)
assert.equal(reopenWrites, 1)
assert.equal(settingsWrites, 1)

for (const run of firstRuns) {
  assert.ok(run.auditId)
  const audit = db
    .prepare(
      `SELECT operation_id, consumer, result_code, correlation_json
       FROM control_audit WHERE audit_id = ?`
    )
    .get(run.auditId!) as {
    operation_id: string
    consumer: string
    result_code: string
    correlation_json: string
  }
  assert.equal(
    audit.operation_id,
    definitions.find(({ id }) => id === run.automationId)?.operationId
  )
  assert.equal(audit.consumer, 'automation')
  assert.equal(audit.result_code, 'completed')
  assert.deepEqual(
    (({ automationId, runId, idempotencyKey }) => ({
      automationId,
      runId,
      idempotencyKey
    }))(JSON.parse(audit.correlation_json) as Record<string, unknown>),
    {
      automationId: run.automationId,
      runId: run.id,
      idempotencyKey: run.idempotencyKey
    }
  )
}

const repeatedFirstRuns = await automation.scheduler.emitEvent(firstEvent)
assert.deepEqual(repeatedFirstRuns.map(({ id }) => id).sort(), firstRuns.map(({ id }) => id).sort())
assert.equal(automation.service.listRuns(undefined, 100).length, OPERATION_IDS.length)
assert.equal(renameWrites, 1)
assert.equal(reopenWrites, 1)
assert.equal(settingsWrites, 1)

now += 1
const replayRuns = await automation.scheduler.emitEvent({
  ...firstEvent,
  id: 'production-event-2',
  occurredAt: now
})
assert.equal(replayRuns.length, OPERATION_IDS.length)
assert.ok(
  replayRuns.every(({ status, resultCode }) => status === 'succeeded' && resultCode === 'completed')
)
assert.equal(automation.service.listRuns(undefined, 100).length, OPERATION_IDS.length * 2)
assert.equal(renameWrites, 1, 'natural rename replay must not write an unchanged name')
assert.equal(reopenWrites, 1, 'natural reopen replay must not write an already-open workspace')
assert.equal(settingsWrites, 1, 'natural settings replay must not persist an unchanged override')
assert.equal(workspaceSettings.overrides.effort, 'low')

for (const definition of definitions) {
  const disabled = await automation.scheduler.setEnabled(definition.id, false, managementContext())
  automation.scheduler.deleteDefinition(disabled.id, managementContext())
}
assert.equal(automation.service.listDefinitions().length, 0)
workspaceSnapshots.set(WORKSPACE_ID, { ...originalWorkspace })
workspaceSettings = {
  ...originalWorkspaceSettings,
  overrides: { ...originalWorkspaceSettings.overrides }
}
dirty = false
assert.deepEqual(workspaceSnapshots.get(WORKSPACE_ID), originalWorkspace)
assert.deepEqual(workspaceSettings, originalWorkspaceSettings)
assert.equal(dirty, false)
db.close()

console.log('Production automation operations verification passed.')
