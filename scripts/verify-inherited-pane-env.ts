// ---------------------------------------------------------------------------
// scripts/verify-inherited-pane-env.ts
//
// Guards the fix for a real, user-visible bug: launching Orpheus from inside
// an Orpheus workspace pane (the normal dev loop) made the app inherit that
// pane's env. tmuxSpawnEnv passes {...process.env} to tmux, and the tmux
// server's GLOBAL env is the spawning client's env — so the outer pane's
// ORPHEUS_CLAUDE_FLAGS reached every later pane whose own composed flags were
// empty (a fresh Codex workspace), via harness-common.sh's rollback fallback.
// `codex` was handed Claude's argv and died on `--permission-mode`.
// The same inheritance leaked the outer app's ORPHEUS_CMD_TOKEN across
// variants.
//
// Asserted behaviourally against the real exported scrubber, not by grepping
// source (this repo has a documented case of a grep assertion passing against
// a dead `if (false && ...)` guard).
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import {
  INHERITED_PANE_ENV_KEYS,
  scrubInheritedPaneEnvFrom
} from '../src/main/scrubInheritedPaneEnv.ts'

// ---------------------------------------------------------------------------
// 1. The exact env observed live on a leaking dev app is fully scrubbed.
// ---------------------------------------------------------------------------
{
  const env: Record<string, string | undefined> = {
    ORPHEUS_CLAUDE_FLAGS:
      '--model\x1fopus\x1f--permission-mode\x1fbypassPermissions\x1f--effort\x1fhigh',
    ORPHEUS_CMD_TOKEN: 'secret-bearer-token',
    ORPHEUS_WORKSPACE_ID: 'outer-workspace',
    ORPHEUS_SOCK: '/tmp/outer.sock',
    PATH: '/usr/bin',
    HOME: '/Users/someone'
  }
  const removed = scrubInheritedPaneEnvFrom(env)

  assert.equal(
    env.ORPHEUS_CLAUDE_FLAGS,
    undefined,
    'ORPHEUS_CLAUDE_FLAGS must be removed — it is what poisoned codex argv'
  )
  assert.equal(
    env.ORPHEUS_CMD_TOKEN,
    undefined,
    'ORPHEUS_CMD_TOKEN must be removed — a cross-variant bearer-token leak'
  )
  assert.ok(removed.includes('ORPHEUS_CLAUDE_FLAGS'))
  assert.ok(removed.includes('ORPHEUS_CMD_TOKEN'))

  // Unrelated vars are untouched — the scrub must be surgical.
  assert.equal(env.PATH, '/usr/bin', 'PATH must survive the scrub')
  assert.equal(env.HOME, '/Users/someone', 'HOME must survive the scrub')
}

// ---------------------------------------------------------------------------
// 2. Every launch-composition + secret key is covered, and the cross-variant
//    GUARD is deliberately NOT scrubbed.
// ---------------------------------------------------------------------------
{
  for (const key of [
    'ORPHEUS_CLAUDE_FLAGS',
    'ORPHEUS_HARNESS_FLAGS',
    'ORPHEUS_CLAUDE_SETTINGS_JSON',
    'ORPHEUS_HARNESS_SETTINGS_JSON',
    'ORPHEUS_HARNESS_BINARY',
    'ORPHEUS_WORKSPACE_ID',
    'ORPHEUS_SOCK',
    'ORPHEUS_NOTIFY',
    'ORPHEUS_CMD_SOCK',
    'ORPHEUS_CMD_TOKEN'
  ]) {
    assert.ok(
      INHERITED_PANE_ENV_KEYS.includes(key),
      `${key} is pane plumbing and must be scrubbed from an inheriting app process`
    )
  }
  // ORPHEUS_INVOKED_VARIANT is the cross-variant GUARD (paths.ts prefers it
  // over the ambient value — see CLAUDE.md). Scrubbing it would re-open the
  // misrouting it exists to prevent.
  assert.equal(
    INHERITED_PANE_ENV_KEYS.includes('ORPHEUS_INVOKED_VARIANT'),
    false,
    'ORPHEUS_INVOKED_VARIANT is the cross-variant guard and must NOT be scrubbed'
  )
  // Likewise ORPHEUS_DATA_VARIANT identifies which app a pane belongs to.
  assert.equal(
    INHERITED_PANE_ENV_KEYS.includes('ORPHEUS_DATA_VARIANT'),
    false,
    'ORPHEUS_DATA_VARIANT must not be scrubbed — it is variant identity, not plumbing'
  )
}

// ---------------------------------------------------------------------------
// 3. Idempotent, and a no-op on a clean env.
// ---------------------------------------------------------------------------
{
  const clean: Record<string, string | undefined> = { PATH: '/usr/bin' }
  assert.deepEqual(scrubInheritedPaneEnvFrom(clean), [], 'clean env removes nothing')
  assert.deepEqual(clean, { PATH: '/usr/bin' }, 'clean env is untouched')

  const dirty: Record<string, string | undefined> = { ORPHEUS_CLAUDE_FLAGS: 'x' }
  scrubInheritedPaneEnvFrom(dirty)
  assert.deepEqual(scrubInheritedPaneEnvFrom(dirty), [], 'second scrub is a no-op')
}

// ---------------------------------------------------------------------------
// 4. harness-common.sh unsets the FLAGS vars but NOT the SETTINGS_JSON vars.
//    orpheus-claude.sh reads ORPHEUS_HARNESS_SETTINGS_JSON *after* sourcing
//    harness-common.sh, so unsetting it there would silently drop Claude's
//    `--settings` blob. The flags vars are safe to unset because they are
//    already parsed into the `flags` array by that point.
// ---------------------------------------------------------------------------
{
  const fs = await import('node:fs')
  const common = fs.readFileSync(new URL('../resources/harness-common.sh', import.meta.url), 'utf8')
  assert.match(
    common,
    /^unset ORPHEUS_CLAUDE_FLAGS ORPHEUS_HARNESS_FLAGS$/m,
    'harness-common.sh must unset both FLAGS vars after building the flags array'
  )
  assert.equal(
    /unset[^\n]*SETTINGS_JSON/.test(common),
    false,
    'harness-common.sh must NOT unset the SETTINGS_JSON vars — orpheus-claude.sh reads them after sourcing it'
  )

  const claudeWrapper = fs.readFileSync(
    new URL('../resources/orpheus-claude.sh', import.meta.url),
    'utf8'
  )
  assert.match(
    claudeWrapper,
    /ORPHEUS_HARNESS_SETTINGS_JSON/,
    'sanity: orpheus-claude.sh still consumes ORPHEUS_HARNESS_SETTINGS_JSON, which is why it must survive'
  )
}

// ---------------------------------------------------------------------------
// 5. buildMountEnv must emit the flag vars UNCONDITIONALLY — including as an
//    empty string. This is the belt-and-braces half of the fix: the session's
//    own `-e` vars are what SHADOW the tmux server's (possibly poisoned)
//    global env. Making this conditional again is exactly the regression that
//    let a fresh Codex workspace — whose composed flags are empty — fall
//    through to the outer app's Claude argv. Asserted as source structure
//    because buildMountEnv statically imports electron + the native addon and
//    cannot be called from a plain harness (see verify-harness-launch.ts's
//    own note on the same limitation for this exact file).
// ---------------------------------------------------------------------------
{
  const fs = await import('node:fs')
  const adapter = fs.readFileSync(
    new URL('../src/main/orpheusSurfaceAdapter.ts', import.meta.url),
    'utf8'
  )
  assert.match(
    adapter,
    /^\s*ORPHEUS_CLAUDE_FLAGS: effectiveFlags,$/m,
    'buildMountEnv must emit ORPHEUS_CLAUDE_FLAGS unconditionally (not behind an `effectiveFlags ?` guard)'
  )
  assert.match(
    adapter,
    /^\s*ORPHEUS_HARNESS_FLAGS: effectiveFlags,$/m,
    'buildMountEnv must emit ORPHEUS_HARNESS_FLAGS unconditionally — zsh `:=` substitutes on empty, so BOTH names must be set'
  )
  assert.equal(
    /effectiveFlags\s*\?\s*\{ ORPHEUS_CLAUDE_FLAGS/.test(adapter),
    false,
    'the conditional flag emission is the regression that poisoned codex argv — it must not return'
  )
}

console.log(
  '✓ inherited workspace-pane env is scrubbed (argv poisoning + cross-variant token leak), the variant guards survive, and the wrapper unsets only the already-parsed FLAGS vars'
)
