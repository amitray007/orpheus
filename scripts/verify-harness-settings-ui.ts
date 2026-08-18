// ---------------------------------------------------------------------------
// scripts/verify-harness-settings-ui.ts
//
// Behavior guard for the harness settings UI's pure logic module
// (src/renderer/src/components/dashboard/settings/harnessSettingsLogic.ts,
// U8, multi-harness architecture plan). Asserts against the REAL exported
// functions (isSecretLikeKey, moveRow, resolveProvenance, mergeDefaultArgs,
// draftsToStoredRows), not a restatement of their logic or a grep over
// component source text — see CLAUDE.md: "Assert behaviour, not source
// text... Extract the logic into a directly-callable pure function and call
// it."
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
  shouldResyncDrafts,
  moveRow,
  resolveProvenance,
  mergeDefaultArgs,
  draftsToStoredRows,
  type HarnessScopeSettingsBundle
} from '../src/renderer/src/components/dashboard/settings/harnessSettingsLogic'
import type { HarnessArgRow } from '../src/shared/harness/types'

/** Strip the display-only `fromDefault` marker, leaving the stored row shape.
 *  A destructure-to-omit (`({ fromDefault: _f, ...r }) => r`) reads fine but
 *  trips no-unused-vars here — this repo's config has no underscore
 *  exemption, and adding one for a test file is the wrong lever. */
function toStoredShape<T extends { fromDefault?: boolean }>(row: T): Omit<T, 'fromDefault'> {
  const copy = { ...row }
  delete copy.fromDefault
  return copy
}

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
//
// Two scopes only — global + project. Workspace scope was removed
// deliberately (see HARNESS_SETTINGS_SCOPE in src/main/db/schema.ts), and
// permissionMode is no longer a curated concept (it's a Claude flag now
// seeded as a defaultArgs row — see CuratedField's header in
// src/shared/harness/types.ts) — neither belongs in this bundle anymore.
// ---------------------------------------------------------------------------

const layered: HarnessScopeSettingsBundle = {
  global: {
    args: [
      { key: '--verbose', value: undefined, enabled: true },
      { key: '--permission-mode', value: 'acceptEdits', enabled: false }
    ],
    env: [{ key: 'ANTHROPIC_LOG', value: 'debug', enabled: true }],
    curated: { model: 'claude-opus-4-7' }
  },
  project: {
    args: [
      { key: '--add-dir', value: '/repo', enabled: true },
      { key: '--verbose', value: undefined, enabled: false }
    ],
    curated: { model: 'claude-sonnet-4-7', effort: 'high' }
  }
}

const provenance = resolveProvenance(layered)

// A key set at global only -> reports 'global'.
assert.equal(provenance.env.get('ANTHROPIC_LOG'), 'global')
// A key introduced at project only -> reports 'project'.
assert.equal(provenance.args.get('--add-dir'), 'project')
// A key set at global AND overridden at project -> provenance still
// reports the FIRST (lowest-precedence) scope that introduced it — 'global'
// — since provenance answers "where did this row come from", not "which
// scope currently wins" (that's resolveHarnessSettings' job, a different
// function this component also calls for the effective/merged view).
assert.equal(provenance.args.get('--verbose'), 'global')
// A key never set anywhere -> absent, not a crash.
assert.equal(provenance.args.get('--never-set'), undefined)
assert.equal(provenance.env.get('--never-set'), undefined)

// Curated: model set at both global and project -> reports 'global' (first
// scope to introduce it, same "where did this come from" semantics).
assert.equal(provenance.curated.model, 'global')
// Curated: effort set at project only -> reports 'project'.
assert.equal(provenance.curated.effort, 'project')
// Curated field names are now exactly 'model' | 'effort' — permissionMode is
// not a key of HarnessProvenance['curated'] at all anymore (a compile-time
// guarantee, not just a runtime absence), so there is nothing to assert for
// it here beyond that this file compiles.

console.log('✓ resolveProvenance: layered scenario resolves the correct introducing scope')

// ---------------------------------------------------------------------------
// mergeDefaultArgs / draftsToStoredRows — the defaultArgs seeding contract
// (task item 2): a shipped default must appear as a real, user-editable,
// visibly-marked row; a user edit or disable must stick; nothing gets
// written to storage just for being displayed; a NEW descriptor default
// must reach a user who already has custom rows.
// ---------------------------------------------------------------------------

const CLAUDE_LIKE_DEFAULTS: HarnessArgRow[] = [
  { key: '--permission-mode', value: 'acceptEdits', enabled: false }
]

// 1. Untouched default: no user row for this key at all -> appears with the
//    descriptor's own value/enabled, marked fromDefault, and — the write-path
//    half of the contract — draftsToStoredRows drops it (nothing persisted
//    just because it was displayed).
{
  const merged = mergeDefaultArgs(CLAUDE_LIKE_DEFAULTS, undefined)
  assert.deepEqual(merged, [
    { key: '--permission-mode', value: 'acceptEdits', enabled: false, fromDefault: true }
  ])
  const persisted = draftsToStoredRows(merged.map(toStoredShape), CLAUDE_LIKE_DEFAULTS)
  assert.deepEqual(persisted, [], 'an untouched default must not be written to storage')
}

// 2. User override wins: the user's stored row for the default's key has a
//    DIFFERENT value than the descriptor default -> the merge shows the
//    user's value (not the descriptor's), still marked fromDefault (it still
//    originated from a default), and persists because it now differs.
{
  const userRows = [{ key: '--permission-mode', value: 'plan', enabled: true }]
  const merged = mergeDefaultArgs(CLAUDE_LIKE_DEFAULTS, userRows)
  assert.deepEqual(merged, [
    { key: '--permission-mode', value: 'plan', enabled: true, fromDefault: true }
  ])
  const persisted = draftsToStoredRows(merged.map(toStoredShape), CLAUDE_LIKE_DEFAULTS)
  assert.deepEqual(persisted, [{ key: '--permission-mode', value: 'plan', enabled: true }])
}

// 3. User-disabled default stays disabled: descriptor ships it enabled:false
//    already, but exercise the inverse — descriptor default enabled, user
//    explicitly disables it -> disabled sticks through the merge AND persists
//    (differs from the descriptor's enabled:true).
{
  const enabledDefaults: HarnessArgRow[] = [{ key: '--verbose', value: undefined, enabled: true }]
  const userRows = [{ key: '--verbose', value: undefined, enabled: false }]
  const merged = mergeDefaultArgs(enabledDefaults, userRows)
  assert.deepEqual(merged, [
    { key: '--verbose', value: undefined, enabled: false, fromDefault: true }
  ])
  const persisted = draftsToStoredRows(merged.map(toStoredShape), enabledDefaults)
  assert.deepEqual(
    persisted,
    [{ key: '--verbose', value: undefined, enabled: false }],
    'a user-disabled default must persist the override, not be dropped'
  )
}

// 4. A NEW descriptor default appears for a user who already has unrelated
//    custom rows: the new default is prepended (defaults first, in
//    descriptor order) and the user's own rows follow, unmarked.
{
  const userRows = [{ key: '--add-dir', value: '/repo', enabled: true }]
  const merged = mergeDefaultArgs(CLAUDE_LIKE_DEFAULTS, userRows)
  assert.deepEqual(merged, [
    { key: '--permission-mode', value: 'acceptEdits', enabled: false, fromDefault: true },
    { key: '--add-dir', value: '/repo', enabled: true, fromDefault: false }
  ])
}

// 5. No defaultArgs at all (a harness that ships none) -> user rows pass
//    through untouched and unmarked, never a crash on undefined.
{
  const userRows = [{ key: '--add-dir', value: '/repo', enabled: true }]
  const merged = mergeDefaultArgs(undefined, userRows)
  assert.deepEqual(merged, [
    { key: '--add-dir', value: '/repo', enabled: true, fromDefault: false }
  ])
}

console.log(
  '✓ mergeDefaultArgs/draftsToStoredRows: untouched/override/disable/new-default/no-defaults all correct'
)

// ---------------------------------------------------------------------------
// MUTATION TEST — deliberately break the "don't clobber a user override"
// guarantee and confirm the assertion above actually catches it. This
// exercises the exact failure CLAUDE.md warns about: an assertion never
// tried against a mutation is one you don't know works.
// ---------------------------------------------------------------------------

function mutatedMergeDefaultArgsClobbersOverride(
  defaultArgs: readonly HarnessArgRow[] | undefined,
  userRows: readonly { key: string; value?: string; enabled: boolean }[] | undefined
): { key: string; value?: string; enabled: boolean; fromDefault: boolean }[] {
  // BUG: always uses the descriptor's own value/enabled, ignoring any
  // matching user row entirely — this is the exact "later descriptor change
  // clobbers a user's edit" regression task item 2 forbids.
  const defaults = defaultArgs ?? []
  const rows = userRows ?? []
  const defaultKeys = new Set(defaults.map((d) => d.key))
  const merged = defaults.map((def) => ({ ...def, fromDefault: true }))
  for (const row of rows) {
    if (!defaultKeys.has(row.key)) merged.push({ ...row, fromDefault: false })
  }
  return merged
}

{
  const userRows = [{ key: '--permission-mode', value: 'plan', enabled: true }]
  const mutatedResult = mutatedMergeDefaultArgsClobbersOverride(CLAUDE_LIKE_DEFAULTS, userRows)
  let threw = false
  try {
    assert.deepEqual(mutatedResult, [
      { key: '--permission-mode', value: 'plan', enabled: true, fromDefault: true }
    ])
  } catch (err) {
    threw = true
    console.log('  mutation caught (expected failure):', (err as Error).message.split('\n')[0])
  }
  assert.ok(threw, 'MUTATION TEST FAILED TO FAIL: the clobbering bug went undetected')
}

console.log('✓ mutation test: a clobbering merge is correctly caught as a failing assertion')

// ---------------------------------------------------------------------------
// shouldResyncDrafts — the Add-button regression
// ---------------------------------------------------------------------------
//
// REGRESSION: the row editor's resync guard compared external rows against
// ALL local drafts. `addRow` appends a blank, deliberately-uncommitted draft
// (a row with no key is not a setting yet), which made local diverge from
// external — so the guard fired on the next render and deleted the new row
// before the user could type. The Add args / Add env buttons looked dead:
// the row appeared and vanished inside one frame.
{
  const stored = [{ key: '--verbose', enabled: true }]

  // The bug: a pending blank draft must NOT count as divergence.
  assert.equal(
    shouldResyncDrafts(stored, [
      { key: '--verbose', enabled: true },
      { key: '', value: '', enabled: true }
    ]),
    false,
    'a pending blank draft must not trigger a resync — that is what deleted the new row'
  )

  // In-progress typing must survive too: the row exists locally but is not
  // yet stored, so external still has one row and local has one named row
  // plus the one being typed.
  assert.equal(
    shouldResyncDrafts(stored, [
      { key: '--verbose', enabled: true },
      { key: '--add', value: '', enabled: true }
    ]),
    true,
    'a newly NAMED row does diverge — the editor commits it, then props catch up'
  )

  // A real external change still resyncs.
  assert.equal(
    shouldResyncDrafts(
      [{ key: '--verbose', enabled: false }],
      [{ key: '--verbose', enabled: true }]
    ),
    true,
    'a genuine external change (toggled enabled) must still resync'
  )

  // Identical state must not resync — otherwise the editor thrashes forever.
  assert.equal(
    shouldResyncDrafts(stored, [{ key: '--verbose', enabled: true }]),
    false,
    'identical state must not resync'
  )
  // THE CRASH (React #301, too many re-renders). A blank row that reached
  // storage appears in `external`. If only the local side filtered blanks, the
  // two lists could never match: resync -> render -> still unequal -> resync,
  // forever, until React aborts. Reordering a blank row triggered it because
  // move() commits, and commit used to send blank rows upward.
  //
  // Both sides now filter, so the comparison is total: an equal set of KEYED
  // rows compares equal no matter what blanks either side carries.
  assert.equal(
    shouldResyncDrafts(
      [
        { key: '', value: '', enabled: true },
        { key: '--verbose', enabled: true }
      ],
      [{ key: '--verbose', enabled: true }]
    ),
    false,
    'a blank row in EXTERNAL must not force an unsatisfiable resync — this is the #301 crash'
  )

  // Convergence: whatever resync produces must itself not want another resync,
  // or the loop is merely slower rather than fixed.
  {
    const external = [
      { key: '', value: '', enabled: true },
      { key: '--verbose', enabled: true }
    ]
    const afterResync = external.map((r) => ({ ...r }))
    assert.equal(
      shouldResyncDrafts(external, afterResync),
      false,
      'the state produced BY a resync must not request another one — that is what makes it terminate'
    )
  }
  console.log('✓ shouldResyncDrafts: a pending blank row survives; real external changes resync')
  console.log(
    '✓ shouldResyncDrafts: a blank row in storage cannot cause an unsatisfiable resync loop'
  )
}

console.log('\nharness settings UI logic verification passed')
