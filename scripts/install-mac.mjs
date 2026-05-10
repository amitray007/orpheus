#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  console.log('[install-mac] skipping: not macOS')
  process.exit(0)
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = resolve(projectRoot, 'dist')

// Tell Spotlight to skip dist/ so the build-output Orpheus.app doesn't appear
// alongside the real one in /Applications when searching. The marker file
// applies to the whole tree below it; we drop it idempotently every install.
if (existsSync(distDir)) {
  const marker = resolve(distDir, '.metadata_never_index')
  if (!existsSync(marker)) {
    closeSync(openSync(marker, 'w'))
  }
}

function findAppBundle(dir) {
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
  console.error(`[install-mac] no .app found under ${distDir}. Did the build succeed?`)
  process.exit(1)
}

const appName = appBundle.split('/').pop()
const target = `/Applications/${appName}`

function isAppRunning() {
  try {
    execSync(`pgrep -fl "/Applications/${appName}/Contents/MacOS/"`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

if (existsSync(target) && isAppRunning()) {
  console.error(`[install-mac] ${appName} is currently running. Quit it (⌘Q) and re-run the build.`)
  process.exit(1)
}

try {
  // electron-builder's ad-hoc signing leaves the inner frameworks (Electron Framework,
  // Squirrel, Helpers, etc.) with mismatched Team IDs. macOS 15+ refuses to load
  // any framework whose Team ID doesn't match the loading process, so the app
  // crashes on launch with a "Library not loaded" dyld error and Finder shows the
  // misleading "check with the developer" Gatekeeper-style dialog. Re-signing the
  // whole bundle as one ad-hoc unit normalizes the Team IDs across components.
  console.log(`[install-mac] re-signing ${appBundle} (ad-hoc, unified Team IDs)`)
  execSync(`codesign --force --deep --sign - "${appBundle}"`, { stdio: 'inherit' })
  execSync(`codesign --verify --deep --strict "${appBundle}"`, { stdio: 'pipe' })

  if (existsSync(target)) {
    console.log(`[install-mac] removing existing ${target}`)
    rmSync(target, { recursive: true, force: true })
  }
  console.log(`[install-mac] installing ${appBundle} -> ${target}`)
  execSync(`/usr/bin/ditto "${appBundle}" "${target}"`, { stdio: 'inherit' })
  console.log(`[install-mac] done. Open with: open "${target}"`)
} catch (err) {
  console.error(`[install-mac] failed: ${err.message}`)
  process.exit(1)
}
