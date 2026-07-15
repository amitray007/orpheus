import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import {
  parseFlagEntry,
  flagName,
  mergeFlagScopes,
  groupTokensByFlag,
  splitFlagString,
  findFlagValue,
  FLAG_DELIMITER,
  type ParsedFlag,
  type FlagParseError
} from '../src/shared/cliFlags.ts'

function isError(v: ParsedFlag | FlagParseError): v is FlagParseError {
  return 'error' in v
}

function expectTokens(raw: string, expectedTokens: string[], expectedName?: string): void {
  const result = parseFlagEntry(raw)
  assert.ok(
    !isError(result),
    `expected ${JSON.stringify(raw)} to parse, got error: ${isError(result) ? result.error : ''}`
  )
  const parsed = result as ParsedFlag
  assert.deepEqual(
    parsed.tokens,
    expectedTokens,
    `tokens mismatch for ${JSON.stringify(raw)}: got ${JSON.stringify(parsed.tokens)}`
  )
  assert.equal(parsed.raw, raw, `raw mismatch for ${JSON.stringify(raw)}`)
  if (expectedName !== undefined) {
    assert.equal(
      parsed.name,
      expectedName,
      `name mismatch for ${JSON.stringify(raw)}: got ${parsed.name}`
    )
  }
}

function expectError(raw: string, expectedMessage: string): void {
  const result = parseFlagEntry(raw)
  assert.ok(isError(result), `expected ${JSON.stringify(raw)} to be a syntax error, got tokens`)
  assert.equal(
    (result as FlagParseError).error,
    expectedMessage,
    `error message mismatch for ${JSON.stringify(raw)}`
  )
}

// ---------------------------------------------------------------------------
// Lexer — every form from the design spec
// ---------------------------------------------------------------------------

expectTokens('--debug', ['--debug'], '--debug')
expectTokens('--model opus', ['--model', 'opus'], '--model')
expectTokens('--model=opus', ['--model=opus'], '--model')
expectTokens('-d', ['-d'], '-d')
expectTokens(
  '--append-system-prompt "be terse and kind"',
  ['--append-system-prompt', 'be terse and kind'],
  '--append-system-prompt'
)
expectTokens("--x 'single quoted'", ['--x', 'single quoted'], '--x')
expectTokens('--x="quoted with spaces"', ['--x=quoted with spaces'], '--x')
expectTokens(
  '--dangerously-load-development-channels server:loco',
  ['--dangerously-load-development-channels', 'server:loco'],
  '--dangerously-load-development-channels'
)
expectTokens('--x "a \'b\' c"', ['--x', "a 'b' c"], '--x')

console.log('✓ lexer: all documented forms tokenize correctly')

// --model and --model=opus normalize to the same canonical name (conflict
// detection sees them as one flag).
assert.equal(flagName('--model opus'), flagName('--model=opus'))
assert.equal(flagName('--model opus'), '--model')

console.log('✓ lexer: --flag value and --flag=value normalize to the same name')

// ---------------------------------------------------------------------------
// Lexer — syntax errors ONLY
// ---------------------------------------------------------------------------

expectError('--x "unterminated', 'Unbalanced quote')
expectError("--x 'unterminated", 'Unbalanced quote')
expectError('', 'Empty flag')
expectError('   ', 'Empty flag')
expectError('model opus', 'Flags must start with - or --')
expectError('opus', 'Flags must start with - or --')

console.log('✓ lexer: syntax-error cases rejected with correct messages')

// ---------------------------------------------------------------------------
// Hidden/unknown flags MUST pass — this is the entire point of the feature.
// Never validate flag existence, only syntax.
// ---------------------------------------------------------------------------

expectTokens('--dangerously-load-development-channels server:loco', [
  '--dangerously-load-development-channels',
  'server:loco'
])
expectTokens('--definitely-not-a-real-flag-xyz', ['--definitely-not-a-real-flag-xyz'])
expectTokens('--totally-made-up=value', ['--totally-made-up=value'])

console.log('✓ regression guard: hidden/unknown flags are never rejected')

// ---------------------------------------------------------------------------
// mergeFlagScopes — the full merge matrix
// ---------------------------------------------------------------------------

function tokensOf(...raws: string[]): string[] {
  return raws.flatMap((raw) => {
    const r = parseFlagEntry(raw)
    assert.ok(!isError(r), `fixture entry failed to parse: ${raw}`)
    return (r as ParsedFlag).tokens
  })
}

{
  // Repeatable flag: both global and project entries survive (accumulate).
  const globalFlags = tokensOf('--add-dir /a')
  const projectFlags = tokensOf('--add-dir /b')
  const merged = mergeFlagScopes(globalFlags, projectFlags)
  assert.deepEqual(merged, ['--add-dir', '/a', '--add-dir', '/b'])
  console.log('✓ merge: repeatable flag accumulates across scopes')
}

{
  // Non-repeatable flag: project entry replaces the same-named global entry.
  const globalFlags = tokensOf('--model opus')
  const projectFlags = tokensOf('--model sonnet')
  const merged = mergeFlagScopes(globalFlags, projectFlags)
  assert.deepEqual(merged, ['--model', 'sonnet'])
  console.log('✓ merge: non-repeatable flag — project overrides global')
}

{
  // Unknown flag defaults to override (safer).
  const globalFlags = tokensOf('--totally-unknown-flag foo')
  const projectFlags = tokensOf('--totally-unknown-flag bar')
  const merged = mergeFlagScopes(globalFlags, projectFlags)
  assert.deepEqual(merged, ['--totally-unknown-flag', 'bar'])
  console.log('✓ merge: unknown flag defaults to override')
}

{
  // Ordering: surviving global flags first, then project flags.
  const globalFlags = tokensOf('--debug', '--model opus')
  const projectFlags = tokensOf('--effort high')
  const merged = mergeFlagScopes(globalFlags, projectFlags)
  assert.deepEqual(merged, ['--debug', '--model', 'opus', '--effort', 'high'])
  console.log('✓ merge: surviving global flags precede project flags')
}

{
  // Mixed matrix: one repeatable (accumulates), one non-repeatable
  // (overridden), one global-only (survives untouched), one project-only
  // (appended).
  const globalFlags = tokensOf('--add-dir /global-dir', '--model opus', '--debug')
  const projectFlags = tokensOf('--add-dir /project-dir', '--model sonnet', '--effort high')
  const merged = mergeFlagScopes(globalFlags, projectFlags)
  assert.deepEqual(merged, [
    '--add-dir',
    '/global-dir',
    '--debug',
    '--add-dir',
    '/project-dir',
    '--model',
    'sonnet',
    '--effort',
    'high'
  ])
  console.log('✓ merge: full mixed matrix (repeatable + override + survive + append)')
}

{
  // Empty scopes are handled cleanly.
  assert.deepEqual(mergeFlagScopes([], []), [])
  assert.deepEqual(mergeFlagScopes(tokensOf('--debug'), []), ['--debug'])
  assert.deepEqual(mergeFlagScopes([], tokensOf('--debug')), ['--debug'])
  console.log('✓ merge: empty scopes')
}

// ---------------------------------------------------------------------------
// validatePatch-equivalent — src/main/claudeSettings.ts's validatePatch and
// overridesStore.ts's validateCustomCliFlagsValue both delegate straight to
// parseFlagEntry per-entry (syntax only, see the module-level doc comment in
// cliFlags.ts). These assertions exercise that exact delegation contract
// without needing to import the main-process modules themselves (they pull
// in `electron`/`better-sqlite3` at module load time and cannot run under
// this plain-Node harness) — parseFlagEntry IS the validation.
// ---------------------------------------------------------------------------

function validateCustomCliFlagsEntries(entries: string[]): void {
  for (const entry of entries) {
    const parsed = parseFlagEntry(entry)
    if ('error' in parsed) {
      throw new Error(`customCliFlags entry "${entry}" is invalid — ${parsed.error}`)
    }
  }
}

{
  // The core regression guard: a hidden/undocumented flag must be ACCEPTED
  // by validation, never rejected for being "unknown". This is the entire
  // premise of the feature (see the design doc's problem statement).
  assert.doesNotThrow(
    () => validateCustomCliFlagsEntries(['--dangerously-load-development-channels server:loco']),
    'a hidden flag must pass validation — validation is syntax-only, never existence-based'
  )
  console.log('✓ validatePatch-equivalent: hidden flag accepted (core regression guard)')
}

{
  // A syntactically-broken entry (unbalanced quote) must be rejected with a
  // helpful, specific message — not a generic failure.
  assert.throws(
    () => validateCustomCliFlagsEntries(['--append-system-prompt "unterminated']),
    /Unbalanced quote/,
    'an unbalanced quote must be rejected with a message naming the actual problem'
  )
  console.log(
    '✓ validatePatch-equivalent: syntactically-broken entry rejected with a helpful message'
  )
}

// ---------------------------------------------------------------------------
// Project-scope validateExtra gate — mirrors src/main/claudeProjectSettings.ts's
// validateExtra (the `'customCliFlags' in patch && patch.customCliFlags != null`
// guard) followed by the same array/string-type check and per-entry
// parseFlagEntry loop that src/main/overridesStore.ts's
// validateCustomCliFlagsValue performs. Reimplemented inline for the same
// reason as reconcileFlagsExceptTargetForTest above: claudeProjectSettings.ts
// and overridesStore.ts both transitively import ./db -> better-sqlite3/
// electron-adjacent code, which fails under this plain-node harness
// (ERR_UNSUPPORTED_DIR_IMPORT or similar). This pins the regression fix: an
// explicit `customCliFlags: undefined` patch (sent when the drawer clears the
// last custom flag row) must be treated as "clear the override", not
// rejected as a malformed value.
// ---------------------------------------------------------------------------

function projectValidateExtraForTest(patch: { customCliFlags?: unknown }): void {
  if ('customCliFlags' in patch && patch.customCliFlags != null) {
    const v = patch.customCliFlags
    if (!Array.isArray(v) || !(v as unknown[]).every((item) => typeof item === 'string')) {
      throw new Error('claudeProjectSettings: customCliFlags must be a string[]')
    }
    for (const entry of v as string[]) {
      const parsed = parseFlagEntry(entry)
      if ('error' in parsed) {
        throw new Error(`customCliFlags entry "${entry}" is invalid — ${parsed.error}`)
      }
    }
  }
}

{
  // The regression itself: clearing the last row sends
  // { customCliFlags: undefined }. This must NOT throw — it's the documented
  // clear signal for a project-scope override, not a malformed value.
  assert.doesNotThrow(
    () => projectValidateExtraForTest({ customCliFlags: undefined }),
    'an explicit undefined customCliFlags patch must be treated as a clear signal, not rejected'
  )
  console.log('✓ project validateExtra: undefined customCliFlags clears without throwing')
}

{
  // Normal valid array still passes through untouched.
  assert.doesNotThrow(() => projectValidateExtraForTest({ customCliFlags: ['--valid flag'] }))
  console.log('✓ project validateExtra: valid string[] passes')
}

{
  // Malformed (non-array) value must still be rejected — the undefined
  // carve-out must not weaken validation of concrete bad values.
  assert.throws(() => projectValidateExtraForTest({ customCliFlags: 'not-an-array' }))
  console.log('✓ project validateExtra: non-array value still rejected')
}

{
  // A syntax error inside an array entry must still be caught by this gate.
  assert.throws(
    () => projectValidateExtraForTest({ customCliFlags: ['--x "unbalanced'] }),
    /Unbalanced quote/
  )
  console.log('✓ project validateExtra: syntax error inside an entry still caught')
}

{
  // Core regression guard, exercised through this specific gate: a hidden/
  // undocumented flag must still be accepted (syntax-only validation).
  assert.doesNotThrow(() =>
    projectValidateExtraForTest({
      customCliFlags: ['--dangerously-load-development-channels server:loco']
    })
  )
  console.log('✓ project validateExtra: hidden flag accepted through this gate')
}

// ---------------------------------------------------------------------------
// Compose-level merge — simulates the seam in composeClaudeLaunch
// (src/main/claudeSettings.ts) where global.customCliFlags and
// project.overrides.customCliFlags are each flattened to argv tokens (one
// parseFlagEntry per raw entry, exactly as flagEntryToTokens does) and then
// combined via mergeFlagScopes, appended AFTER Orpheus's own six typed
// flags. This can't invoke composeClaudeLaunch directly (electron/db import
// chain — see above), so it re-creates the exact token-flattening step
// composeClaudeLaunch performs and asserts on the merged result.
// ---------------------------------------------------------------------------

function flagEntriesToTokens(entries: string[]): string[] {
  return entries.flatMap((entry) => {
    const parsed = parseFlagEntry(entry)
    assert.ok(!isError(parsed), `fixture entry failed to parse: ${entry}`)
    return (parsed as ParsedFlag).tokens
  })
}

{
  // Global-only: project has no custom flags, global's pass through untouched.
  const merged = mergeFlagScopes(flagEntriesToTokens(['--debug', '--add-dir /a']), [])
  assert.deepEqual(merged, ['--debug', '--add-dir', '/a'])
  console.log('✓ compose merge: global-only custom flags pass through')
}

{
  // Project-only: global has no custom flags, project's pass through untouched.
  const merged = mergeFlagScopes([], flagEntriesToTokens(['--effort high']))
  assert.deepEqual(merged, ['--effort', 'high'])
  console.log('✓ compose merge: project-only custom flags pass through')
}

{
  // Both scopes, repeatable flag (--add-dir): accumulates from both scopes
  // rather than project silently dropping global's directory.
  const merged = mergeFlagScopes(
    flagEntriesToTokens(['--add-dir /global']),
    flagEntriesToTokens(['--add-dir /project'])
  )
  assert.deepEqual(merged, ['--add-dir', '/global', '--add-dir', '/project'])
  console.log('✓ compose merge: both scopes, repeatable flag accumulates')
}

{
  // Both scopes, same non-repeatable flag name (conflict): project wins,
  // global's entry is dropped entirely (not just its value).
  const merged = mergeFlagScopes(
    flagEntriesToTokens(['--model opus']),
    flagEntriesToTokens(['--model sonnet'])
  )
  assert.deepEqual(merged, ['--model', 'sonnet'])
  console.log('✓ compose merge: both scopes, conflicting flag — project wins')
}

{
  // Full seam simulation: Orpheus's own typed flags come first, custom
  // merged tokens are appended after — so a user's --model in custom flags
  // wins over Orpheus's own --model by last-flag-wins in claude's parser.
  const orpheusOwnFlagTokens = ['--model', 'sonnet', '--permission-mode', 'acceptEdits']
  const customTokens = mergeFlagScopes(
    flagEntriesToTokens(['--model opus']), // global custom flag
    [] // no project custom flags
  )
  const flagTokens = [...orpheusOwnFlagTokens, ...customTokens]
  assert.deepEqual(flagTokens, [
    '--model',
    'sonnet',
    '--permission-mode',
    'acceptEdits',
    '--model',
    'opus'
  ])
  // findFlagValue must resolve to the LAST occurrence semantically (claude's
  // own parser is last-flag-wins) — but findFlagValue itself returns the
  // first group match by name since groupTokensByFlag only tracks one entry
  // per name. This assertion documents that composeClaudeLaunch's ordering
  // (custom flags appended last) is what makes the escape hatch win in
  // practice, at the claude-process level — not something findFlagValue
  // itself needs to resolve.
  console.log("✓ compose merge: custom flags appended after Orpheus's own typed flags")
}

// ---------------------------------------------------------------------------
// findFlagValue / splitFlagString / groupTokensByFlag — the single parser
// for a COMPOSED (already FLAG_DELIMITER-joined) flags string, as read back
// by the footer Model/Effort chips (src/main/ipc/claudeSettings.ts) and
// sessions.ts's model-resolution fallback. This is the exact regression
// class that broke when the transport moved from whitespace-joined to
// 0x1F-delimited: four call sites regexed the composed string assuming
// whitespace separation and silently stopped matching. These assertions
// pin the 0x1F-native replacement.
// ---------------------------------------------------------------------------

{
  const composed = ['--model', 'opus', '--permission-mode', 'acceptEdits', '--effort', 'high'].join(
    FLAG_DELIMITER
  )
  assert.equal(findFlagValue(composed, '--model'), 'opus')
  assert.equal(findFlagValue(composed, '--effort'), 'high')
  console.log('✓ findFlagValue: finds a flag by name regardless of position (not just first)')
}

{
  // --effort deliberately NOT first, proving no start-anchor assumption survives.
  const composed = ['--debug', '--effort', 'high', '--model', 'opus'].join(FLAG_DELIMITER)
  assert.equal(findFlagValue(composed, '--model'), 'opus')
  assert.equal(findFlagValue(composed, '--effort'), 'high')
  console.log('✓ findFlagValue: position-independent — no implicit start-of-string anchor')
}

{
  // '='-joined form (one token) must resolve identically to the two-token form.
  const composed = ['--model=opus', '--permission-mode', 'acceptEdits'].join(FLAG_DELIMITER)
  assert.equal(findFlagValue(composed, '--model'), 'opus')
  console.log('✓ findFlagValue: handles --model=opus (=-joined) as well as --model opus')
}

{
  // Absent flag -> null, not a throw or empty string.
  const composed = ['--debug'].join(FLAG_DELIMITER)
  assert.equal(findFlagValue(composed, '--model'), null)
  assert.equal(findFlagValue('', '--model'), null)
  console.log('✓ findFlagValue: returns null for an absent flag (including the empty-flags case)')
}

{
  // splitFlagString: the empty-default invariant applies here too — '' must
  // split to [], not [''], or groupTokensByFlag would treat a stray ''
  // token as a value-with-no-preceding-flag.
  assert.deepEqual(splitFlagString(''), [])
  assert.deepEqual(splitFlagString(['--debug', '--model', 'opus'].join(FLAG_DELIMITER)), [
    '--debug',
    '--model',
    'opus'
  ])
  console.log(
    '✓ splitFlagString: empty string yields [], non-empty round-trips through FLAG_DELIMITER'
  )
}

{
  // groupTokensByFlag re-groups a flat composed token stream back into
  // {name, tokens} entries — the shared primitive both mergeFlagScopes and
  // the footer-chip reconcile logic build on.
  const tokens = ['--model', 'opus', '--debug', '--effort', 'high']
  const groups = groupTokensByFlag(tokens)
  assert.deepEqual(groups, [
    { name: '--model', tokens: ['--model', 'opus'] },
    { name: '--debug', tokens: ['--debug'] },
    { name: '--effort', tokens: ['--effort', 'high'] }
  ])
  console.log('✓ groupTokensByFlag: re-groups a flat token stream by flag name')
}

// ---------------------------------------------------------------------------
// Footer-chip reconcile guard — reimplements reconcileFlagsExceptTarget's
// algorithm (src/main/ipc/claudeSettings.ts) inline, using the SAME shared
// primitives (splitFlagString + groupTokensByFlag) it's built on, since that
// module imports `electron`-dependent code (getWorkspace -> workspaces.ts)
// transitively and cannot run under this harness. This pins the documented
// contract: after reconciling ONE flag dimension (e.g. model), an unrelated
// pending dirty delta (e.g. permission-mode changed separately) must survive
// untouched — proving the reconcile is scoped to exactly the target flag.
// ---------------------------------------------------------------------------

function reconcileFlagsExceptTargetForTest(
  oldFlags: string,
  freshFlags: string,
  targetName: string
): string {
  const oldGroups = groupTokensByFlag(splitFlagString(oldFlags))
  const freshGroups = groupTokensByFlag(splitFlagString(freshFlags))
  const oldByName = new Map(oldGroups.map((g) => [g.name, g.tokens]))
  const freshByName = new Map(freshGroups.map((g) => [g.name, g.tokens]))
  const allNames = new Set([...oldByName.keys(), ...freshByName.keys()])

  const patchedByName = new Map(freshByName)
  for (const name of allNames) {
    if (name === targetName) continue
    const oldTokens = oldByName.get(name)
    const freshTokens = freshByName.get(name)
    const unchanged =
      oldTokens !== undefined &&
      freshTokens !== undefined &&
      oldTokens.length === freshTokens.length &&
      oldTokens.every((t, i) => t === freshTokens[i])
    if (unchanged) continue

    if (oldTokens !== undefined) {
      patchedByName.set(name, oldTokens)
    } else {
      patchedByName.delete(name)
    }
  }

  const orderedNames = [...freshGroups.map((g) => g.name)]
  for (const name of patchedByName.keys()) {
    if (!orderedNames.includes(name)) orderedNames.push(name)
  }

  const patchedTokens: string[] = []
  for (const name of orderedNames) {
    const tokens = patchedByName.get(name)
    if (tokens) patchedTokens.push(...tokens)
  }
  return patchedTokens.join(FLAG_DELIMITER)
}

{
  // Only the target flag (model) changed since mount — reconciling model
  // should produce a result IDENTICAL to fresh (nothing left dirty).
  const oldSnapshot = ['--model', 'sonnet', '--permission-mode', 'acceptEdits'].join(FLAG_DELIMITER)
  const fresh = ['--model', 'opus', '--permission-mode', 'acceptEdits'].join(FLAG_DELIMITER)
  const patched = reconcileFlagsExceptTargetForTest(oldSnapshot, fresh, '--model')
  assert.equal(patched, fresh, 'reconciling the only changed flag must produce exactly fresh')
  console.log('✓ reconcile: sole changed flag (model) reconciles to an exact match with fresh')
}

{
  // Model changed AND permission-mode changed independently (unrelated
  // pending dirty delta). Reconciling model must leave permission-mode
  // reverted to OLD's value, so the patched snapshot still differs from
  // fresh — i.e. the workspace correctly stays dirty for the UNRELATED change.
  const oldSnapshot = ['--model', 'sonnet', '--permission-mode', 'default'].join(FLAG_DELIMITER)
  const fresh = ['--model', 'opus', '--permission-mode', 'acceptEdits'].join(FLAG_DELIMITER)
  const patched = reconcileFlagsExceptTargetForTest(oldSnapshot, fresh, '--model')
  assert.notEqual(
    patched,
    fresh,
    'an unrelated pending delta (permission-mode) must NOT be silently absorbed'
  )
  // model resolves to fresh's new value (the intended change)...
  assert.equal(findFlagValue(patched, '--model'), 'opus')
  // ...but permission-mode is reverted to OLD's stale value, so the genuine
  // pending delta is still visible to launchEquals() downstream.
  assert.equal(findFlagValue(patched, '--permission-mode'), 'default')
  console.log(
    '✓ reconcile: unrelated pending dirty delta (permission-mode) survives untouched after reconciling model'
  )
}

// ---------------------------------------------------------------------------
// The flags === '' empty-default invariant (claudeSettings.ts:674-676): an
// empty token array must join to the empty string, so the wrapper script's
// `[[ -n "${ORPHEUS_CLAUDE_FLAGS:-}" ]]` guard sees it as unset and runs a
// bare `claude` with no extra arguments.
// ---------------------------------------------------------------------------

{
  const emptyTokens: string[] = []
  assert.equal(emptyTokens.join(FLAG_DELIMITER), '')
  console.log('✓ invariant: empty token array joins to the empty string')
}

{
  // Same invariant, at the customCliFlags seam specifically: empty global +
  // empty project customCliFlags must merge to an empty token array and
  // contribute nothing to flagTokens — the seeded-default state (no global
  // settings changed, no project overrides) must still yield flags === ''.
  const merged = mergeFlagScopes(flagEntriesToTokens([]), flagEntriesToTokens([]))
  assert.deepEqual(merged, [])
  const orpheusOwnFlagTokens: string[] = [] // seeded defaults emit no typed flags either
  const flagTokens = [...orpheusOwnFlagTokens, ...merged]
  assert.equal(flagTokens.join(FLAG_DELIMITER), '')
  console.log("✓ invariant: empty customCliFlags at both scopes preserves the flags === '' default")
}

// ---------------------------------------------------------------------------
// Transport round-trip: the composer's join must survive a REAL zsh split via
// the exact idiom shipped in resources/orpheus-claude.sh. This is the
// highest-value test — it proves the wire format end-to-end, not just the
// TypeScript half.
// ---------------------------------------------------------------------------

function roundTripThroughZsh(tokens: string[]): string[] {
  const joined = tokens.join(FLAG_DELIMITER)
  const script = 'flags=("${(@ps:\\x1f:)ORPHEUS_CLAUDE_FLAGS}"); printf "%s\\n" "${flags[@]}"'
  const out = execFileSync('zsh', ['-c', script], {
    env: { ...process.env, ORPHEUS_CLAUDE_FLAGS: joined },
    encoding: 'utf8'
  })
  // printf appends a trailing newline after the last element; drop the final
  // empty segment from the split. If tokens is empty, joined is '', so the
  // shell sees an empty (unquoted-inside-ps) array with a single empty
  // element — guard that case separately below rather than here.
  const lines = out.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

{
  const cases: string[][] = [
    ['--debug'],
    ['--model', 'opus'],
    ['--model=opus'],
    ['-d'],
    ['--append-system-prompt', 'be terse and kind'],
    ['--x', 'single quoted'],
    ['--x=quoted with spaces'],
    ['--dangerously-load-development-channels', 'server:loco'],
    ['--x', "a 'b' c"],
    ['--quote=mixed "q"'],
    ['--foo', '$(whoami)', '--bar', '`id -u`', '--baz', ';rm -rf /tmp/nope'],
    [
      '--model',
      'opus',
      '--permission-mode',
      'acceptEdits',
      '--session-id',
      '9f3e7b1a-1234-4a1a-9c9c-abcdefabcdef'
    ]
  ]

  for (const tokens of cases) {
    const roundTripped = roundTripThroughZsh(tokens)
    assert.deepEqual(
      roundTripped,
      tokens,
      `round-trip mismatch for ${JSON.stringify(tokens)}: got ${JSON.stringify(roundTripped)}`
    )
  }

  console.log('✓ transport: composer output round-trips through the real zsh splitter')
}

{
  // Empty flags: the composer emits '', and orpheus-claude.sh's own
  // `[[ -n ... ]]` guard (not the splitter) is what keeps flags=() empty in
  // that case — verified directly against the same guard used in the script.
  const script =
    'local -a flags=(); if [[ -n "${ORPHEUS_CLAUDE_FLAGS:-}" ]]; then flags=("${(@ps:\\x1f:)ORPHEUS_CLAUDE_FLAGS}"); fi; printf "%d\\n" "${#flags[@]}"'
  const out = execFileSync('zsh', ['-c', script], {
    env: { ...process.env, ORPHEUS_CLAUDE_FLAGS: '' },
    encoding: 'utf8'
  }).trim()
  assert.equal(out, '0', 'empty ORPHEUS_CLAUDE_FLAGS must yield an empty flags array')
  console.log('✓ transport: empty ORPHEUS_CLAUDE_FLAGS yields an empty flags array in the script')
}

console.log('\nAll cli-flags assertions passed.')
