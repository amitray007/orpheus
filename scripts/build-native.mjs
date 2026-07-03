#!/usr/bin/env node
// Build all native Node.js addons using node-gyp targeting the packaged Electron ABI.
// Add new addon packages to the TARGETS array.

import { execFileSync, execSync } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// Each entry is the path to a package dir that contains a binding.gyp.
const TARGETS = ['packages/ghostty-surface']

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
        stdio: 'inherit'
      })
    } catch {
      // ignore
    }
  }

  const gypBin = resolve(ROOT, 'node_modules/.bin/node-gyp')
  // Pass an explicit python3 so node-gyp does NOT create its temporary
  // `build/node_gyp_bins` PATH-shim symlink dir. On macOS 27 + node-gyp 12 that
  // dir's end-of-run cleanup races and throws an UNCAUGHT `ENOENT lstat
  // node_gyp_bins` (exit 7) even though compile+link fully succeeded.
  const pythonBin = process.env.PYTHON || process.env.npm_config_python || 'python3'
  const gypFlags = [
    `--target=${electronVersion}`,
    '--dist-url=https://electronjs.org/headers',
    '--arch=arm64',
    `--python=${pythonBin}`,
    '--verbose'
  ]

  try {
    // Step 1: clean + configure (generates the Makefile and build/ skeleton).
    console.log(`[build-native] $ node-gyp rebuild (clean+configure) ${gypFlags.join(' ')}`)
    execFileSync(gypBin, ['clean'], { cwd: pkgDir, stdio: 'inherit' })
    execFileSync(gypBin, ['configure', ...gypFlags], { cwd: pkgDir, stdio: 'inherit' })

    // Step 2: pre-create the .deps directory tree that clang's -MMD flag needs.
    // node-gyp's generated Makefile does NOT mkdir -p the .deps/ path before the
    // compile step, so the first compile fails with "No such file or directory"
    // when writing the .d.raw dependency tracking file.  Creating it here (after
    // configure has made the build/ skeleton) is the minimal fix.
    const { mkdirSync } = await import('fs')
    const depsDir = resolve(pkgDir, 'build/Release/.deps/Release/obj.target/ghostty_native')
    mkdirSync(depsDir, { recursive: true })
    console.log(`[build-native] pre-created .deps dir: ${depsDir}`)

    // Step 3: build (make). Force serial make (JOBS=1): even with the .deps dir
    // pre-created, parallel make can re-race on per-object dep dirs.
    console.log(`[build-native] $ node-gyp build ${gypFlags.join(' ')}`)
    execFileSync(gypBin, ['build', ...gypFlags], {
      cwd: pkgDir,
      stdio: 'inherit',
      env: { ...process.env, JOBS: '1' }
    })

    // Step 4: prune build intermediates, keeping ONLY the final .node. The
    // .deps/ and obj.target/ trees hold transient .o/.o.tmp/.d.raw files that
    // electron-builder's node_modules traversal walks into and intermittently
    // fails on ("ENOENT ... addon.o.d.raw" / ".../ghostty_native.node.d") when a
    // temp file vanishes mid-walk. Only build/Release/ghostty_native.node is
    // consumed downstream (package.json#main + electron-builder extraResources).
    const { rmSync, existsSync } = await import('fs')
    for (const sub of ['Release/.deps', 'Release/obj.target']) {
      const p = resolve(pkgDir, 'build', sub)
      if (existsSync(p)) rmSync(p, { recursive: true, force: true })
    }
    console.log(`[build-native] ${target} OK`)
  } catch {
    console.error(`[build-native] ${target} FAILED`)
    anyFailed = true
  }
}

if (anyFailed) {
  process.exit(1)
}
