import { app, BrowserWindow } from 'electron'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { getDb } from './db'
import type {
  UpdateCheckResult,
  UpdatePhase,
  UpdateProgress,
  UpdateSnapshot
} from '../shared/types'

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
// Module-level update snapshot — source of truth for rehydration
// ---------------------------------------------------------------------------

let snapshot: UpdateSnapshot = {
  kind: 'idle',
  latest: null,
  lastChecked: null,
  phase: null,
  percent: null,
  log: [],
  reason: null
}

function setSnapshot(partial: Partial<UpdateSnapshot>): void {
  snapshot = { ...snapshot, ...partial }
}

export function getUpdateSnapshot(): UpdateSnapshot {
  return snapshot
}

const SNAPSHOT_LOG_CAP = 200

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
  const repoKillTimer = setTimeout(() => repoChild.kill('SIGTERM'), 60_000)
  repoChild.on('error', () => {
    clearTimeout(repoKillTimer)
    done()
  })

  let tapPath = ''
  repoChild.stdout.on('data', (chunk: Buffer) => (tapPath += chunk.toString()))
  // consume stderr to avoid pipe buffer blocks
  repoChild.stderr.on('data', () => {})

  repoChild.on('exit', (code) => {
    clearTimeout(repoKillTimer)
    tapPath = tapPath.trim()
    if (code !== 0 || !tapPath || !existsSync(tapPath)) {
      done()
      return
    }
    const pullChild = spawn('git', ['-C', tapPath, 'pull', '--ff-only'], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const pullKillTimer = setTimeout(() => pullChild.kill('SIGTERM'), 60_000)
    pullChild.on('error', () => {
      clearTimeout(pullKillTimer)
      done()
    })
    // consume stdout/stderr to avoid pipe buffer blocks
    pullChild.stdout.on('data', () => {})
    pullChild.stderr.on('data', () => {})
    pullChild.on('exit', () => {
      clearTimeout(pullKillTimer)
      done()
    })
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
  const killTimer = setTimeout(() => child.kill('SIGTERM'), 60_000)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
  child.on('exit', (code) => {
    clearTimeout(killTimer)
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
// Brew output line parser
// ---------------------------------------------------------------------------

/**
 * Pure function that parses a single brew output line into a phase + optional
 * download percentage. Returns the previous phase unchanged for unrecognised lines
 * so the caller's phase never regresses unexpectedly.
 *
 * Phase markers observed from `brew upgrade --cask`:
 *   ==> Downloading …       → download phase
 *   ==> Verifying checksum  → verify phase
 *   ==> Installing …        → install phase
 *   ==> Moving …            → install phase
 *   ==> Purging …           → install phase
 *   ==> Linking …           → install phase
 *
 * Download progress may appear as:
 *   "  #####      ##                             5.6%  --:--"  (curl bar)
 *   "Already downloaded: …"  (cached; skip % extraction)
 */
export function parseBrewLine(
  line: string,
  prevPhase: UpdatePhase
): { phase: UpdatePhase; percent: number | null } {
  const trimmed = line.trimStart()

  // Phase-transition markers
  if (/^==>.*[Dd]ownload/.test(trimmed)) {
    return { phase: 'download', percent: null }
  }
  if (/^==>.*[Vv]erif/.test(trimmed)) {
    return { phase: 'verify', percent: null }
  }
  if (/^==>\s*(Installing|Moving|Purging|Linking)/.test(trimmed)) {
    return { phase: 'install', percent: null }
  }

  // Percent extraction — only meaningful during the download phase.
  // curl pipe format: "  ###   ###   ###   5.6%  --:--"
  // or a bare "5.6%" anywhere on the line
  if (prevPhase === 'download') {
    const m = line.match(/(\d{1,3}(?:\.\d+)?)%/)
    if (m) {
      const pct = parseFloat(m[1])
      if (!isNaN(pct) && pct >= 0 && pct <= 100) {
        return { phase: prevPhase, percent: pct }
      }
    }
  }

  // Unrecognised line — keep current phase, no percent
  return { phase: prevPhase, percent: null }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function checkForUpdates(): Promise<UpdateCheckResult> {
  const current = app.getVersion()
  const checkedAt = Date.now()
  setSnapshot({ kind: 'checking' })
  return new Promise((resolve) => {
    refreshTap(() =>
      runOutdated(current, checkedAt, (result) => {
        if (result.error) {
          setSnapshot({ kind: 'error', reason: result.error, lastChecked: result.checkedAt })
        } else if (result.available && result.latest) {
          setSnapshot({ kind: 'available', latest: result.latest, lastChecked: result.checkedAt })
        } else {
          setSnapshot({
            kind: 'up_to_date',
            latest: result.latest,
            lastChecked: result.checkedAt
          })
        }
        broadcast('updates:checkResult', result)
        resolve(result)
      })
    )
  })
}

export function installUpdate(): void {
  // First refresh the tap so the cask definition is current; broadcast the
  // refresh phase, then run the real upgrade.
  const refreshProgress: UpdateProgress = {
    phase: 'refresh',
    percent: null,
    line: 'Refreshing tap…'
  }
  setSnapshot({ kind: 'installing', phase: 'refresh', percent: null, log: [], reason: null })
  broadcast('updates:progress', refreshProgress)

  refreshTap(() => {
    let currentPhase: UpdatePhase = 'download'

    const child = spawn(BREW, ['upgrade', '--cask', 'orpheus'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const killTimer = setTimeout(() => child.kill('SIGTERM'), 180_000)

    function handleLine(raw: string): void {
      // Split on newlines — a single data event may carry multiple lines
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        const { phase, percent } = parseBrewLine(line, currentPhase)
        currentPhase = phase
        const currentLog = snapshot.log
        const newLog =
          currentLog.length >= SNAPSHOT_LOG_CAP
            ? [...currentLog.slice(currentLog.length - SNAPSHOT_LOG_CAP + 1), line]
            : [...currentLog, line]
        setSnapshot({ phase, percent, log: newLog })
        const progress: UpdateProgress = { phase, percent, line }
        broadcast('updates:progress', progress)
      }
    }

    child.stdout.on('data', (chunk: Buffer) => handleLine(chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => handleLine(chunk.toString()))
    child.on('exit', (code) => {
      clearTimeout(killTimer)
      if (code === 0) {
        setSnapshot({ kind: 'installed', phase: null, percent: null })
      } else {
        setSnapshot({
          kind: 'error',
          reason: `brew upgrade exited with code ${code ?? 'unknown'}`,
          phase: null,
          percent: null
        })
      }
      broadcast('updates:done', { success: code === 0, code })
    })
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
    await checkForUpdates()
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
