// ---------------------------------------------------------------------------
// scripts/verify-doctor.ts
//
// C2 (multi-harness migration) BEHAVIOR guard for
// src/shared/harness/doctor.ts — the pure decision logic behind the
// missing-harness boot gate (App.tsx's showMissingModal) and the
// per-harness install check. Pure module, no Electron/DB imports, so this
// runs as a plain script — no mock.module() needed (see
// scripts/verify-harness-registry.ts's header for why THAT one does).
//
// Asserts, against the REAL exported functions (isAnyHarnessInstalled,
// isHarnessInstalled), not a restatement of their source text:
//
//   1. All registered harnesses present/installed -> isAnyHarnessInstalled
//      is true (no modal).
//   2. No harness installed at all -> isAnyHarnessInstalled is false (modal
//      shows).
//   3. Mixed (some installed, some not) -> isAnyHarnessInstalled is true —
//      the gate is ANY, not ALL.
//   4. Empty harnesses array -> isAnyHarnessInstalled is false (nothing to
//      be installed).
//   5. With exactly ONE registered harness (today's real HARNESSES list —
//      see src/main/harness/registry.ts), isAnyHarnessInstalled agrees with
//      that harness's own `installed` flag in both directions — this is the
//      single-harness equivalence the C2 migration must preserve: on a
//      Claude-only machine, today's `claudeInstalled` boolean and the new
//      gate must produce identical results.
//   6. isHarnessInstalled finds the right entry by id, is false for an id
//      absent from the result, and false for a present-but-not-installed id.
//   7. SINGLE SOURCE OF TRUTH: src/shared/harness/membership.ts's
//      HARNESS_IDS constant (a plain data array, extracted so
//      workspaceCapabilities.ts can validate a harnessId WITHOUT importing
//      registry.ts's electron-reaching chain — see membership.ts's own
//      header) must never drift from src/main/harness/registry.ts's REAL
//      HARNESSES list. Asserted here as a set-equality check between
//      HARNESS_IDS and HARNESSES.map(h => h.id) — this is the guard that
//      makes the C2-follow-up split (moving isKnownHarnessId's DATA out of
//      registry.ts) safe. Uses the same mock.module()-then-dynamic-import
//      technique as scripts/verify-harness-registry.ts to reach the real
//      registry without linking electron.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { isAnyHarnessInstalled, isHarnessInstalled } from '../src/shared/harness/doctor.ts'
import {
  HARNESS_IDS,
  isKnownHarnessId as isKnownHarnessIdPure
} from '../src/shared/harness/membership.ts'
import type { DoctorResult, HarnessDoctorEntry } from '../src/shared/types.ts'

function entry(id: string, installed: boolean): HarnessDoctorEntry {
  return {
    id,
    label: id,
    installed,
    version: installed ? '1.0.0' : null,
    path: installed ? `/usr/local/bin/${id}` : null
  }
}

function makeResult(entries: HarnessDoctorEntry[]): DoctorResult {
  return { harnesses: entries }
}

// 1. All installed -> true
assert.equal(
  isAnyHarnessInstalled(makeResult([entry('claude', true), entry('codex-cli', true)])),
  true,
  'all harnesses installed must gate the modal OFF'
)

// 2. None installed -> false
assert.equal(
  isAnyHarnessInstalled(makeResult([entry('claude', false), entry('codex-cli', false)])),
  false,
  'no harness installed must gate the modal ON'
)

// 3. Mixed -> true (ANY, not ALL)
assert.equal(
  isAnyHarnessInstalled(makeResult([entry('claude', false), entry('codex-cli', true)])),
  true,
  'gate must be ANY installed, not ALL installed'
)

// 4. Empty -> false
assert.equal(
  isAnyHarnessInstalled(makeResult([])),
  false,
  'empty harness list must gate the modal ON'
)

// 5. Single-harness equivalence (today's real shape: HARNESSES has exactly
// one descriptor, Claude). Both directions must agree with the harness's
// own `installed` flag — this is the regression net for "identical to
// today's boolean on a Claude-only machine."
assert.equal(
  isAnyHarnessInstalled(makeResult([entry('claude', true)])),
  true,
  'single-harness installed=true must read as installed'
)
assert.equal(
  isAnyHarnessInstalled(makeResult([entry('claude', false)])),
  false,
  'single-harness installed=false must read as not-installed'
)

// 6. isHarnessInstalled — per-id lookup
const mixed = makeResult([entry('claude', true), entry('codex-cli', false)])
assert.equal(isHarnessInstalled(mixed, 'claude'), true, 'installed harness by id must be true')
assert.equal(
  isHarnessInstalled(mixed, 'codex-cli'),
  false,
  'present-but-not-installed harness by id must be false'
)
assert.equal(
  isHarnessInstalled(mixed, 'gemini-cli'),
  false,
  'id absent from the result entirely must be false'
)

// 7. HARNESS_IDS (shared/harness/membership.ts) vs the REAL HARNESSES list
// (src/main/harness/registry.ts). Same electron-stubbing technique as
// scripts/verify-harness-registry.ts — resolveHarness/getHarnessDescriptor/
// isKnownHarnessId/HARNESSES never touch the DB or a BrowserWindow, so the
// stubs below exist only to satisfy the module linker and are never called.
const mainDir = new URL('../src/main/', import.meta.url)
const abs = (rel: string): string => new URL(rel, mainDir).pathname

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
  // codex/launch.ts -> codex/session.ts, which imports both getWorkspace
  // AND setWorkspaceClaudeSessionId from this module. Same "throw if
  // actually invoked" discipline as getWorkspace above.
  setWorkspaceClaudeSessionId: () => {
    throw new Error(
      'setWorkspaceClaudeSessionId() must not be called by the registry lookup functions'
    )
  }
}))

const { HARNESSES } = await import('../src/main/harness/registry.ts')
const realIds = HARNESSES.map((h) => h.id)

assert.deepEqual(
  [...HARNESS_IDS].sort(),
  [...realIds].sort(),
  'HARNESS_IDS (shared/harness/membership.ts) must exactly match HARNESSES.map(h => h.id) (main/harness/registry.ts) — update both together'
)

// And the predicate itself must agree with the real registry for every real
// id, using HARNESS_IDS as its (default) source — proving the shared
// constant is not just numerically equal in size but actually the same set
// membership isKnownHarnessId (registry.ts) would report.
for (const id of realIds) {
  assert.equal(
    isKnownHarnessIdPure(id),
    true,
    `real harness id ${id} must be known via the shared HARNESS_IDS-backed predicate`
  )
}
assert.equal(
  isKnownHarnessIdPure('definitely-not-a-real-harness'),
  false,
  'an id absent from every real descriptor must not be reported as known'
)

console.log('[verify-doctor] all assertions passed')
