/**
 * commands/ws-status.ts — `ws status <id>` command implementation.
 *
 * Reports the current activity status for a single workspace.
 *
 * STATUS PRECEDENCE
 * -----------------
 * 1. getLiveStatus(claudeSessionId) — scans ~/.claude/sessions/ for a live session
 *    file matching this workspace's claudeSessionId. Returns a fresher signal when
 *    the Orpheus app is running and the workspace is active.
 * 2. DB status column — authoritative offline fallback, always available.
 *
 * The waitingFor reason is similarly sourced from the live file when available.
 */

import { registerCommand } from '../cli.js'
import { openDb } from '../reads/db.js'
import { getLiveStatus } from '../reads/session-status.js'
import { printResult, printKeyValue, printError, printNotFoundError } from '../output.js'

registerCommand('ws status', {
  isRead: true,
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
      let status: string = ws.status
      let waitingFor: string | undefined

      if (ws.claudeSessionId != null) {
        const live = getLiveStatus(ws.claudeSessionId)
        if (live != null) {
          if (live.status != null) status = live.status
          if (live.waitingFor != null) waitingFor = live.waitingFor
        }
      }

      const result: Record<string, unknown> = {
        id: ws.id,
        name: ws.name,
        status
      }
      if (waitingFor != null) result.waitingFor = waitingFor

      printResult(result, () => {
        printKeyValue(result)
      })
    } catch (err: unknown) {
      printError(err)
    } finally {
      db.close()
    }
  }
})
