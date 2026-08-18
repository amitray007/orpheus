// ---------------------------------------------------------------------------
// scripts/verify-harness-settings-ui.ts
//
// Behavior guard for the harness settings UI's pure logic module
// (src/renderer/src/components/dashboard/settings/harnessSettingsLogic.ts,
// U8, multi-harness architecture plan). Asserts against the REAL exported
// functions (isSecretLikeKey, moveRow, resolveProvenance), not a restatement
// of their logic or a grep over component source text — see CLAUDE.md:
// "Assert behaviour, not source text... Extract the logic into a directly-
// callable pure function and call it."
//
// RUNTIME CHOICE — plain `bun run`, not `node --experimental-strip-types`.
// harnessSettingsLogic.ts has zero SQLite/native/Electron dependencies (pure
// TS types + arithmetic over plain objects), unlike verify-harness-settings.ts
// / verify-harness-claude-launch.ts / verify-harness-session.ts, which need a
// real better-sqlite3-backed DB and hit a documented Bun/native-addon crash —
// see verify-harness-settings.ts's own header for that constraint. No such
// constraint applies here, so this runs like the majority of this repo's
// verify-*.ts scripts (bun run scripts/<name>.ts).
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import {
  isSecretLikeKey,
  moveRow,
  resolveProvenance,
  type HarnessScopeSettingsBundle
} from '../src/renderer/src/components/dashboard/settings/harnessSettingsLogic'

// ---------------------------------------------------------------------------
// isSecretLikeKey
// ---------------------------------------------------------------------------

const SECRET_POSITIVES = [
  'API_KEY',
  'ANTHROPIC_API_KEY',
  'GITHUB_TOKEN',
  'secret_value',
  'password',
  'AUTH_HEADER',
  'MY_CREDENTIAL',
  'OAUTH_TOKEN'
]
for (const key of SECRET_POSITIVES) {
  assert.ok(isSecretLikeKey(key), `expected isSecretLikeKey('${key}') to be true`)
}

const SECRET_NEGATIVES = ['PATH', 'NODE_ENV', 'DEBUG', '--verbose', 'CLAUDE_CODE_DISABLE_MOUSE']
for (const key of SECRET_NEGATIVES) {
  assert.ok(!isSecretLikeKey(key), `expected isSecretLikeKey('${key}') to be false`)
}

console.log(
  `✓ isSecretLikeKey: ${SECRET_POSITIVES.length} positives, ${SECRET_NEGATIVES.length} negatives`
)

// ---------------------------------------------------------------------------
// moveRow
// ---------------------------------------------------------------------------

const rows = ['a', 'b', 'c']

// Middle move up.
assert.deepEqual(moveRow(rows, 1, 'up'), ['b', 'a', 'c'])
// Middle move down.
assert.deepEqual(moveRow(rows, 1, 'down'), ['a', 'c', 'b'])
// Boundary no-ops: first row up, last row down.
assert.deepEqual(moveRow(rows, 0, 'up'), ['a', 'b', 'c'])
assert.deepEqual(moveRow(rows, 2, 'down'), ['a', 'b', 'c'])
// Out-of-range index — safe no-op, not a throw.
assert.deepEqual(moveRow(rows, 99, 'up'), ['a', 'b', 'c'])
assert.deepEqual(moveRow(rows, -1, 'down'), ['a', 'b', 'c'])
// Original array is never mutated.
assert.deepEqual(rows, ['a', 'b', 'c'])

console.log('✓ moveRow: reorders correctly, boundary/out-of-range no-ops confirmed, no mutation')

// ---------------------------------------------------------------------------
// resolveProvenance
// ---------------------------------------------------------------------------

const layered: HarnessScopeSettingsBundle = {
  global: {
    args: [{ key: '--verbose', value: undefined, enabled: true }],
    env: [{ key: 'ANTHROPIC_LOG', value: 'debug', enabled: true }],
    curated: { model: 'claude-opus-4-7' }
  },
  project: {
    args: [{ key: '--add-dir', value: '/repo', enabled: true }]
  },
  workspace: {
    args: [{ key: '--verbose', value: undefined, enabled: false }],
    curated: { model: 'claude-sonnet-4-7', effort: 'high' }
  }
}

const provenance = resolveProvenance(layered)

// A key set at global only -> reports 'global'.
assert.equal(provenance.env.get('ANTHROPIC_LOG'), 'global')
// A key introduced at project only -> reports 'project'.
assert.equal(provenance.args.get('--add-dir'), 'project')
// A key set at global AND overridden at workspace -> provenance still
// reports the FIRST (lowest-precedence) scope that introduced it — 'global'
// — since provenance answers "where did this row come from", not "which
// scope currently wins" (that's resolveHarnessSettings' job, a different
// function this component also calls for the effective/merged view).
assert.equal(provenance.args.get('--verbose'), 'global')
// A key never set anywhere -> absent, not a crash.
assert.equal(provenance.args.get('--never-set'), undefined)
assert.equal(provenance.env.get('--never-set'), undefined)

// Curated: model set at both global and workspace -> reports 'global' (first
// scope to introduce it, same "where did this come from" semantics).
assert.equal(provenance.curated.model, 'global')
// Curated: effort set at workspace only -> reports 'workspace'.
assert.equal(provenance.curated.effort, 'workspace')
// Curated: permissionMode never set anywhere -> absent.
assert.equal(provenance.curated.permissionMode, undefined)

console.log('✓ resolveProvenance: layered scenario resolves the correct introducing scope')

console.log('\nharness settings UI logic verification passed')
