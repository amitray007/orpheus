#!/usr/bin/env node
/**
 * scripts/build-native.mjs
 *
 * Compiles all native Node addons in packages/ against Electron's ABI
 * before electron-builder packages the app.
 *
 * Usage (called automatically by "build:unpack"):
 *   node scripts/build-native.mjs
 *
 * Extensible: add more targets to the TARGETS array as new native
 * packages are introduced (e.g., the future ghostty-native addon).
 */
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')
const _require = createRequire(import.meta.url)

// Read Electron version from the installed package
const electronVersion = _require(resolve(projectRoot, 'node_modules/electron/package.json')).version
console.log(`[build-native] Electron version: ${electronVersion}`)

// List of native addon packages to build (relative to packages/)
const TARGETS = ['native-spike-zorder']

let failed = false

for (const target of TARGETS) {
  const pkgDir = resolve(projectRoot, 'packages', target)
  const bindingGyp = resolve(pkgDir, 'binding.gyp')

  if (!existsSync(bindingGyp)) {
    console.warn(`[build-native] ${target}: no binding.gyp found, skipping`)
    continue
  }

  console.log(`[build-native] Building ${target} for Electron ${electronVersion} arm64 …`)

  try {
    execSync(
      [
        'npx node-gyp rebuild',
        `--target=${electronVersion}`,
        '--dist-url=https://electronjs.org/headers',
        '--arch=arm64'
      ].join(' '),
      {
        cwd: pkgDir,
        stdio: 'inherit',
        env: { ...process.env }
      }
    )
    console.log(`[build-native] ${target}: ok`)
  } catch (err) {
    console.error(`[build-native] ${target}: FAILED — ${err.message}`)
    failed = true
  }
}

if (failed) {
  console.error('[build-native] One or more native addons failed to build. Aborting.')
  process.exit(1)
}

console.log('[build-native] All native addons built successfully.')
