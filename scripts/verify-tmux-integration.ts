// ---------------------------------------------------------------------------
// scripts/verify-tmux-integration.ts
//
// End-to-end tmux integration harness — unlike verify-tmux-host.ts (pure
// functions only), this script drives REAL `tmux` against a throwaway,
// process-unique socket (`-L orpheus-verify-<pid>`). Requires tmux on PATH;
// skips (exit 0) rather than failing when it isn't installed, since tmux
// hosting is an optional feature (see tmuxHost.ts's TmuxNotAvailableError).
//
// SAFETY: only ever touches its own throwaway socket, never
// orpheus/orpheus-dev/orpheus-wt/orpheus-nightly, and always kill-servers it
// (AND unlinks the socket file — kill-server alone leaves that behind, see
// tmuxSocketPath()) in a `finally` so a failed assertion never leaks a
// background tmux server or a stale socket file in $TMUX_TMPDIR.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rm } from 'node:fs/promises'
import * as path from 'node:path'
import { tmuxSessionName, shouldRetainInTmuxEnvironment } from '../src/main/tmuxHost'

const execFileAsync = promisify(execFile)

const RESERVED_SOCKET_NAMES = ['orpheus', 'orpheus-dev', 'orpheus-wt', 'orpheus-nightly']

function assertSafeSocketName(name: string): void {
  assert.ok(
    !RESERVED_SOCKET_NAMES.includes(name),
    `refusing to touch a real Orpheus tmux socket in a test: ${name}`
  )
}

async function tmux(socket: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  assertSafeSocketName(socket)
  return execFileAsync('tmux', ['-L', socket, ...args])
}

async function tmuxExitCode(socket: string, args: string[]): Promise<number> {
  assertSafeSocketName(socket)
  try {
    await execFileAsync('tmux', ['-L', socket, ...args])
    return 0
  } catch (err) {
    const code = (err as { code?: number }).code
    return typeof code === 'number' ? code : 1
  }
}

async function hasTmux(): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['-V'])
    return true
  } catch {
    return false
  }
}

/**
 * Path of the socket FILE tmux creates for `-L <name>` (as opposed to the
 * server process, which `kill-server` tears down separately). MUST be called
 * while the server is still alive — it asks tmux itself, via
 * `display-message -p '#{socket_path}'`, rather than recomputing tmux's
 * resolution rule (a previous version of this helper reimplemented that rule
 * with `$TMUX_TMPDIR` else `os.tmpdir()` and got it wrong: on macOS
 * `os.tmpdir()` returns the per-user `$TMPDIR` — e.g.
 * `/var/folders/.../T` — but tmux hardcodes `/tmp` (not `$TMPDIR`) for its
 * `$TMUX_TMPDIR`-unset fallback, so the recomputed path never matched the
 * real socket and `rm({ force: true })` silently no-op'd on every run).
 * Falls back to the literal `/tmp/tmux-<uid>/<socket>` (note: `/tmp`, not
 * `os.tmpdir()`) only if the query itself fails, e.g. the server was already
 * dead (never started, or died between two cleanup attempts).
 */
async function tmuxSocketPath(socket: string): Promise<string> {
  try {
    const { stdout } = await tmux(socket, ['display-message', '-p', '#{socket_path}'])
    const queried = stdout.trim()
    if (queried !== '') return queried
  } catch {
    // Server already gone — fall through to the literal fallback below.
  }
  const tmpDir = process.env.TMUX_TMPDIR ?? `/tmp/tmux-${process.getuid?.() ?? 0}`
  return path.join(tmpDir, socket)
}

async function main(): Promise<void> {
  if (!(await hasTmux())) {
    console.log('tmux not found on PATH — skipping integration checks (this is not a failure).')
    return
  }

  const socketA = `orpheus-verify-${process.pid}-a`
  const socketB = `orpheus-verify-${process.pid}-b`
  assertSafeSocketName(socketA)
  assertSafeSocketName(socketB)

  const cleanup = async (): Promise<void> => {
    for (const socket of [socketA, socketB]) {
      // Capture the real socket path WHILE the server may still be alive —
      // tmuxSocketPath() queries tmux itself for it, which only works before
      // kill-server tears the server down.
      const socketPath = await tmuxSocketPath(socket)
      try {
        await tmux(socket, ['kill-server'])
      } catch {
        // Already gone / never started — fine.
      }
      // kill-server tears down the server process but does not reliably
      // unlink the socket FILE (Bug 3) — remove it explicitly so a run
      // leaves no trace in $TMUX_TMPDIR. force+ignore: the file may already
      // be gone (kill-server sometimes does clean it up) or never existed
      // (e.g. the server was never started, checks 1's socketA case).
      await rm(socketPath, { force: true }).catch(() => {})
    }
  }

  try {
    // -------------------------------------------------------------------
    // 1. "no server running" reports as a clean exit-1, not a crash — the
    //    same condition listHostedSessions()/hasSession() must treat as
    //    "nothing hosted" rather than an error.
    // -------------------------------------------------------------------
    {
      const code = await tmuxExitCode(socketA, ['list-sessions', '-F', '#{session_name}'])
      assert.equal(code, 1, 'list-sessions against a not-yet-started server must exit 1')
      console.log('✓ list-sessions on a server that was never started exits 1 (treated as empty)')
    }

    // -------------------------------------------------------------------
    // 2. tmuxSessionName() output is actually accepted by tmux as a target:
    //    round-trip it through new-session + has-session.
    // -------------------------------------------------------------------
    const sessionName = tmuxSessionName('feature: fix.bug 🎉', 'abcdef1234567890')
    await tmux(socketA, ['new-session', '-d', '-s', sessionName, '-c', '/tmp', '--', 'sleep', '60'])
    {
      const { stdout } = await tmux(socketA, ['has-session', '-t', sessionName])
      void stdout // has-session prints nothing on success; absence of a throw is the signal.
      console.log('✓ a tmuxSessionName() output round-trips through new-session + has-session')
    }

    // -------------------------------------------------------------------
    // 3. -e env delivery, INCLUDING a 0x1F-containing value (the
    //    ORPHEUS_CLAUDE_FLAGS delimiter, see src/shared/cliFlags.ts).
    // -------------------------------------------------------------------
    const flagsValue = ['--model', 'opus', '--permission-mode', 'plan'].join('\x1f')
    const envSessionName = `env-check-${process.pid}`
    await tmux(socketA, [
      'new-session',
      '-d',
      '-s',
      envSessionName,
      '-e',
      `ORPHEUS_CLAUDE_FLAGS=${flagsValue}`,
      '-e',
      'ORPHEUS_WORKSPACE_ID=workspace-123',
      '-e',
      'ANTHROPIC_API_KEY=sk-ant-not-a-real-key',
      '--',
      'sleep',
      '60'
    ])
    {
      // `tmux show-environment` rendering of a control byte is version-
      // dependent: some tmux builds print a backslash-octal escape for
      // display (0x1F -> `\037`), but tmux 3.6a (confirmed via a direct
      // `-e "PROBE=$(printf 'a\037b')"` + hexdump probe) prints the raw
      // 0x1F byte unescaped. Both are valid renderings of the SAME stored
      // value — accept either rather than assuming one specific tmux
      // version's presentation, so the real property under test (the byte
      // survives `-e` delivery intact) holds across tmux versions.
      const { stdout } = await tmux(socketA, [
        'show-environment',
        '-t',
        envSessionName,
        'ORPHEUS_CLAUDE_FLAGS'
      ])
      const expectedRaw = `ORPHEUS_CLAUDE_FLAGS=${flagsValue}`
      const expectedEscaped = `ORPHEUS_CLAUDE_FLAGS=${flagsValue.replaceAll('\x1f', '\\037')}`
      const actual = stdout.trim()
      assert.ok(
        actual === expectedRaw || actual === expectedEscaped,
        `show-environment must render the 0x1F byte as either the raw byte or its \\037 octal ` +
          `escape, got: ${JSON.stringify(actual)}`
      )
      console.log(
        '✓ -e env delivery preserves a 0x1F-containing value (raw byte or octal escape, both accepted)'
      )
    }

    // -------------------------------------------------------------------
    // 4. Secret scrub (ALLOWLIST semantics — see tmuxHost.ts's
    //    shouldRetainInTmuxEnvironment): every key gets `set-environment -u`
    //    EXCEPT the small operational allowlist. Verify both directions —
    //    ANTHROPIC_API_KEY (scrubbed) and ORPHEUS_WORKSPACE_ID (retained,
    //    load-bearing for CLI attribution in a future pane) — against a
    //    real tmux session, mirroring exactly what scrubSecretEnvironment
    //    does. The ALREADY-RUNNING process keeps its own copy regardless
    //    (env is captured at exec time), so scrubbing the session's stored
    //    table cannot break the running process.
    // -------------------------------------------------------------------
    {
      const { stdout: secretBefore } = await tmux(socketA, [
        'show-environment',
        '-t',
        envSessionName,
        'ANTHROPIC_API_KEY'
      ])
      assert.equal(secretBefore.trim(), 'ANTHROPIC_API_KEY=sk-ant-not-a-real-key')

      // Mirror scrubSecretEnvironment: unset every key NOT on the allowlist.
      const sessionKeys = ['ORPHEUS_CLAUDE_FLAGS', 'ORPHEUS_WORKSPACE_ID', 'ANTHROPIC_API_KEY']
      for (const key of sessionKeys) {
        if (shouldRetainInTmuxEnvironment(key)) continue
        await tmux(socketA, ['set-environment', '-t', envSessionName, '-u', key])
      }

      const secretAfterCode = await tmuxExitCode(socketA, [
        'show-environment',
        '-t',
        envSessionName,
        'ANTHROPIC_API_KEY'
      ])
      assert.equal(secretAfterCode, 1, 'ANTHROPIC_API_KEY must be scrubbed from show-environment')

      const { stdout: retainedAfter } = await tmux(socketA, [
        'show-environment',
        '-t',
        envSessionName,
        'ORPHEUS_WORKSPACE_ID'
      ])
      assert.equal(
        retainedAfter.trim(),
        'ORPHEUS_WORKSPACE_ID=workspace-123',
        'ORPHEUS_WORKSPACE_ID is allowlisted and must survive the scrub'
      )
      console.log(
        '✓ the allowlist scrub removes ANTHROPIC_API_KEY from show-environment while retaining ORPHEUS_WORKSPACE_ID'
      )
    }

    // -------------------------------------------------------------------
    // 5. window-size latest is accepted.
    // -------------------------------------------------------------------
    await tmux(socketA, ['set-option', '-t', sessionName, 'window-size', 'latest'])
    console.log('✓ set-option window-size latest is accepted')

    // -------------------------------------------------------------------
    // 6. has-session / kill-session / list-sessions lifecycle.
    // -------------------------------------------------------------------
    {
      const { stdout } = await tmux(socketA, ['list-sessions', '-F', '#{session_name}'])
      const names = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      assert.ok(names.includes(sessionName))
      assert.ok(names.includes(envSessionName))

      await tmux(socketA, ['kill-session', '-t', sessionName])
      const goneCode = await tmuxExitCode(socketA, ['has-session', '-t', sessionName])
      assert.equal(goneCode, 1, 'has-session must report gone after kill-session')
      console.log('✓ has-session/kill-session/list-sessions lifecycle behaves as expected')
    }

    // -------------------------------------------------------------------
    // 7. Socket isolation — the single most important guarantee: sessions
    //    on socketA are invisible from socketB and vice versa. This is the
    //    dev/prod/wt/nightly separation contract (docs/TUI_SPEC.md).
    // -------------------------------------------------------------------
    {
      await tmux(socketB, ['new-session', '-d', '-s', 'isolated-b', '--', 'sleep', '60'])

      const codeInB = await tmuxExitCode(socketA, ['has-session', '-t', 'isolated-b'])
      assert.equal(codeInB, 1, 'a session on socket B must be invisible from socket A')

      const codeInA = await tmuxExitCode(socketB, ['has-session', '-t', envSessionName])
      assert.equal(codeInA, 1, 'a session on socket A must be invisible from socket B')

      console.log(
        '✓ socket isolation holds — sessions on distinct -L sockets never cross-see each other'
      )
    }
  } finally {
    await cleanup()
  }

  console.log('\nAll tmux integration checks passed.')
}

main().catch((err) => {
  console.error(err)
  // Use process.exit() rather than process.exitCode alone — a lingering
  // handle (e.g. a child-process reference from execFile) could otherwise
  // keep the event loop alive long enough for something else to override
  // the exit code before the process naturally exits. An assertion failure
  // in this harness must be an unambiguous non-zero exit every time.
  process.exit(1)
})
