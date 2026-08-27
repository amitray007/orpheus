// ---------------------------------------------------------------------------
// scripts/verify-project-drawer-settings.ts
//
// Behavior guard for src/shared/harness/projectDrawerSettings.ts (H1,
// support-multi-harness) — the pure core of the project Settings drawer's
// harness-aware re-point (SettingsDrawer.tsx now reads/writes harness_settings
// instead of claude_project_settings for Model/Effort/Permission-mode). Asserts
// against the REAL exported functions, not a restatement of their logic — see
// CLAUDE.md: "Assert behaviour, not source text... Extract the logic into a
// directly-callable pure function and call it."
//
// RUNTIME CHOICE — plain `bun run`, not `node --experimental-strip-types`.
// projectDrawerSettings.ts has zero SQLite/native/Electron dependencies (pure
// TS types + array/object transforms), matching verify-harness-settings-ui.ts's
// own header rationale for the same choice.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import {
  harnessesPresentInProject,
  shouldShowProjectHarnessPicker,
  resolveDrawerHarnessId,
  resolveArgRowValue,
  withArgRowSet,
  applyProjectDrawerPatch,
  countProjectHarnessOverrides,
  projectOverrideChipInfo,
  customCliFlagsToRows,
  rowsToCustomCliFlags,
  customEnvVarsToRows,
  rowsToCustomEnvVars
} from '../src/shared/harness/projectDrawerSettings'
import type { HarnessSettingRow, HarnessSettings } from '../src/shared/types'

const PERM_KEY = '--permission-mode'

// ---------------------------------------------------------------------------
// harnessesPresentInProject
// ---------------------------------------------------------------------------

assert.deepEqual(harnessesPresentInProject(null), [], 'null workspaces -> []')
assert.deepEqual(harnessesPresentInProject(undefined), [], 'undefined workspaces -> []')
assert.deepEqual(harnessesPresentInProject([]), [], 'empty workspaces -> []')
assert.deepEqual(
  harnessesPresentInProject([{ harnessId: 'claude' }, { harnessId: 'claude' }]),
  ['claude'],
  'duplicate harness ids dedupe to one entry'
)
assert.deepEqual(
  harnessesPresentInProject([
    { harnessId: 'codex' },
    { harnessId: 'claude' },
    { harnessId: 'codex' }
  ]),
  ['codex', 'claude'],
  'first-seen order preserved, not sorted'
)

// ---------------------------------------------------------------------------
// shouldShowProjectHarnessPicker
// ---------------------------------------------------------------------------

assert.equal(
  shouldShowProjectHarnessPicker([]),
  false,
  'zero registered harnesses -> no picker (still loading)'
)
assert.equal(
  shouldShowProjectHarnessPicker([{ id: 'claude' }]),
  false,
  'exactly one registered harness -> no picker (THE single-Claude-install invariant)'
)
assert.equal(
  shouldShowProjectHarnessPicker([{ id: 'claude' }, { id: 'codex' }]),
  true,
  'two+ registered harnesses -> picker shows'
)

// ---------------------------------------------------------------------------
// resolveDrawerHarnessId
// ---------------------------------------------------------------------------

assert.equal(
  resolveDrawerHarnessId([{ id: 'claude' }], [], ''),
  'claude',
  'single-Claude install, no selection, no project membership yet -> falls back to the only registered harness'
)
assert.equal(
  resolveDrawerHarnessId([{ id: 'claude' }, { id: 'codex' }], ['codex'], ''),
  'codex',
  'no explicit selection -> defaults to the harness the project actually runs'
)
assert.equal(
  resolveDrawerHarnessId([{ id: 'claude' }, { id: 'codex' }], [], 'codex'),
  'codex',
  'an explicit in-session selection wins over project membership'
)
assert.equal(
  resolveDrawerHarnessId([{ id: 'claude' }, { id: 'codex' }], ['claude'], 'stale-removed-harness'),
  'claude',
  'a selection naming a NO-LONGER-registered harness is ignored, falls through to project membership'
)
assert.equal(
  resolveDrawerHarnessId([{ id: 'claude' }, { id: 'codex' }], ['unregistered-harness'], ''),
  'claude',
  'project membership naming an unregistered harness is skipped, falls to first registered'
)
assert.equal(
  resolveDrawerHarnessId([], [], ''),
  '',
  'nothing registered at all -> empty string sentinel'
)

// ---------------------------------------------------------------------------
// resolveArgRowValue
// ---------------------------------------------------------------------------

assert.equal(resolveArgRowValue(undefined, PERM_KEY), undefined, 'no rows -> undefined')
assert.equal(
  resolveArgRowValue([{ key: PERM_KEY, value: 'acceptEdits', enabled: true }], PERM_KEY),
  'acceptEdits',
  'matching row -> its value'
)
assert.equal(
  resolveArgRowValue([{ key: '--other-flag', value: 'x', enabled: true }], PERM_KEY),
  undefined,
  'no matching key -> undefined'
)
assert.equal(
  resolveArgRowValue([{ key: PERM_KEY, enabled: true }], PERM_KEY),
  '',
  'a bare row (no value) resolves to empty string, not undefined'
)

// ---------------------------------------------------------------------------
// withArgRowSet
// ---------------------------------------------------------------------------

assert.deepEqual(
  withArgRowSet(undefined, PERM_KEY, 'acceptEdits'),
  [{ key: PERM_KEY, value: 'acceptEdits', enabled: true }],
  'setting on undefined rows creates a single enabled row'
)
{
  const before: HarnessSettingRow[] = [
    { key: '--verbose', value: undefined, enabled: true },
    { key: PERM_KEY, value: 'plan', enabled: true }
  ]
  const after = withArgRowSet(before, PERM_KEY, 'bypassPermissions')
  assert.deepEqual(
    after,
    [
      { key: '--verbose', value: undefined, enabled: true },
      { key: PERM_KEY, value: 'bypassPermissions', enabled: true }
    ],
    'updating an existing row preserves position and every OTHER row untouched'
  )
  assert.notEqual(after, before, 'never mutates the input array in place')
}
{
  const before: HarnessSettingRow[] = [{ key: '--verbose', value: undefined, enabled: true }]
  const after = withArgRowSet(before, PERM_KEY, 'acceptEdits')
  assert.deepEqual(
    after,
    [
      { key: '--verbose', value: undefined, enabled: true },
      { key: PERM_KEY, value: 'acceptEdits', enabled: true }
    ],
    'a new key is appended at the end, existing rows keep their order'
  )
}
{
  const before: HarnessSettingRow[] = [
    { key: '--verbose', value: undefined, enabled: true },
    { key: PERM_KEY, value: 'plan', enabled: true }
  ]
  const after = withArgRowSet(before, PERM_KEY, undefined)
  assert.deepEqual(
    after,
    [{ key: '--verbose', value: undefined, enabled: true }],
    'clearing (undefined) REMOVES the row entirely, not disables it'
  )
}
assert.equal(
  withArgRowSet([{ key: PERM_KEY, value: 'plan', enabled: true }], PERM_KEY, undefined),
  undefined,
  'clearing the LAST row returns undefined, not an empty array — matches "nothing configured"'
)

// ---------------------------------------------------------------------------
// applyProjectDrawerPatch
// ---------------------------------------------------------------------------

{
  const existing: HarnessSettings = {}
  const next = applyProjectDrawerPatch(existing, { model: 'opus' }, PERM_KEY)
  assert.deepEqual(next.curated, { model: 'opus' }, 'setting model alone writes only curated.model')
  assert.equal(
    next.args,
    undefined,
    'permissionMode untouched (absent from patch) -> args unchanged'
  )
}
{
  const existing: HarnessSettings = { curated: { model: 'opus', effort: 'high' } }
  const next = applyProjectDrawerPatch(existing, { model: null }, PERM_KEY)
  assert.deepEqual(
    next.curated,
    { effort: 'high' },
    'clearing model (null) preserves a previously-stored effort — merge-write, not whole-row replace'
  )
}
{
  const existing: HarnessSettings = { curated: { model: 'opus' } }
  const next = applyProjectDrawerPatch(existing, { model: null, effort: null }, PERM_KEY)
  assert.equal(
    next.curated,
    undefined,
    'clearing every curated field drops the whole curated object rather than persisting {}'
  )
}
{
  const existing: HarnessSettings = {
    args: [{ key: '--verbose', value: undefined, enabled: true }],
    env: [{ key: 'FOO', value: 'bar', enabled: true }],
    curatedOptions: { model: { add: ['custom-model'] } }
  }
  const next = applyProjectDrawerPatch(existing, { permissionMode: 'acceptEdits' }, PERM_KEY)
  assert.deepEqual(
    next.args,
    [
      { key: '--verbose', value: undefined, enabled: true },
      { key: PERM_KEY, value: 'acceptEdits', enabled: true }
    ],
    'permissionMode lands in args, preserving other rows'
  )
  assert.deepEqual(next.env, existing.env, 'env untouched')
  assert.deepEqual(next.curatedOptions, existing.curatedOptions, 'curatedOptions untouched')
  assert.equal(next.curated, undefined, 'curated untouched (absent from patch)')
}
{
  // A field omitted entirely (not present as a key) must leave the existing
  // value alone — the "undefined = leave alone" half of the tri-state.
  const existing: HarnessSettings = { curated: { model: 'opus', effort: 'high' } }
  const next = applyProjectDrawerPatch(existing, { effort: 'medium' }, PERM_KEY)
  assert.deepEqual(
    next.curated,
    { model: 'opus', effort: 'medium' },
    'model omitted from patch stays exactly as it was; only effort changes'
  )
}

// ---------------------------------------------------------------------------
// countProjectHarnessOverrides
// ---------------------------------------------------------------------------

assert.equal(countProjectHarnessOverrides(undefined, PERM_KEY), 0, 'no settings at all -> 0')
assert.equal(countProjectHarnessOverrides({}, PERM_KEY), 0, 'empty settings -> 0')
assert.equal(
  countProjectHarnessOverrides({ curated: { model: 'opus' } }, PERM_KEY),
  1,
  'model alone -> 1'
)
assert.equal(
  countProjectHarnessOverrides({ curated: { model: 'opus', effort: 'high' } }, PERM_KEY),
  2,
  'model + effort -> 2'
)
assert.equal(
  countProjectHarnessOverrides(
    {
      curated: { model: 'opus', effort: 'high' },
      args: [{ key: PERM_KEY, value: 'acceptEdits', enabled: true }]
    },
    PERM_KEY
  ),
  3,
  'model + effort + permission-mode row -> 3'
)
assert.equal(
  countProjectHarnessOverrides(
    {
      args: [
        { key: '--verbose', value: undefined, enabled: true },
        { key: '--add-dir', value: '/tmp', enabled: true }
      ]
    },
    PERM_KEY
  ),
  0,
  'unrelated args rows (edited on the Harness Settings page, not this drawer) do NOT count'
)

// ---------------------------------------------------------------------------
// projectOverrideChipInfo
// ---------------------------------------------------------------------------

assert.deepEqual(
  projectOverrideChipInfo('claude', 0, []),
  { visible: false, appliesToEveryWorkspace: true },
  'zero overrides -> not visible'
)
assert.deepEqual(
  projectOverrideChipInfo('claude', 2, []),
  { visible: true, appliesToEveryWorkspace: true },
  'no workspaces yet -> nothing to contradict project-wide reach'
)
assert.deepEqual(
  projectOverrideChipInfo('claude', 2, ['claude']),
  { visible: true, appliesToEveryWorkspace: true },
  'every workspace runs the SAME harness the overrides were set for -> project-wide is honest'
)
assert.deepEqual(
  projectOverrideChipInfo('claude', 2, ['claude', 'codex']),
  { visible: true, appliesToEveryWorkspace: false },
  'THE BUG THIS FIXES — a second, different harness present means the chip must NOT claim project-wide reach'
)
assert.deepEqual(
  projectOverrideChipInfo('claude', 2, ['codex']),
  { visible: true, appliesToEveryWorkspace: false },
  'the edited harness has ZERO workspaces in the project (settings set before/after a harness switch) -> still dishonest to claim project-wide'
)

// ---------------------------------------------------------------------------
// customCliFlagsToRows / rowsToCustomCliFlags — the hard conversion
// ---------------------------------------------------------------------------

{
  const { rows, warnings } = customCliFlagsToRows(['--model opus', '--verbose'])
  assert.deepEqual(
    rows,
    [
      { key: '--model', value: 'opus', enabled: true },
      { key: '--verbose', value: undefined, enabled: true }
    ],
    'the common 2-token and bare-flag cases convert losslessly'
  )
  assert.deepEqual(warnings, [], 'no warnings for clean entries')
}
{
  // Quoted phrase collapses to ONE token before this ever sees it —
  // tokenizeWords (cliFlags.ts) handles the quoting, so this is NOT a
  // >2-token entry despite looking like one at a glance.
  const { rows, warnings } = customCliFlagsToRows(['--append-system-prompt "be terse and kind"'])
  assert.deepEqual(
    rows,
    [{ key: '--append-system-prompt', value: 'be terse and kind', enabled: true }],
    'a quoted multi-word VALUE is one token, converts losslessly'
  )
  assert.deepEqual(warnings, [], 'no warning for a quoted phrase')
}
{
  // THE LOSSY CASE — an unquoted entry with 2+ words after the flag has no
  // lossless row representation (see customCliFlagsToRows' own header).
  const { rows, warnings } = customCliFlagsToRows(['--add-dir /a /b'])
  assert.deepEqual(
    rows,
    [{ key: '--add-dir', value: '/a /b', enabled: true }],
    'extra tokens are joined into ONE value with a space'
  )
  assert.equal(warnings.length, 1, 'exactly one warning for the lossy join')
  assert.match(warnings[0], /joined into one/, 'warning names the lossy join')
}
{
  // THE COLLISION CASE — mergeRowsByKey (settings.ts) would collapse two
  // same-key rows within one scope anyway, so this function makes the
  // same "last wins" decision explicitly and reports it.
  const { rows, warnings } = customCliFlagsToRows(['--model opus', '--model sonnet'])
  assert.deepEqual(
    rows,
    [{ key: '--model', value: 'sonnet', enabled: true }],
    'a same-flag collision keeps only the LAST entry, at the FIRST position'
  )
  assert.equal(warnings.length, 1, 'exactly one warning for the collision')
  assert.match(warnings[0], /same flag/, 'warning names the collision')
}
{
  const { rows, warnings } = customCliFlagsToRows(['not-a-flag', '--model opus'])
  assert.deepEqual(
    rows,
    [{ key: '--model', value: 'opus', enabled: true }],
    'an unparseable entry is dropped, valid entries still convert'
  )
  assert.equal(warnings.length, 1, 'exactly one warning for the dropped entry')
  assert.match(warnings[0], /could not be converted/, 'warning explains the drop')
}
assert.deepEqual(
  rowsToCustomCliFlags([
    { key: '--model', value: 'opus', enabled: true },
    { key: '--verbose', value: undefined, enabled: true },
    { key: '--disabled-flag', value: 'x', enabled: false }
  ]),
  ['--model opus', '--verbose'],
  'rowsToCustomCliFlags renders enabled rows back to entries, skips disabled'
)
assert.deepEqual(rowsToCustomCliFlags(undefined), [], 'undefined rows -> []')

// ---------------------------------------------------------------------------
// customEnvVarsToRows / rowsToCustomEnvVars — lossless both ways
// ---------------------------------------------------------------------------

assert.deepEqual(
  customEnvVarsToRows({ FOO: 'bar', BAZ: 'qux' }),
  [
    { key: 'FOO', value: 'bar', enabled: true },
    { key: 'BAZ', value: 'qux', enabled: true }
  ],
  'every entry becomes an enabled row, insertion order preserved'
)
assert.deepEqual(
  rowsToCustomEnvVars([
    { key: 'FOO', value: 'bar', enabled: true },
    { key: 'DISABLED', value: 'x', enabled: false }
  ]),
  { FOO: 'bar' },
  'rowsToCustomEnvVars round-trips enabled rows, skips disabled'
)
{
  const original = { FOO: 'bar', BAZ: 'qux' }
  const roundTripped = rowsToCustomEnvVars(customEnvVarsToRows(original))
  assert.deepEqual(roundTripped, original, 'full round-trip is lossless (unlike CLI flags)')
}

// ---------------------------------------------------------------------------
// applyProjectDrawerPatch — the new fields (customCliFlags/customEnvVars/
// preLaunchSnippet), plus the coexistence guarantee with permission-mode
// ---------------------------------------------------------------------------

{
  const existing: HarnessSettings = {}
  const next = applyProjectDrawerPatch(
    existing,
    { customCliFlags: [{ key: '--verbose', enabled: true }] },
    PERM_KEY
  )
  assert.deepEqual(
    next.args,
    [{ key: '--verbose', enabled: true }],
    'customCliFlags alone writes args'
  )
  assert.equal(next.curated, undefined, 'curated untouched (absent from patch)')
}
{
  // THE COEXISTENCE GUARANTEE — a customCliFlags write must NEVER wipe an
  // existing permission-mode row, even though CLI-flags is conceptually a
  // "replace the CLI-flags-owned rows" write.
  const existing: HarnessSettings = {
    args: [{ key: PERM_KEY, value: 'acceptEdits', enabled: true }]
  }
  const next = applyProjectDrawerPatch(
    existing,
    { customCliFlags: [{ key: '--verbose', enabled: true }] },
    PERM_KEY
  )
  assert.deepEqual(
    next.args,
    [
      { key: '--verbose', enabled: true },
      { key: PERM_KEY, value: 'acceptEdits', enabled: true }
    ],
    'permission-mode row survives a customCliFlags write untouched'
  )
}
{
  // And the reverse: a permissionMode write must not disturb CLI-flags rows.
  const existing: HarnessSettings = {
    args: [{ key: '--verbose', enabled: true }]
  }
  const next = applyProjectDrawerPatch(existing, { permissionMode: 'plan' }, PERM_KEY)
  assert.deepEqual(
    next.args,
    [
      { key: '--verbose', enabled: true },
      { key: PERM_KEY, value: 'plan', enabled: true }
    ],
    'a permissionMode write appends its row, leaves CLI-flags rows untouched'
  )
}
{
  const existing: HarnessSettings = {}
  const next = applyProjectDrawerPatch(
    existing,
    { customEnvVars: [{ key: 'FOO', value: 'bar', enabled: true }] },
    PERM_KEY
  )
  assert.deepEqual(
    next.env,
    [{ key: 'FOO', value: 'bar', enabled: true }],
    'customEnvVars writes env'
  )
}
{
  const existing: HarnessSettings = {}
  const next = applyProjectDrawerPatch(
    existing,
    { preLaunchSnippet: 'eval "$(direnv export zsh)"' },
    PERM_KEY
  )
  assert.equal(
    next.preLaunchSnippet,
    'eval "$(direnv export zsh)"',
    'preLaunchSnippet sets the field'
  )
}
{
  const existing: HarnessSettings = { preLaunchSnippet: 'eval "$(direnv export zsh)"' }
  const next = applyProjectDrawerPatch(existing, { preLaunchSnippet: null }, PERM_KEY)
  assert.equal(next.preLaunchSnippet, undefined, 'preLaunchSnippet: null clears it')
  assert.equal(
    'preLaunchSnippet' in next,
    false,
    'clearing DELETES the key rather than setting it to undefined'
  )
}
{
  // A patch that touches NOTHING must produce an object with exactly the
  // same keys as `existing` — no stray undefined-valued keys from an
  // unconditional assignment. This is the exact bug class caught during
  // development (see this unit's report).
  const existing: HarnessSettings = { curated: { model: 'opus' } }
  const next = applyProjectDrawerPatch(existing, {}, PERM_KEY)
  assert.deepEqual(Object.keys(next).sort(), ['curated'], 'no stray undefined-valued keys')
}

console.log('All project-drawer-settings assertions passed.')

// ---------------------------------------------------------------------------
// Mutation tests — break each load-bearing rule, confirm the harness fails,
// then restore. Run LAST so a failure here can't mask an earlier real bug.
// ---------------------------------------------------------------------------

function mustFail(label: string, fn: () => void): void {
  try {
    fn()
  } catch (err) {
    console.log(`  mutation caught (expected failure) [${label}]:`, (err as Error).message)
    return
  }
  throw new Error(`MUTATION TEST FAILED TO CATCH A BUG: ${label} did not throw`)
}

// Mutation 1 — projectOverrideChipInfo with the "other harnesses present"
// check inverted (as if nobody had noticed a second harness).
mustFail('projectOverrideChipInfo ignoring a second harness', () => {
  // Signature intentionally drops harnessId/harnessesInProject — the bug
  // being simulated is "never looks at project membership at all".
  function brokenChipInfo(overrideCount: number): {
    visible: boolean
    appliesToEveryWorkspace: boolean
  } {
    // BUG: always claims project-wide reach, exactly the overclaim this
    // unit exists to fix.
    return { visible: overrideCount > 0, appliesToEveryWorkspace: true }
  }
  const real = projectOverrideChipInfo('claude', 2, ['claude', 'codex'])
  const broken = brokenChipInfo(2)
  assert.deepEqual(broken, real, 'broken chip info must match the real, honest result')
})

// Mutation 2 — withArgRowSet's clear treated as "disable" (keep the row)
// instead of removing it, breaking the drawer's "Use global" sentinel.
mustFail('withArgRowSet clearing by disabling instead of removing', () => {
  function brokenWithArgRowSet(
    rows: readonly HarnessSettingRow[] | undefined,
    key: string,
    nextValue: string | undefined
  ): HarnessSettingRow[] | undefined {
    const existing = rows ?? []
    if (nextValue === undefined) {
      // BUG: disables instead of removing — resolveArgRowValue would still
      // see a row (a bare-flag '' value) instead of "no override".
      return existing.map((r) => (r.key === key ? { ...r, enabled: false } : r))
    }
    const index = existing.findIndex((r) => r.key === key)
    const nextRow = { key, value: nextValue, enabled: true }
    if (index === -1) return [...existing, nextRow]
    const copy = existing.slice()
    copy[index] = nextRow
    return copy
  }
  const before: HarnessSettingRow[] = [{ key: PERM_KEY, value: 'plan', enabled: true }]
  const real = withArgRowSet(before, PERM_KEY, undefined)
  const broken = brokenWithArgRowSet(before, PERM_KEY, undefined)
  assert.deepEqual(
    broken,
    real,
    'broken clear-by-disable must match the real remove-the-row result'
  )
})

// Mutation 3 — applyProjectDrawerPatch's undefined-vs-null distinction
// collapsed (both treated as "leave alone"), breaking Reset/clear buttons.
mustFail('applyProjectDrawerPatch collapsing null into undefined', () => {
  // Signature intentionally drops permissionModeArgKey — the bug being
  // simulated is entirely within the curated-field branch.
  function brokenApply(
    existing: HarnessSettings,
    patch: { model?: string | null }
  ): HarnessSettings {
    const nextCurated = { ...existing.curated }
    // BUG: only a truthy string sets it; null (explicit clear) is silently
    // ignored instead of clearing the field — a Reset button would do
    // nothing.
    if (patch.model) nextCurated.model = patch.model
    return { ...existing, curated: nextCurated, args: existing.args }
  }
  const existing: HarnessSettings = { curated: { model: 'opus' } }
  const real = applyProjectDrawerPatch(existing, { model: null }, PERM_KEY)
  const broken = brokenApply(existing, { model: null })
  assert.deepEqual(
    broken.curated,
    real.curated,
    'broken clear-as-noop must match the real clear result'
  )
})

// Mutation 4 — THE COEXISTENCE GUARANTEE broken: a customCliFlags write
// wholesale-replaces `args` instead of excluding the permission-mode row,
// silently wiping it. This is the exact "wholesale replace would wipe the
// OTHER page's row" bug applyProjectDrawerPatch's own comment warns about.
mustFail('customCliFlags write wiping the permission-mode row', () => {
  function brokenApply(existing: HarnessSettings, nextRows: HarnessSettingRow[]): HarnessSettings {
    // BUG: assigns the CLI-flags editor's rows AS the whole args array,
    // instead of merging around the excluded permission-mode key.
    return { ...existing, args: nextRows }
  }
  const existing: HarnessSettings = {
    args: [{ key: PERM_KEY, value: 'acceptEdits', enabled: true }]
  }
  const real = applyProjectDrawerPatch(
    existing,
    { customCliFlags: [{ key: '--verbose', enabled: true }] },
    PERM_KEY
  )
  const broken = brokenApply(existing, [{ key: '--verbose', enabled: true }])
  assert.deepEqual(
    broken.args,
    real.args,
    'a wholesale-replace bug must disagree with the real, permission-mode-preserving result'
  )
})

// Mutation 5 — the same-flag-name collision silently keeps the FIRST entry
// instead of the LAST (the wrong precedence — mergeRowsByKey's own
// within-scope collapse rule is "later overwrites earlier").
mustFail('customCliFlagsToRows keeping the first entry on a collision', () => {
  function brokenConvert(entries: readonly string[]): HarnessSettingRow[] {
    const rows: HarnessSettingRow[] = []
    const seen = new Set<string>()
    for (const raw of entries) {
      const [key, ...rest] = raw.split(' ')
      // BUG: skips an entry whose key was already seen, instead of
      // overwriting — keeps the FIRST entry, not the last.
      if (seen.has(key)) continue
      seen.add(key)
      rows.push({ key, value: rest.join(' ') || undefined, enabled: true })
    }
    return rows
  }
  const { rows: real } = customCliFlagsToRows(['--model opus', '--model sonnet'])
  const broken = brokenConvert(['--model opus', '--model sonnet'])
  assert.deepEqual(broken, real, 'keep-first must disagree with the real keep-last result')
})

console.log('All project-drawer-settings mutation tests passed.')
