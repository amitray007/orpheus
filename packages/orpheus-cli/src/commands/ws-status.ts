/**
 * commands/ws-status.ts — `ws status <id>` command implementation.
 *
 * Reports the current activity status for a single workspace.
 *
 * STATUS PRECEDENCE (run-status)
 * -------------------------------
 * 1. getLiveStatus(claudeSessionId) — scans ~/.claude/sessions/ for a live session
 *    file matching this workspace's claudeSessionId. Returns a fresher signal when
 *    the Orpheus app is running and the workspace is active.
 * 2. DB status column — authoritative offline fallback, always available.
 *
 * The waitingFor reason is similarly sourced from the live file when available.
 *
 * LIFECYCLE OVERLAY (#9)
 * -----------------------
 * The run-status above is then folded through effectiveLifecycleStatus() so a
 * closed/archived workspace displays 'closed'/'archived' instead of a stale
 * run-status like 'idle'. See reads/session-status.ts for the precedence.
 * The primary `status` field IS the effective (lifecycle-aware) status; the
 * underlying run-status is also exposed as `runStatus` so scripts that want
 * the raw activity signal regardless of lifecycle can still get it.
 *
 * NAME RESOLUTION
 * ---------------
 * `name` is the raw DB value (for scripts that want the stored value);
 * `displayName` is resolved via resolveWorkspaceDisplayName() to match what
 * the GUI would show (see reads/resolve-name.ts for the full ladder).
 */

import { registerCommand } from '../registry.js'
import { openDb } from '../reads/db.js'
import { getLiveStatus, effectiveLifecycleStatus } from '../reads/session-status.js'
import { resolveWorkspaceDisplayName, extractSessionTitle } from '../reads/resolve-name.js'
import { printResult, printKeyValue, printError, printNotFoundError } from '../output.js'

registerCommand('ws status', {
  isRead: true,
  usage: 'ws status <id>',
  help: 'Show the current lifecycle + activity status for a workspace',
  longDesc:
    'A pure read (never triggers auto-launch) — a quick non-blocking status check, ' +
    'as opposed to ws wait which blocks until a terminal state. Prefers a live ' +
    "status signal from claude's on-disk session file when available, falling " +
    'back to the last-known DB status.',
  minPositionals: 1,
  maxPositionals: 1,
  argsSpec: [{ name: 'id', required: true, desc: 'Workspace id to check.' }],
  examples: ['orpheus ws status abc-123', 'orpheus --json ws status abc-123 | jq .status'],
  handler: async (ctx) => {
    const id = ctx.positionals[0]
    if (id == null || id === '') {
      printError('workspace id is required: ws status <id>', { exitCode: 2 })
      return
    }

    const db = openDb()
    try {
      const ws = db.getWorkspace(id)
      if (ws == null) {
        printNotFoundError(`workspace not found: ${id}`)
        return
      }

      // Prefer live status from session file; fall back to DB status.
      let runStatus: string = ws.status
      let waitingFor: string | undefined

      if (ws.claudeSessionId != null) {
        const live = getLiveStatus(ws.claudeSessionId)
        if (live != null) {
          if (live.status != null) runStatus = live.status
          if (live.waitingFor != null) waitingFor = live.waitingFor
        }
      }

      const status = effectiveLifecycleStatus(ws, runStatus)

      // Resolve display name (only extract sessionTitle if a cheaper rung
      // hasn't already decided the name — avoids an unnecessary disk read).
      let sessionTitle: string | null = null
      if (ws.nameIsAuto && !ws.lastTitle && ws.closedAt === null) {
        const project = db.getProjectFull(ws.projectId)
        if (project != null) sessionTitle = extractSessionTitle(ws, project)
      }
      const displayName = resolveWorkspaceDisplayName(ws, sessionTitle)

      const result: Record<string, unknown> = {
        id: ws.id,
        name: ws.name,
        displayName,
        status,
        runStatus
      }
      if (waitingFor != null) result.waitingFor = waitingFor

      printResult(result, () => {
        printKeyValue({
          id: ws.id,
          name: displayName,
          status,
          ...(waitingFor != null ? { waitingFor } : {})
        })
      })
    } catch (err: unknown) {
      printError(err)
    } finally {
      db.close()
    }
  }
})
