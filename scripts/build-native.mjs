#!/usr/bin/env node
// Build all native Node.js addons using node-gyp targeting the packaged Electron ABI.
// Add new addon packages to the TARGETS array.

import { execSync } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// Each entry is the path to a package dir that contains a binding.gyp.
const TARGETS = ['packages/ghostty-native']

// Electron version — read from the installed electron package.
const electronPkg = JSON.parse(
  (await import('fs')).default.readFileSync(
    resolve(ROOT, 'node_modules/electron/package.json'),
    'utf-8'
  )
)
const electronVersion = electronPkg.version
console.log(`[build-native] electron version: ${electronVersion}`)

// node-addon-api must be resolvable from ROOT for the node-gyp include.
// It is a transitive dep of electron-builder; confirm it's present.
let napiInclude
try {
  const { createRequire } = await import('module')
  const req = createRequire(import.meta.url)
  napiInclude = req('node-addon-api').include
  console.log(`[build-native] node-addon-api include: ${napiInclude}`)
} catch {
  // node-addon-api may not be installed; try to install it locally per package.
  console.warn('[build-native] node-addon-api not found at root — will attempt per-package install')
  napiInclude = null
}

let anyFailed = false

for (const target of TARGETS) {
  const pkgDir = resolve(ROOT, target)
  console.log(`\n[build-native] building ${target}`)

  // Ensure node-addon-api is present in the package if not at root.
  if (!napiInclude) {
    try {
      execSync('npm install node-addon-api --no-save', {
        cwd: pkgDir,
        stdio: 'inherit',
      })
    } catch {
      // ignore
    }
  }

  const cmd = [
    resolve(ROOT, 'node_modules/.bin/node-gyp'),
    'rebuild',
    `--target=${electronVersion}`,
    '--dist-url=https://electronjs.org/headers',
    '--arch=arm64',
    '--verbose',
  ].join(' ')

  console.log(`[build-native] $ ${cmd}`)
  try {
    execSync(cmd, { cwd: pkgDir, stdio: 'inherit' })
    console.log(`[build-native] ${target} OK`)
  } catch {
    console.error(`[build-native] ${target} FAILED`)
    anyFailed = true
  }
}

// Rust addon (terminal-vt-native) — built via napi-rs, not node-gyp.
// libghostty-vt port in progress; this addon is the future replacement for
// packages/ghostty-native. For now it's built alongside the legacy C++ addon.
const RUST_DIR = resolve(ROOT, 'packages/terminal-vt-native')
console.log(`\n[build-native] building packages/terminal-vt-native (napi-rs)`)
try {
  execSync('bun run build', { cwd: RUST_DIR, stdio: 'inherit' })
  console.log('[build-native] terminal-vt-native OK')
} catch {
  console.error('[build-native] terminal-vt-native FAILED')
  anyFailed = true
}

if (anyFailed) {
  process.exit(1)
}
