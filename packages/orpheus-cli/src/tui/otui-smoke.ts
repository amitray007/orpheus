/**
 * tui/otui-smoke.ts — standalone packaging smoke test for the Bun + OpenTUI
 * runtime, NOT part of the shipping `orpheus tui` command.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM tui/entry.ts
 * -----------------------------------------------------------------------
 * `orpheus tui` (tui/entry.ts, bundled to dist/tui.mjs) is an Ink/React
 * application that runs under Node/Electron-as-Node — see cli.ts's dynamic
 * import() and the "WHY dist/tui.mjs IS ESM" note in commands/tui.ts. The
 * OpenTUI rebuild of that picker has not landed yet; nothing in this package
 * imports @opentui/core today.
 *
 * @opentui/core's native rendering backend loads its dylib via `node:ffi`,
 * which does not exist on Node 22 / Electron 39 — it only works under Bun.
 * So shipping OpenTUI means the packaged app must carry its OWN Bun binary
 * (see scripts/fetch-bun.sh) and exec it for anything OpenTUI-based, with
 * OTUI_ASSET_ROOT pointed at the relocated native dylib (see
 * scripts/package-tui-assets.mjs and resources/bin/orpheus's `__otui-smoke`
 * branch).
 *
 * This script exists purely to PROVE that pipeline end-to-end (bundled Bun +
 * relocated dylib + OTUI_ASSET_ROOT resolution) before any real OpenTUI UI
 * exists to build against. It is intentionally NOT wired into cli.ts's
 * command registry — there is no `orpheus otui-smoke` user-facing command.
 * It is invoked directly by resources/bin/orpheus's `__otui-smoke` internal
 * branch for packaging verification, and by whoever does the real OpenTUI
 * rebuild as a starting point for the actual renderer entry point.
 *
 * What it does: initializes a real CliRenderer (which forces
 * @opentui/core's native dylib to load — the exact codepath the shipping
 * TUI will need), draws one frame containing visible text, waits one paint
 * tick, then destroys the renderer and exits 0. A cryptic
 * "Cannot find module '@opentui/core-darwin-arm64'" error at this point
 * means OTUI_ASSET_ROOT / the packaged dylib is missing or misconfigured —
 * that failure mode is exactly what this script is built to surface.
 *
 * BUILD: bundled by "build:cli:tui:otui-smoke" in the root package.json to
 * packages/orpheus-cli/dist/tui-otui-smoke.mjs, run directly via
 * `bun dist/tui-otui-smoke.mjs` (or through the shim's `__otui-smoke`
 * branch). @opentui/core is bundled in (unlike Ink's react-devtools-core
 * externalization) but its own platform-specific native package
 * (`@opentui/core-darwin-arm64`) is left external — it must stay a real
 * runtime import so OTUI_ASSET_ROOT's asset-root short-circuit (checked
 * BEFORE the bare-specifier import) has a chance to run at all.
 */

import { createCliRenderer, TextRenderable } from '@opentui/core'

const SMOKE_TEXT = 'orpheus otui-smoke: OpenTUI renderer OK'

async function main(): Promise<void> {
  const renderer = await createCliRenderer({
    stdin: process.stdin,
    stdout: process.stdout,
    exitOnCtrlC: false,
    targetFps: 30
  })

  try {
    const label = new TextRenderable(renderer, {
      id: 'otui-smoke-label',
      content: SMOKE_TEXT
    })
    renderer.root.add(label)
    renderer.requestRender()

    // Give the native backend one paint tick to actually draw the frame
    // before we tear down — proves the renderer is live, not just constructed.
    await new Promise((resolve) => setTimeout(resolve, 200))
  } finally {
    renderer.destroy()
  }

  // Signal success on stdout for scripted/offline verification (stdout is
  // the terminal buffer while the renderer is alive, but by the time we
  // reach here destroy() has torn down alternate-screen mode).
  console.log(`${SMOKE_TEXT}: rendered and exited cleanly`)
}

main().catch((err: unknown) => {
  console.error('otui-smoke failed:', err instanceof Error ? (err.stack ?? err.message) : err)
  process.exit(1)
})
