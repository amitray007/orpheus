/**
 * tui/entry.ts — runtime orchestrator for `orpheus tui`.
 *
 * This is the esbuild entry point bundled separately (as ESM — see the
 * "WHY dist/tui.mjs IS ESM" note in commands/tui.ts for why this can't be a
 * second CJS bundle like dist/cli.cjs) into dist/tui.mjs (see "build:cli:tui"
 * in the root package.json) and lazy-imported at runtime by commands/tui.ts —
 * never statically imported from cli.ts/the command modules, so react/ink
 * never load for one-shot commands (`ws ls` etc).
 *
 * CONNECTION REUSE (do not reinvent app-launch handling here)
 * -------------------------------------------------------------
 * The FIRST subscribe() call below happens synchronously enough that a
 * thrown AppNotRunningError propagates out of runTui()'s returned promise,
 * out of commands/tui.ts's handler, and into cli.ts's existing
 * runWithSingleAppRetry + autoLaunch flow — the same one every other action
 * command uses. This file does not implement its own "spawn the app" path.
 *
 * PICKER <-> TMUX LOOP (docs/TUI_SPEC.md D1/D6)
 * -------------------------------------------------------------
 * runTui() loops: render the picker, and when the user opens a workspace,
 * host it (workspace.host) and exec `tmux attach` with inherited stdio. When
 * the user detaches (or the tmux process exits for any reason), control
 * returns to the picker rather than dropping to a shell — this loop-back is
 * the core UX this feature exists to deliver.
 *
 * FRAME DELIVERY: STORE, NOT rerender() (see tui/frameStore.ts)
 * -------------------------------------------------------------
 * <App> is mounted exactly ONCE via `render()`. Incoming `tree` frames are
 * pushed into frameStore (a tiny external store) rather than triggering
 * `instance.rerender(<App .../>)` with a fresh element tree — the previous
 * approach forced a full reconciliation from a new root on every frame
 * (~20x/sec at the 50ms server-side debounce), which both wasted work and
 * defeated memoization (the closures passed as props were recreated every
 * call). App.tsx reads the store via `useSyncExternalStore`, so Ink diffs
 * normally against the previous render.
 */

import { spawn } from 'node:child_process'
import * as React from 'react'
import { render, type Instance } from 'ink'
import { subscribe, sendCommand } from '../socket-client.js'
import { App } from './App.js'
import { applyFrame, resetFrame } from './frameStore.js'
import { isTreeFrame, type WorkspaceHostResult } from './types.js'
import type { ProjectScope } from './layout.js'

export interface RunTuiOptions {
  /** Set when `--project` narrows the picker to a single project. */
  scope?: ProjectScope
}

type PickerOutcome = { type: 'open'; workspaceId: string } | { type: 'quit' }

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Mount the picker ONCE and resolve once the user opens a workspace or
 * quits. `tree` frames arrive from OUTSIDE React (the /subscribe event
 * callback) and are pushed into frameStore, which App.tsx reads via
 * `useSyncExternalStore` — see the file header for why this replaced a
 * per-frame `instance.rerender()`.
 */
function runPickerOnce(options: RunTuiOptions): Promise<PickerOutcome> {
  let settleOnce: (outcome: PickerOutcome) => void = () => {}

  const node = React.createElement(App, {
    scope: options.scope,
    onOpen: (workspaceId: string) => {
      subscription.close()
      settleOnce({ type: 'open', workspaceId })
    },
    onQuit: () => {
      subscription.close()
      settleOnce({ type: 'quit' })
    }
  })

  const onEvent = (evt: unknown): void => {
    if (!isTreeFrame(evt)) return
    applyFrame(evt)
  }

  // Start clean: a previous loop iteration (returning here after a tmux
  // detach) must not flash the last-known frame from before this
  // subscription existed.
  resetFrame()

  // No client-side timeout — the picker stays open indefinitely until the
  // user acts. May throw AppNotRunningError synchronously; see the file
  // header for why that's intentionally left uncaught here.
  const subscription = subscribe({ tree: true }, onEvent, { timeoutMs: 0 })

  // Mount immediately, before the first frame lands — App.tsx renders its
  // own "connecting…" state for a null store snapshot.
  //
  // alternateScreen: true keeps the picker's redraws off the user's normal
  // terminal scrollback (same buffer-swap behavior `tmux attach` itself
  // uses) and cuts redraw traffic over SSH. UNVERIFIED specifically on
  // Termius (iOS) — if it misbehaves on-device (garbled restore, blank
  // screen on detach), this is the one line to flip back to `false`.
  const instance: Instance = render(node, { alternateScreen: true })

  return new Promise<PickerOutcome>((resolve) => {
    let settled = false
    settleOnce = (outcome) => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    // subscription.done never rejects for OUR OWN subscription.close() call
    // (see onOpen/onQuit above) — teardown() there passes no error, and by
    // the time `done` settles, settleOnce has ALREADY run synchronously, so
    // this handler becomes a no-op for that case (guarded by `settled`).
    // The two cases where this handler actually does something are both
    // the connection ending WITHOUT us asking for it:
    //   - done RESOLVES: the server's response stream ended on its own
    //     (res.on('end') in socket-client.ts — e.g. Orpheus quit cleanly).
    //     Not an error, but the user didn't ask to leave the picker either,
    //     so a neutral note (not an alarming one) explains why they're
    //     suddenly back at a shell prompt instead of silently dropping them
    //     there with zero explanation.
    //   - done REJECTS with a SubscriptionError: a genuine transport
    //     failure (aborted/errored response — see socket-client.ts). Print
    //     its message; this is worth a real "something went wrong" line.
    subscription.done
      .then(() => {
        if (!settled) {
          process.stderr.write('orpheus: connection to Orpheus closed; returning to shell\n')
        }
      })
      .catch((err: unknown) => {
        process.stderr.write(`orpheus: lost connection to Orpheus: ${errorMessage(err)}\n`)
      })
      .finally(() => settleOnce({ type: 'quit' }))
  }).finally(async () => {
    instance.unmount()
    await instance.waitUntilExit()
  })
}

/**
 * Wait for a single keypress on stdin, restoring whatever raw-mode state was
 * in effect beforehand. Used to make sure a hosting/tmux error is actually
 * seen before looping back to the picker (rather than being instantly
 * overdrawn).
 */
function waitForKeypress(): Promise<void> {
  return new Promise<void>((resolve) => {
    const stdin = process.stdin
    const wasRaw = stdin.isTTY === true && stdin.isRaw === true
    if (stdin.isTTY === true) stdin.setRawMode(true)
    stdin.resume()
    const onData = (): void => {
      stdin.removeListener('data', onData)
      if (stdin.isTTY === true) stdin.setRawMode(wasRaw)
      resolve()
    }
    stdin.once('data', onData)
  })
}

/** Host the workspace in tmux (via the running app) and attach, inheriting stdio. */
async function hostAndAttach(workspaceId: string): Promise<void> {
  let hostResult: WorkspaceHostResult
  try {
    const result = await sendCommand('workspace.host', { id: workspaceId })
    hostResult = result as WorkspaceHostResult
  } catch (err) {
    process.stderr.write(`orpheus: failed to host workspace: ${errorMessage(err)}\n`)
    process.stderr.write('press any key to return to the picker…\n')
    await waitForKeypress()
    return
  }

  await new Promise<void>((resolve) => {
    const child = spawn(
      'tmux',
      ['-L', hostResult.socketName, 'attach', '-t', hostResult.sessionName],
      { stdio: 'inherit' }
    )
    child.once('exit', () => resolve())
    child.once('error', (err) => {
      // e.g. tmux isn't installed (ENOENT) — surface it rather than crashing
      // the whole TUI, then fall through to the "press any key" wait below.
      process.stderr.write(`orpheus: could not run tmux: ${errorMessage(err)}\n`)
      resolve()
    })
  })
}

export async function runTui(options: RunTuiOptions = {}): Promise<void> {
  if (process.stdout.isTTY !== true) {
    process.stderr.write('orpheus tui requires an interactive terminal (TTY)\n')
    process.exitCode = 1
    return
  }

  for (;;) {
    // Sequential by design: this IS the picker <-> tmux loop (open, attach,
    // detach, re-show the picker) — there is nothing to parallelize.
    const outcome = await runPickerOnce(options)
    if (outcome.type === 'quit') return
    await hostAndAttach(outcome.workspaceId)
  }
}
