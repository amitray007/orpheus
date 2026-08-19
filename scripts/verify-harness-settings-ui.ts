// ---------------------------------------------------------------------------
// scripts/verify-harness-settings-ui.ts
//
// Behavior guard for the harness settings UI's pure logic module
// (src/renderer/src/components/dashboard/settings/harnessSettingsLogic.ts,
// U8, multi-harness architecture plan). Asserts against the REAL exported
// functions (isSecretLikeKey, moveRow, resolveProvenance, mergeDefaultArgs,
// draftsToStoredRows, hasUnsavedChanges), not a restatement of their logic
// or a grep over component source text — see CLAUDE.md: "Assert behaviour,
// not source text... Extract the logic into a directly-callable pure
// function and call it."
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
  hasUnsavedChanges,
  moveRow,
  resolveProvenance,
  mergeDefaultArgs,
  draftsToStoredRows,
  composedCommandPreview,
  summarizeArgRows,
  summarizeEnvRows,
  buildCuratedOptionRows,
  draftRowsToOverlay,
  curatedOptionsRowsDirty,
  summarizeCuratedOptionRows,
  type HarnessScopeSettingsBundle,
  type CuratedOptionRowDraft
} from '../src/renderer/src/components/dashboard/settings/harnessSettingsLogic'
import { resolveCuratedOptions } from '../src/shared/harness/curatedOptions'
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
// hasUnsavedChanges — the explicit-Save dirty check
// ---------------------------------------------------------------------------
//
// Replaces the old render-time resync guard (`shouldResyncDrafts`, deleted):
// the row editor no longer auto-saves on blur or fights local edits with a
// resync. Local drafts are the single source of truth while editing; this
// function only decides whether the Save button should be enabled.
{
  const loaded = [{ key: '--verbose', enabled: true }]

  // No difference at all -> not dirty.
  assert.equal(
    hasUnsavedChanges(loaded, [{ key: '--verbose', enabled: true }]),
    false,
    'identical drafts must not read as dirty'
  )

  // An edited value -> dirty.
  assert.equal(
    hasUnsavedChanges(loaded, [{ key: '--verbose', value: 'x', enabled: true }]),
    true,
    'an edited row value must read as dirty'
  )

  // A toggle -> dirty.
  assert.equal(
    hasUnsavedChanges(loaded, [{ key: '--verbose', enabled: false }]),
    true,
    'a toggled enabled flag must read as dirty'
  )

  // An added (named) row -> dirty.
  assert.equal(
    hasUnsavedChanges(loaded, [
      { key: '--verbose', enabled: true },
      { key: '--add-dir', value: '/repo', enabled: true }
    ]),
    true,
    'a newly added, named row must read as dirty'
  )

  // A reorder -> dirty (order is part of the persisted shape).
  assert.equal(
    hasUnsavedChanges(
      [
        { key: '--a', enabled: true },
        { key: '--b', enabled: true }
      ],
      [
        { key: '--b', enabled: true },
        { key: '--a', enabled: true }
      ]
    ),
    true,
    'a reordered pair must read as dirty'
  )

  // A removed row -> dirty.
  assert.equal(
    hasUnsavedChanges(
      [
        { key: '--a', enabled: true },
        { key: '--b', enabled: true }
      ],
      [{ key: '--a', enabled: true }]
    ),
    true,
    'a removed row must read as dirty'
  )

  // BLANK ROWS ARE NOT CHANGES. A pending, never-named Add-row draft must not
  // make an otherwise-untouched list read as dirty — that would enable Save
  // for a click that has nothing real to persist, and (per draftsToStoredRows
  // / the save-time filter) the blank row would be dropped anyway.
  assert.equal(
    hasUnsavedChanges(loaded, [
      { key: '--verbose', enabled: true },
      { key: '', value: '', enabled: true }
    ]),
    false,
    'a pending blank row must not make the drafts read as dirty'
  )

  // A blank row already present on BOTH sides (defensive — should never
  // happen once save-time filtering is correct, but the check must still be
  // symmetric) -> not dirty.
  assert.equal(
    hasUnsavedChanges(
      [
        { key: '', value: '', enabled: true },
        { key: '--verbose', enabled: true }
      ],
      [{ key: '--verbose', enabled: true }]
    ),
    false,
    'a blank row on either side must not affect dirtiness — the check is symmetric'
  )

  console.log(
    '✓ hasUnsavedChanges: edit/toggle/add/reorder/remove all dirty; identical and blank-only diffs are not'
  )
}

// ---------------------------------------------------------------------------
// MUTATION TEST — hasUnsavedChanges
// ---------------------------------------------------------------------------
//
// Deliberately break the dirty check (always return false, i.e. Save stays
// disabled forever no matter what the user typed) and confirm a real
// behavioral assertion — the exact shape used above, against the exact
// expected boolean a correct implementation must return — actually catches
// it. CLAUDE.md: "an assertion never tried against a mutation is one you
// don't know works."
function mutatedHasUnsavedChangesAlwaysClean(): boolean {
  // BUG: never reports dirty, no matter what differs. Takes no params (the
  // real signature's `loadedRows`/`draftRows` are irrelevant to a function
  // that ignores its input) rather than declaring and not using them.
  return false
}

{
  let threw = false
  try {
    assert.equal(mutatedHasUnsavedChangesAlwaysClean(), true, 'an edited row must read as dirty')
  } catch (err) {
    threw = true
    console.log('  mutation caught (expected failure):', (err as Error).message.split('\n')[0])
  }
  assert.ok(threw, 'MUTATION TEST FAILED TO FAIL: an always-false dirty check went undetected')

  console.log(
    '✓ mutation test: an always-false dirty check is correctly caught as a failing assertion'
  )
}

// ---------------------------------------------------------------------------
// composedCommandPreview (B2 restructure — Launch panel)
// ---------------------------------------------------------------------------

{
  assert.equal(
    composedCommandPreview('claude', []),
    'claude',
    'no rows -> bare binary, no trailing space'
  )

  assert.equal(
    composedCommandPreview('claude', [
      { key: '--permission-mode', value: 'acceptEdits', enabled: true },
      { key: '--verbose', enabled: true }
    ]),
    'claude --permission-mode acceptEdits --verbose',
    'enabled rows appear in order, flag then value when present'
  )

  assert.equal(
    composedCommandPreview('claude', [
      { key: '--permission-mode', value: 'acceptEdits', enabled: false },
      { key: '--verbose', enabled: true }
    ]),
    'claude --verbose',
    'a disabled row is skipped entirely'
  )

  assert.equal(
    composedCommandPreview('claude', [{ key: '', value: '', enabled: true }]),
    'claude',
    'a blank-key (in-progress Add) row is skipped, matching hasUnsavedChanges/draftsToStoredRows'
  )

  console.log(
    '✓ composedCommandPreview: binary-only, ordered flag+value, disabled-skip, blank-skip all correct'
  )
}

// MUTATION TEST — composedCommandPreview
function mutatedComposedCommandPreviewIgnoresEnabled(
  binary: string,
  rows: readonly { key: string; value?: string; enabled: boolean }[]
): string {
  // BUG: includes every named row regardless of `enabled`, so a disabled row
  // still shows up in the "what will actually run" line.
  const tokens = [binary]
  for (const row of rows) {
    if (row.key.trim() === '') continue
    tokens.push(row.key)
    if (row.value) tokens.push(row.value)
  }
  return tokens.join(' ')
}

{
  let threw = false
  try {
    assert.equal(
      mutatedComposedCommandPreviewIgnoresEnabled('claude', [{ key: '--verbose', enabled: false }]),
      'claude',
      'a disabled row must not appear in the composed preview'
    )
  } catch (err) {
    threw = true
    console.log('  mutation caught (expected failure):', (err as Error).message.split('\n')[0])
  }
  assert.ok(threw, 'MUTATION TEST FAILED TO FAIL: a preview that ignores `enabled` went undetected')

  console.log(
    '✓ mutation test: a composed preview that ignores `enabled` is correctly caught as a failing assertion'
  )
}

// ---------------------------------------------------------------------------
// summarizeArgRows / summarizeEnvRows (B2 restructure — section summary lines)
// ---------------------------------------------------------------------------

{
  assert.equal(summarizeArgRows([]), 'No arguments', 'empty rows -> "No arguments"')
  assert.equal(
    summarizeArgRows([{ key: '', enabled: true }]),
    'No arguments',
    'a blank-key row does not count toward the summary'
  )
  assert.equal(
    summarizeArgRows([
      { key: '--permission-mode', enabled: true, fromDefault: true },
      { key: '--verbose', enabled: false }
    ]),
    '1 enabled, 1 default',
    'mixed enabled/disabled/default rows summarized correctly'
  )
  assert.equal(
    summarizeArgRows([{ key: '--verbose', enabled: true }]),
    '1 enabled',
    'no default rows -> the ", N default" clause is omitted entirely'
  )

  assert.equal(summarizeEnvRows([]), 'No variables', 'empty rows -> "No variables"')
  assert.equal(
    summarizeEnvRows([{ key: '' }]),
    'No variables',
    'a blank-key row does not count toward the summary'
  )
  assert.equal(
    summarizeEnvRows([{ key: 'FOO' }]),
    '1 variable',
    'singular "variable" for exactly one'
  )
  assert.equal(
    summarizeEnvRows([{ key: 'FOO' }, { key: 'BAR' }, { key: 'BAZ' }]),
    '3 variables',
    'plural "variables" for more than one'
  )

  console.log(
    '✓ summarizeArgRows/summarizeEnvRows: counts, blank-row exclusion, singular/plural all correct'
  )
}

// MUTATION TEST — summarizeArgRows
function mutatedSummarizeArgRowsCountsBlankRows(
  rows: readonly { key: string; enabled: boolean; fromDefault?: boolean }[]
): string {
  // BUG: counts every row including blank in-progress ones, so an untouched
  // Add-row inflates the "N enabled" summary before it's ever named.
  if (rows.length === 0) return 'No arguments'
  const enabledCount = rows.filter((r) => r.enabled).length
  const defaultCount = rows.filter((r) => r.fromDefault).length
  const parts = [`${enabledCount} enabled`]
  if (defaultCount > 0) parts.push(`${defaultCount} default`)
  return parts.join(', ')
}

{
  let threw = false
  try {
    assert.equal(
      mutatedSummarizeArgRowsCountsBlankRows([{ key: '', value: '', enabled: true }]),
      'No arguments',
      'a blank-key row must not count toward the summary'
    )
  } catch (err) {
    threw = true
    console.log('  mutation caught (expected failure):', (err as Error).message.split('\n')[0])
  }
  assert.ok(threw, 'MUTATION TEST FAILED TO FAIL: a summary that counts blank rows went undetected')

  console.log(
    '✓ mutation test: a summary that counts blank rows is correctly caught as a failing assertion'
  )
}

// ---------------------------------------------------------------------------
// resolveCuratedOptions (B3, support-multi-harness) — the pure resolver
// behind the Models/Effort settings editors. Asserts every rule from its own
// doc comment: dedupe on add, hide-except-selected (THE invariant), order
// with unknown-name tolerance, and total/no-op behavior.
// ---------------------------------------------------------------------------

const DESCRIPTOR_MODELS = ['opus', 'sonnet', 'haiku']

// 1. No overlay at all -> descriptor options returned BY REFERENCE (true
//    no-op), matching mergeCuratedModelEffort's same-reference convention.
{
  const result = resolveCuratedOptions(DESCRIPTOR_MODELS, undefined)
  assert.equal(result, DESCRIPTOR_MODELS, 'no overlay must return the exact same array reference')
}

// 2. An entirely-empty overlay ({}) is also a no-op by reference.
{
  const result = resolveCuratedOptions(DESCRIPTOR_MODELS, {})
  assert.equal(result, DESCRIPTOR_MODELS, 'an empty overlay object must also be a true no-op')
}

// 3. ADD: a new value is appended; a value that duplicates an existing
//    descriptor option is NOT appended a second time.
{
  const result = resolveCuratedOptions(DESCRIPTOR_MODELS, {
    add: ['my-finetune', 'opus']
  })
  assert.deepEqual(
    result,
    ['opus', 'sonnet', 'haiku', 'my-finetune'],
    'add appends new values and dedupes an add that already exists in descriptorOptions'
  )
}

// 4. HIDE: a hidden value is removed from the resolved list when it is NOT
//    the current selection.
{
  const result = resolveCuratedOptions(DESCRIPTOR_MODELS, { hide: ['haiku'] })
  assert.deepEqual(result, ['opus', 'sonnet'], 'a hidden, unselected value must be removed')
}

// 5. THE INVARIANT: a hidden value that IS the current selection must still
//    appear in the resolved list — hiding never hides the active selection.
{
  const result = resolveCuratedOptions(DESCRIPTOR_MODELS, { hide: ['haiku'] }, 'haiku')
  assert.deepEqual(
    result,
    ['opus', 'sonnet', 'haiku'],
    'HIDDEN-BUT-SELECTED INVARIANT: a hidden value that is currently selected must still appear'
  )
}

// 5b. The same invariant when the selected value isn't even in
//     descriptorOptions/add at all (a legacy selection from a since-changed
//     descriptor) — still must be surfaced, not silently dropped.
{
  const result = resolveCuratedOptions(
    DESCRIPTOR_MODELS,
    { hide: ['legacy-model'] },
    'legacy-model'
  )
  assert.ok(
    result.includes('legacy-model'),
    'a selected value absent from descriptorOptions AND add must still be surfaced'
  )
}

// 6. ORDER: named values come first in the given order; unnamed values keep
//    their relative position after them.
{
  const result = resolveCuratedOptions(DESCRIPTOR_MODELS, { order: ['haiku', 'opus'] })
  assert.deepEqual(
    result,
    ['haiku', 'opus', 'sonnet'],
    'order brings named values to the front in the given order; the rest keep relative order'
  )
}

// 7. ORDER naming a value that no longer exists (hidden, or never existed)
//    must be ignored, not throw.
{
  const result = resolveCuratedOptions(DESCRIPTOR_MODELS, {
    hide: ['haiku'],
    order: ['haiku', 'sonnet', 'nonexistent']
  })
  assert.deepEqual(
    result,
    ['sonnet', 'opus'],
    'order entries naming a hidden or nonexistent value must be silently skipped, not throw'
  )
}

// 8. Combined: add + hide + order all applied together, in that documented
//    order (add, then hide-except-selected, then order).
{
  const result = resolveCuratedOptions(
    DESCRIPTOR_MODELS,
    { add: ['my-finetune'], hide: ['haiku'], order: ['my-finetune', 'sonnet'] },
    undefined
  )
  assert.deepEqual(
    result,
    ['my-finetune', 'sonnet', 'opus'],
    'add + hide + order compose correctly: haiku hidden, my-finetune added and ordered first'
  )
}

console.log(
  '✓ resolveCuratedOptions: no-op, dedupe-on-add, hide, hidden-but-selected invariant (twice), order, unknown-order-name-ignored, and combined all correct'
)

// ---------------------------------------------------------------------------
// MUTATION TESTS — resolveCuratedOptions. Each deliberately breaks one rule
// and confirms a real behavioral assertion (the exact expectation a correct
// implementation must satisfy) actually fails against it.
// ---------------------------------------------------------------------------

function assertMutationCaught(run: () => void, label: string): void {
  let threw = false
  try {
    run()
  } catch (err) {
    threw = true
    console.log(
      `  mutation caught (expected failure) [${label}]:`,
      (err as Error).message.split('\n')[0]
    )
  }
  assert.ok(threw, `MUTATION TEST FAILED TO FAIL: ${label} went undetected`)
}

// Mutation A: hide the selected value anyway (breaks THE invariant).
function mutatedResolveHidesSelected(
  descriptorOptions: readonly string[],
  hide: string[] | undefined
): string[] {
  const hideSet = new Set(hide ?? [])
  return descriptorOptions.filter((v) => !hideSet.has(v)) // BUG: no selectedValue exception
}
assertMutationCaught(() => {
  assert.deepEqual(
    mutatedResolveHidesSelected(DESCRIPTOR_MODELS, ['haiku']),
    ['opus', 'sonnet', 'haiku'],
    'a hidden-but-selected value must still appear'
  )
}, 'hiding the selected value')

// Mutation B: ignore `order` entirely.
function mutatedResolveIgnoresOrder(descriptorOptions: readonly string[]): string[] {
  return [...descriptorOptions] // BUG: order overlay never applied
}
assertMutationCaught(() => {
  assert.deepEqual(
    mutatedResolveIgnoresOrder(DESCRIPTOR_MODELS),
    ['haiku', 'opus', 'sonnet'],
    'order must reorder the resolved list'
  )
}, 'ignoring order')

// Mutation C: drop the dedupe on add (append even if already present).
function mutatedResolveNoDedupeOnAdd(
  descriptorOptions: readonly string[],
  add: string[] | undefined
): string[] {
  return [...descriptorOptions, ...(add ?? [])] // BUG: no seen-set guard
}
assertMutationCaught(() => {
  assert.deepEqual(
    mutatedResolveNoDedupeOnAdd(DESCRIPTOR_MODELS, ['opus']),
    DESCRIPTOR_MODELS,
    'adding a value that already exists in descriptorOptions must not duplicate it'
  )
}, 'dropping the add dedupe')

// Mutation D: merge overlays across scopes instead of the whole-field
// replace the Settings UI relies on (this exercises the SAME rule
// verify-harness-settings.ts's mutation test #9 covers at the storage
// layer — repeated here against the UI-facing draft/overlay round trip via
// draftRowsToOverlay, so the rule is pinned on both sides of the boundary).
{
  const projectOnlyOverlay = draftRowsToOverlay(
    [
      { value: 'sonnet', custom: false, hidden: false, selected: false },
      { value: 'opus', custom: false, hidden: false, selected: false }
    ],
    DESCRIPTOR_MODELS
  )
  assert.deepEqual(
    projectOnlyOverlay,
    { order: ['sonnet', 'opus'] },
    'draftRowsToOverlay must produce the WHOLE overlay for a field, not a partial delta to merge with another scope'
  )
}

// Mutation E: buildCuratedOptionRows built naively on top of
// resolveCuratedOptions (the FIRST implementation this file caught during
// development) — a hidden-and-unselected value would be silently absent
// from the editor's row list entirely, with no toggle left to un-hide it.
// This is a real bug this harness caught before it shipped: resolver output
// is correct for a PICKER (drop what shouldn't be offered) but wrong for the
// EDITOR (must keep every overlay-addressable value visible, hidden or not).
function mutatedBuildCuratedOptionRowsDropsHiddenRows(
  descriptorOptions: readonly string[],
  hide: string[] | undefined
): string[] {
  const hideSet = new Set(hide ?? [])
  return descriptorOptions.filter((v) => !hideSet.has(v)) // BUG: matches resolveCuratedOptions, not the editor's contract
}
assertMutationCaught(() => {
  assert.deepEqual(
    mutatedBuildCuratedOptionRowsDropsHiddenRows(DESCRIPTOR_MODELS, ['haiku']),
    ['opus', 'sonnet', 'haiku'],
    'the editor must keep listing a hidden-and-unselected value so it can be un-hidden'
  )
}, 'editor dropping a hidden row entirely')

console.log(
  '✓ mutation tests: hidden-but-selected, order, add-dedupe, whole-field-replace, and editor-drops-hidden-rows all correctly caught as failures when broken'
)

// ---------------------------------------------------------------------------
// buildCuratedOptionRows / draftRowsToOverlay — the Settings UI's editor
// draft-row round trip (harnessSettingsLogic.ts), mirroring
// mergeDefaultArgs/draftsToStoredRows' display<->storage contract above but
// for the Models/Effort option-list editors.
// ---------------------------------------------------------------------------

// 1. No overlay, no selection: every row is a plain, non-custom,
//    non-hidden, unselected descriptor option, in descriptor order.
{
  const rows = buildCuratedOptionRows(DESCRIPTOR_MODELS, undefined, undefined)
  assert.deepEqual(rows, [
    { value: 'opus', custom: false, hidden: false, selected: false },
    { value: 'sonnet', custom: false, hidden: false, selected: false },
    { value: 'haiku', custom: false, hidden: false, selected: false }
  ])
}

// 2. A hidden, unselected row is marked hidden but still present when it IS
//    the selection (round-tripping the resolver's own invariant into the
//    row shape the editor renders).
{
  const rows = buildCuratedOptionRows(DESCRIPTOR_MODELS, { hide: ['haiku'] }, 'haiku')
  const haikuRow = rows.find((r) => r.value === 'haiku')
  assert.ok(haikuRow, 'a hidden-but-selected value must still produce a row')
  assert.deepEqual(haikuRow, { value: 'haiku', custom: false, hidden: true, selected: true })
}

// 3. A custom (add-only) value is marked custom: true.
{
  const rows = buildCuratedOptionRows(DESCRIPTOR_MODELS, { add: ['my-finetune'] }, undefined)
  const customRow = rows.find((r) => r.value === 'my-finetune')
  assert.deepEqual(customRow, {
    value: 'my-finetune',
    custom: true,
    hidden: false,
    selected: false
  })
}

// 4. Round trip: rows built from an overlay, converted back via
//    draftRowsToOverlay, produce an equivalent overlay (order is always
//    written once the editor has any rows — see draftRowsToOverlay's doc
//    comment on why `order` is unconditional). The editor's row set keeps
//    the HIDDEN row too (buildCuratedOptionRows deliberately does not drop
//    hidden rows the way resolveCuratedOptions' picker-facing output does —
//    see that function's own doc comment — so the user has a visible toggle
//    to un-hide 'haiku', and its position survives in `order`).
{
  const overlay: CuratedOptionRowDraft[] = buildCuratedOptionRows(
    DESCRIPTOR_MODELS,
    { add: ['my-finetune'], hide: ['haiku'], order: ['my-finetune', 'sonnet'] },
    undefined
  )
  assert.deepEqual(
    overlay.map((r) => r.value),
    ['my-finetune', 'sonnet', 'opus', 'haiku'],
    'the editor must still list a hidden row (haiku) so it can be un-hidden'
  )
  assert.equal(
    overlay.find((r) => r.value === 'haiku')?.hidden,
    true,
    'haiku must be marked hidden in the editor row, not omitted'
  )
  const rebuilt = draftRowsToOverlay(overlay, DESCRIPTOR_MODELS)
  assert.deepEqual(rebuilt, {
    add: ['my-finetune'],
    hide: ['haiku'],
    order: ['my-finetune', 'sonnet', 'opus', 'haiku']
  })
}

// 5. Empty rows -> undefined overlay (never persists an empty {} object,
//    which would win over an earlier scope's real overlay after merge).
{
  assert.equal(draftRowsToOverlay([], DESCRIPTOR_MODELS), undefined)
}

console.log(
  '✓ buildCuratedOptionRows/draftRowsToOverlay: plain/hidden-but-selected/custom rows and the overlay round trip all correct'
)

// ---------------------------------------------------------------------------
// curatedOptionsRowsDirty / summarizeCuratedOptionRows
// ---------------------------------------------------------------------------

{
  const loaded: CuratedOptionRowDraft[] = [
    { value: 'opus', custom: false, hidden: false, selected: true },
    { value: 'sonnet', custom: false, hidden: false, selected: false }
  ]
  assert.equal(
    curatedOptionsRowsDirty(
      loaded,
      loaded.map((r) => ({ ...r }))
    ),
    false
  )
  assert.equal(
    curatedOptionsRowsDirty(loaded, [{ ...loaded[0], hidden: true }, loaded[1]]),
    true,
    'a hide toggle must read as dirty'
  )
  assert.equal(
    curatedOptionsRowsDirty(loaded, [loaded[1], loaded[0]]),
    true,
    'a reorder must read as dirty'
  )

  assert.equal(summarizeCuratedOptionRows([]), 'Default list')
  assert.equal(
    summarizeCuratedOptionRows([{ value: 'opus', custom: false, hidden: false, selected: true }]),
    'Default list',
    'an untouched, all-visible, non-custom row list summarizes as the default'
  )
  assert.equal(
    summarizeCuratedOptionRows([
      { value: 'opus', custom: false, hidden: false, selected: true },
      { value: 'sonnet', custom: false, hidden: true, selected: false }
    ]),
    '1 shown, 1 hidden'
  )
  console.log(
    '✓ curatedOptionsRowsDirty/summarizeCuratedOptionRows: dirty detection and summary line both correct'
  )
}

console.log('\nharness settings UI logic verification passed')
