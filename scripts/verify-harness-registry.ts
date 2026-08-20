// ---------------------------------------------------------------------------
// scripts/verify-harness-registry.ts
//
// Phase 1 (multi-harness migration, P1.7) BEHAVIOR guard for
// src/main/harness/registry.ts — the declarative harness list added in
// P1.2. Asserts, against the REAL exported functions (resolveHarness,
// getHarnessDescriptor, isKnownHarnessId, HARNESSES), not a restatement of
// their source text:
//
//   1. resolveHarness('claude') returns the Claude descriptor.
//   2. resolveHarness NEVER THROWS and always returns a usable descriptor —
//      for an unknown id, undefined, null, and '' alike. This is the
//      data-only-removal / stale-row guarantee documented on
//      resolveHarness's own doc comment: a workspace's `harness_id` column
//      can hold a value this build doesn't recognize (a descriptor removed
//      later, or a row written by a newer build read by an older one after
//      a rollback), and that must be INERT, not fatal.
//   3. isKnownHarnessId is true only for ids actually present in HARNESSES.
//   4. THE ToS INVARIANT, as an executable assertion: no descriptor other
//      than 'claude' may have capabilities.modelRouting === true. See
//      src/main/modelRouting.ts:10-14 — "for a Claude-model workspace,
//      applyModelRouting must be a byte-for-byte no-op. Claude traffic must
//      reach real api.anthropic.com via the official binary, never through
//      a third-party proxy." A second descriptor with modelRouting: true
//      would let a NON-Claude harness's traffic get routed through the
//      model-routing proxy — the thing that invariant exists to prevent for
//      Claude specifically must not silently become available to a harness
//      the invariant was never written to reason about. Today HARNESSES
//      holds only Claude, so this passes trivially; it exists so it goes RED
//      the moment a second descriptor sets modelRouting: true, rather than
//      relying on code review to catch it.
//   5. Every descriptor has non-empty id/label/binary/wrapperScript and all
//      eight HarnessCapabilities flags present as real booleans (not
//      undefined, not a truthy non-boolean) — the shape a UI gating on
//      `capabilities.xxx` must be able to trust without a null check.
//
// IMPORTABILITY: src/main/harness/registry.ts imports ./claudeSettings,
// which transitively imports ./workspaces (-> electron BrowserWindow) and
// ./db (-> electron app). A plain `bun run` import dies at module-link time
// outside Electron. This follows scripts/verify-project-add.ts's and
// scripts/verify-non-claude-launch-behavior.ts's precedent: mock.module()
// the handful of modules that reach electron, then dynamically import the
// module under test so real registry logic runs while only the unreachable
// electron surface is stubbed. Stubbed as little as possible — the stubs
// below throw if actually invoked, which itself proves resolveHarness/
// isKnownHarnessId/getHarnessDescriptor never need to touch the DB or
// electron to do their job.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import type { HarnessDescriptor } from '../src/shared/harness/types.ts'

// Module specifiers exactly as claudeSettings.ts imports them, resolved to
// absolute paths so mock.module() doesn't depend on this script's location
// relative to src/main (same technique as the two precedent scripts).
const mainDir = new URL('../src/main/', import.meta.url)
const abs = (rel: string): string => new URL(rel, mainDir).pathname

// Static imports hoist, so these must run BEFORE the dynamic import() below
// pulls in registry.ts -> claudeSettings.ts -> the real './db' (-> electron
// `app`) / './workspaces' (-> electron `BrowserWindow`). None of
// resolveHarness/getHarnessDescriptor/isKnownHarnessId/HARNESSES touch the
// DB or a BrowserWindow — the module reference to composeClaudeLaunch
// (assigned to CLAUDE_DESCRIPTOR.composeLaunch) is captured at module-eval
// time but never CALLED by anything this script exercises, so these stubs
// exist purely to satisfy the module linker and should never actually run.
mock.module('electron', () => ({}))
mock.module(abs('db/index.ts'), () => ({
  getDb: () => {
    throw new Error('getDb() must not be called by resolveHarness/getHarnessDescriptor')
  }
}))
mock.module(abs('workspaces.ts'), () => ({
  getWorkspace: () => {
    throw new Error('getWorkspace() must not be called by the registry lookup functions')
  },
  // C5 (support-multi-harness) — registry.ts now transitively reaches
  // codex/launch.ts -> codex/session.ts, which imports
  // setWorkspaceClaudeSessionId alongside getWorkspace (both from this same
  // module). Not previously exported by this stub because nothing on this
  // import path referenced it before C5. Same "throw if actually invoked"
  // discipline as getWorkspace above — this script only exercises the pure
  // registry lookup functions, never a real launch composition, so this
  // should never run either.
  setWorkspaceClaudeSessionId: () => {
    throw new Error(
      'setWorkspaceClaudeSessionId() must not be called by the registry lookup functions'
    )
  }
}))

const { HARNESSES, resolveHarness, getHarnessDescriptor, isKnownHarnessId } =
  await import('../src/main/harness/registry.ts')

// ---------------------------------------------------------------------------
// 1. resolveHarness('claude') returns the Claude descriptor.
// ---------------------------------------------------------------------------

{
  const claude = resolveHarness('claude')
  assert.equal(claude.id, 'claude')
  assert.equal(claude, getHarnessDescriptor('claude'))
  console.log("✓ resolveHarness('claude') returns the Claude descriptor")
}

// ---------------------------------------------------------------------------
// 2. resolveHarness never throws — unknown/undefined/null/empty all fall
//    back to a usable Claude descriptor with a real wrapperScript + binary.
// ---------------------------------------------------------------------------

{
  const inputs: Array<string | null | undefined> = ['nonexistent-harness', undefined, null, '']
  for (const input of inputs) {
    let resolved: HarnessDescriptor
    assert.doesNotThrow(
      () => {
        resolved = resolveHarness(input)
      },
      `resolveHarness(${JSON.stringify(input)}) must never throw`
    )
    assert.equal(
      resolved!.id,
      'claude',
      `resolveHarness(${JSON.stringify(input)}) must fall back to the Claude descriptor`
    )
    assert.ok(
      typeof resolved!.wrapperScript === 'string' && resolved!.wrapperScript.length > 0,
      `fallback descriptor for ${JSON.stringify(input)} must carry a real wrapperScript`
    )
    assert.ok(
      typeof resolved!.binary === 'string' && resolved!.binary.length > 0,
      `fallback descriptor for ${JSON.stringify(input)} must carry a real binary`
    )
  }
  console.log(
    '✓ resolveHarness NEVER THROWS for unknown/undefined/null/empty ids — always a usable Claude fallback'
  )
}

// ---------------------------------------------------------------------------
// Data-only-removal simulation: a "removed" descriptor's stale id must stay
// inert (fall back to Claude, not crash) for ANY id not currently in
// HARNESSES — proven generically rather than for one hardcoded string, so it
// also covers a currently-known id that gets removed later.
// ---------------------------------------------------------------------------

{
  const removedIds = ['never-a-real-harness', 'also-never-a-real-harness', 'some-future-harness-id']
  for (const id of removedIds) {
    assert.equal(
      HARNESSES.some((h: HarnessDescriptor) => h.id === id),
      false,
      `fixture id ${id} must not currently be a real descriptor (test would be vacuous otherwise)`
    )
    const resolved = resolveHarness(id)
    assert.equal(resolved.id, 'claude', `a stale/removed id (${id}) must resolve to Claude, inert`)
  }
  console.log('✓ a harness id absent from HARNESSES (simulating removal) resolves inert, not fatal')
}

// ---------------------------------------------------------------------------
// 3. isKnownHarnessId — true only for real membership in HARNESSES.
// ---------------------------------------------------------------------------

{
  assert.equal(isKnownHarnessId('claude'), true)
  assert.equal(isKnownHarnessId('nonexistent-harness'), false)
  assert.equal(isKnownHarnessId(''), false)
  console.log("✓ isKnownHarnessId is true for 'claude' and false for unknown ids")
}

// ---------------------------------------------------------------------------
// 4. THE ToS INVARIANT: no descriptor other than 'claude' may have
//    capabilities.modelRouting === true. See src/main/modelRouting.ts:10-14.
// ---------------------------------------------------------------------------

{
  const offenders = HARNESSES.filter(
    (h: HarnessDescriptor) => h.capabilities.modelRouting === true && h.id !== 'claude'
  )
  assert.deepEqual(
    offenders,
    [],
    'ToS invariant violated: a non-Claude harness descriptor sets capabilities.modelRouting === true. ' +
      'See src/main/modelRouting.ts:10-14 — Claude traffic must reach real api.anthropic.com via the ' +
      'official binary, never through a third-party proxy; a non-Claude harness must not silently gain ' +
      'that routing capability.'
  )
  console.log(
    "✓ ToS invariant: no descriptor other than 'claude' has capabilities.modelRouting === true"
  )
}

// ---------------------------------------------------------------------------
// 5. Every descriptor has non-empty id/label/binary/wrapperScript and all
//    eight capability flags present as real booleans.
// ---------------------------------------------------------------------------

{
  const CAPABILITY_KEYS = [
    'structuredStatus',
    'transcript',
    'resume',
    'fork',
    'usage',
    'hooks',
    'inlineSettingsJson',
    'modelRouting'
  ] as const

  assert.ok(HARNESSES.length > 0, 'HARNESSES must not be empty')

  for (const descriptor of HARNESSES as HarnessDescriptor[]) {
    for (const field of ['id', 'label', 'binary', 'wrapperScript'] as const) {
      const value = descriptor[field]
      assert.ok(
        typeof value === 'string' && value.length > 0,
        `descriptor ${descriptor.id}.${field} must be a non-empty string, got ${JSON.stringify(value)}`
      )
    }
    for (const key of CAPABILITY_KEYS) {
      const value = descriptor.capabilities[key]
      assert.equal(
        typeof value,
        'boolean',
        `descriptor ${descriptor.id}.capabilities.${key} must be a real boolean, got ${typeof value}`
      )
    }
  }
  console.log(
    '✓ every descriptor has non-empty id/label/binary/wrapperScript and all 8 capability flags as booleans'
  )
}

console.log('\nAll harness registry assertions passed.')
