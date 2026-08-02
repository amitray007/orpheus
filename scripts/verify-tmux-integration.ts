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
// in a `finally` so a failed assertion never leaks a background tmux server.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
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
      try {
        await tmux(socket, ['kill-server'])
      } catch {
        // Already gone / never started — fine.
      }
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
      // `tmux show-environment` renders control bytes as backslash-octal
      // escapes for display (0x1F -> `\037`) — that's a presentation detail
      // of the CLI, not evidence the stored value differs. Confirm the byte
      // survived by checking for the escape sequence rather than the raw
      // control character (which show-environment never prints literally).
      const { stdout } = await tmux(socketA, [
        'show-environment',
        '-t',
        envSessionName,
        'ORPHEUS_CLAUDE_FLAGS'
      ])
      const expectedEscaped = `ORPHEUS_CLAUDE_FLAGS=${flagsValue.replaceAll('\x1f', '\\037')}`
      assert.equal(stdout.trim(), expectedEscaped)
      console.log(
        "✓ -e env delivery preserves a 0x1F-containing value (verified via show-environment's octal escape)"
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
  process.exitCode = 1
})
