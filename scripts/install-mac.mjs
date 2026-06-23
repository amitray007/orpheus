#!/usr/bin/env node
/**
 * Install the built Orpheus .app bundle to /Applications/.
 *
 * Usage:
 *   node scripts/install-mac.mjs --dev     # dev  (dist-dev/ -> /Applications/Orpheus Dev.app)
 *   ORPHEUS_ALLOW_PROD_INSTALL=1 node scripts/install-mac.mjs   # prod (dist/ -> /Applications/Orpheus.app)
 *
 * Local development installs the DEV variant only. The production variant lives
 * exclusively in /Applications/Orpheus.app and is owned by the Homebrew cask /
 * CI release pipeline — never by a local build. Installing prod locally would
 * clobber that managed copy, so it is locked behind ORPHEUS_ALLOW_PROD_INSTALL=1
 * and must be invoked deliberately. The agent/build loop never sets this flag.
 */
import { execSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  console.log('[install-mac] skipping: not macOS')
  process.exit(0)
}

const isDev = process.argv.includes('--dev')

// Guard: prod local-install is opt-in only. Without the flag, refuse rather than
// overwrite the Homebrew/CI-managed /Applications/Orpheus.app. Dev installs are
// always allowed — they target the isolated /Applications/Orpheus Dev.app.
if (!isDev && process.env.ORPHEUS_ALLOW_PROD_INSTALL !== '1') {
  console.error(
    '[install-mac] refusing to install the PRODUCTION bundle locally.\n' +
      '  Production Orpheus.app is managed by Homebrew / CI — a local build must not clobber it.\n' +
      '  Use `bun run build:dev` (or `build:unpack`) to build + install Orpheus Dev.app instead.\n' +
      '  To override deliberately: ORPHEUS_ALLOW_PROD_INSTALL=1 bun run build:mac'
  )
  process.exit(1)
}
const tag = isDev ? '[install-mac-dev]' : '[install-mac]'
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = resolve(projectRoot, isDev ? 'dist-dev' : 'dist')

// Tell Spotlight to skip dist/ so the build-output .app doesn't appear
// alongside the real one in /Applications when searching.
if (existsSync(distDir)) {
  const marker = resolve(distDir, '.metadata_never_index')
  if (!existsSync(marker)) {
    closeSync(openSync(marker, 'w'))
  }
}

const findAppBundle = (dir) => {
  if (!existsSync(dir)) return null
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry)
    if (entry.endsWith('.app')) return full
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      const found = findAppBundle(full)
      if (found) return found
    }
  }
  return null
}

const appBundle = findAppBundle(distDir)
if (!appBundle) {
  console.error(`${tag} no .app found under ${distDir}. Did the build succeed?`)
  process.exit(1)
}

const appName = appBundle.split('/').pop()
const target = `/Applications/${appName}`

const isAppRunning = () => {
  try {
    execSync(`pgrep -fl "/Applications/${appName}/Contents/MacOS/"`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

if (existsSync(target) && isAppRunning()) {
  console.error(`${tag} ${appName} is currently running. Quit it (⌘Q) and re-run the build.`)
  process.exit(1)
}

try {
  // Sign node-pty's pty.node and spawn-helper individually BEFORE the bundle-level
  // re-sign. `codesign --deep` is documented as unreliable for bare Mach-O
  // executables (like spawn-helper) that are not inside a recognised nested
  // bundle — it may silently skip them, leaving them unsigned or with a stale
  // signature that fails at exec time ("claude won't start"). Pre-signing each
  // file explicitly is idempotent: --force overwrites any prior signature.
  const unpacked = `${appBundle}/Contents/Resources/app.asar.unpacked`
  const ptyNodePath = `${unpacked}/node_modules/@lydell/node-pty-darwin-arm64/prebuilds/darwin-arm64/pty.node`
  const spawnHelperPath = `${unpacked}/node_modules/@lydell/node-pty-darwin-arm64/prebuilds/darwin-arm64/spawn-helper`
  if (existsSync(ptyNodePath)) {
    console.log(`${tag} pre-signing pty.node (ad-hoc)`)
    execSync(`codesign --force --sign - "${ptyNodePath}"`, { stdio: 'inherit' })
    execSync(`codesign -vvv --verify "${ptyNodePath}"`, { stdio: 'pipe' })
  }
  if (existsSync(spawnHelperPath)) {
    console.log(`${tag} pre-signing spawn-helper (ad-hoc)`)
    execSync(`codesign --force --sign - "${spawnHelperPath}"`, { stdio: 'inherit' })
    execSync(`codesign -vvv --verify "${spawnHelperPath}"`, { stdio: 'inherit' })
  }

  // electron-builder's ad-hoc signing leaves inner frameworks with mismatched
  // Team IDs. macOS 15+ refuses to load them, so we re-sign the whole bundle
  // as one ad-hoc unit to normalise Team IDs across all components.
  console.log(`${tag} re-signing ${appBundle} (ad-hoc, unified Team IDs)`)
  execSync(`codesign --force --deep --sign - "${appBundle}"`, { stdio: 'inherit' })
  execSync(`codesign --verify --deep --strict "${appBundle}"`, { stdio: 'pipe' })

  if (existsSync(target)) {
    console.log(`${tag} removing existing ${target}`)
    rmSync(target, { recursive: true, force: true })
  }
  console.log(`${tag} installing ${appBundle} -> ${target}`)
  execSync(`/usr/bin/ditto "${appBundle}" "${target}"`, { stdio: 'inherit' })

  // Remove the build-output bundle so there's only ever one copy on disk
  // after install — avoids stale builds appearing in Spotlight / Finder.
  console.log(`${tag} cleaning ${distDir}`)
  rmSync(distDir, { recursive: true, force: true })

  console.log(`${tag} done. Open with: open "${target}"`)
} catch (err) {
  console.error(`${tag} failed: ${err.message}`)
  process.exit(1)
}
