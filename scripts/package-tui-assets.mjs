#!/usr/bin/env node
/**
 * Stage the OpenTUI native dylib next to the built OpenTUI-based bundle(s)
 * under packages/orpheus-cli/dist/, using the SAME relative layout OpenTUI's
 * own OTUI_ASSET_ROOT resolver expects: <root>/@opentui/core-darwin-arm64/libopentui.dylib
 * (see chunk-bun-t2myhmwd.js's resolveAssetRootPath — the asset key is
 * `${packageName}/${fileName}`, i.e. "@opentui/core-darwin-arm64/libopentui.dylib").
 *
 * Run as part of "build:cli:tui:otui-smoke" so a plain `bun run
 * build:cli:tui:otui-smoke` leaves a runnable local setup:
 *   OTUI_ASSET_ROOT=packages/orpheus-cli/dist \
 *     vendor/bun/bun packages/orpheus-cli/dist/tui-otui-smoke.mjs
 *
 * electron-builder's `cli/` extraResources glob (electron-builder*.yml) is
 * updated separately to pick up this nested directory — its default filter
 * only copies `*.mjs` at the top level, which would silently miss a nested
 * dylib.
 *
 * macOS-only, arm64-only: matches fetch-bun.sh / the rest of the Orpheus
 * build (Apple Silicon only, no Intel/Linux variant).
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const SOURCE_DYLIB = resolve(
  projectRoot,
  'node_modules/@opentui/core-darwin-arm64/libopentui.dylib'
)
const DEST_DIR = resolve(projectRoot, 'packages/orpheus-cli/dist/@opentui/core-darwin-arm64')
const DEST_DYLIB = join(DEST_DIR, 'libopentui.dylib')

if (!existsSync(SOURCE_DYLIB)) {
  console.error(
    `[package-tui-assets] missing ${SOURCE_DYLIB}\n` +
      '  Is @opentui/core installed? Run `bun install` first.'
  )
  process.exit(1)
}

mkdirSync(DEST_DIR, { recursive: true })
copyFileSync(SOURCE_DYLIB, DEST_DYLIB)

console.log(`[package-tui-assets] staged libopentui.dylib -> ${DEST_DYLIB}`)
