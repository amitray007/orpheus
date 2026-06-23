import { app, BrowserWindow } from 'electron'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { getDb } from './db'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpdateCheckResult {
  current: string
  latest: string | null
  available: boolean
  checkedAt: number
  error?: string
}

// ---------------------------------------------------------------------------
// Brew path resolution
// ---------------------------------------------------------------------------

function findBrew(): string {
  for (const candidate of [
    '/opt/homebrew/bin/brew', // Apple Silicon default
    '/usr/local/bin/brew', // Intel default
    '/home/linuxbrew/.linuxbrew/bin/brew' // Linux
  ]) {
    if (existsSync(candidate)) return candidate
  }
  // Fallback: ask the login shell (slower, but works if brew is in a custom prefix)
  try {
    return execFileSync('/bin/zsh', ['-lc', 'which brew'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return 'brew' // last resort; will ENOENT if not found
  }
}

const BREW = findBrew()

// ---------------------------------------------------------------------------
// Broadcast helpers
// ---------------------------------------------------------------------------

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(channel, payload)
  }
}

// ---------------------------------------------------------------------------
// Tap refresh
// ---------------------------------------------------------------------------

function refreshTap(done: () => void): void {
  const repoChild = spawn(BREW, ['--repository', 'amitray007/homebrew-tap'], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  repoChild.on('error', () => done())

  let tapPath = ''
  repoChild.stdout.on('data', (chunk: Buffer) => (tapPath += chunk.toString()))
  // consume stderr to avoid pipe buffer blocks
  repoChild.stderr.on('data', () => {})

  repoChild.on('exit', (code) => {
    tapPath = tapPath.trim()
    if (code !== 0 || !tapPath || !existsSync(tapPath)) {
      done()
      return
    }
    const pullChild = spawn('git', ['-C', tapPath, 'pull', '--ff-only'], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    pullChild.on('error', () => done())
    // consume stdout/stderr to avoid pipe buffer blocks
    pullChild.stdout.on('data', () => {})
    pullChild.stderr.on('data', () => {})
    pullChild.on('exit', () => done())
  })
}

// ---------------------------------------------------------------------------
// Outdated check
// ---------------------------------------------------------------------------

function runOutdated(
  current: string,
  checkedAt: number,
  resolve: (r: UpdateCheckResult) => void
): void {
  // Use brew as the source of truth — it knows the tap's latest cask version
  // and whether the installed cask is outdated. Avoids polling the private
  // source repo's GitHub releases (which would need auth or always match).
  // NOTE: --fetch only pre-downloads the cask artifact; it does NOT pull new
  // cask definitions from the tap git repo. Tap refresh is done separately
  // via refreshTap() (a targeted git pull --ff-only) before this runs.
  const child = spawn(BREW, ['outdated', '--cask', 'orpheus', '--json', '--fetch'], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
  child.on('exit', (code) => {
    // brew outdated exits 1 when casks are outdated — that's not an error.
    // Only treat non-zero as an error when stdout is empty (real failure).
    if (code !== 0 && !stdout.trim()) {
      resolve({
        current,
        latest: null,
        available: false,
        checkedAt,
        error: `brew outdated exited ${code}: ${stderr.slice(0, 120)}`
      })
      return
    }
    try {
      const data = JSON.parse(stdout) as {
        casks?: { name: string; installed_versions: string; current_version: string }[]
      }
      const entry = (data.casks ?? []).find((c) => c.name === 'orpheus')
      if (entry) {
        resolve({ current, latest: entry.current_version, available: true, checkedAt })
      } else {
        resolve({ current, latest: current, available: false, checkedAt })
      }
    } catch {
      resolve({
        current,
        latest: null,
        available: false,
        checkedAt,
        error: 'Failed to parse brew output'
      })
    }
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function checkForUpdates(): Promise<UpdateCheckResult> {
  const current = app.getVersion()
  const checkedAt = Date.now()
  return new Promise((resolve) => {
    refreshTap(() => runOutdated(current, checkedAt, resolve))
  })
}

export function installUpdate(): void {
  const child = spawn(BREW, ['upgrade', '--cask', 'orpheus'], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  child.stdout.on('data', (chunk: Buffer) => {
    broadcast('updates:progress', { line: chunk.toString() })
  })
  child.stderr.on('data', (chunk: Buffer) => {
    broadcast('updates:progress', { line: chunk.toString() })
  })
  child.on('exit', (code) => {
    broadcast('updates:done', { success: code === 0, code })
  })
}

export function relaunchApp(): void {
  app.relaunch()
  app.exit(0)
}

// ---------------------------------------------------------------------------
// Auto-check loop
// ---------------------------------------------------------------------------

let autoCheckTimer: NodeJS.Timeout | null = null
const SIX_HOURS_MS = 6 * 60 * 60 * 1000
const INITIAL_DELAY_MS = 30_000

function isAutoCheckEnabled(): boolean {
  try {
    const db = getDb()
    const row = db.prepare('SELECT auto_check_updates FROM app_ui_state WHERE id = 1').get() as
      | { auto_check_updates: number | null }
      | undefined
    return (row?.auto_check_updates ?? 1) === 1
  } catch {
    return true
  }
}

async function runAutoCheck(): Promise<void> {
  if (!isAutoCheckEnabled()) return
  try {
    const result = await checkForUpdates()
    broadcast('updates:checkResult', result)
  } catch (err) {
    console.warn('[updates] auto-check failed:', err)
  }
}

export function startAutoCheckLoop(): void {
  stopAutoCheckLoop()
  autoCheckTimer = setTimeout(() => {
    void runAutoCheck()
    autoCheckTimer = setInterval(() => {
      void runAutoCheck()
    }, SIX_HOURS_MS)
  }, INITIAL_DELAY_MS)
}

export function stopAutoCheckLoop(): void {
  if (autoCheckTimer !== null) {
    clearTimeout(autoCheckTimer)
    clearInterval(autoCheckTimer)
    autoCheckTimer = null
  }
}
