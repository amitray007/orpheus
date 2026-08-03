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
 *
 * RECONNECT WITH BACKOFF (see tui/reconnect.ts, subscribeTimeout.ts)
 * -------------------------------------------------------------
 * Even with the server no longer killing a tree-mode subscription at 300s
 * (subscribeTimeout.ts's SERVER_NO_DEADLINE_TIMEOUT_MS), a stream can still
 * end for reasons outside anyone's control: the Orpheus app restarting, a
 * laptop sleeping, a phone's connection dropping in a tunnel (Termius — the
 * whole premise of this feature). `runPickerOnce` distinguishes a
 * USER-INITIATED close (onOpen/onQuit calling `.close()` — see `settled`)
 * from an UNEXPECTED end (the connection dying on its own) and, only for the
 * latter, attempts to resubscribe with `nextBackoffMs()`-paced delays instead
 * of immediately giving up and dropping to a shell. The revision guard
 * (frameStore's lastRevision) is reset on every reconnect attempt, not just
 * the first subscribe of a loop iteration — see attemptReconnect() below for
 * why that matters. Reconnect state is shown via connectionStore.ts, reusing
 * the same "Connecting to Orpheus…" text spot App.tsx already had.
 */

import { spawn } from 'node:child_process'
import * as React from 'react'
import { render, type Instance } from 'ink'
import { subscribe, sendCommand } from '../socket-client.js'
import { App } from './App.js'
import { applyFrame, resetFrame } from './frameStore.js'
import { setConnectionNotice } from './connectionStore.js'
import { nextBackoffMs } from './reconnect.js'
import { isTreeFrame, type WorkspaceHostResult } from './types.js'
import type { ProjectScope } from './layout.js'

export interface RunTuiOptions {
  /** Set when `--project` narrows the picker to a single project. */
  scope?: ProjectScope
}

type PickerOutcome = { type: 'open'; workspaceId: string } | { type: 'quit' }

type Subscription = ReturnType<typeof subscribe>

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Mount the picker ONCE and resolve once the user opens a workspace or
 * quits (or reconnect ultimately gives up — see attemptReconnect()). `tree`
 * frames arrive from OUTSIDE React (the /subscribe event callback) and are
 * pushed into frameStore, which App.tsx reads via `useSyncExternalStore` —
 * see the file header for why this replaced a per-frame `instance.rerender()`.
 */
function runPickerOnce(options: RunTuiOptions): Promise<PickerOutcome> {
  let settleOnce: (outcome: PickerOutcome) => void = () => {}
  let settled = false

  // Mutable holder: onOpen/onQuit (wired once into the single <App> mount
  // below) must always close whichever subscription is CURRENTLY live, which
  // changes across reconnect attempts — a plain `const subscription` (the
  // pre-reconnect shape) would go stale after the first resubscribe.
  let currentSubscription: Subscription | null = null

  // STUCK-CONNECTING GAP — HANDLED IN socket-client.ts, NOT HERE (companion
  // bug to the 300s server-side kill this whole fix addresses): before this
  // fix, "connecting…" had no timeout at all — if the first frame simply
  // never arrived (a wedged server that accepts the socket but never sends
  // response headers), the user saw an unexplained, permanently frozen
  // "Connecting to Orpheus…" with no way to tell it apart from a slow-but-
  // working connect, and `subscribe()`'s own `timeoutMs: 0` disabled its
  // ONLY client-side timer entirely (it covered both connection
  // establishment AND the live stream as one deadline). Fixed at the root:
  // socket-client.ts's `subscribe()` now arms a separate, always-on
  // CONNECTION_ESTABLISHMENT_TIMEOUT_MS guard whenever `timeoutMs === 0`,
  // independent of the stream's own unbounded lifetime — see that file's
  // "ESTABLISHMENT VS STREAM DEADLINE" doc comment. A wedged/never-responds
  // connection now surfaces as a rejected `sub.done` through the EXACT SAME
  // path as any other unexpected disconnect (handleUnexpectedEnd below),
  // which already drives attemptReconnect()/connectionStore — so there is
  // only ONE state machine handling both "never connected" and "connection
  // dropped mid-session", not two independently racing mechanisms. No
  // separate App.tsx-level timer needed.
  const onEvent = (evt: unknown): void => {
    if (!isTreeFrame(evt)) return
    applyFrame(evt)
  }

  /**
   * Open one subscribe() attempt and wire its `done` settlement to either
   * resolve the picker (user-initiated close) or trigger a reconnect
   * (unexpected end). Returns the new Subscription so the caller can stash
   * it as `currentSubscription`.
   *
   * RECONNECT ATTEMPTS MUST NOT THROW UNCAUGHT (unlike the FIRST subscribe of
   * the process — see the file header's "CONNECTION REUSE" note): a thrown
   * AppNotRunningError here must be caught and treated as "this attempt
   * failed, schedule another backoff retry", not propagate up through
   * runTui()'s promise into cli.ts's autoLaunch flow (that flow exists for
   * the FIRST invocation of the CLI, not a mid-session reconnect).
   */
  function openSubscription(): Subscription {
    const sub = subscribe({ tree: true, timeoutMs: 0 }, onEvent, { timeoutMs: 0 })
    sub.done
      .then(() => {
        if (!settled) handleUnexpectedEnd(null)
      })
      .catch((err: unknown) => {
        if (!settled) handleUnexpectedEnd(err)
      })
    return sub
  }

  /**
   * The connection ended WITHOUT us asking for it (see the two cases
   * documented at the original call site below). Instead of settling
   * immediately, kick off the backoff-paced reconnect loop.
   */
  function handleUnexpectedEnd(err: unknown): void {
    if (err == null) {
      process.stderr.write('orpheus: connection to Orpheus closed; attempting to reconnect…\n')
    } else {
      const detail = errorMessage(err)
      process.stderr.write(
        `orpheus: lost connection to Orpheus: ${detail}; attempting to reconnect…\n`
      )
    }
    void attemptReconnect(1)
  }

  /**
   * Reconnect loop: wait `nextBackoffMs(attempt)`, then try to resubscribe.
   * No cap on the number of attempts — a phone losing signal in a tunnel for
   * ten minutes and then regaining it is exactly the scenario this exists
   * for, and the backoff is capped at 30s per attempt so a long outage just
   * settles into periodic retries rather than spinning. The user can still
   * quit at any time: `<App>`'s useInput (`q`/escape) stays wired to
   * onQuit for the whole reconnect loop's duration since the component never
   * unmounts here (only runPickerOnce's returned promise is pending).
   *
   * REVISION GUARD RESET (see file header, tui/frameStore.ts's applyFrame):
   * resetFrame() is called before EVERY reconnect subscribe, not just the
   * very first one at the top of runPickerOnce. A fresh connection may
   * legitimately start numbering revisions lower than what was last seen
   * (e.g. the Orpheus app itself restarted and its in-memory revision
   * counter reset) — without this reset, applyFrame's `revision <=
   * lastRevision` guard would silently drop every frame from the new
   * connection forever, leaving the picker frozen on stale data with no
   * visible sign anything is wrong. Strictly worse than the bug being fixed.
   */
  async function attemptReconnect(attempt: number): Promise<void> {
    if (settled) return
    setConnectionNotice(`Reconnecting to Orpheus… (attempt ${attempt})`)
    const delay = nextBackoffMs(attempt)
    await new Promise<void>((r) => setTimeout(r, delay))
    if (settled) return

    resetFrame() // see doc comment above — must happen before the resubscribe
    try {
      currentSubscription = openSubscription()
      // Attempt "succeeded" in the sense that a request was issued without
      // throwing synchronously; socket-client.ts's `subscribe()` returns
      // immediately and connects on process.nextTick, so genuine transport
      // failures still surface later via `sub.done` rejecting, which
      // handleUnexpectedEnd() above will route back into another
      // attemptReconnect() call (attempt + 1). Clear the notice optimistically
      // once we're not immediately erroring here; a frame arriving is the
      // real "fully recovered" signal and clears the notice again via
      // frameStore's own render path (connectionNotice just stops gating
      // the UI once null).
      setConnectionNotice(null)
    } catch (err) {
      // AppNotRunningError (or anything else) from a RECONNECT attempt must
      // not crash the process — see this function's doc comment.
      void err
      void attemptReconnect(attempt + 1)
    }
  }

  const node = React.createElement(App, {
    scope: options.scope,
    onOpen: (workspaceId: string) => {
      currentSubscription?.close()
      settleOnce({ type: 'open', workspaceId })
    },
    onQuit: () => {
      currentSubscription?.close()
      settleOnce({ type: 'quit' })
    }
  })

  // Start clean: a previous loop iteration (returning here after a tmux
  // detach) must not flash the last-known frame from before this
  // subscription existed.
  resetFrame()
  setConnectionNotice(null)

  // No client- or server-side timeout — the picker stays open indefinitely
  // until the user acts. `timeoutMs: 0` must be in BOTH places: the `opts`
  // arg (3rd param) only controls socket-client.ts's own local
  // connection-establishment timer; the request BODY's `timeoutMs: 0` (1st
  // param, `payload`) is what commandServer.ts's parseSubscribeRequestBody
  // actually reads to resolve the server-side stream deadline (see
  // subscribeTimeout.ts) — omitting it from the payload was the root cause
  // of the 300s server-side kill this fix addresses; the two are otherwise
  // independent knobs that happen to want the same value here. May throw
  // AppNotRunningError synchronously; see the file header for why that's
  // intentionally left uncaught here (first call only — see
  // attemptReconnect() above for why RECONNECT calls must NOT let that
  // propagate the same way).
  currentSubscription = openSubscription()

  // Mount immediately, before the first frame lands — App.tsx renders its
  // own "connecting…" state for a null store snapshot.
  //
  // alternateScreen: true keeps the picker's redraws off the user's normal
  // terminal scrollback (same buffer-swap behavior `tmux attach` itself
  // uses) and cuts redraw traffic over SSH. UNVERIFIED specifically on
  // Termius (iOS) — if it misbehaves on-device (garbled restore, blank
  // screen on detach), this is the one line to flip back to `false`.
  //
  // exitOnCtrlC: false — Ink's default (true) calls process.exit() on Ctrl-C
  // internally, bypassing this function's own onQuit-driven cleanup
  // (currentSubscription?.close(), the `settleOnce`/`.finally()` unmount +
  // waitUntilExit() sequence below). The OpenTUI reference build
  // (tui-otui/entry.ts) made the same choice for the same reason: quit is
  // handled entirely by the app's own q/escape keys (see App.tsx's
  // useInput), which already call onQuit -> settleOnce, so Ctrl-C hitting a
  // hard process.exit() instead would skip subscription teardown and the
  // unmount/waitUntilExit ordering this file relies on to leave the
  // terminal in a clean state. Ctrl-C fed through App.tsx's own useInput as
  // a plain keypress is a no-op there today (no explicit handler for it),
  // which matches Ink's own non-raw-mode terminal behavior of doing nothing
  // for keys it doesn't recognize — not a regression, since q/escape remain
  // the documented quit keys (see Footer.tsx/HelpOverlay.tsx).
  const instance: Instance = render(node, { alternateScreen: true, exitOnCtrlC: false })

  return new Promise<PickerOutcome>((resolve) => {
    settleOnce = (outcome) => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
  }).finally(async () => {
    setConnectionNotice(null)
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

  // HAND STDIN OVER COMPLETELY BEFORE SPAWNING TMUX.
  //
  // `stdio: 'inherit'` shares the fd, it does not transfer ownership: Ink put
  // stdin in raw mode and left Node's reader flowing, so with the picker
  // unmounted but the stream still resumed, Node kept consuming keypresses
  // that were meant for tmux. Typing inside an attached workspace did
  // nothing, and tmux — reading a stream whose bytes another reader had
  // already taken — would exit, dropping the user straight back to the
  // picker. (Ink's own unmount does not undo this: the process, not the
  // component, owns the stream.)
  //
  // Pausing the stream and clearing raw mode leaves the fd untouched for the
  // child while stopping Node from racing it for input. Both are restored
  // afterwards so the next picker iteration starts from the same state it
  // would have had.
  const stdin = process.stdin
  const hadRawMode = stdin.isTTY === true && stdin.isRaw === true
  if (stdin.isTTY === true) stdin.setRawMode(false)
  stdin.pause()

  try {
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
  } finally {
    // finally, not after the await: an attach that throws must not leave
    // stdin paused, or the picker would render but ignore every keypress.
    if (stdin.isTTY === true) stdin.setRawMode(hadRawMode)
    stdin.resume()
  }
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
