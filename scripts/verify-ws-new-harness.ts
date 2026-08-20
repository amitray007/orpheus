/**
 * scripts/verify-ws-new-harness.ts — `ws new --harness <id>` client plumbing.
 *
 * Orpheus gained a second harness (Codex CLI, id 'codex-cli' — see
 * src/main/harness/registry.ts). The server side (commandServer.ts's
 * handleLegacyWorkspaceCreate) already type-checks and validates
 * `args.harnessId` via isKnownHarnessId. This harness covers the CLIENT half:
 * `orpheus ws new --harness <id>` must translate into `args.harnessId` on the
 * workspace.create payload, and must NOT do any client-side membership check
 * against a hardcoded harness-id list (the server is the single source of
 * truth and already returns a clear `unknown harnessId: <id>` error) — see
 * ws-new.ts's own comment on `buildCreateArgs` for why duplicating that list
 * here would be exactly the drift hazard the multi-harness migration is
 * removing.
 *
 * Calls the REAL exported `buildCreateArgs` from commands/ws-new.ts directly
 * (not a source-text grep) — this repo has a documented case (project.add)
 * of a source-grep assertion passing against a dead `if (false && ...)`
 * guard. Also asserts against the REAL registered command descriptor
 * (registry.ts's getCommand) and the REAL --help renderer (command-help.ts's
 * commandHelp), so a usage-string/flag-spec edit that isn't wired into the
 * actual command registration would be caught here too.
 *
 * No SQLite/native/socket dependency — plain bun, like the majority of this
 * suite's entries.
 */

import assert from 'node:assert/strict'

// Importing commands/ws-new.ts runs its top-level `registerCommand('ws new', ...)`
// call as a side effect — this is the same pattern verify-cli-phase3-compat.ts
// and verify-tui-wizard.ts already rely on for their own imports.
import { buildCreateArgs } from '../packages/orpheus-cli/src/commands/ws-new.ts'
import { getCommand } from '../packages/orpheus-cli/src/registry.ts'
import { commandHelp } from '../packages/orpheus-cli/src/command-help.ts'

// ---------------------------------------------------------------------------
// 1. buildCreateArgs — the actual arg-building function, not source text.
// ---------------------------------------------------------------------------

// --harness codex-cli -> args.harnessId === 'codex-cli'
{
  const args = buildCreateArgs({ harness: 'codex-cli' }, 'proj-1', '/tmp/proj-1', false)
  assert.equal(args.harnessId, 'codex-cli', '--harness codex-cli must set args.harnessId')
}

// Omitting --harness leaves harnessId ABSENT — not defaulted to 'claude'
// client-side. The server/DB own the default; a client-side default would
// be a second place that decision could drift from the server's.
{
  const args = buildCreateArgs({}, 'proj-1', '/tmp/proj-1', false)
  assert.equal(
    'harnessId' in args,
    false,
    '--harness omitted must leave args.harnessId absent, not defaulted to "claude"'
  )
}

// An empty-string --harness value behaves like every other string flag in
// this function (--name, --model, --effort, --permission-mode all gate on
// `!== ''`) — must not send an empty harnessId.
{
  const args = buildCreateArgs({ harness: '' }, 'proj-1', '/tmp/proj-1', false)
  assert.equal('harnessId' in args, false, '--harness "" must not set args.harnessId')
}

// No membership check against a hardcoded id list: an arbitrary/unknown
// string still passes through unchanged. The server is the sole validator
// (isKnownHarnessId in commandServer.ts) — verified by inspection there,
// not re-asserted here (out of scope: server side is explicitly done).
{
  const args = buildCreateArgs({ harness: 'not-a-real-harness' }, 'proj-1', '/tmp/proj-1', false)
  assert.equal(
    args.harnessId,
    'not-a-real-harness',
    '--harness must not be validated client-side against a hardcoded list'
  )
}

// harness combines cleanly with the other flags already covered by
// buildCreateArgs (model/effort/permission-mode/task) — no interference.
{
  const args = buildCreateArgs(
    { harness: 'codex-cli', task: 'do the thing', model: 'gpt-5', effort: 'high' },
    'proj-1',
    '/tmp/proj-1',
    true
  )
  assert.equal(args.harnessId, 'codex-cli')
  assert.equal(args.task, 'do the thing')
  assert.equal(args.model, 'gpt-5')
  assert.equal(args.effort, 'high')
  assert.equal(args.focus, true)
}

// ---------------------------------------------------------------------------
// 2. The registered command descriptor — usage string + flag spec actually
//    reach the real 'ws new' registration, not just this file's edits.
// ---------------------------------------------------------------------------

const descriptor = getCommand('ws new')
assert.ok(descriptor != null, "'ws new' must be registered")
assert.match(descriptor.usage, /--harness <id>/, 'usage string must document --harness <id>')
assert.ok(descriptor.flags.harness != null, "flags spec must declare 'harness'")
assert.ok(
  typeof descriptor.flags.harness === 'object' && descriptor.flags.harness.type === 'string',
  '--harness must be a string-valued flag'
)
assert.ok(
  descriptor.examples?.some((ex) => ex.includes('--harness')),
  'at least one example must demonstrate --harness'
)

// ---------------------------------------------------------------------------
// 3. The real --help renderer — end-to-end proof the flag surfaces in the
//    actual text an agent/user sees, not just in the raw descriptor fields.
// ---------------------------------------------------------------------------

const helpText = commandHelp('ws new', descriptor)
assert.match(helpText, /--harness <id>/, '--help output must mention --harness <id>')
assert.match(
  helpText,
  /Harness to run in the new workspace/,
  '--help output must include the --harness description'
)

console.log(helpText)
console.log(
  '\n✓ ws-new-harness: --harness codex-cli sets args.harnessId; omitted/empty leaves it ' +
    'absent (no client-side default); no hardcoded membership check; registered command ' +
    'descriptor + --help both document the flag.'
)
