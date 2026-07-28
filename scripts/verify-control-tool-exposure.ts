import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import {
  ControlToolExposureStore,
  withControlToolExposurePolicy
} from '../src/main/controlPlane/controlToolExposure.ts'
import { ControlRegistry } from '../src/main/controlPlane/registry.ts'
import {
  DEFAULT_RUNTIME_CONTROL_PERMISSIONS,
  RuntimeControlGrantPolicy
} from '../src/main/controlPlane/runtimeGrants.ts'
import type { ClaudeRuntimeBinding } from '../src/main/controlPlane/runtimeLeases.ts'
import { createRuntimeResourceScopeSource } from '../src/main/controlPlane/runtimeResourceScope.ts'
import type {
  ControlAuthorizationPolicy,
  ControlContext,
  ControlDescriptor,
  ControlDescription
} from '../src/main/controlPlane/types.ts'

const db = new Database(':memory:')
db.exec(`
  CREATE TABLE control_tool_category_preferences (
    category_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE control_tool_preferences (
    operation_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  );
`)

const descriptions: ControlDescription[] = [
  {
    id: 'workspaces.list',
    version: 1,
    kind: 'query',
    description: 'List workspaces.',
    inputSchema: {},
    outputSchema: {},
    allowedSurfaces: ['mcp'],
    permission: 'workspaces.read',
    scope: { kind: 'project' },
    risk: { tier: 0, label: 'read' },
    declaredEffects: []
  },
  {
    id: 'workspaces.rename',
    version: 1,
    kind: 'mutation',
    description: 'Rename a workspace.',
    inputSchema: {},
    outputSchema: {},
    allowedSurfaces: ['mcp'],
    permission: 'workspaces.rename',
    scope: { kind: 'workspace', inputField: 'workspaceId' },
    risk: { tier: 2, label: 'write' },
    declaredEffects: ['db.write']
  },
  {
    id: 'workspaces.reopen',
    version: 1,
    kind: 'mutation',
    description: 'Reopen a workspace.',
    inputSchema: {},
    outputSchema: {},
    allowedSurfaces: ['mcp'],
    permission: 'workspaces.open',
    scope: { kind: 'workspace', inputField: 'workspaceId' },
    risk: { tier: 1, label: 'lifecycle' },
    declaredEffects: ['db.write']
  },
  {
    id: 'reviews.setResolved',
    version: 1,
    kind: 'mutation',
    description: 'Resolve a review.',
    inputSchema: {},
    outputSchema: {},
    allowedSurfaces: ['renderer'],
    permission: 'reviews.resolve',
    scope: { kind: 'resource', inputField: 'id' },
    risk: { tier: 2, label: 'write' },
    declaredEffects: ['db.write']
  }
]
let now = 100
const exposure = new ControlToolExposureStore(
  db,
  () => descriptions,
  () => now++
)

// Missing rows are enabled, and renderer-only operations never appear as
// pretend MCP toggles.
let snapshot = exposure.get()
assert.deepEqual(
  snapshot.tools.map((tool) => tool.id),
  ['workspaces.list', 'workspaces.rename', 'workspaces.reopen']
)
assert.ok(snapshot.tools.every((tool) => tool.enabled && tool.override == null))
assert.equal(snapshot.updatedAt, null)

snapshot = exposure.update({ target: 'category', id: 'workspaces', enabled: false })
assert.ok(snapshot.tools.every((tool) => !tool.enabled && !tool.categoryEnabled))
assert.equal(exposure.isEnabled('workspaces.rename'), false)

snapshot = exposure.update({ target: 'tool', id: 'workspaces.rename', enabled: true })
assert.equal(snapshot.tools.find((tool) => tool.id === 'workspaces.rename')?.enabled, false)
assert.throws(
  () => exposure.update({ target: 'tool', id: 'reviews.setResolved', enabled: true }),
  /Unknown control tool/
)

snapshot = exposure.reset({ target: 'category', id: 'workspaces' })
assert.equal(snapshot.tools.find((tool) => tool.id === 'workspaces.rename')?.enabled, true)
assert.equal(snapshot.tools.find((tool) => tool.id === 'workspaces.reopen')?.enabled, true)

// Per-tool disable is exact: another operation in the same category remains
// discoverable. Invocation checks exposure after base authorization resolves,
// immediately before the handler.
exposure.update({ target: 'tool', id: 'workspaces.rename', enabled: false })
const allow: ControlAuthorizationPolicy = {
  canDiscover: () => true,
  authorize: () => ({ allowed: true })
}
const policy = withControlToolExposurePolicy(allow, exposure)
const context: ControlContext = {
  principal: { type: 'workspace-agent', id: 'runtime-1' },
  consumer: 'mcp',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  requestId: 'request-1'
}
assert.equal(policy.canDiscover(descriptions[0]!, context), true)
assert.equal(policy.canDiscover(descriptions[1]!, context), false)
assert.equal(policy.canDiscover(descriptions[2]!, context), true)

let mutationCalls = 0
const registry = new ControlRegistry(policy)
registry.register({
  ...descriptions[1],
  validateInput: (input): input is Record<string, never> =>
    input != null && typeof input === 'object' && Object.keys(input).length === 0,
  handler: () => {
    mutationCalls++
    return {}
  }
} as ControlDescriptor<Record<string, never>, Record<string, never>>)
const disabledResult = await registry.invoke({ id: 'workspaces.rename', input: {}, context })
assert.equal(disabledResult.ok, false)
assert.equal(mutationCalls, 0)

exposure.reset({ target: 'all' })
const disableDuringBaseAuthorization = withControlToolExposurePolicy(
  {
    canDiscover: () => true,
    authorize: () => {
      exposure.update({ target: 'tool', id: 'workspaces.rename', enabled: false })
      return { allowed: true }
    }
  },
  exposure
)
assert.deepEqual(await disableDuringBaseAuthorization.authorize(descriptions[1]!, {}, context), {
  allowed: false,
  code: 'forbidden',
  error: 'This Orpheus control tool is disabled in Settings.'
})

// Live managed leases receive the full vocabulary. Pending and stale bindings
// fail closed even when a caller retains an old object.
const liveBinding: ClaudeRuntimeBinding = {
  runtimeId: 'runtime-1',
  runtimeKind: 'claude',
  surfaceId: 'workspace-1',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  claudeConversationId: 'conversation-1',
  parentWorkspaceId: null,
  forkedFromConversationId: null,
  issuedAt: 1,
  state: 'live',
  pid: 42
}
const livePolicy = new RuntimeControlGrantPolicy(undefined, {
  getCurrentBinding: () => liveBinding
})
assert.deepEqual(livePolicy.permissionsFor(liveBinding), DEFAULT_RUNTIME_CONTROL_PERMISSIONS)
assert.deepEqual(livePolicy.permissionsFor({ ...liveBinding, state: 'pending', pid: null }), [])
assert.deepEqual(
  new RuntimeControlGrantPolicy(undefined, { getCurrentBinding: () => null }).permissionsFor(
    liveBinding
  ),
  []
)

// Pane scope is re-derived from current DB rows and limited to the runtime's
// project plus its worktree roots.
db.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL);
  CREATE TABLE workspaces (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, cwd TEXT NOT NULL);
  CREATE TABLE pane_layouts (id TEXT PRIMARY KEY, dir TEXT NOT NULL);
  CREATE TABLE pane_terminals (id TEXT PRIMARY KEY, layout_id TEXT NOT NULL);
  INSERT INTO projects VALUES ('project-1', '/code/project-one'), ('project-2', '/code/project-two');
  INSERT INTO workspaces VALUES ('workspace-1', 'project-1', '/code/project-one'),
    ('worktree-1', 'project-1', '/tmp/project-one-worktree');
  INSERT INTO pane_layouts VALUES ('layout-project', '/code/project-one/subdir'),
    ('layout-worktree', '/tmp/project-one-worktree'),
    ('layout-other', '/code/project-two');
  INSERT INTO pane_terminals VALUES ('terminal-project', 'layout-project'),
    ('terminal-worktree', 'layout-worktree'),
    ('terminal-other', 'layout-other');
`)
const scopeSource = createRuntimeResourceScopeSource(db)
assert.deepEqual(scopeSource(liveBinding), {
  selfOnly: true,
  layoutIds: ['layout-project', 'layout-worktree'],
  surfaceIds: ['pane:layout-project:terminal-project', 'pane:layout-worktree:terminal-worktree']
})
db.prepare("DELETE FROM pane_layouts WHERE id = 'layout-project'").run()
db.prepare("DELETE FROM pane_terminals WHERE layout_id = 'layout-project'").run()
assert.deepEqual(scopeSource(liveBinding).layoutIds, ['layout-worktree'])

console.log('Control tool exposure verification passed.')
