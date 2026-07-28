import assert from 'node:assert/strict'
import {
  createPhase456QaGrantSource,
  parsePhase456QaScope,
  phase456QaGrantEnabled,
  PHASE456_QA_PERMISSIONS
} from '../src/main/controlPlane/phase456QaGrant.ts'
import type { ClaudeRuntimeBinding } from '../src/main/controlPlane/runtimeLeases.ts'
import {
  BASE_RUNTIME_CONTROL_PERMISSIONS,
  DEFAULT_RUNTIME_CONTROL_PERMISSIONS,
  RuntimeControlGrantPolicy
} from '../src/main/controlPlane/runtimeGrants.ts'

const VALID_SCOPE = Object.freeze({
  projectId: 'project-1',
  workspaceId: 'workspace-1',
  layoutId: 'layout-1',
  terminalId: 'terminal-1'
})
const VALID_SCOPE_JSON = JSON.stringify(VALID_SCOPE)

function binding(overrides: Partial<ClaudeRuntimeBinding> = {}): ClaudeRuntimeBinding {
  return {
    runtimeId: 'runtime-1',
    runtimeKind: 'claude',
    surfaceId: VALID_SCOPE.workspaceId,
    workspaceId: VALID_SCOPE.workspaceId,
    projectId: VALID_SCOPE.projectId,
    claudeConversationId: 'conversation-1',
    parentWorkspaceId: null,
    forkedFromConversationId: null,
    issuedAt: 1,
    state: 'live',
    pid: 42,
    ...overrides
  }
}

assert.equal(phase456QaGrantEnabled(undefined, 'Orpheus Dev'), false)
assert.equal(phase456QaGrantEnabled('0', 'Orpheus Dev'), false)
assert.equal(phase456QaGrantEnabled('1', 'Orpheus'), false)
assert.equal(phase456QaGrantEnabled('1', 'Orpheus WT'), false)
assert.equal(phase456QaGrantEnabled('1', 'Orpheus Dev'), true)

assert.deepEqual(parsePhase456QaScope(VALID_SCOPE_JSON), VALID_SCOPE)
for (const invalid of [
  undefined,
  '',
  'null',
  '[]',
  '{',
  JSON.stringify({ ...VALID_SCOPE, extra: true }),
  JSON.stringify({ ...VALID_SCOPE, workspaceId: '' }),
  JSON.stringify({ ...VALID_SCOPE, workspaceId: ' workspace-1' }),
  JSON.stringify({ ...VALID_SCOPE, terminalId: 'x'.repeat(129) }),
  JSON.stringify({
    projectId: VALID_SCOPE.projectId,
    workspaceId: VALID_SCOPE.workspaceId,
    layoutId: VALID_SCOPE.layoutId
  })
]) {
  assert.equal(parsePhase456QaScope(invalid), null)
}

let workspaceLookups = 0
let paneLookups = 0
let runtimeLookups = 0
let observedRuntime = binding()
const sourceOptions = {
  flagValue: '1',
  scopeValue: VALID_SCOPE_JSON,
  appName: 'Orpheus Dev',
  getRuntimeBinding: (runtimeId: string) => {
    runtimeLookups++
    return runtimeId === observedRuntime.runtimeId ? observedRuntime : null
  },
  getWorkspaceProjectId: (workspaceId: string) => {
    workspaceLookups++
    return workspaceId === VALID_SCOPE.workspaceId ? VALID_SCOPE.projectId : null
  },
  hasPaneTerminal: (layoutId: string, terminalId: string) => {
    paneLookups++
    return layoutId === VALID_SCOPE.layoutId && terminalId === VALID_SCOPE.terminalId
  }
}

const productionSource = createPhase456QaGrantSource({
  ...sourceOptions,
  appName: 'Orpheus'
})
assert.equal(productionSource, undefined)
assert.equal(runtimeLookups, 0)
assert.equal(workspaceLookups, 0)
assert.equal(paneLookups, 0)

const malformedSource = createPhase456QaGrantSource({
  ...sourceOptions,
  scopeValue: '{"workspaceId":"workspace-1"}'
})
assert.equal(malformedSource, undefined)
assert.equal(runtimeLookups, 0)
assert.equal(workspaceLookups, 0)
assert.equal(paneLookups, 0)

const source = createPhase456QaGrantSource(sourceOptions)
assert.ok(source)
const grant = source(binding())
assert.ok(grant)
assert.equal(grant.maxRiskTier, 2)
assert.deepEqual(grant.permissions, PHASE456_QA_PERMISSIONS)
assert.deepEqual(grant.scope, {
  selfOnly: true,
  layoutIds: [VALID_SCOPE.layoutId],
  surfaceIds: [`pane:${VALID_SCOPE.layoutId}:${VALID_SCOPE.terminalId}`]
})
assert.ok(Object.isFrozen(grant))
assert.ok(Object.isFrozen(grant.permissions))
assert.ok(Object.isFrozen(grant.scope))
assert.ok(Object.isFrozen(grant.scope?.layoutIds))
assert.ok(Object.isFrozen(grant.scope?.surfaceIds))
assert.equal(runtimeLookups, 1)
assert.equal(workspaceLookups, 1)
assert.equal(paneLookups, 1)

for (const mismatch of [
  binding({ projectId: 'project-2' }),
  binding({ workspaceId: 'workspace-2' }),
  binding({ surfaceId: 'surface-2' }),
  binding({ state: 'pending', pid: null }),
  binding({ pid: null }),
  binding({ pid: 0 }),
  binding({ pid: -1 }),
  binding({ pid: 1.5 }),
  binding({ pid: Number.NaN })
]) {
  assert.equal(source(mismatch), null)
}
assert.equal(runtimeLookups, 1, 'invalid bindings must fail before main-store lookup')
assert.equal(workspaceLookups, 1)
assert.equal(paneLookups, 1)

const pendingPolicy = new RuntimeControlGrantPolicy(source)
assert.deepEqual(pendingPolicy.permissionsFor(binding({ state: 'pending', pid: null })), [])
assert.deepEqual(pendingPolicy.scopeFor(binding({ state: 'pending', pid: null })), {
  selfOnly: true,
  layoutIds: [],
  surfaceIds: []
})

const revokedSource = createPhase456QaGrantSource({
  ...sourceOptions,
  getRuntimeBinding: () => null
})
assert.ok(revokedSource)
const revokedPolicy = new RuntimeControlGrantPolicy(revokedSource)
assert.deepEqual(revokedPolicy.permissionsFor(binding()), BASE_RUNTIME_CONTROL_PERMISSIONS)
assert.deepEqual(revokedPolicy.scopeFor(binding()), {
  selfOnly: true,
  layoutIds: [],
  surfaceIds: []
})

const mismatchedObservedSource = createPhase456QaGrantSource({
  ...sourceOptions,
  getRuntimeBinding: () => binding({ pid: 43 })
})
assert.ok(mismatchedObservedSource)
assert.deepEqual(
  new RuntimeControlGrantPolicy(mismatchedObservedSource).permissionsFor(binding()),
  BASE_RUNTIME_CONTROL_PERMISSIONS
)

const pendingObservedSource = createPhase456QaGrantSource({
  ...sourceOptions,
  getRuntimeBinding: () => binding({ state: 'pending', pid: null })
})
assert.ok(pendingObservedSource)
assert.deepEqual(
  new RuntimeControlGrantPolicy(pendingObservedSource).permissionsFor(binding()),
  BASE_RUNTIME_CONTROL_PERMISSIONS
)

observedRuntime = binding({ runtimeId: 'runtime-2', issuedAt: 2, pid: 84 })
const rotatedGrant = source(observedRuntime)
assert.strictEqual(
  rotatedGrant,
  grant,
  'a fresh live, observed lease for the selected workspace is valid'
)

const policy = new RuntimeControlGrantPolicy(source)
const permissions = policy.permissionsFor(observedRuntime)
for (const permission of [...BASE_RUNTIME_CONTROL_PERMISSIONS, ...PHASE456_QA_PERMISSIONS]) {
  assert.ok(permissions.includes(permission))
}
for (const forbidden of [
  'workspaces.create',
  'workspaces.send',
  'workspaces.archive',
  'reviews.resolve'
] as const) {
  assert.equal(permissions.includes(forbidden), false)
}
assert.deepEqual(policy.scopeFor(observedRuntime), grant.scope)

const staleWorkspaceSource = createPhase456QaGrantSource({
  ...sourceOptions,
  getRuntimeBinding: () => observedRuntime,
  getWorkspaceProjectId: () => null
})
assert.ok(staleWorkspaceSource)
assert.equal(staleWorkspaceSource(observedRuntime), null)

const stalePaneSource = createPhase456QaGrantSource({
  ...sourceOptions,
  getRuntimeBinding: () => observedRuntime,
  hasPaneTerminal: () => false
})
assert.ok(stalePaneSource)
assert.equal(stalePaneSource(observedRuntime), null)

const throwingSource = createPhase456QaGrantSource({
  ...sourceOptions,
  getRuntimeBinding: () => observedRuntime,
  getWorkspaceProjectId: () => {
    throw new Error('sensitive database failure')
  }
})
assert.ok(throwingSource)
assert.equal(throwingSource(observedRuntime), null)

const throwingRuntimeSource = createPhase456QaGrantSource({
  ...sourceOptions,
  getRuntimeBinding: () => {
    throw new Error('sensitive runtime registry failure')
  }
})
assert.ok(throwingRuntimeSource)
assert.equal(throwingRuntimeSource(binding()), null)

const defaultPolicy = new RuntimeControlGrantPolicy(
  createPhase456QaGrantSource({ ...sourceOptions, flagValue: undefined })
)
assert.deepEqual(defaultPolicy.permissionsFor(binding()), DEFAULT_RUNTIME_CONTROL_PERMISSIONS)
assert.deepEqual(defaultPolicy.scopeFor(binding()), {
  selfOnly: true,
  layoutIds: [],
  surfaceIds: []
})

console.log('Phase 4-6 Dev QA grant verification passed.')
