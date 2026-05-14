#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  console.log('[install-tauri] skipping: not macOS')
  process.exit(0)
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const tauriAppRoot = resolve(scriptDir, '..')
const bundleDir = resolve(tauriAppRoot, 'target/release/bundle/macos')

const targetDir = resolve(tauriAppRoot, 'target')
if (existsSync(targetDir)) {
  const marker = resolve(targetDir, '.metadata_never_index')
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

const appBundle = findAppBundle(bundleDir)
if (!appBundle) {
  console.error(`[install-tauri] no .app found under ${bundleDir}. Did cargo tauri build succeed?`)
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
  console.log(`[install-tauri] ${appName} is running — quitting it first`)
  try {
    execSync(`osascript -e 'tell application "${appName.replace(/\.app$/, '')}" to quit'`, { stdio: 'pipe' })
  } catch {}
  for (let i = 0; i < 20 && isAppRunning(); i++) {
    execSync('sleep 0.25')
  }
  if (isAppRunning()) {
    console.log(`[install-tauri] graceful quit timed out — pkill`)
    try {
      execSync(`pkill -x "${appName.replace(/\.app$/, '')}"`, { stdio: 'pipe' })
    } catch {}
  }
}

try {
  // Tauri's ad-hoc signing leaves the inner frameworks (WebKit, JSC, embedded helpers)
  // with mismatched Team IDs across components. macOS 15+ refuses to load any
  // framework whose Team ID doesn't match the loading process. Re-signing the whole
  // bundle as one ad-hoc unit normalizes them. Mirrors the Electron-era fix.
  console.log(`[install-tauri] re-signing ${appBundle} (ad-hoc, unified Team IDs)`)
  execSync(`codesign --force --deep --sign - "${appBundle}"`, { stdio: 'inherit' })
  execSync(`codesign --verify --deep --strict "${appBundle}"`, { stdio: 'pipe' })

  if (existsSync(target)) {
    console.log(`[install-tauri] removing existing ${target}`)
    rmSync(target, { recursive: true, force: true })
  }
  console.log(`[install-tauri] installing ${appBundle} -> ${target}`)
  execSync(`/usr/bin/ditto "${appBundle}" "${target}"`, { stdio: 'inherit' })

  // Wipe the bundle output so there's only one Orpheus.app on disk and Spotlight
  // doesn't index a stale build. Matches the Electron install-mac.mjs behavior.
  console.log(`[install-tauri] cleaning ${bundleDir}`)
  rmSync(bundleDir, { recursive: true, force: true })

  console.log(`[install-tauri] done. Open with: open "${target}"`)
} catch (err) {
  console.error(`[install-tauri] failed: ${err.message}`)
  process.exit(1)
}
