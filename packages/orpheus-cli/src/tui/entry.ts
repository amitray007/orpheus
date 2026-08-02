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
 */

import { spawn } from 'node:child_process'
import * as React from 'react'
import { render, type Instance } from 'ink'
import { subscribe, sendCommand } from '../socket-client.js'
import { App } from './App.js'
import { isTreeFrame, type TreeFrame, type WorkspaceHostResult } from './types.js'
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
 * Mount the picker and resolve once the user opens a workspace or quits.
 * `tree` frames are pushed into the already-mounted Ink instance via
 * `rerender` (not React state) since they arrive from OUTSIDE React, in the
 * /subscribe event callback.
 */
function runPickerOnce(options: RunTuiOptions): Promise<PickerOutcome> {
  let instance: Instance | null = null
  let lastRevision = -1

  const draw = (frame: TreeFrame | null): void => {
    const node = React.createElement(App, {
      frame,
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
    if (instance == null) {
      instance = render(node)
    } else {
      instance.rerender(node)
    }
  }

  const onEvent = (evt: unknown): void => {
    if (!isTreeFrame(evt)) return
    // Snapshots are applied wholesale by revision (D5) — a stale/older frame
    // (e.g. reordered on a flaky link) is simply ignored.
    if (evt.revision <= lastRevision) return
    lastRevision = evt.revision
    draw(evt)
  }

  // No client-side timeout — the picker stays open indefinitely until the
  // user acts. May throw AppNotRunningError synchronously; see the file
  // header for why that's intentionally left uncaught here.
  const subscription = subscribe({ tree: true }, onEvent, { timeoutMs: 0 })

  // Render the "connecting…" state immediately, before the first frame lands.
  draw(null)

  let settleOnce: (outcome: PickerOutcome) => void = () => {}

  return new Promise<PickerOutcome>((resolve) => {
    let settled = false
    settleOnce = (outcome) => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    // If the connection drops on its own (server closed, app quit
    // mid-session) treat it as "return to the caller" rather than hanging.
    subscription.done.catch(() => {}).then(() => settleOnce({ type: 'quit' }))
  }).finally(async () => {
    if (instance != null) {
      instance.unmount()
      await instance.waitUntilExit()
    }
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
