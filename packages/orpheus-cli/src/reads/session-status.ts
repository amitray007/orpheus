/**
 * reads/session-status.ts — Best-effort live status overlay from claude session files.
 *
 * AUTHORITY MODEL
 * ---------------
 * The DB's workspaces.status column is the PRIMARY status source: always available,
 * offline-safe, and driven by Orpheus's own reconcile loop when the app is running.
 *
 * This module provides a FRESHER signal when the Orpheus app is live: it reads
 * ~/.claude/sessions/<pid>.json files written by the claude CLI directly, without
 * going through the app. Because the CLI process writes its own file, this can
 * surface a transition (e.g. busy → waiting) faster than the DB — but it is
 * best-effort only. If the sessions dir is absent, unreadable, or no file matches,
 * callers MUST fall back to the DB status.
 *
 * SESSION FILE FORMAT (from src/main/sessionState.ts SessionFile)
 * ---------------------------------------------------------------
 * Files live at ~/.claude/sessions/<pid>.json. Key fields:
 *   pid           — OS process id (matches the filename stem)
 *   sessionId     — stable across --resume; matches workspace.claudeSessionId
 *   status        — 'busy' | 'idle' | 'waiting' (absent/null while starting)
 *   waitingFor    — e.g. 'permission prompt' | 'input needed' (present when waiting)
 *   statusUpdatedAt — unix ms timestamp of last status write
 *
 * STATUS VOCABULARY NORMALIZATION
 * --------------------------------
 * Claude's session file uses raw vocabulary: busy / idle / waiting.
 * The DB column and rest of the Orpheus codebase uses mapped vocabulary:
 *   busy    → in_progress
 *   idle    → awaiting_input   (freshly idle; app uses idle when stale, but CLI can't know)
 *   waiting → attention
 *
 * getLiveStatus returns already-mapped vocabulary so `ws ls` / `ws status` display
 * the same strings whether the app is live or offline. This matches the mapping
 * applied by sessionState.ts / orpheusNotify.ts setStatusFromFile.
 *
 * MATCHING STRATEGY
 * -----------------
 * To find the live status for a workspace, we scan all *.json files in the
 * sessions dir, parse each, and match on sessionId === claudeSessionId. We also
 * check PID liveness so a stale file from a dead process is not reported as live.
 * All reads are try/catch per file to tolerate torn writes.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type { WorkspaceRecord } from './db.js'

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions')

/** Shape we care about from a session file. All fields optional for safety. */
type SessionFilePartial = {
  pid?: number
  sessionId?: string
  status?: string
  waitingFor?: string
}

/** Check whether a PID is alive (same logic as sessionState.ts isAlive). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: unknown) {
    const err = e as { code?: string }
    // EPERM = alive but not owned; ESRCH = dead
    return err.code === 'EPERM'
  }
}

/**
 * Map a raw claude session-file status to the Orpheus DB vocabulary.
 *
 * Matches the mapping applied by sessionState.ts setStatusFromFile:
 *   busy    → in_progress
 *   idle    → awaiting_input  (CLI cannot know stale threshold, so always awaiting_input)
 *   waiting → attention
 */
function mapFileStatus(raw: string): string {
  if (raw === 'busy') return 'in_progress'
  if (raw === 'idle') return 'awaiting_input'
  if (raw === 'waiting') return 'attention'
  return raw // unknown raw value — pass through unchanged
}

/**
 * Scan ~/.claude/sessions/ for a session whose sessionId matches the given
 * claudeSessionId and whose process is still alive.
 *
 * Returns the matching file's status (mapped to Orpheus vocabulary) and
 * optional waitingFor field, or null if no matching live session is found.
 *
 * The returned status uses Orpheus DB vocabulary (in_progress / awaiting_input /
 * attention) rather than raw claude vocabulary (busy / idle / waiting), so callers
 * get consistent strings whether the app is live or offline.
 *
 * This is a FRESHNESS OVERLAY over the DB status column. Callers must fall
 * back to the DB value when this returns null (app not running, session not
 * yet started, or scan failed entirely).
 */
export function getLiveStatus(
  claudeSessionId: string
): { status?: string; waitingFor?: string } | null {
  let entries: string[]
  try {
    entries = fs.readdirSync(SESSIONS_DIR)
  } catch {
    // Sessions dir doesn't exist or is unreadable — app may not be running.
    return null
  }

  for (const filename of entries) {
    if (!filename.endsWith('.json')) continue

    try {
      const raw = fs.readFileSync(path.join(SESSIONS_DIR, filename), 'utf8')
      const parsed = JSON.parse(raw) as SessionFilePartial

      if (parsed.sessionId !== claudeSessionId) continue
      if (typeof parsed.pid !== 'number') continue
      if (!isAlive(parsed.pid)) continue

      // Matched: return what we have (status may be absent while starting).
      // Map raw claude status to Orpheus vocabulary for consistency with DB values.
      const result: { status?: string; waitingFor?: string } = {}
      if (typeof parsed.status === 'string') result.status = mapFileStatus(parsed.status)
      if (typeof parsed.waitingFor === 'string') result.waitingFor = parsed.waitingFor
      return result
    } catch {
      // Torn write, invalid JSON, or missing field — skip this file.
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Lifecycle status (#9) — surfaces closed/archived over the run-status
// ---------------------------------------------------------------------------

/**
 * The run-status (activity) for a workspace: 'in_progress' | 'attention' |
 * 'awaiting_input' | 'idle' | any other WorkspaceStatus value — i.e. whatever
 * getLiveStatus()/the DB status column reports. This is orthogonal to
 * lifecycle (open/closed/archived).
 */
export type RunStatus = string

/**
 * Compute the effective status to DISPLAY for a workspace, folding lifecycle
 * (archived/closed) over the run-status.
 *
 * BUG THIS FIXES (#9)
 * --------------------
 * Previously `ws status`/`ws ls` always printed the run-status column
 * (idle/in_progress/attention/awaiting_input) even for a workspace that has
 * been closed or archived — so a closed workspace showed 'idle' instead of
 * something indicating it's closed. That's misleading: 'idle' implies the
 * workspace is still an active, resumable session sitting there waiting,
 * when in fact it's been explicitly closed or archived.
 *
 * PRECEDENCE
 * ----------
 *   1. archivedAt != null → 'archived'   (archived always wins — terminal state)
 *   2. closedAt != null   → 'closed'     (closed but not archived)
 *   3. otherwise          → runStatus    (the live/DB activity status)
 *
 * Callers should still expose the raw runStatus (e.g. as a `status` field in
 * --json output) alongside this effective value (e.g. as `lifecycle` or
 * `effectiveStatus`) so scripts that want the underlying activity status
 * unaffected by lifecycle can still get it.
 */
export function effectiveLifecycleStatus(
  workspace: Pick<WorkspaceRecord, 'archivedAt' | 'closedAt'>,
  runStatus: RunStatus
): string {
  if (workspace.archivedAt != null) return 'archived'
  if (workspace.closedAt != null) return 'closed'
  return runStatus
}
