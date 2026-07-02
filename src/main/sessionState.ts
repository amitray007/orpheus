/**
 * sessionState.ts — session state service
 *
 * Watches ~/.claude/sessions/<pid>.json files written by the claude CLI and
 * drives workspace status transitions. This module is the SOLE authority for
 * workspace state (in_progress / attention / awaiting_input / idle).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as childProcess from 'node:child_process'
import { getDb } from './db'
import { getWorkspaceActivity, setFileStatusProvider, setStatusFromFile } from './orpheusNotify'
import { getAppUiState } from './uiState'
import { setFileInfoProvider } from './osNotifications'
import type { WorkspaceStatus } from '../shared/types'
import { getUserShellPath } from './shellHelpers'
import { logDiagMain } from './diagnostics'
import { DIAG_EVENTS } from '../shared/diagEvents'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions')
const KNOWN_GOOD_VERSIONS = new Set(['2.1.190', '2.1.198'])

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionFile {
  pid: number
  sessionId: string
  cwd: string
  version: string
  kind: string
  status?: 'busy' | 'idle' | 'waiting'
  waitingFor?: string
  statusUpdatedAt: number
}

export interface LiveSession {
  sessionId: string
  pid: number
  /** null = starting (status field absent in the file) */
  status: 'busy' | 'idle' | 'waiting' | null
  waitingFor?: string
  version: string
  cwd: string
  statusUpdatedAt: number
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** Keyed by sessionId from inside the file. */
let liveSessionMap = new Map<string, LiveSession>()

/** Keyed by workspaceId → composite "fileStatus|hookStatus" key; logs only on change. */
const lastSnapshot = new Map<string, string>()
/** Tracks the last raw file status we acted on, per workspaceId. */
const lastRawActed = new Map<string, string>()
/** Tracks when each workspace last transitioned into busy, per workspaceId. */
const busySince = new Map<string, number>()
/** Tracks workspaces for which the session-ready signal has already been fired. */
const readySignaled = new Set<string>()

let reconcileRunning = false
let dirty = false

let watcher: fs.FSWatcher | null = null
let debounceTimer: NodeJS.Timeout | null = null
let intervalHandle: NodeJS.Timeout | null = null
let stopped = false

/** Tracks filenames that have already emitted a parse-error warning; cleared when file becomes valid or disappears. */
const knownBadSessionFiles = new Set<string>()
/** Tracks claude versions that have already emitted an unknown-version warning; never cleared (bounded by distinct versions seen). */
const warnedVersions = new Set<string>()
/** Tracks pids that have already emitted a dead-pid warning. Pids are recycled OS-wide but accumulation is bounded. */
const deadPidReported = new Set<number>()

let sessionReadyHandler: ((workspaceId: string) => void) | null = null

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Synchronously returns the raw session-file status for the workspace.
 * Used as the fileStatusProvider veto in orpheusNotify.
 * Returns 'unknown' on any miss (no sessionId, not in map, file gone, parse error).
 */
export function getWorkspaceFileStatusSync(
  workspaceId: string
): 'busy' | 'idle' | 'waiting' | 'unknown' {
  let sessionId: string | null = null
  try {
    const row = getDb()
      .prepare('SELECT claude_session_id FROM workspaces WHERE id = ?')
      .get(workspaceId) as { claude_session_id: string | null } | undefined
    sessionId = row?.claude_session_id ?? null
  } catch {
    return 'unknown'
  }
  if (!sessionId) return 'unknown'

  const session = liveSessionMap.get(sessionId)
  if (!session) return 'unknown'
  if (!isAlive(session.pid)) return 'unknown'

  // Freshly read the file to avoid stale in-memory state
  const filePath = path.join(SESSIONS_DIR, `${session.pid}.json`)
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as { status?: string }
    const s = parsed.status
    if (s === 'busy' || s === 'idle' || s === 'waiting') return s
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

export function getWorkspaceFileInfo(workspaceId: string): {
  status: 'busy' | 'idle' | 'waiting' | 'unknown'
  waitingFor?: string
  elapsedMs?: number
} {
  let sessionId: string | null = null
  try {
    const row = getDb()
      .prepare('SELECT claude_session_id FROM workspaces WHERE id = ?')
      .get(workspaceId) as { claude_session_id: string | null } | undefined
    sessionId = row?.claude_session_id ?? null
  } catch {
    return { status: 'unknown' }
  }
  if (!sessionId) return { status: 'unknown' }

  const session = liveSessionMap.get(sessionId)
  if (!session) return { status: 'unknown' }
  if (!isAlive(session.pid)) return { status: 'unknown' }

  const filePath = path.join(SESSIONS_DIR, `${session.pid}.json`)
  let fileStatus: 'busy' | 'idle' | 'waiting' | 'unknown' = 'unknown'
  let waitingFor: string | undefined
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as { status?: string; waitingFor?: string }
    const s = parsed.status
    if (s === 'busy' || s === 'idle' || s === 'waiting') fileStatus = s
    if (parsed.waitingFor) waitingFor = parsed.waitingFor
  } catch {
    return { status: 'unknown' }
  }

  const elapsed = busySince.get(workspaceId)
  const result: {
    status: 'busy' | 'idle' | 'waiting' | 'unknown'
    waitingFor?: string
    elapsedMs?: number
  } = { status: fileStatus }
  if (waitingFor !== undefined) result.waitingFor = waitingFor
  if (elapsed !== undefined) result.elapsedMs = Date.now() - elapsed
  return result
}

export function startSessionStateService(): { stop: () => void } {
  stopped = false

  // Ensure sessions dir exists (may not exist before claude has ever run)
  try {
    fs.accessSync(SESSIONS_DIR)
    _startWatcher()
  } catch {
    console.log(`[sessionState] ${SESSIONS_DIR} not found — falling back to interval-only polling`)
  }

  // Interval backstop regardless of watcher
  intervalHandle = setInterval(() => {
    scheduleReconcile()
  }, 2500)

  // Initial reconcile
  scheduleReconcile()

  // One-time background startup cross-check (non-blocking)
  void _startupCrossCheck()

  // Register the file-status provider so orpheusNotify can veto premature
  // demotions while the main process is still busy.
  setFileStatusProvider(getWorkspaceFileStatusSync)

  // Register the file-info provider for OS notification copy.
  setFileInfoProvider(getWorkspaceFileInfo)

  return {
    stop() {
      stopped = true
      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      if (intervalHandle) {
        clearInterval(intervalHandle)
        intervalHandle = null
      }
      if (watcher) {
        watcher.close()
        watcher = null
      }
    }
  }
}

export function getLiveSessionState(): Map<string, LiveSession> {
  return new Map(liveSessionMap)
}

export async function forceReconcile(): Promise<void> {
  return reconcile()
}

export function setSessionReadyHandler(fn: (workspaceId: string) => void): void {
  sessionReadyHandler = fn
}

/**
 * Returns true when the workspace's claude session file reports a concrete
 * status (busy | idle | waiting). Returns false when the session is absent,
 * still starting (status field null), or the process is dead.
 */
export function isWorkspaceSessionReady(workspaceId: string): boolean {
  const s = getWorkspaceFileStatusSync(workspaceId)
  return s === 'busy' || s === 'idle' || s === 'waiting'
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

function _startWatcher(): void {
  try {
    watcher = fs.watch(SESSIONS_DIR, () => {
      scheduleReconcile()
    })
    watcher.on('error', (err) => {
      console.warn('[sessionState] fs.watch error — falling back to interval-only:', err)
      if (watcher) {
        watcher.close()
        watcher = null
      }
    })
  } catch (err) {
    console.warn(
      '[sessionState] could not watch sessions dir — falling back to interval-only:',
      err
    )
  }
}

// ---------------------------------------------------------------------------
// Single-flight scheduling
// ---------------------------------------------------------------------------

function scheduleReconcile(): void {
  if (stopped) return
  if (debounceTimer) {
    clearTimeout(debounceTimer)
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    if (reconcileRunning) {
      dirty = true
      return
    }
    void _runReconcile()
  }, 75)
}

async function _runReconcile(): Promise<void> {
  reconcileRunning = true
  dirty = false
  try {
    await reconcile()
  } catch (err) {
    console.warn('[sessionState] reconcile error:', err)
  } finally {
    reconcileRunning = false
    if (dirty && !stopped) {
      dirty = false
      void _runReconcile()
    }
  }
}

// ---------------------------------------------------------------------------
// Core reconcile
// ---------------------------------------------------------------------------

async function reconcile(): Promise<void> {
  const t0 = Date.now()
  // 1. Read all session files
  let files: string[] = []
  try {
    const entries = fs.readdirSync(SESSIONS_DIR)
    files = entries.filter((f) => f.endsWith('.json'))
  } catch {
    // Directory doesn't exist or is unreadable — treat as empty
    files = []
  }

  // 2. Parse each file, tolerate torn writes
  const newMap = new Map<string, LiveSession>()
  const lastGoodMap = new Map<string, LiveSession>(liveSessionMap) // keep old for fallback

  // Prune parse-error dedup set for files that are no longer present
  for (const f of knownBadSessionFiles) if (!files.includes(f)) knownBadSessionFiles.delete(f)

  for (const filename of files) {
    const filePath = path.join(SESSIONS_DIR, filename)
    try {
      const raw = fs.readFileSync(filePath, 'utf8')
      const parsed: SessionFile = JSON.parse(raw)
      if (!parsed.sessionId) continue

      // Check for unknown versions
      if (!KNOWN_GOOD_VERSIONS.has(parsed.version) && !warnedVersions.has(parsed.version)) {
        warnedVersions.add(parsed.version)
        console.warn(
          `[sessionState] warning: unknown claude version "${parsed.version}" in session file (pid=${parsed.pid} sessionId=${parsed.sessionId})`
        )
      }

      const session: LiveSession = {
        sessionId: parsed.sessionId,
        pid: parsed.pid,
        status: parsed.status ?? null,
        waitingFor: parsed.waitingFor,
        version: parsed.version,
        cwd: parsed.cwd,
        statusUpdatedAt: parsed.statusUpdatedAt
      }

      newMap.set(parsed.sessionId, session)
      knownBadSessionFiles.delete(filename)
    } catch {
      // Torn write or invalid JSON — keep last-good if available
      // We can't identify which sessionId this was from the filename alone
      // so we just skip; the previous entry (if any) stays in liveSessionMap
      if (!knownBadSessionFiles.has(filename)) {
        knownBadSessionFiles.add(filename)
        logDiagMain({
          category: 'anomaly',
          level: 'warn',
          event: DIAG_EVENTS.SESSION_PARSE_ERROR,
          message: filename,
          data: { filename }
        })
      }
    }
  }

  // Merge: prefer newly parsed, fall back to last-good for sessions not found
  // (this handles torn writes where the file is temporarily unreadable)
  for (const [sessionId, session] of lastGoodMap) {
    if (!newMap.has(sessionId)) {
      // Check if the file for this session still exists (by checking alive)
      if (isAlive(session.pid)) {
        // Process still alive but file may have been temporarily missing; keep last-good
        newMap.set(sessionId, session)
      }
      // Otherwise file is gone and process dead — don't carry forward
    }
  }

  liveSessionMap = newMap

  // 3. Load owned workspaces from DB
  let workspaceRows: Array<{
    id: string
    name: string
    status: string
    claude_session_id: string | null
    archived_at: number | null
  }>

  try {
    const db = getDb()
    workspaceRows = db
      .prepare(
        `SELECT id, name, status, claude_session_id, archived_at
         FROM workspaces
         WHERE claude_session_id IS NOT NULL`
      )
      .all() as typeof workspaceRows
  } catch (err) {
    console.warn('[sessionState] failed to query workspaces:', err)
    return
  }

  // 4. For each owned (non-archived) workspace, compute file-derived status and log
  const activeWorkspaceIds = new Set<string>()
  for (const ws of workspaceRows) {
    // Skip archived workspaces
    if (ws.archived_at !== null) continue
    activeWorkspaceIds.add(ws.id)
    if (!ws.claude_session_id) continue

    const session = liveSessionMap.get(ws.claude_session_id)
    const hookStatus = getWorkspaceActivity(ws.id)

    let fileStatus: WorkspaceStatus

    if (!session) {
      // No session file found
      fileStatus = 'idle'
      const key = `${fileStatus}|${hookStatus}`
      if (lastSnapshot.get(ws.id) !== key) {
        _logWorkspace(ws.id, ws.name, fileStatus, hookStatus, 'no session file', null)
        lastSnapshot.set(ws.id, key)
      }
    } else {
      const pid = session.pid
      const alive = isAlive(pid)

      if (!alive) {
        // Process is dead
        fileStatus = 'idle'
        const key = `${fileStatus}|${hookStatus}`
        if (lastSnapshot.get(ws.id) !== key) {
          _logWorkspace(ws.id, ws.name, fileStatus, hookStatus, 'pid dead/gone', session)
          lastSnapshot.set(ws.id, key)
        }
        if (!deadPidReported.has(pid)) {
          deadPidReported.add(pid)
          logDiagMain({
            category: 'anomaly',
            level: 'debug',
            event: DIAG_EVENTS.SESSION_DEAD_PID,
            workspaceId: ws.id,
            data: { pid }
          })
        }
      } else if (session.status === null) {
        // Status field absent (starting) — skip this workspace, leave snapshot untouched
        continue
      } else {
        fileStatus = _mapFileStatus(session)
        const key = `${fileStatus}|${hookStatus}`
        if (lastSnapshot.get(ws.id) !== key) {
          _logWorkspace(ws.id, ws.name, fileStatus, hookStatus, null, session)
          lastSnapshot.set(ws.id, key)
        }
      }
    }

    // --- Drive step: act on file→status transitions (not just log them) ---
    // Compute rawStatus from the live session
    let rawStatus: string
    if (!session || !isAlive(session.pid)) {
      rawStatus = 'gone'
    } else {
      // session.status !== null is guaranteed here (null path hit `continue` above)
      rawStatus = session.status as string
    }

    if (rawStatus === 'busy') {
      // Drive in_progress on the first busy transition; skip if already recorded busy
      if (lastRawActed.get(ws.id) !== 'busy') {
        setStatusFromFile(ws.id, 'in_progress')
        lastRawActed.set(ws.id, 'busy')
        busySince.set(ws.id, Date.now())
      }
    } else {
      // Only act on a real transition (avoids fighting the idle watchdog every tick)
      if (rawStatus !== lastRawActed.get(ws.id)) {
        let mapped: WorkspaceStatus
        if (rawStatus === 'idle') {
          const idleDuration = Date.now() - (session?.statusUpdatedAt ?? Date.now())
          const threshold = (getAppUiState().staleAfterMinutes ?? 60) * 60_000
          mapped = idleDuration >= threshold ? 'idle' : 'awaiting_input'
        } else if (rawStatus === 'waiting') {
          mapped = 'attention'
        } else {
          // 'gone'
          mapped = 'idle'
        }
        setStatusFromFile(ws.id, mapped)
        lastRawActed.set(ws.id, rawStatus)
      }
    }

    // Session-ready signal: fire once per session lifecycle when the file
    // first reports a concrete status (busy | idle | waiting). This allows
    // the loading overlay to dismiss without relying on the SessionStart hook.
    if (rawStatus === 'busy' || rawStatus === 'idle' || rawStatus === 'waiting') {
      if (!readySignaled.has(ws.id)) {
        readySignaled.add(ws.id)
        try {
          sessionReadyHandler?.(ws.id)
        } catch {
          /* ignore */
        }
      }
    } else if (rawStatus === 'gone') {
      // Clear so the next session (--resume with new pid/file) re-signals.
      readySignaled.delete(ws.id)
    }
  }

  // Prune entries for archived/removed workspaces to prevent memory leaks
  for (const key of lastRawActed.keys()) {
    if (!activeWorkspaceIds.has(key)) lastRawActed.delete(key)
  }
  for (const key of lastSnapshot.keys()) {
    if (!activeWorkspaceIds.has(key)) lastSnapshot.delete(key)
  }
  for (const key of busySince.keys()) {
    if (!activeWorkspaceIds.has(key)) busySince.delete(key)
  }
  for (const key of readySignaled) {
    if (!activeWorkspaceIds.has(key)) readySignaled.delete(key)
  }

  // Emit perf span only when reconcile is slow (>20 ms threshold) to avoid flooding.
  const durationMs = Date.now() - t0
  if (durationMs > 20) {
    logDiagMain({
      category: 'perf',
      level: 'info',
      event: DIAG_EVENTS.SESSION_RECONCILE,
      durationMs,
      data: { liveCount: liveSessionMap.size }
    })
  }
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

function _mapFileStatus(session: LiveSession): WorkspaceStatus {
  const { status, waitingFor } = session
  if (status === 'busy') return 'in_progress'
  if (status === 'waiting') {
    if (waitingFor === 'permission prompt') return 'attention'
    return 'awaiting_input'
  }
  if (status === 'idle') return 'idle'
  // null handled by caller; unknown values → safe default
  return 'in_progress'
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function _logWorkspace(
  workspaceId: string,
  name: string,
  fileStatus: WorkspaceStatus,
  hookStatus: WorkspaceStatus,
  reason: string | null,
  session: LiveSession | null
): void {
  const drift = fileStatus !== hookStatus
  let detail = ''

  if (session) {
    detail = ` (status=${session.status ?? 'null'} pid=${session.pid})`
  } else if (reason) {
    detail = ` (${reason})`
  }

  const driftSuffix = drift ? ' <-- DRIFT' : ''
  const reasonStr = reason ? ` (${reason})` : ''

  let msg: string
  if (session && !reason) {
    msg = `[sessionState] ws=${workspaceId} "${name}": file=${fileStatus} hook=${hookStatus}${detail}${driftSuffix}`
  } else {
    msg = `[sessionState] ws=${workspaceId} "${name}": file=${fileStatus} hook=${hookStatus}${reasonStr}${driftSuffix}`
  }

  console.log(msg)
}

// ---------------------------------------------------------------------------
// PID liveness
// ---------------------------------------------------------------------------

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: unknown) {
    const err = e as { code?: string }
    return err.code === 'EPERM' // EPERM = alive but not owned; ESRCH = dead
  }
}

// ---------------------------------------------------------------------------
// Startup cross-check (best-effort, non-blocking)
// ---------------------------------------------------------------------------

async function _startupCrossCheck(): Promise<void> {
  try {
    const resolvedPath = await getUserShellPath()

    // Find claude binary
    let claudePath: string
    try {
      claudePath = await _which('claude', resolvedPath)
    } catch {
      console.log('[sessionState] startup cross-check skipped (claude not found)')
      return
    }

    // Run claude agents --json
    const output = await _spawnWithTimeout(claudePath, ['agents', '--json'], {
      env: { ...process.env, PATH: resolvedPath },
      timeout: 10000
    })

    let agentList: Array<{ sessionId?: string; status?: string }>
    try {
      agentList = JSON.parse(output)
    } catch {
      console.log(
        '[sessionState] startup cross-check skipped (could not parse claude agents output)'
      )
      return
    }

    if (!Array.isArray(agentList)) {
      console.log('[sessionState] startup cross-check skipped (unexpected agents output format)')
      return
    }

    // Compare against file-derived sessions
    let matchCount = 0
    let mismatchCount = 0

    for (const agent of agentList) {
      if (!agent.sessionId) continue
      const liveSession = liveSessionMap.get(agent.sessionId)
      if (!liveSession) continue

      const fileStatusStr = liveSession.status ?? 'null'
      const agentStatusStr = agent.status ?? 'null'

      if (fileStatusStr === agentStatusStr) {
        matchCount++
      } else {
        mismatchCount++
        console.log(
          `[sessionState] startup cross-check: MISMATCH sessionId=${agent.sessionId} file=${fileStatusStr} agents=${agentStatusStr}`
        )
      }
    }

    if (mismatchCount === 0) {
      console.log(`[sessionState] startup cross-check: OK — ${matchCount} sessions match`)
    } else {
      console.log(
        `[sessionState] startup cross-check: MISMATCH — ${mismatchCount} mismatches out of ${matchCount + mismatchCount} compared`
      )
    }
  } catch (err) {
    console.log('[sessionState] startup cross-check skipped (error):', err)
  }
}

function _which(binary: string, PATH: string): Promise<string> {
  return new Promise((resolve, reject) => {
    childProcess.execFile('which', [binary], { env: { ...process.env, PATH } }, (err, stdout) => {
      if (err) {
        reject(err)
      } else {
        resolve(stdout.trim())
      }
    })
  })
}

function _spawnWithTimeout(
  cmd: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; timeout: number }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const proc = childProcess.spawn(cmd, args, {
      env: opts.env,
      stdio: ['ignore', 'pipe', 'ignore']
    })

    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))

    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`timeout after ${opts.timeout}ms`))
    }, opts.timeout)

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString('utf8'))
      } else {
        reject(new Error(`exited with code ${code}`))
      }
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}
