import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { bootControlRegistry } from '../src/main/controlPlane/boot.ts'
import {
  PROJECTS_GET_CONTROL_ID,
  PROJECTS_LIST_CONTROL_ID,
  SELF_GET_CONTROL_ID,
  WORKSPACES_GET_CONTROL_ID,
  WORKSPACES_GET_LAST_TURN_CONTROL_ID,
  WORKSPACES_GET_STATUS_CONTROL_ID,
  WORKSPACES_GET_TRANSCRIPT_CONTROL_ID,
  WORKSPACES_LIST_CONTROL_ID
} from '../src/main/controlPlane/readCapabilities.ts'
import { createTrustedRuntimeReadPolicy } from '../src/main/controlPlane/readPolicy.ts'
import {
  REVIEW_LIST_CONTROL_ID,
  REVIEW_SET_RESOLVED_CONTROL_ID
} from '../src/main/controlPlane/reviewCapabilities.ts'
import { ControlRegistry } from '../src/main/controlPlane/registry.ts'
import type {
  ControlContext,
  ControlPermission,
  ControlReadObservation,
  LastTurnReadModel,
  ProjectReadModel,
  ReadCapabilityHandlers,
  SelfReadModel,
  TranscriptReadModel,
  TrustedRuntimeBinding,
  WorkspaceReadModel,
  WorkspaceStatusReadModel
} from '../src/main/controlPlane/types.ts'
import type { LocalReviewComment } from '../src/shared/types.ts'

const repoRoot = path.resolve(import.meta.dirname, '..')
const readRepoFile = (relativePath: string): string =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')

function schemaContainsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((item) => schemaContainsKey(item, key))
  if (value == null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    Object.hasOwn(record, key) || Object.values(record).some((item) => schemaContainsKey(item, key))
  )
}

function observation<T>(
  value: T,
  source: ControlReadObservation<T>['source'] = 'sqlite'
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

const allReadPermissions: readonly ControlPermission[] = [
  'identity.read',
  'projects.read',
  'workspaces.read',
  'reviews.read'
]

const binding: TrustedRuntimeBinding = {
  runtimeId: 'runtime-1',
  runtimeKind: 'claude',
  surfaceId: 'surface-1',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  claudeConversationId: 'conversation-1',
  issuedAt: 500,
  permissions: allReadPermissions
}

const mcpContext: ControlContext = {
  principal: { type: 'workspace-agent', id: 'runtime-1' },
  consumer: 'mcp',
  // Deliberately hostile ambient hints: trusted defaults must ignore both.
  workspaceId: 'workspace-other-project',
  projectId: 'project-2',
  requestId: 'request-1',
  trustedRuntime: binding
}

const project: ProjectReadModel = {
  id: 'project-1',
  name: 'Project One',
  path: '/project-one',
  addedAt: 100,
  lastOpenedAt: 200,
  pinnedAt: null,
  classified: false,
  hidden: false
}

const workspace: WorkspaceReadModel = {
  id: 'workspace-1',
  projectId: 'project-1',
  name: 'Workspace One',
  cwd: '/project-one',
  pinnedAt: null,
  createdAt: 100,
  lastOpenedAt: 200,
  archivedAt: null,
  closedAt: null,
  status: 'idle',
  claudeConversationId: 'conversation-1',
  parentWorkspaceId: null,
  worktreeParentCwd: null,
  worktreeBranch: null
}

const self: SelfReadModel = {
  schemaVersion: 1,
  principal: {
    kind: 'orpheus_runtime',
    assurance: 'runtime_lease',
    runtimeId: binding.runtimeId
  },
  runtime: { kind: binding.runtimeKind, issuedAt: binding.issuedAt },
  surface: { surfaceId: binding.surfaceId },
  workspace: { workspaceId: workspace.id, projectId: project.id, cwd: workspace.cwd },
  project: { projectId: project.id, name: project.name },
  claudeConversation: { claudeConversationId: 'conversation-1' },
  defaults: {
    workspaceId: binding.workspaceId,
    projectId: binding.projectId,
    surfaceId: binding.surfaceId
  },
  capabilities: { allow: binding.permissions }
}

const status: WorkspaceStatusReadModel = {
  persistedStatus: 'idle',
  liveStatus: 'waiting',
  waitingFor: 'permission prompt'
}
const transcript: TranscriptReadModel = {
  turns: [{ role: 'assistant', text: 'Done.', timestamp: 800 }],
  truncated: false,
  bytesRead: 128
}
const lastTurn: LastTurnReadModel = {
  userText: 'Do it.',
  assistantText: 'Done.',
  userAt: 700,
  assistantAt: 800
}
const comment: LocalReviewComment = {
  id: 'comment-1',
  workspaceId: workspace.id,
  prNumber: null,
  path: 'src/example.ts',
  line: 10,
  startLine: null,
  side: 'RIGHT',
  body: 'Check this.',
  author: 'you',
  resolved: false,
  createdAt: 100,
  updatedAt: 100
}

const calls = {
  self: 0,
  projectIds: [] as string[],
  workspaceIds: [] as string[],
  workspaceList: [] as { projectId: string; scope: string }[],
  transcriptOptions: [] as object[],
  reviewWorkspaceIds: [] as string[]
}

const reads: ReadCapabilityHandlers = {
  getSelf: (receivedBinding) => {
    calls.self++
    assert.strictEqual(receivedBinding, binding)
    return observation(self, 'live')
  },
  listProjects: (projectId) => {
    calls.projectIds.push(projectId)
    return observation([project] as const)
  },
  getProject: (projectId) => {
    calls.projectIds.push(projectId)
    return observation(project)
  },
  listWorkspaces: (projectId, scope) => {
    calls.workspaceList.push({ projectId, scope })
    return observation([workspace] as const)
  },
  getWorkspace: (workspaceId) => {
    calls.workspaceIds.push(workspaceId)
    return observation(workspace)
  },
  getWorkspaceStatus: (workspaceId) => {
    calls.workspaceIds.push(workspaceId)
    return observation(status, 'claude-session-file')
  },
  getWorkspaceTranscript: (workspaceId, options) => {
    calls.workspaceIds.push(workspaceId)
    calls.transcriptOptions.push(options)
    return observation(transcript, 'claude-jsonl')
  },
  getWorkspaceLastTurn: (workspaceId) => {
    calls.workspaceIds.push(workspaceId)
    return observation(lastTurn, 'claude-jsonl')
  },
  listReviewsByWorkspace: (workspaceId) => {
    calls.reviewWorkspaceIds.push(workspaceId)
    return [comment]
  }
}

const policy = createTrustedRuntimeReadPolicy({
  getWorkspaceProjectId: (workspaceId) => {
    if (workspaceId === 'workspace-1' || workspaceId === 'workspace-sibling') return 'project-1'
    if (workspaceId === 'workspace-other-project') return 'project-2'
    return null
  }
})
const registry = new ControlRegistry(policy)
bootControlRegistry(
  registry,
  {
    listByWorkspace: reads.listReviewsByWorkspace,
    setResolved: () => {
      throw new Error('Phase 2 must never expose review mutation through MCP.')
    }
  },
  reads
)

// Discovery is catalog-driven, permission-filtered, and read-only.
{
  assert.deepEqual(
    registry.listForContext(mcpContext).map((description) => description.id),
    [
      PROJECTS_GET_CONTROL_ID,
      PROJECTS_LIST_CONTROL_ID,
      REVIEW_LIST_CONTROL_ID,
      SELF_GET_CONTROL_ID,
      WORKSPACES_GET_CONTROL_ID,
      WORKSPACES_GET_LAST_TURN_CONTROL_ID,
      WORKSPACES_GET_STATUS_CONTROL_ID,
      WORKSPACES_GET_TRANSCRIPT_CONTROL_ID,
      WORKSPACES_LIST_CONTROL_ID
    ].sort()
  )
  assert.equal(registry.describeForContext(REVIEW_SET_RESOLVED_CONTROL_ID, mcpContext), null)
  for (const description of registry.listForContext(mcpContext)) {
    assert.equal(description.version, 1)
    assert.equal(description.kind, 'query')
    assert.equal(description.risk.tier, 0)
    assert.ok(description.allowedSurfaces.includes('mcp'))
    assert.equal(description.inputSchema['additionalProperties'], false)
    assert.equal(schemaContainsKey(description.outputSchema, 'ref'), false)
  }
}

// Strict validators reject extra properties and out-of-range transcript requests
// before authorization or handlers.
{
  const invalidProject = await registry.invoke({
    id: PROJECTS_GET_CONTROL_ID,
    input: { projectId: 'project-1', extra: true },
    context: mcpContext
  })
  assert.equal(invalidProject.ok ? null : invalidProject.code, 'invalid')

  const invalidTranscript = await registry.invoke({
    id: WORKSPACES_GET_TRANSCRIPT_CONTROL_ID,
    input: { limit: 101 },
    context: mcpContext
  })
  assert.equal(invalidTranscript.ok ? null : invalidTranscript.code, 'invalid')

  for (const input of [{ workspaceId: '' }, { workspaceId: 'workspace-1', extra: true }]) {
    const invalidReview = await registry.invoke({
      id: REVIEW_LIST_CONTROL_ID,
      input,
      context: mcpContext
    })
    assert.equal(invalidReview.ok ? null : invalidReview.code, 'invalid')
  }
  assert.deepEqual(calls.projectIds, [])
  assert.deepEqual(calls.transcriptOptions, [])
  assert.deepEqual(calls.reviewWorkspaceIds, [])
}

// Omitted targets use only the trusted binding, never hostile ambient hints.
{
  assert.equal(
    (await registry.invoke({ id: SELF_GET_CONTROL_ID, input: {}, context: mcpContext })).ok,
    true
  )
  assert.equal(
    (await registry.invoke({ id: PROJECTS_LIST_CONTROL_ID, input: {}, context: mcpContext })).ok,
    true
  )
  assert.equal(
    (await registry.invoke({ id: PROJECTS_GET_CONTROL_ID, input: {}, context: mcpContext })).ok,
    true
  )
  assert.equal(
    (
      await registry.invoke({
        id: WORKSPACES_LIST_CONTROL_ID,
        input: {},
        context: mcpContext
      })
    ).ok,
    true
  )
  assert.equal(
    (await registry.invoke({ id: WORKSPACES_GET_CONTROL_ID, input: {}, context: mcpContext })).ok,
    true
  )
  assert.deepEqual(calls.projectIds, ['project-1', 'project-1'])
  assert.deepEqual(calls.workspaceList, [{ projectId: 'project-1', scope: 'active' }])
  assert.deepEqual(calls.workspaceIds, ['workspace-1'])
}

// Same-project explicit workspaces work; cross-project and unknown resources are
// non-enumerating not_found failures before a read handler runs.
{
  const sibling = await registry.invoke({
    id: WORKSPACES_GET_STATUS_CONTROL_ID,
    input: { workspaceId: 'workspace-sibling' },
    context: mcpContext
  })
  assert.equal(sibling.ok, true)

  for (const workspaceId of ['workspace-other-project', 'workspace-missing']) {
    const before = calls.workspaceIds.length
    const result = await registry.invoke({
      id: WORKSPACES_GET_CONTROL_ID,
      input: { workspaceId },
      context: mcpContext
    })
    assert.deepEqual(result, {
      ok: false,
      code: 'not_found',
      error: 'Requested resource was not found.'
    })
    assert.equal(calls.workspaceIds.length, before)
  }

  const crossProject = await registry.invoke({
    id: PROJECTS_GET_CONTROL_ID,
    input: { projectId: 'project-2' },
    context: mcpContext
  })
  assert.deepEqual(crossProject, {
    ok: false,
    code: 'not_found',
    error: 'Requested resource was not found.'
  })
}

// Transcript shaping reaches the injected reader without a caller-supplied target.
{
  const result = await registry.invoke({
    id: WORKSPACES_GET_TRANSCRIPT_CONTROL_ID,
    input: { limit: 10, role: 'assistant', since: 100, includeToolActivity: true },
    context: mcpContext
  })
  assert.equal(result.ok, true)
  assert.equal(calls.workspaceIds.at(-1), 'workspace-1')
  assert.deepEqual(calls.transcriptOptions.at(-1), {
    limit: 10,
    role: 'assistant',
    since: 100,
    includeToolActivity: true
  })
}

// Review reads are MCP-visible and same-project filtered; mutation is absent.
{
  const result = await registry.invoke({
    id: REVIEW_LIST_CONTROL_ID,
    input: { workspaceId: 'workspace-1' },
    context: mcpContext
  })
  assert.deepEqual(result, { ok: true, value: [comment] })
  assert.deepEqual(calls.reviewWorkspaceIds, ['workspace-1'])
  const mutation = await registry.invoke({
    id: REVIEW_SET_RESOLVED_CONTROL_ID,
    input: { id: 'comment-1', resolved: true },
    context: mcpContext
  })
  assert.equal(mutation.ok ? null : mutation.code, 'forbidden')
}

// Missing leases and missing grants fail closed in discovery and invocation.
{
  const untrusted = { ...mcpContext, trustedRuntime: null }
  assert.deepEqual(registry.listForContext(untrusted), [])
  const noLease = await registry.invoke({ id: SELF_GET_CONTROL_ID, input: {}, context: untrusted })
  assert.equal(noLease.ok ? null : noLease.code, 'forbidden')

  const identityOnly = {
    ...mcpContext,
    trustedRuntime: { ...binding, permissions: ['identity.read'] as const }
  }
  assert.deepEqual(
    registry.listForContext(identityOnly).map((description) => description.id),
    [SELF_GET_CONTROL_ID]
  )
  const denied = await registry.invoke({
    id: PROJECTS_GET_CONTROL_ID,
    input: {},
    context: identityOnly
  })
  assert.deepEqual(denied, {
    ok: false,
    code: 'forbidden',
    error: 'Permission denied: projects.read'
  })
}

// Phase 1 remains unchanged when read handlers/policy are not supplied.
{
  const legacy = new ControlRegistry()
  bootControlRegistry(legacy, {
    listByWorkspace: () => [],
    setResolved: () => comment
  })
  assert.deepEqual(legacy.describe(REVIEW_LIST_CONTROL_ID)?.allowedSurfaces, [
    'renderer',
    'command-socket'
  ])
  assert.deepEqual(legacy.listForContext(mcpContext), [])
}

// The new catalog/policy remains transport-neutral and does not import network,
// Electron, CLI, or live domain modules.
for (const relativePath of [
  'src/main/controlPlane/types.ts',
  'src/main/controlPlane/registry.ts',
  'src/main/controlPlane/readCapabilities.ts',
  'src/main/controlPlane/readPolicy.ts',
  'src/main/controlPlane/boot.ts'
]) {
  const source = readRepoFile(relativePath)
  assert.doesNotMatch(
    source,
    /from ['"].*(electron|orpheus-cli|commandServer|http|https|net|projects|workspaces|sessionState)/i
  )
}

console.log('✓ Phase 2 read-only control catalog and trusted-runtime policy verified')
