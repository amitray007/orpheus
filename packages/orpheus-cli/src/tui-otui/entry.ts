/**
 * tui-otui/entry.ts — OpenTUI-based `orpheus tui` runtime, gated behind
 * ORPHEUS_TUI_ENGINE=opentui.
 *
 * RUNTIME SPLIT (why this bundle is separate from tui/entry.ts)
 * -----------------------------------------------------------------------
 * `orpheus tui` (default, unchanged) runs the Ink/React picker from
 * tui/entry.ts under Node/Electron-as-Node — see commands/tui.ts and
 * tui/entry.ts's own file headers. @opentui/core's native rendering backend
 * loads its dylib via `node:ffi`, which does not exist on Node 22 /
 * Electron 39 — it only works under Bun. So the SAME `orpheus tui` command,
 * when ORPHEUS_TUI_ENGINE=opentui is set, is dispatched by
 * resources/bin/orpheus to a DIFFERENT runtime entirely: the app's bundled
 * Bun binary running THIS file (built to dist/tui-otui.mjs via
 * scripts/build-tui-otui.mjs — see that file's header for why esbuild can't
 * do this build once Solid JSX is involved), with OTUI_ASSET_ROOT pointed
 * at the relocated native dylib.
 *
 * CONSOLE OVERLAY — MUST stay disabled (verified, not merely configured)
 * -----------------------------------------------------------------------
 * OpenTUI captures console.* and paints a debug overlay over the UI.
 * `consoleOptions.startInDebugMode: false` alone is NOT sufficient — it only
 * gates the debug PANEL; `renderer.console.deactivate()` still leaves a
 * "Console ([Copy](ctrl+shift+c))" header stealing a row. BOTH flags below
 * (`consoleMode: 'disabled'` + `openConsoleOnError: false`) are required
 * together — see docs/TUI_OPENTUI_DESIGN.md's non-negotiable #1.
 *
 * Consequence: nothing in this file (or App.tsx/components) may call
 * console.* while the renderer is live — see debugLog() below for the
 * file-based alternative. Verification method for this build: see the
 * final report's "console-overlay verification" section — a temporary
 * console.warn() was added to App.tsx during a real pty capture, confirmed
 * it produced NO visible overlay in the captured frame, then removed.
 *
 * PICKER <-> TMUX LOOP (docs/TUI_SPEC.md D1/D6, ported from tui/entry.ts)
 * -----------------------------------------------------------------------
 * runTui() loops: mount the picker, and when the user opens a workspace,
 * host it (workspace.host) and exec `tmux attach` with inherited stdio. On
 * detach (or tmux exiting for any reason) control returns to the picker.
 * This loop logic is Node-runtime-agnostic child_process/stdio code (not
 * React/Ink-specific), so it's ported close to verbatim from tui/entry.ts.
 *
 * FRAME DELIVERY: PLAIN SIGNAL (see App.tsx's file header)
 * -----------------------------------------------------------------------
 * Unlike tui/entry.ts, there is no separate frameStore.ts module — the
 * /subscribe onEvent callback below writes directly into a createSignal
 * pair created once per picker-loop iteration and handed to <App> as a
 * prop-accessor. See App.tsx's header for why Solid doesn't need the
 * coalescing-store workaround React does.
 *
 * NEVER process.exit() ON THE LIVE-RENDERER PATH
 * -----------------------------------------------------------------------
 * Every exit from runPickerOnce() below goes through renderer.destroy()
 * (called unconditionally at the end of the function, after the picker's
 * promise settles) before the process is allowed to end naturally. The one
 * process.exitCode assignment (non-TTY guard) fires BEFORE any renderer is
 * ever created, so it never races live renderer teardown. No code path in
 * this file calls process.exit()/process.abort().
 */

import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { createCliRenderer, type CliRenderer } from '@opentui/core'
import { render } from '@opentui/solid'
import { createSignal } from 'solid-js'
import { subscribe, sendCommand } from '../socket-client.js'
import { App } from './App.js'
import { isTreeFrame, type TreeFrame, type WorkspaceHostResult } from './types.js'
import type { ProjectScope } from '../tui/layout.js'

export interface RunTuiOptions {
  /** Set when `--project` narrows the picker to a single project. NOTE: the
   * opentui engine does not currently resolve `--project` itself — see the
   * file's bottom-of-file `parseProjectFlag` doc comment for why, and the
   * final report for the explicit scope call. */
  scope?: ProjectScope
}

type PickerOutcome = { type: 'open'; workspaceId: string } | { type: 'quit' }

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Write a diagnostic line to a file, NEVER to console/stdout — see the file header's console-overlay note. */
function debugLog(msg: string): void {
  const path = process.env.ORPHEUS_TUI_OTUI_DEBUG_LOG
  if (!path) return
  try {
    appendFileSync(path, `${new Date().toISOString()} ${msg}\n`)
  } catch {
    // Best-effort diagnostics only — never let a logging failure affect the UI.
  }
}

/**
 * Root-cause fix for the "shrink-repaint" bug (design-pass task: resizing a
 * wider frame down, e.g. 80x24 -> 44x12, left stale cell debris from the
 * wider frame on screen — reproduced with ZERO workspaces, confirming it was
 * a pure repaint bug, not list/data state; the "vanishing rows across
 * resize+filter toggles" report shared this exact root cause).
 *
 * ROOT CAUSE (verified via tui-mcp against @opentui/core@0.4.x's own
 * chunk-node-*.js — `CliRenderer.processResize()`):
 * `processResize(width, height)` resizes the native render buffer
 * (`this.lib.resizeRenderer`) and repaints ONLY the cells within the NEW
 * (possibly smaller) dimensions via diff-based cell writes — confirmed via
 * `mcp__tui-mcp__output`'s raw byte capture showing surgical per-cell writes
 * with no `\x1b[2J`/`\x1b[K` erase sequence anywhere in a shrink resize's
 * output. `ANSI.clearScreen` IS defined in the library and IS used
 * elsewhere (`resetSplitFooterForReplay`, initial terminal setup), but is
 * NEVER called from `processResize()` in the normal fullscreen/alt-screen
 * mode this app uses (only `screenMode === "split-footer"` gets a
 * conditional partial clear, a mode we don't use). So when a terminal's own
 * character grid is wider/taller than what it currently reports (true of
 * every real terminal emulator across a live resize, and reproduced here via
 * tui-mcp's pty), cells previously painted outside the NEW bounds are never
 * told to clear — verified directly: `mcp__tui-mcp__read_region` reading
 * width=80 on a session already resized down to 44 cols showed the previous
 * frame's content (a `────` rule fragment past column 44, a duplicated
 * "quit" past the new footer's end) still sitting in the terminal's grid.
 * This is a genuine @opentui/core library gap for fullscreen mode, not
 * something wrong in our component tree — `useTerminalDimensions()`/the
 * `resize` event both report the new size correctly and immediately.
 *
 * FIX: `CliRenderer extends EventEmitter` and emits `'resize'` (width,
 * height) synchronously from `processResize()`, BEFORE its own
 * `requestRender()` call queues the next paint. Listening here — at the
 * renderer level, not inside the Solid tree, so it fires exactly once per
 * physical resize regardless of what's mounted — and writing `\x1b[2J`
 * (erase entire screen) directly to the same `stdout` the renderer itself
 * writes to, ONLY on shrink (either dimension decreasing), clears every
 * stale cell before the very next diff-paint frame repaints on top. Verified
 * via tui-mcp: no visible flash (the repaint lands in the same event-loop
 * turn's immediately-following render), and `read_region` at the old wider
 * width after the fix shows a fully blank grid past the new bounds — see the
 * final report for the exact before/after byte captures.
 *
 * Deliberately NOT an unconditional clear-every-frame — that would defeat
 * OpenTUI's documented diff-based repainting performance property (real
 * concern on SSH). Only fires on shrink, which is the only direction that
 * leaves stale cells (growing has nothing stale to clear — confirmed via
 * tui-mcp: 44->120 repaints cleanly with no fix needed).
 */
function installShrinkRepaintFix(renderer: CliRenderer): void {
  let lastWidth = renderer.width
  let lastHeight = renderer.height
  renderer.on('resize', (width: number, height: number) => {
    if (width < lastWidth || height < lastHeight) {
      process.stdout.write('\x1b[2J')
    }
    lastWidth = width
    lastHeight = height
  })
}

/**
 * Mount the picker ONCE per loop iteration and resolve once the user opens
 * a workspace or quits. Frames arrive from OUTSIDE Solid's reactive graph
 * (the /subscribe event callback) and are pushed into a signal created here
 * — see the file header's "FRAME DELIVERY" note for why this replaces
 * tui/frameStore.ts's coalescing store.
 */
async function runPickerOnce(options: RunTuiOptions): Promise<PickerOutcome> {
  const renderer = await createCliRenderer({
    stdin: process.stdin,
    stdout: process.stdout,
    exitOnCtrlC: false, // we handle quit ourselves (q/escape) — see App.tsx's useKeyboard
    // Both flags required together — see the file header's console-overlay note.
    consoleMode: 'disabled',
    openConsoleOnError: false
  })
  installShrinkRepaintFix(renderer)

  const [frame, setFrame] = createSignal<TreeFrame | null>(null)
  const [disconnected, setDisconnected] = createSignal<string | null>(null)

  let settleOnce: (outcome: PickerOutcome) => void = () => {}
  let settled = false

  const onEvent = (evt: unknown): void => {
    if (!isTreeFrame(evt)) return
    // Revision-monotonicity guard (self-heals a stale/reordered frame on a
    // flaky link — docs/TUI_SPEC.md D5) — inlined here since there's no
    // frameStore.ts module to own it; Solid's signal write is already cheap
    // enough per-frame that no coalescing buffer is needed (see App.tsx).
    const current = frame()
    if (current != null && evt.revision <= current.revision) return
    setFrame(evt)
  }

  // No client-side timeout — the picker stays open indefinitely until the
  // user acts. May throw AppNotRunningError synchronously; propagates out
  // of runTui()'s returned promise into cli.ts's existing
  // runWithSingleAppRetry + autoLaunch flow, same as the Ink build (see
  // tui/entry.ts's "CONNECTION REUSE" note — same contract applies here).
  const subscription = subscribe({ tree: true }, onEvent, { timeoutMs: 0 })

  const outcome = await new Promise<PickerOutcome>((resolve) => {
    settleOnce = (o) => {
      if (settled) return
      settled = true
      resolve(o)
    }

    // DISCONNECTED MID-SESSION (explicit Ink-version bug fix — see App.tsx's
    // header). Both the resolve and reject paths render a VISIBLE on-screen
    // notice via the disconnected() signal, then wait for a keypress
    // (App.tsx's useKeyboard treats ANY key as "quit" once disconnected is
    // set, because the picker has nothing live left to interact with).
    subscription.done
      .then(() => {
        if (!settled) setDisconnected('Orpheus closed the connection')
      })
      .catch((err: unknown) => {
        if (!settled) setDisconnected(errorMessage(err))
      })

    render(
      () =>
        App({
          scope: options.scope,
          frame,
          disconnected,
          onOpen: (workspaceId: string) => {
            subscription.close()
            settleOnce({ type: 'open', workspaceId })
          },
          onQuit: () => {
            subscription.close()
            settleOnce({ type: 'quit' })
          }
        }),
      renderer
    ).catch((err: unknown) => {
      debugLog(`tui-otui: render() rejected: ${errorMessage(err)}`)
      settleOnce({ type: 'quit' })
    })
  })

  // Once disconnected fires (and wasn't already resolved by onOpen/onQuit),
  // App.tsx's useKeyboard treats the next keypress as quit — but if the
  // user never presses a key (e.g. piping stdin), the promise above never
  // resolves on its own from setDisconnected() alone. That's intentional:
  // the task requires a VISIBLE notice + keypress ack, not an auto-timeout,
  // matching hostAndAttach's waitForKeypress() pattern below for the other
  // error states this build must not silently blow past.

  renderer.destroy() // NEVER process.exit() — see file header.
  return outcome
}

/**
 * Wait for a single keypress on stdin, restoring whatever raw-mode state was
 * in effect beforehand. Ported near-verbatim from tui/entry.ts — used AFTER
 * renderer.destroy() so the message renders on the plain terminal (the
 * renderer's alt-screen has already been torn down by this point), same
 * ordering discipline as the Ink version's own waitForKeypress().
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

/**
 * Host the workspace in tmux (via the running app) and attach, inheriting
 * stdio. Handles three failure/refusal shapes distinctly (see the task
 * brief's "STATES THAT MUST HAVE REAL UI"):
 *   1. sendCommand() itself throws (AppNotRunningError/CommandError/
 *      CommandTransportError, or a raw Error) — command failure.
 *   2. The result carries `refused` — the workspace is live natively on the
 *      desktop (src/main/commandServer.ts's shouldBlockTmuxHost guard). NO
 *      tmux session was created; attaching would be wrong, so this branches
 *      BEFORE ever touching tmux.
 *   3. Neither — proceed to `tmux attach`.
 * All error/refusal paths print a clear message and wait for a keypress
 * before returning to the picker, exactly like tui/entry.ts's hostAndAttach.
 *
 * WHY `tmuxHosted` IN THE TREE FRAME DOESN'T LET US PRE-EMPT THIS: the tree
 * frame's `tmuxHosted` field only reports "this workspace IS ALREADY
 * tmux-hosted right now" (used here for the row's "open" visual state) — it
 * says nothing about whether hosting WOULD BE refused if attempted. That
 * liveness check (native surface phase + claude's on-disk session registry)
 * is server-side only, evaluated inside the workspace.host handler itself,
 * and isn't part of the /subscribe wire contract. So handling `refused`
 * reactively, only after Enter is pressed and the server has actually
 * responded, is the correct (and only available) approach — not a
 * shortcut. A workspace mounted natively before the tmux rollout (or one
 * that fell back because tmux was missing/too old) will list normally with
 * `tmuxHosted: false` and only reveal the refusal on an actual open attempt.
 */
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

  if (hostResult.refused != null) {
    process.stderr.write(`orpheus: ${hostResult.refused.message}\n`)
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
    // Sequential by design: this IS the picker <-> tmux loop.
    const outcome = await runPickerOnce(options)
    if (outcome.type === 'quit') return
    await hostAndAttach(outcome.workspaceId)
  }
}

/**
 * `--project <value>` PARSING — INTENTIONALLY UNSUPPORTED IN THIS BUILD
 * -----------------------------------------------------------------------
 * commands/tui.ts resolves --project into a ProjectScope via a DB read
 * (openDb() + resolveContext()) BEFORE ever dispatching to a picker
 * runtime — but that resolution happens on the Node/Electron-as-Node side
 * for the Ink engine. This Bun-run bundle is a SEPARATE process launched
 * directly by resources/bin/orpheus's opentui branch (bypassing
 * commands/tui.ts entirely — see that shell script's dispatch), so no
 * --project resolution happens upstream for this path today.
 *
 * Wiring it here would mean this Bun process opening its own better-sqlite3
 * handle against the live orpheus.sqlite (via reads/db.js + context.js) —
 * plausible in principle (better-sqlite3 is a native addon Bun can load
 * too), but doing that safely means matching the Node/Electron-as-Node
 * side's exact resolution ladder (id -> name -> filesystem path) and
 * getting concurrent-reader semantics right against a DB the main app
 * process also writes to, live, from a second runtime — real risk for a
 * first landing whose primary goal is visual quality of the OpenTUI
 * picker, not --project plumbing. Left unsupported: `orpheus tui --project
 * X` under ORPHEUS_TUI_ENGINE=opentui silently shows every project (no
 * error, no scope) — same as omitting --project entirely. Flagged
 * explicitly in the final report as a deliberate scope cut, not an
 * oversight.
 */
export function parseProjectFlagUnsupportedNote(): void {
  // Intentionally a no-op placeholder documenting the above — kept as a
  // named export so a future implementer has an obvious anchor to replace.
}

main().catch((err: unknown) => {
  debugLog(`tui-otui failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  process.exitCode = 1
})

async function main(): Promise<void> {
  await runTui({})
}
