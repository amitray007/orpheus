#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  console.log('[install-mac-dev] skipping: not macOS')
  process.exit(0)
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = resolve(projectRoot, 'dist-dev')

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
  console.error(`[install-mac-dev] no .app found under ${distDir}. Did the build succeed?`)
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
  console.error(
    `[install-mac-dev] ${appName} is currently running. Quit it (⌘Q) and re-run the build.`
  )
  process.exit(1)
}

try {
  console.log(`[install-mac-dev] re-signing ${appBundle} (ad-hoc, unified Team IDs)`)
  execSync(`codesign --force --deep --sign - "${appBundle}"`, { stdio: 'inherit' })
  execSync(`codesign --verify --deep --strict "${appBundle}"`, { stdio: 'pipe' })

  if (existsSync(target)) {
    console.log(`[install-mac-dev] removing existing ${target}`)
    rmSync(target, { recursive: true, force: true })
  }
  console.log(`[install-mac-dev] installing ${appBundle} -> ${target}`)
  execSync(`/usr/bin/ditto "${appBundle}" "${target}"`, { stdio: 'inherit' })

  console.log(`[install-mac-dev] cleaning ${distDir}`)
  rmSync(distDir, { recursive: true, force: true })

  console.log(`[install-mac-dev] done. Open with: open "${target}"`)
} catch (err) {
  console.error(`[install-mac-dev] failed: ${err.message}`)
  process.exit(1)
}
