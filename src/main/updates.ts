import { app, BrowserWindow } from 'electron'
import { spawn, execSync } from 'node:child_process'
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
// Token resolution
// ---------------------------------------------------------------------------

function resolveToken(): string {
  if (process.env['HOMEBREW_GITHUB_API_TOKEN']) return process.env['HOMEBREW_GITHUB_API_TOKEN']
  if (process.env['GH_TOKEN']) return process.env['GH_TOKEN']
  try {
    return execSync('gh auth token', { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Semver comparison (major.minor.patch, no pre-release)
// ---------------------------------------------------------------------------

function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/, '')
      .split('.')
      .map((n) => parseInt(n, 10) || 0)
  const [lMaj, lMin, lPat] = parse(latest)
  const [cMaj, cMin, cPat] = parse(current)
  if (lMaj !== cMaj) return (lMaj ?? 0) > (cMaj ?? 0)
  if (lMin !== lMin) return (lMin ?? 0) > (cMin ?? 0)
  return (lPat ?? 0) > (cPat ?? 0)
}

// ---------------------------------------------------------------------------
// Broadcast helpers
// ---------------------------------------------------------------------------

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(channel, payload)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const current = app.getVersion()
  const checkedAt = Date.now()
  const token = resolveToken()

  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
    if (token) headers['Authorization'] = `Bearer ${token}`

    const res = await fetch('https://api.github.com/repos/amitray007/orpheus/releases/latest', {
      headers,
      signal: AbortSignal.timeout(10_000)
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { current, latest: null, available: false, checkedAt, error: `GitHub API ${res.status}: ${text.slice(0, 120)}` }
    }

    const data = await res.json() as { tag_name?: string }
    const tag = data.tag_name ?? ''
    const latest = tag.replace(/^v/, '')

    const available = Boolean(latest && isNewerVersion(latest, current))
    return { current, latest: latest || null, available, checkedAt }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { current, latest: null, available: false, checkedAt, error: msg }
  }
}

export function installUpdate(): void {
  const token = resolveToken()
  const child = spawn('brew', ['upgrade', '--cask', 'orpheus'], {
    env: { ...process.env, ...(token ? { HOMEBREW_GITHUB_API_TOKEN: token } : {}) },
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
    autoCheckTimer = setInterval(() => { void runAutoCheck() }, SIX_HOURS_MS)
  }, INITIAL_DELAY_MS)
}

export function stopAutoCheckLoop(): void {
  if (autoCheckTimer !== null) {
    clearTimeout(autoCheckTimer)
    clearInterval(autoCheckTimer)
    autoCheckTimer = null
  }
}
