// ---------------------------------------------------------------------------
// scripts/verify-runtime-leases.ts
//
// Deterministic, offline Phase 2 runtime-lease harness. It exercises the pure
// in-memory registry without importing Electron, opening the DB, starting the
// command socket, or launching Orpheus.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import {
  RuntimeLeaseRegistry,
  type ClaudeRuntimeIdentity
} from '../src/main/controlPlane/runtimeLeases.ts'

let now = 1_000
const runtimeIds = ['runtime-1', 'runtime-2', 'runtime-3', 'runtime-4']
const tokens = [
  'runtime-secret-one',
  'runtime-secret-one',
  'runtime-secret-two',
  'runtime-secret-three'
]
const registry = new RuntimeLeaseRegistry({
  now: () => now,
  generateRuntimeId: () => runtimeIds.shift() ?? 'runtime-fallback',
  generateToken: () => tokens.shift() ?? 'runtime-secret-fallback',
  pendingTtlMs: 500
})

const identity: ClaudeRuntimeIdentity = {
  surfaceId: 'surface-1',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  claudeConversationId: 'conversation-1',
  parentWorkspaceId: null,
  forkedFromConversationId: null
}

// First issue exposes the raw token exactly once and stores an immutable binding.
const first = registry.issueOrReuseClaude(identity)
assert.equal(first.created, true)
assert.equal(first.token, 'runtime-secret-one')
assert.ok(Object.isFrozen(first))
assert.ok(Object.isFrozen(first.binding))
assert.equal(first.binding.runtimeId, 'runtime-1')
assert.equal(first.binding.runtimeKind, 'claude')
assert.equal(first.binding.state, 'pending')
assert.equal(first.binding.pid, null)
assert.strictEqual(registry.resolve(first.token), first.binding)
assert.strictEqual(registry.getByRuntimeId('runtime-1'), first.binding)
assert.strictEqual(registry.getBySurfaceId('surface-1'), first.binding)
assert.deepEqual(registry.listByWorkspace('workspace-1'), [first.binding])

// A duplicate pending mount and a later hide/reattach reuse the same lease
// without re-exposing the raw token.
const pendingReuse = registry.issueOrReuseClaude(identity)
assert.equal(pendingReuse.created, false)
assert.equal(pendingReuse.token, null)
assert.strictEqual(pendingReuse.binding, first.binding)

const live = registry.markLive('runtime-1', 1234)
assert.ok(live)
assert.equal(live.state, 'live')
assert.equal(live.pid, 1234)
assert.notStrictEqual(live, first.binding)
assert.strictEqual(registry.resolve(first.token), live)

const hiddenReuse = registry.issueOrReuseClaude(identity)
assert.equal(hiddenReuse.created, false)
assert.equal(hiddenReuse.token, null)
assert.strictEqual(hiddenReuse.binding, live)

// Session observation is scoped by workspace and conversation. A mismatched
// conversation cannot mark or revoke the runtime.
assert.equal(
  registry.observeClaude({
    workspaceId: 'workspace-1',
    claudeConversationId: 'wrong-conversation',
    pid: 9876
  }),
  null
)
assert.strictEqual(registry.resolve(first.token), live)

// Destroy/restart revokes the previous token and creates a fresh runtime. The
// token generator deliberately collides once; the registry retries by digest.
assert.equal(registry.revokeBySurface('surface-1'), true)
assert.equal(registry.revokeBySurface('surface-1'), false)
assert.equal(registry.resolve(first.token), null)

now += 100
const restarted = registry.issueOrReuseClaude(identity)
assert.equal(restarted.created, true)
assert.equal(restarted.binding.runtimeId, 'runtime-2')
assert.equal(restarted.token, 'runtime-secret-two')
assert.notEqual(restarted.token, first.token)

// A missing observed Claude process revokes the lease even if the terminal
// surface remains alive and has dropped into its post-Claude shell.
assert.equal(
  registry.observeClaude({
    workspaceId: 'workspace-1',
    claudeConversationId: 'conversation-1',
    pid: 2222
  })?.state,
  'live'
)
assert.equal(
  registry.observeClaude({
    workspaceId: 'workspace-1',
    claudeConversationId: 'conversation-1',
    pid: null
  }),
  null
)
assert.equal(registry.resolve(restarted.token), null)

// Only pending leases expire. Advancing the injected clock makes expiry exact
// and keeps the test free of timers.
const expiring = registry.issueOrReuseClaude({
  ...identity,
  surfaceId: 'surface-expiring',
  workspaceId: 'workspace-expiring'
})
assert.equal(expiring.created, true)
now += 499
assert.equal(registry.sweepExpiredPendingLeases(), 0)
assert.strictEqual(registry.resolve(expiring.token), expiring.binding)
now += 1
assert.equal(registry.sweepExpiredPendingLeases(), 1)
assert.equal(registry.resolve(expiring.token), null)

const persistent = registry.issueOrReuseClaude({
  ...identity,
  surfaceId: 'surface-live',
  workspaceId: 'workspace-live'
})
assert.equal(persistent.created, true)
assert.ok(registry.markLive(persistent.binding.runtimeId, 3333))
now += 10_000
assert.equal(registry.sweepExpiredPendingLeases(), 0)
assert.strictEqual(registry.resolve(persistent.token)?.state, 'live')

// Workspace and global teardown are idempotent and remove every index.
assert.equal(registry.revokeByWorkspace('workspace-live'), 1)
assert.equal(registry.revokeByWorkspace('workspace-live'), 0)
assert.equal(registry.resolve(persistent.token), null)
assert.equal(registry.revokeAll(), 0)
assert.equal(registry.revokeAll(), 0)

// A pending runtime without a preassigned Claude conversation survives initial
// absence, adopts the first observed conversation, and then becomes live.
let adoptionNow = 5_000
const adoptionRegistry = new RuntimeLeaseRegistry({
  now: () => adoptionNow,
  generateRuntimeId: () => 'runtime-adoption',
  generateToken: () => 'runtime-secret-adoption',
  pendingTtlMs: 500
})
const adopting = adoptionRegistry.issueOrReuseClaude({
  ...identity,
  surfaceId: 'surface-adoption',
  workspaceId: 'workspace-adoption',
  claudeConversationId: null
})
assert.equal(adopting.created, true)
assert.strictEqual(
  adoptionRegistry.observeClaude({
    workspaceId: 'workspace-adoption',
    claudeConversationId: null,
    pid: null
  }),
  adopting.binding
)
assert.strictEqual(adoptionRegistry.resolve(adopting.token), adopting.binding)
const adopted = adoptionRegistry.observeClaude({
  workspaceId: 'workspace-adoption',
  claudeConversationId: 'conversation-adopted',
  pid: 4444
})
assert.ok(adopted)
assert.equal(adopted.claudeConversationId, 'conversation-adopted')
assert.equal(adopted.state, 'live')
assert.equal(adopted.pid, 4444)
assert.equal(
  adoptionRegistry.observeClaude({
    workspaceId: 'workspace-adoption',
    claudeConversationId: 'conversation-adopted',
    pid: 5555
  }),
  null
)
assert.equal(adoptionRegistry.resolve(adopting.token), null)
assert.equal(adoptionRegistry.getBySurfaceId('surface-adoption'), null)

// Authentication itself sweeps expired pending leases; callers do not need an
// external timer or explicit sweep before resolving a token.
const autoExpiryRegistry = new RuntimeLeaseRegistry({
  now: () => adoptionNow,
  generateRuntimeId: () => 'runtime-auto-expiry',
  generateToken: () => 'runtime-secret-auto-expiry',
  pendingTtlMs: 500
})
const autoExpiring = autoExpiryRegistry.issueOrReuseClaude({
  ...identity,
  surfaceId: 'surface-auto-expiry',
  workspaceId: 'workspace-auto-expiry'
})
assert.equal(autoExpiring.created, true)
adoptionNow += 500
assert.equal(autoExpiryRegistry.resolve(autoExpiring.token), null)
assert.equal(autoExpiryRegistry.getBySurfaceId('surface-auto-expiry'), null)

// Neither public diagnostics nor generated errors retain or echo a raw token.
const diagnostics = JSON.stringify({
  registry,
  bindings: registry.listByWorkspace('workspace-1')
})
assert.equal(diagnostics.includes('runtime-secret'), false)

const redactingRegistry = new RuntimeLeaseRegistry({
  generateRuntimeId: () => 'redaction-runtime',
  generateToken: () => {
    throw new Error('do-not-echo-this-secret')
  }
})
assert.throws(
  () => redactingRegistry.issueOrReuseClaude(identity),
  (error: unknown) =>
    error instanceof Error &&
    error.message === 'Failed to generate runtime lease token' &&
    !error.message.includes('do-not-echo-this-secret')
)

console.log('Runtime lease verification passed.')
