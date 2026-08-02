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
 * Bun binary running THIS file (built to dist/tui-otui.mjs), with
 * OTUI_ASSET_ROOT pointed at the relocated native dylib so OpenTUI's asset
 * resolver doesn't fall back to a bare `import("@opentui/core-darwin-arm64")`
 * specifier — which Bun would try to auto-install from the npm registry,
 * failing hard offline (verified: fresh $HOME + unreachable registry +
 * OTUI_ASSET_ROOT unset -> "Cannot find module '@opentui/core-darwin-arm64'").
 *
 * This is intentionally the SAME command name and the SAME shim code path
 * that will carry production traffic once the real OpenTUI rebuild lands —
 * not a throwaway smoke test. When that rebuild is ready, the swap is
 * deleting the ORPHEUS_TUI_ENGINE default-off check (one line), not
 * rewiring a command. Keep this file's structure (renderer init, one
 * visible frame, keypress-driven quit, clean teardown) as the seed the real
 * picker grows into.
 *
 * CONSOLE OVERLAY — MUST stay disabled (verified, not merely configured)
 * -----------------------------------------------------------------------
 * OpenTUI captures console.* and paints a debug overlay over the UI.
 * `consoleOptions.startInDebugMode: false` alone is NOT sufficient — it only
 * gates the debug PANEL; `renderer.console.deactivate()` still leaves a
 * "Console ([Copy](ctrl+shift+c))" header stealing a row, which on a 12-row
 * phone-sized screen is 8% of the viewport gone. BOTH flags below are
 * required together. `openConsoleOnError: false` matters especially: its
 * default re-opens the overlay on error, exactly when the UI most needs to
 * stay readable.
 *
 * Consequence: nothing in this file (or anything it grows to include) may
 * call console.* while the renderer is live — see debugLog() below for the
 * file-based alternative, used only for the OFFLINE VERIFICATION SIGNAL
 * (deliberately written with node:fs AFTER renderer.destroy(), never to
 * stdout/console while the renderer owns the terminal).
 */

import { appendFileSync } from 'node:fs'
import { createCliRenderer, TextRenderable, type KeyEvent } from '@opentui/core'

const LABEL_TEXT = 'orpheus tui (opentui engine) — press q or esc to quit'

/** Write a diagnostic line to a file, NEVER to console/stdout — see the file header's console-overlay note. */
function debugLog(msg: string): void {
  const path = process.env.ORPHEUS_TUI_OTUI_DEBUG_LOG
  if (!path) return
  appendFileSync(path, `${new Date().toISOString()} ${msg}\n`)
}

async function main(): Promise<void> {
  const renderer = await createCliRenderer({
    stdin: process.stdin,
    stdout: process.stdout,
    exitOnCtrlC: true,
    // Both flags are required together — see the file header. Neither alone
    // fully suppresses the console overlay's terminal footprint.
    consoleMode: 'disabled',
    openConsoleOnError: false
  })

  const label = new TextRenderable(renderer, {
    id: 'otui-label',
    content: LABEL_TEXT
  })
  renderer.root.add(label)
  renderer.requestRender()

  await new Promise<void>((resolve) => {
    const quit = (): void => {
      renderer.keyInput.off('keypress', onKeypress)
      resolve()
    }
    function onKeypress(key: KeyEvent): void {
      if (key.name === 'q' || key.name === 'escape') {
        quit()
      }
    }
    renderer.keyInput.on('keypress', onKeypress)
  })

  renderer.destroy()
  debugLog('tui-otui: renderer destroyed, exiting cleanly')
}

main().catch((err: unknown) => {
  debugLog(`tui-otui failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  process.exitCode = 1
})
