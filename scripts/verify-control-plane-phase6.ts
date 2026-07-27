import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
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
import { bootControlRegistry } from '../src/main/controlPlane/boot.ts'
import { createConfiguredControlRegistry } from '../src/main/controlPlane/configuredRegistry.ts'
import { createTrustedRuntimeReadPolicy } from '../src/main/controlPlane/readPolicy.ts'
import { RuntimeControlGrantPolicy } from '../src/main/controlPlane/runtimeGrants.ts'
import {
  RESOURCES_LIST_PROJECT_METADATA_ID,
  SETTINGS_GET_EFFECTIVE_ID,
  SETTINGS_PATCH_WORKSPACE_ID,
  SettingsResourceService
} from '../src/main/controlPlane/settingsResourceService.ts'
import type {
  ControlContext,
  ControlPermission,
  ReviewCapabilityHandlers
} from '../src/main/controlPlane/types.ts'
import type { ClaudeRuntimeBinding } from '../src/main/controlPlane/runtimeLeases.ts'
import type { WorkspaceControlAuditRecord } from '../src/main/workspaceOrchestration/types.ts'
import { recursivelyRedact } from '../src/main/workspaceOrchestration/redaction.ts'
import { resolveProjectResourcePath } from '../src/main/projectResourceScope.ts'

const leaseBinding: ClaudeRuntimeBinding = {
  runtimeId: 'runtime-1',
  runtimeKind: 'claude',
  surfaceId: 'surface-1',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  claudeConversationId: 'conversation-1',
  parentWorkspaceId: null,
  forkedFromConversationId: null,
  issuedAt: 1,
  state: 'live',
  pid: 42
}

const defaultPermissions = new RuntimeControlGrantPolicy().permissionsFor(leaseBinding)
assert.equal(defaultPermissions.includes('settings.read'), false)
assert.equal(defaultPermissions.includes('settings.workspace.patch'), false)
assert.equal(defaultPermissions.includes('resources.read'), false)

const exactPermissions = new RuntimeControlGrantPolicy(() => ({
  permissions: ['settings.read', 'settings.workspace.patch', 'resources.read'],
  maxRiskTier: 2
})).permissionsFor(leaseBinding)
assert.equal(exactPermissions.includes('settings.read'), true)
assert.equal(exactPermissions.includes('settings.workspace.patch'), true)
assert.equal(exactPermissions.includes('resources.read'), true)

const tierZeroPermissions = new RuntimeControlGrantPolicy(() => ({
  permissions: ['settings.read', 'settings.workspace.patch', 'resources.read'],
  maxRiskTier: 0
})).permissionsFor(leaseBinding)
assert.equal(tierZeroPermissions.includes('settings.read'), true)
assert.equal(tierZeroPermissions.includes('settings.workspace.patch'), false)
assert.equal(tierZeroPermissions.includes('resources.read'), true)

const workspace = {
  id: 'workspace-1',
  projectId: 'project-1',
  name: 'One',
  cwd: '/project-one'
} as WorkspaceRecord
const sibling = {
  id: 'workspace-2',
  projectId: 'project-1',
  name: 'Two',
  cwd: '/project-one'
} as WorkspaceRecord
const crossProject = {
  id: 'workspace-cross',
  projectId: 'project-2',
  name: 'Cross',
  cwd: '/project-two'
} as WorkspaceRecord
const workspaces = new Map([
  [workspace.id, workspace],
  [sibling.id, sibling],
  [crossProject.id, crossProject]
])

const globalSettings = {
  model: 'global-model',
  effort: 'auto',
  maxWorkspaceDepth: 4,
  maxWorkspaceChildren: 8,
  updatedAt: 100
} as ClaudeGlobalSettings
const projectSettings: ClaudeProjectSettings = {
  projectId: 'project-1',
  overrides: { model: 'project-model' },
  updatedAt: 200
}
let workspaceSettings: ClaudeWorkspaceSettings = {
  workspaceId: workspace.id,
  overrides: { effort: 'high' },
  updatedAt: 300
}
const siblingSettings: ClaudeWorkspaceSettings = {
  workspaceId: sibling.id,
  overrides: {},
  updatedAt: 0
}

let composeCalls = 0
let recomputeCalls = 0
let scopedMcpCalls = 0
let scopedHookCalls = 0
let scopedCommandCalls = 0
let scopedSubagentCalls = 0
let failNextUpdate = false
let failNextRecompute = false
let bulkMcp = false
let dirty = false
let idCounter = 0
const audits: WorkspaceControlAuditRecord[] = []
const updates: ClaudeWorkspaceSettingsOverrides[] = []

function composeLaunch(projectId?: string, workspaceId?: string): ClaudeLaunch {
  composeCalls++
  assert.equal(projectId, 'project-1')
  assert.ok(workspaceId === workspace.id || workspaceId === sibling.id)
  const targetSettings = workspaceId === workspace.id ? workspaceSettings : siblingSettings
  const model =
    targetSettings.overrides.model ?? projectSettings.overrides.model ?? globalSettings.model
  const effort =
    targetSettings.overrides.effort ?? projectSettings.overrides.effort ?? globalSettings.effort
  const tokens = model ? ['--model', model] : []
  if (effort !== 'auto') tokens.push('--effort', effort)
  return { flags: tokens.join(FLAG_DELIMITER), settingsJson: '', env: {}, model }
}

const service = new SettingsResourceService({
  getWorkspace: (workspaceId) => workspaces.get(workspaceId) ?? null,
  getProject: (projectId) =>
    projectId === 'project-1'
      ? ({
          id: projectId,
          path: '/project-one',
          name: 'Project One'
        } as ProjectRecord)
      : null,
  getGlobalSettings: () => globalSettings,
  getProjectSettings: (projectId) =>
    projectId === 'project-1' ? projectSettings : { projectId, overrides: {}, updatedAt: 0 },
  getWorkspaceSettings: (workspaceId) =>
    workspaceId === workspace.id ? workspaceSettings : siblingSettings,
  composeLaunch,
  updateWorkspaceSettings: (workspaceId, patch) => {
    assert.equal(workspaceId, workspace.id)
    if (failNextUpdate) {
      failNextUpdate = false
      throw new Error('token=do-not-leak /private/settings.json')
    }
    updates.push({ ...patch })
    const merged = { ...workspaceSettings.overrides }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === null) {
        delete merged[key as keyof ClaudeWorkspaceSettingsOverrides]
      } else {
        ;(merged as Record<string, unknown>)[key] = value
      }
    }
    workspaceSettings = {
      workspaceId,
      overrides: merged,
      updatedAt: 400
    }
    return workspaceSettings
  },
  reconcileEffort: (patch) =>
    patch.model === 'project-model' && patch.effort === undefined
      ? { ...patch, effort: 'medium' }
      : patch,
  recomputeDirty: () => {
    if (failNextRecompute) {
      failNextRecompute = false
      throw new Error('token=dirty-secret /private/dirty-state')
    }
    recomputeCalls++
    dirty = true
  },
  isDirty: () => dirty,
  listProjectMcpServers: (projectId) => {
    scopedMcpCalls++
    assert.equal(projectId, 'project-1')
    if (bulkMcp) {
      return Array.from({ length: 300 }, (_, index) => ({
        name: `server-${index.toString().padStart(3, '0')}`,
        transport: 'stdio' as const,
        command: '/secret/command',
        source: 'project' as const,
        projectId,
        filePath: '/project-one/.mcp.json'
      }))
    }
    return [
      {
        name: 'safe-server',
        transport: 'stdio',
        command: '/secret/command',
        args: ['--token=hidden'],
        env: { API_KEY: 'hidden' },
        url: 'https://user:pass@example.test',
        source: 'project',
        projectId,
        filePath: '/project-one/.mcp.json'
      }
    ]
  },
  listProjectHooks: (projectId) => {
    scopedHookCalls++
    assert.equal(projectId, 'project-1')
    return [
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        type: 'command',
        command: 'send token=hidden',
        source: 'project',
        projectId,
        filePath: '/project-one/.claude/settings.json',
        matcherEntryIdx: 0,
        hookIdx: 0
      }
    ]
  },
  listProjectSlashCommands: (projectId) => {
    scopedCommandCalls++
    assert.equal(projectId, 'project-1')
    return [
      {
        name: 'deploy',
        path: '/project-one/.claude/commands/deploy.md',
        source: 'project',
        projectId,
        description: 'token=highly-sensitive-value',
        allowedTools: ['Bash'],
        argumentHint: '<target>',
        frontmatter: { secret: 'hidden' },
        bodyPreview: 'secret body'
      }
    ]
  },
  listProjectSubagents: (projectId) => {
    scopedSubagentCalls++
    assert.equal(projectId, 'project-1')
    return [
      {
        name: 'reviewer',
        path: '/project-one/.claude/agents/reviewer.md',
        source: 'project',
        projectId,
        description: 'See https://user:pass@example.test/private',
        tools: Array.from({ length: 80 }, (_, index) => `Tool${index}`),
        model: '/private/model',
        frontmatter: { password: 'hidden' },
        bodyPreview: 'secret body'
      }
    ]
  },
  audit: { append: (record) => audits.push(record) },
  now: () => 1_000,
  generateId: () => `audit-${++idCounter}`
})

const reviewHandlers: ReviewCapabilityHandlers = {
  listByWorkspace: () => [],
  setResolved: () => {
    throw new Error('not used')
  }
}
const registry = createConfiguredControlRegistry({
  authorization: createTrustedRuntimeReadPolicy({
    getWorkspaceProjectId: (workspaceId) => workspaces.get(workspaceId)?.projectId ?? null
  }),
  settingsResources: service
})
bootControlRegistry(registry, reviewHandlers, undefined, undefined, service)

function context(permissions: readonly ControlPermission[]): ControlContext {
  return {
    principal: { type: 'workspace-agent', id: 'runtime-1' },
    consumer: 'mcp',
    workspaceId: 'hostile-ambient-workspace',
    projectId: 'hostile-ambient-project',
    requestId: `request-${idCounter + 1}`,
    trustedRuntime: {
      runtimeId: 'runtime-1',
      runtimeKind: 'claude',
      surfaceId: 'surface-1',
      workspaceId: workspace.id,
      projectId: workspace.projectId,
      claudeConversationId: 'conversation-1',
      issuedAt: 1,
      permissions
    }
  }
}

const noPhase6Context = context(defaultPermissions)
assert.equal(registry.describeForContext(SETTINGS_GET_EFFECTIVE_ID, noPhase6Context), null)
assert.equal(registry.describeForContext(SETTINGS_PATCH_WORKSPACE_ID, noPhase6Context), null)
assert.equal(registry.describeForContext(RESOURCES_LIST_PROJECT_METADATA_ID, noPhase6Context), null)

const grantedContext = context(exactPermissions)
function schemaContainsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((item) => schemaContainsKey(item, key))
  if (value == null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    Object.hasOwn(record, key) || Object.values(record).some((item) => schemaContainsKey(item, key))
  )
}

const phase6Catalog = registry
  .listForContext(grantedContext)
  .filter((description) =>
    [
      SETTINGS_GET_EFFECTIVE_ID,
      SETTINGS_PATCH_WORKSPACE_ID,
      RESOURCES_LIST_PROJECT_METADATA_ID
    ].includes(description.id)
  )
assert.deepEqual(
  phase6Catalog.map((description) => description.id),
  [RESOURCES_LIST_PROJECT_METADATA_ID, SETTINGS_GET_EFFECTIVE_ID, SETTINGS_PATCH_WORKSPACE_ID]
)

bulkMcp = true
const boundedResources = await registry.invoke({
  id: RESOURCES_LIST_PROJECT_METADATA_ID,
  input: { kinds: ['mcp_server'] },
  context: grantedContext
})
assert.equal(boundedResources.ok, true)
if (boundedResources.ok) {
  const value = boundedResources.value as ReturnType<typeof service.listProjectMetadata>
  assert.equal(value.resources.length, 256)
  assert.equal(value.resources[0]?.kind, 'mcp_server')
  assert.equal(value.resources.at(-1)?.kind, 'mcp_server')
}
bulkMcp = false

const staleProjectContext: ControlContext = {
  ...grantedContext,
  trustedRuntime: {
    ...grantedContext.trustedRuntime!,
    projectId: 'deleted-project'
  }
}
const staleProjectRead = await registry.invoke({
  id: RESOURCES_LIST_PROJECT_METADATA_ID,
  input: {},
  context: staleProjectContext
})
assert.deepEqual(staleProjectRead, {
  ok: false,
  code: 'not_found',
  error: 'Requested resource was not found.'
})
for (const description of phase6Catalog) {
  assert.equal(description.allowedSurfaces.length, 1)
  assert.equal(description.allowedSurfaces[0], 'mcp')
  assert.equal(description.inputSchema.additionalProperties, false)
  for (const excluded of [
    'customEnvVars',
    'customCliFlags',
    'preLaunchSnippet',
    'sourceZshrc',
    'apiKey',
    'command',
    'bodyPreview',
    'frontmatter',
    'filePath'
  ]) {
    assert.equal(
      schemaContainsKey(description, excluded),
      false,
      `${description.id} leaked ${excluded}`
    )
  }
}

const effective = await registry.invoke({
  id: SETTINGS_GET_EFFECTIVE_ID,
  input: {},
  context: grantedContext
})
assert.equal(effective.ok, true)
if (effective.ok) {
  const value = effective.value as ReturnType<typeof service.getEffective>
  assert.equal(value.settings.model.effective, 'project-model')
  assert.equal(value.settings.model.source, 'project')
  assert.equal(value.settings.effort.effective, 'high')
  assert.equal(value.settings.effort.source, 'workspace')
  assert.equal(value.orpheus.maxWorkspaceDepth, 4)
  assert.equal(value.restartRequired, false)
}
assert.equal(composeCalls, 1)

const siblingRead = await registry.invoke({
  id: SETTINGS_GET_EFFECTIVE_ID,
  input: { workspaceId: sibling.id },
  context: grantedContext
})
assert.equal(siblingRead.ok, true)
if (siblingRead.ok) {
  const value = siblingRead.value as ReturnType<typeof service.getEffective>
  assert.equal(value.workspaceId, sibling.id)
  assert.equal(value.settings.model.source, 'project')
  assert.equal(value.settings.effort.source, 'global')
}

const safeGlobalModel = globalSettings.model
globalSettings.model = 'token=must-not-be-published'
const unsafeStoredSettings = await registry.invoke({
  id: SETTINGS_GET_EFFECTIVE_ID,
  input: {},
  context: grantedContext
})
assert.deepEqual(unsafeStoredSettings, {
  ok: false,
  code: 'unavailable',
  error: 'Effective settings are unavailable.'
})
assert.equal(JSON.stringify(unsafeStoredSettings).includes('must-not-be-published'), false)
globalSettings.model = safeGlobalModel

const crossRead = await registry.invoke({
  id: SETTINGS_GET_EFFECTIVE_ID,
  input: { workspaceId: crossProject.id },
  context: grantedContext
})
assert.deepEqual(crossRead, {
  ok: false,
  code: 'not_found',
  error: 'Requested resource was not found.'
})

const resourceResult = await registry.invoke({
  id: RESOURCES_LIST_PROJECT_METADATA_ID,
  input: {},
  context: grantedContext
})
assert.equal(resourceResult.ok, true)
if (resourceResult.ok) {
  const value = resourceResult.value as ReturnType<typeof service.listProjectMetadata>
  const serialized = JSON.stringify(resourceResult.value)
  for (const secret of [
    '/secret/command',
    '--token=hidden',
    'API_KEY',
    'user:pass',
    'send token=hidden',
    '/project-one/',
    'secret body',
    'frontmatter',
    'matcherEntryIdx'
  ]) {
    assert.equal(serialized.includes(secret), false, `resource result leaked ${secret}`)
  }
  assert.equal(serialized.includes('[REDACTED]'), true)
  const subagent = value.resources.find((resource) => resource.kind === 'subagent')
  assert.ok(subagent?.kind === 'subagent')
  assert.equal(subagent.description, '[REDACTED]')
  assert.equal(subagent.model, '[REDACTED]')
  assert.equal(subagent.tools?.length, 64)
}
assert.deepEqual(
  [scopedMcpCalls, scopedHookCalls, scopedCommandCalls, scopedSubagentCalls],
  [2, 1, 1, 1]
)

const invalidPatch = await registry.invoke({
  id: SETTINGS_PATCH_WORKSPACE_ID,
  input: { patch: { model: 'safe', apiKey: 'nested-secret-value' } },
  context: grantedContext
})
assert.equal(invalidPatch.ok, false)
if (!invalidPatch.ok) assert.equal(invalidPatch.code, 'invalid')
const invalidAudit = audits.at(-1)
assert.ok(invalidAudit)
assert.equal(
  (invalidAudit.redactedParams['patch'] as Record<string, unknown>)['apiKey'],
  '[REDACTED]'
)

const siblingPatch = await registry.invoke({
  id: SETTINGS_PATCH_WORKSPACE_ID,
  input: { workspaceId: sibling.id, patch: { effort: 'low' } },
  context: grantedContext
})
assert.deepEqual(siblingPatch, {
  ok: false,
  code: 'not_found',
  error: 'Requested resource was not found.'
})

const patch = await registry.invoke({
  id: SETTINGS_PATCH_WORKSPACE_ID,
  input: { patch: { model: 'claude-sonnet-5', effort: 'low' } },
  context: grantedContext
})
assert.equal(patch.ok, true)
if (patch.ok) {
  const value = patch.value as Awaited<ReturnType<typeof service.patchWorkspace>>
  assert.equal(value.effective.settings.model.effective, 'claude-sonnet-5')
  assert.equal(value.effective.settings.model.source, 'workspace')
  assert.equal(value.effective.settings.effort.effective, 'low')
  assert.equal(value.restartRequired, true)
  assert.deepEqual(value.effects, [
    { effect: 'db.write', status: 'applied' },
    { effect: 'workspace.dirty.recompute', status: 'applied' }
  ])
}
assert.deepEqual(updates.at(-1), { model: 'claude-sonnet-5', effort: 'low' })
assert.equal(recomputeCalls, 1)
const successAudit = audits.at(-1)
assert.ok(successAudit)
assert.equal(successAudit.decision, 'allow')
assert.equal(successAudit.result.code, 'completed')

const clearModel = await registry.invoke({
  id: SETTINGS_PATCH_WORKSPACE_ID,
  input: { patch: { model: null } },
  context: grantedContext
})
assert.equal(clearModel.ok, true)
if (clearModel.ok) {
  const value = clearModel.value as Awaited<ReturnType<typeof service.patchWorkspace>>
  assert.equal(value.applied.model, null)
  assert.equal(value.effective.settings.model.effective, 'project-model')
  assert.equal(value.effective.settings.effort.effective, 'medium')
}
assert.deepEqual(updates.at(-1), { model: undefined, effort: 'medium' })

failNextRecompute = true
const dirtyFailure = await registry.invoke({
  id: SETTINGS_PATCH_WORKSPACE_ID,
  input: { patch: { effort: 'medium' } },
  context: grantedContext
})
assert.deepEqual(dirtyFailure, {
  ok: false,
  code: 'failed',
  error: 'Workspace settings update failed.'
})
const dirtyFailureAudit = audits.at(-1)
assert.ok(dirtyFailureAudit)
assert.deepEqual(dirtyFailureAudit.receipts, [
  { effect: 'db.write', status: 'applied', workspaceId: workspace.id },
  {
    effect: 'workspace.dirty.recompute',
    status: 'failed',
    workspaceId: workspace.id
  }
])

failNextUpdate = true
const failedPatch = await registry.invoke({
  id: SETTINGS_PATCH_WORKSPACE_ID,
  input: { patch: { effort: 'high' } },
  context: grantedContext
})
assert.deepEqual(failedPatch, {
  ok: false,
  code: 'failed',
  error: 'Workspace settings update failed.'
})
assert.equal(JSON.stringify(failedPatch).includes('do-not-leak'), false)
assert.equal(JSON.stringify(failedPatch).includes('/private/'), false)

const redacted = recursivelyRedact({
  nested: {
    apiKey: 'abcdef',
    credential: 'abcdef',
    safe: 'token=highly-sensitive-value',
    array: [{ authorization: 'Bearer hidden' }, 'Bearer another-hidden']
  }
})
assert.deepEqual(redacted, {
  nested: {
    apiKey: '[REDACTED]',
    credential: '[REDACTED]',
    safe: '[REDACTED]',
    array: [{ authorization: '[REDACTED]' }, '[REDACTED]']
  }
})

const resourceFixture = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'orpheus-phase6-scope-'))
try {
  const projectRoot = nodePath.join(resourceFixture, 'project')
  const outsideRoot = nodePath.join(resourceFixture, 'outside')
  fs.mkdirSync(nodePath.join(projectRoot, '.claude'), { recursive: true })
  fs.mkdirSync(outsideRoot)
  fs.writeFileSync(nodePath.join(outsideRoot, 'settings.json'), '{}')
  fs.symlinkSync(outsideRoot, nodePath.join(projectRoot, '.claude', 'commands'))
  fs.symlinkSync(
    nodePath.join(outsideRoot, 'settings.json'),
    nodePath.join(projectRoot, '.mcp.json')
  )
  assert.equal(resolveProjectResourcePath(projectRoot, ['.claude', 'commands'], 'directory'), null)
  assert.equal(resolveProjectResourcePath(projectRoot, ['.mcp.json'], 'file'), null)

  const localFile = nodePath.join(projectRoot, '.claude', 'settings.json')
  fs.writeFileSync(localFile, '{}')
  assert.equal(
    resolveProjectResourcePath(projectRoot, ['.claude', 'settings.json'], 'file'),
    localFile
  )
} finally {
  fs.rmSync(resourceFixture, { recursive: true, force: true })
}

console.log('Phase 6 settings/resources verification passed')
