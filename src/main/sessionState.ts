/**
 * sessionState.ts — Shadow-mode session state service (Phase 1)
 *
 * Watches ~/.claude/sessions/<pid>.json files written by the claude CLI and
 * reconciles their reported status against the hook-derived status tracked by
 * orpheusNotify. This module is OBSERVING ONLY — it never calls
 * setWorkspaceStatus, emits IPC, or writes to the DB.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as childProcess from 'node:child_process'
import { getDb } from './db'
import { getWorkspaceActivity } from './orpheusNotify'
import type { WorkspaceStatus } from '../shared/types'
import { getUserShellPath } from './shellHelpers'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions')
const KNOWN_GOOD_VERSIONS = new Set(['2.1.190'])

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

let reconcileRunning = false
let dirty = false

let watcher: fs.FSWatcher | null = null
let debounceTimer: NodeJS.Timeout | null = null
let intervalHandle: NodeJS.Timeout | null = null
let stopped = false

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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

  for (const filename of files) {
    const filePath = path.join(SESSIONS_DIR, filename)
    try {
      const raw = fs.readFileSync(filePath, 'utf8')
      const parsed: SessionFile = JSON.parse(raw)
      if (!parsed.sessionId) continue

      // Check for unknown versions
      if (!KNOWN_GOOD_VERSIONS.has(parsed.version)) {
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
    } catch {
      // Torn write or invalid JSON — keep last-good if available
      // We can't identify which sessionId this was from the filename alone
      // so we just skip; the previous entry (if any) stays in liveSessionMap
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
  for (const ws of workspaceRows) {
    // Skip archived workspaces
    if (ws.archived_at !== null) continue
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
