#!/usr/bin/env bun
/**
 * scripts/build-tui-otui.mjs — builds packages/orpheus-cli/dist/tui-otui.mjs
 * from the Solid-based tui-otui/ picker.
 *
 * WHY Bun.build() INSTEAD OF esbuild (the tool every other build:cli:* script uses)
 * -----------------------------------------------------------------------
 * Solid's JSX compiler does a much deeper transform than React's automatic
 * JSX runtime (fine-grained reactive DOM-update calls, not a simple h()/jsx()
 * pragma swap) via a dedicated Babel-based plugin. @opentui/solid ships this
 * as `@opentui/solid/bun-plugin`, designed for Bun.build(), not esbuild —
 * esbuild has no equivalent hook for a full custom-JSX-to-reactive-calls
 * transform. So this ONE bundle (tui-otui.mjs) is built with Bun's own
 * bundler; every other packages/orpheus-cli bundle (cli.cjs, tui.mjs) stays
 * on bunx esbuild in package.json — no need to migrate those, they don't use
 * Solid JSX.
 *
 * Run standalone (`bun run scripts/build-tui-otui.mjs`) or via
 * `bun run build:cli:tui-otui`, which chains this with
 * scripts/package-tui-assets.mjs (native dylib staging) exactly as before —
 * that second step is UNCHANGED, only the bundling step swapped tools.
 *
 * WHY "@opentui/core" ITSELF IS EXTERNAL (not just its platform packages)
 * -----------------------------------------------------------------------
 * Verified the hard way: re-bundling @opentui/core's own code with
 * Bun.build() crashes at import time —
 *   TypeError: undefined is not an object (evaluating 'loadedPath.startsWith')
 *   at normalizeLoadedFilePath
 * — because @opentui/core ships a PRE-BUILT internal chunk
 * (lib/tree-sitter/parser.worker.js, pulled in unconditionally by
 * @opentui/solid's component catalogue for its <code>/<diff>/<line_number>
 * renderables, which OUR app never uses but can't opt out of importing)
 * containing a top-level `await resolveBundledFilePath(...)` whose inline
 * dynamic-import placeholder doesn't survive a SECOND bundler pass — the
 * re-bundled chunk's `.default` export comes back `undefined`. Reproduced
 * with a MINIMAL two-line `<text>hi</text>` Solid app (no app code of ours
 * involved) to confirm this is an @opentui/core/@opentui/solid bundling
 * incompatibility, not something introduced by this feature's components.
 * Running the UNBUNDLED source directly under `bun run --preload=
 * @opentui/solid/preload` works fine — confirming the bug is specific to
 * Bun.build() re-processing @opentui/core's own pre-built output.
 *
 * Fix: externalize "@opentui/core" itself (not just its per-platform native
 * packages). Bun then resolves it via its `bun` package-export condition
 * straight from node_modules at RUNTIME instead of inlining it — the exact
 * same resolution path that already works when running unbundled. This is
 * the same pattern this repo already uses for better-sqlite3 (external +
 * NODE_PATH-based resolution at runtime, see resources/bin/orpheus) rather
 * than a one-off hack.
 *
 * PACKAGING CONSEQUENCE: tui-otui.mjs is therefore NOT fully
 * self-contained — @opentui/core (and its transitive deps: yoga-layout,
 * web-tree-sitter, etc.) must be resolvable from node_modules alongside the
 * shipped bundle (e.g. via NODE_PATH, mirroring how cli.cjs's shim already
 * points NODE_PATH at app.asar.unpacked/node_modules for better-sqlite3).
 * Wiring that into resources/bin/orpheus / electron-builder*.yml is
 * EXPLICITLY OUT OF SCOPE for this landing (the task brief prohibits
 * touching resources/bin/orpheus beyond confirming --project passthrough,
 * and prohibits any production/package build) — flagged clearly in the
 * final report as follow-up packaging work, not silently glossed over.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import solidPlugin from '@opentui/solid/bun-plugin'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const result = await Bun.build({
  entrypoints: [resolve(projectRoot, 'packages/orpheus-cli/src/tui-otui/entry.ts')],
  outdir: resolve(projectRoot, 'packages/orpheus-cli/dist'),
  target: 'bun',
  format: 'esm',
  naming: 'tui-otui.mjs',
  // Matches the ACTUAL platform-package import specifiers @opentui/core's
  // bundled asset resolver uses internally (chunk-bun-*.js) — verified by
  // grepping the installed package rather than assumed. Note this differs
  // from the old esbuild command's list, which externalized a
  // "@opentui/core-windows-x64" specifier that the resolver never actually
  // imports (it's "win32-x64"/"win32-arm64") — a harmless-but-dead entry
  // under esbuild (unused externals are silently ignored), but Bun.build()
  // does not need it corrected to build successfully; it's fixed here
  // anyway so the list is accurate rather than cargo-culted.
  external: [
    '@opentui/core',
    '@opentui/core-darwin-arm64',
    '@opentui/core-darwin-x64',
    '@opentui/core-linux-x64',
    '@opentui/core-linux-x64-musl',
    '@opentui/core-linux-arm64',
    '@opentui/core-linux-arm64-musl',
    '@opentui/core-win32-x64',
    '@opentui/core-win32-arm64'
  ],
  plugins: [solidPlugin]
})

if (!result.success) {
  console.error('[build-tui-otui] build failed:')
  for (const message of result.logs) {
    console.error(message)
  }
  process.exit(1)
}

for (const output of result.outputs) {
  console.log(`[build-tui-otui] wrote ${output.path} (${output.kind})`)
}
