import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import {
  parseFlagEntry,
  flagName,
  mergeFlagScopes,
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
