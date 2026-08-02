#!/usr/bin/env node
/**
 * Stage runtime dependencies for tui-otui.mjs alongside the built bundle(s)
 * under packages/orpheus-cli/dist/. Two independent staging steps live here:
 *
 * 1. The OpenTUI native dylib, using the SAME relative layout OpenTUI's own
 *    OTUI_ASSET_ROOT resolver expects: <root>/@opentui/core-darwin-arm64/libopentui.dylib
 *    (see chunk-bun-t2myhmwd.js's resolveAssetRootPath — the asset key is
 *    `${packageName}/${fileName}`, i.e. "@opentui/core-darwin-arm64/libopentui.dylib").
 *
 * 2. A trimmed `node_modules/` tree containing `@opentui/core` (external per
 *    scripts/build-tui-otui.mjs's Bun.build() call — see that file's header
 *    for why it can't be bundled) plus its flat runtime dependencies, so the
 *    bare specifiers `@opentui/core` and `@opentui/core/testing` left in
 *    tui-otui.mjs can resolve at runtime via NODE_PATH even when there is no
 *    repo node_modules/ around (i.e. inside the packaged .app — see
 *    resources/bin/orpheus, which points NODE_PATH at this staged tree).
 *
 * Run as part of "build:cli:tui-otui" so a plain `bun run
 * build:cli:tui-otui` leaves a runnable local setup:
 *   OTUI_ASSET_ROOT=packages/orpheus-cli/dist \
 *   NODE_PATH=packages/orpheus-cli/dist/node_modules \
 *     vendor/bun/bun packages/orpheus-cli/dist/tui-otui.mjs
 *
 * electron-builder's `cli/` extraResources glob (electron-builder*.yml) is
 * updated separately to pick up both nested directories — its default filter
 * only copies `*.mjs` at the top level, which would silently miss a nested
 * dylib or node_modules tree.
 *
 * macOS-only, arm64-only: matches fetch-bun.sh / the rest of the Orpheus
 * build (Apple Silicon only, no Intel/Linux variant).
 */
import { cpSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_NODE_MODULES = resolve(projectRoot, 'node_modules')
const DIST_DIR = resolve(projectRoot, 'packages/orpheus-cli/dist')

// ---------------------------------------------------------------------------
// Step 1: OpenTUI native dylib (unchanged from before).
// ---------------------------------------------------------------------------

const SOURCE_DYLIB = resolve(REPO_NODE_MODULES, '@opentui/core-darwin-arm64/libopentui.dylib')
const DYLIB_DEST_DIR = resolve(DIST_DIR, '@opentui/core-darwin-arm64')
const DEST_DYLIB = join(DYLIB_DEST_DIR, 'libopentui.dylib')

if (!existsSync(SOURCE_DYLIB)) {
  console.error(
    `[package-tui-assets] missing ${SOURCE_DYLIB}\n` +
      '  Is @opentui/core installed? Run `bun install` first.'
  )
  process.exit(1)
}

mkdirSync(DYLIB_DEST_DIR, { recursive: true })
copyFileSync(SOURCE_DYLIB, DEST_DYLIB)

console.log(`[package-tui-assets] staged libopentui.dylib -> ${DEST_DYLIB}`)

// ---------------------------------------------------------------------------
// Step 2: trimmed node_modules tree for @opentui/core + its flat deps.
// ---------------------------------------------------------------------------
//
// tui-otui.mjs (see scripts/build-tui-otui.mjs) externalizes "@opentui/core"
// itself rather than bundling it. Two bare specifiers survive into the built
// bundle's import graph: "@opentui/core" and "@opentui/core/testing" (the
// latter pulled in transitively by @opentui/solid's bundled index.bun.js,
// which unconditionally imports createTestRenderer from it for its own
// test-helper export — dead code at runtime for us, but still part of the
// import graph Bun must resolve).
//
// Bun always execs the "bun" package-export condition (our shim always runs
// the bundled Bun binary), so only the bun-target files are needed:
// index.bun.js + its two bun chunks, plus testing.bun.js for the /testing
// subpath. index.node.js + chunk-node-*.js (~1.3MB) are dead weight for this
// runtime path. All *.map files (~5.3MB across the package) are devtools-only
// and never read at runtime. Verified by grepping the bun chunks for local
// relative-path requires: everything else under @opentui/core (assets/,
// lib/, platform/, plugins/, post/, renderables/, animation/, audio-stream/,
// testing/, tests/) is either TypeScript source/.d.ts (never imported at
// runtime) or reachable only through resolveAssetRootPath/
// resolveBundledFilePath's OTUI_ASSET_ROOT-gated lazy dynamic import()  —
// never required at module-load time. Those asset files (tree-sitter
// wasm/scm) are unrelated to this NODE_PATH fix and are not staged here.
//
// @opentui/core's package.json also declares 5 flat runtime dependencies
// (bun-ffi-structs, diff, marked, string-width, strip-ansi) that must be
// resolvable as siblings-of-ancestor the same way ordinary node_modules
// resolution works. string-width itself nests its own strip-ansi under
// string-width/node_modules/strip-ansi — preserved as-is so nested
// resolution keeps working if anything ever walks up through it.
//
// Do NOT stage @opentui/core-darwin-arm64 here — it's already shipped via
// the dylib-staging step above (Step 1) and OTUI_ASSET_ROOT already
// short-circuits before @opentui/core's platform-package import() fallback
// is ever reached (confirmed: resolveAssetRootPath returns before that
// import when OTUI_ASSET_ROOT is set, which our shim always does).

const NM_DEST = resolve(DIST_DIR, 'node_modules')

/** @type {(src: string) => boolean} */
function isExcludedFromCoreCopy(src) {
  if (src.endsWith('.map')) return true
  const base = src.split('/').pop() ?? ''
  if (base === 'index.node.js') return true
  if (/^chunk-node-.*\.js$/.test(base)) return true
  return false
}

/**
 * Copies a package directory into the staged node_modules tree, excluding
 * .map files (devtools-only, never read at runtime).
 * @param {string} pkgName - e.g. "diff" or "@opentui/core"
 * @param {(src: string) => boolean} [extraExclude]
 */
function stagePackage(pkgName, extraExclude) {
  const source = resolve(REPO_NODE_MODULES, pkgName)
  if (!existsSync(source)) {
    console.error(
      `[package-tui-assets] missing ${source}\n` +
        `  @opentui/core's runtime dependency "${pkgName}" is not installed.` +
        ' Run `bun install` first.'
    )
    process.exit(1)
  }
  const dest = resolve(NM_DEST, pkgName)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(source, dest, {
    recursive: true,
    filter: (src) => {
      if (src.endsWith('.map')) return false
      if (extraExclude && extraExclude(src)) return false
      return true
    }
  })
}

// Fresh start so stale files from a previous build never linger.
rmSync(NM_DEST, { recursive: true, force: true })

stagePackage('@opentui/core', isExcludedFromCoreCopy)
stagePackage('bun-ffi-structs')
stagePackage('diff')
stagePackage('marked')
stagePackage('string-width')
// string-width/node_modules/strip-ansi is copied as part of the string-width
// tree above (cpSync recursive covers nested node_modules); stage the
// top-level strip-ansi separately since @opentui/core also depends on it
// directly as a flat dependency.
stagePackage('strip-ansi')

console.log(`[package-tui-assets] staged trimmed node_modules -> ${NM_DEST}`)
