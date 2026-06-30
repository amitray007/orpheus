/**
 * commands/ws-read.ts — `ws read` command implementation.
 *
 * Reads and renders the Claude Code JSONL transcript for a given workspace.
 * This is a pure disk-read command (isRead: true); it never triggers auto-launch.
 *
 * USAGE
 *   orpheus ws read <workspaceId> [flags]
 *
 * FLAGS
 *   --last-assistant   Show only the last assistant turn (default when no flags given)
 *   --last <n>         Show last N turns
 *   --full             Show all turns
 *   --role <role>      Filter by role: 'user' or 'assistant'
 *   --since <ts>       Show turns at or after this Unix timestamp (seconds)
 *
 * DEFAULT BEHAVIOUR (no flags)
 *   Returns the last assistant turn — the common "get the result" case after
 *   running Claude. To see everything, pass --full.
 *
 * STUB REPLACEMENT
 *   cli.ts pre-registers `ws read` as a stub (makeStub('U10')). This module
 *   is imported by cli.ts (import './commands/ws-read.js') and calls
 *   registerCommand('ws read', ...) which overwrites the stub in the registry.
 *   The Map.set() semantics guarantee last-writer wins, so the import must
 *   happen AFTER the initial registerCommand('ws read', makeStub('U10')) call
 *   in cli.ts, which is satisfied by placing the import at the bottom of cli.ts.
 */

import * as fs from 'node:fs'
import { registerCommand } from '../registry.js'
import { openDb } from '../reads/db.js'
import { printResult, printNotFoundError, printError, printLines } from '../output.js'
import { resolveTranscriptPath, readTranscript, renderTurns } from '../reads/transcript.js'
import type { TranscriptOpts } from '../reads/transcript.js'

registerCommand('ws read', {
  isRead: true,
  flags: {
    'last-assistant': 'boolean',
    last: 'string',
    full: 'boolean',
    role: 'string',
    since: 'string'
  },
  handler: async (ctx) => {
    const wsId = ctx.positionals[0]
    if (wsId == null || wsId === '') {
      printError('usage: orpheus ws read <workspaceId> [flags]', { exitCode: 2 })
      return
    }

    const db = openDb()
    try {
      // Look up workspace
      const workspace = db.getWorkspace(wsId)
      if (workspace == null) {
        printNotFoundError(`workspace not found: ${wsId}`)
        return
      }

      // Look up project for encoded name
      const project = db.getProjectFull(workspace.projectId)
      if (project == null) {
        printNotFoundError(`project not found for workspace: ${workspace.projectId}`)
        return
      }

      // Resolve transcript path
      const transcriptPath = resolveTranscriptPath(workspace, project)
      if (transcriptPath == null) {
        printLines('no transcript yet (workspace has not started a Claude session)')
        return
      }

      // Check file exists
      if (!fs.existsSync(transcriptPath)) {
        printLines('no transcript yet (transcript file not found)')
        return
      }

      // Build opts from flags
      const opts: TranscriptOpts = {}

      if (ctx.flags['last-assistant'] === true) {
        opts.lastAssistant = true
      }

      if (typeof ctx.flags['last'] === 'string' && ctx.flags['last'] !== '') {
        const n = parseInt(ctx.flags['last'], 10)
        if (isNaN(n) || n < 1) {
          printError('--last must be a positive integer', { exitCode: 2 })
          return
        }
        opts.last = n
      }

      if (ctx.flags['full'] === true) {
        opts.full = true
      }

      if (typeof ctx.flags['role'] === 'string' && ctx.flags['role'] !== '') {
        const r = ctx.flags['role']
        if (r !== 'user' && r !== 'assistant') {
          printError(`--role must be 'user' or 'assistant', got: ${r}`, { exitCode: 2 })
          return
        }
        opts.role = r
      }

      if (typeof ctx.flags['since'] === 'string' && ctx.flags['since'] !== '') {
        const ts = parseInt(ctx.flags['since'], 10)
        if (isNaN(ts)) {
          printError('--since must be a Unix timestamp (integer seconds)', { exitCode: 2 })
          return
        }
        opts.since = ts
      }

      // Parse transcript
      const turns = readTranscript(transcriptPath, opts)

      // Render
      printResult(turns, () => {
        renderTurns(turns)
      })
    } finally {
      db.close()
    }
  }
})
