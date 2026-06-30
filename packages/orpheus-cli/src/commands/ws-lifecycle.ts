/**
 * commands/ws-lifecycle.ts — workspace lifecycle commands.
 *
 * Registers the following commands (all ACTION commands — not isRead — so
 * AppNotRunningError triggers auto-launch + retry in cli.ts):
 *
 *   ws open <id>
 *     Ask the app to open and mount a workspace in the GUI.
 *     Server returns { requested: true }.
 *
 *   ws archive <id...> [--recursive]
 *     Archive one or more workspaces. With --recursive, archives the full
 *     subtree rooted at each id (children before parents). Multiple ids are
 *     accepted so agents can batch archive several workspaces in one call.
 *     The server enforces a self-action guard: archiving your own workspace
 *     (or a subtree that contains it) is rejected.
 *
 *   ws close <id>
 *     Close a workspace (sets closed_at without deleting it).
 *     The server enforces a self-action guard: closing your own workspace
 *     is rejected.
 *
 *   ws reopen <id>
 *     Reopen a previously-closed workspace (clears closed_at).
 *
 *   ws rename <id> <name>
 *     Rename a workspace.
 *
 * AUTO-LAUNCH
 * -----------
 * None of these set isRead, so AppNotRunningError triggers the standard
 * auto-launch + retry loop in cli.ts.
 *
 * OUTPUT
 * ------
 * All commands support --json for machine-readable output.
 * Pretty-mode prints a key/value summary.
 * Server errors (CommandError) are surfaced via printError.
 */

import { registerCommand } from '../cli.js'
import { sendCommand } from '../socket-client.js'
import { printResult, printKeyValue, printError, printUsageError } from '../output.js'
import type { WorkspaceRecord } from '../reads/db.js'

// ---------------------------------------------------------------------------
// ws open
// ---------------------------------------------------------------------------

registerCommand('ws open', {
  handler: async (ctx) => {
    const id = ctx.positionals[0]
    if (id == null || id === '') {
      printUsageError('usage: ws open <id>')
      return
    }

    let result: unknown
    try {
      result = await sendCommand('workspace.open', { id })
    } catch (err) {
      printError(err)
      return
    }

    const data = result as { requested: boolean } | null
    printResult(data, () => {
      printKeyValue({ id, requested: String(data?.requested ?? false) })
    })
  }
})

// ---------------------------------------------------------------------------
// ws archive
// ---------------------------------------------------------------------------

registerCommand('ws archive', {
  flags: {
    recursive: 'boolean'
  },
  handler: async (ctx) => {
    if (ctx.positionals.length === 0) {
      printUsageError('usage: ws archive <id...> [--recursive]')
      return
    }

    const recursive = ctx.flags.recursive === true
    const ids = ctx.positionals

    // Archive each id in sequence; collect results and any errors.
    const results: Array<{ id: string; ok: boolean; error?: string; count?: number }> = []

    for (const id of ids) {
      try {
        const result = await sendCommand('workspace.archive', { id, recursive })
        const data = result as { archived: boolean; count?: number } | null
        results.push({ id, ok: true, count: data?.count })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        results.push({ id, ok: false, error: message })
      }
    }

    // In JSON mode, emit all results as an array.
    if (ctx.jsonMode) {
      printResult(results)
      // Set non-zero exit if any failed
      if (results.some((r) => !r.ok)) {
        process.exitCode = 1
      }
      return
    }

    // Pretty mode: print each result.
    for (const r of results) {
      if (r.ok) {
        const kv: Record<string, unknown> = { id: r.id, archived: true }
        if (recursive && r.count != null) kv.count = r.count
        printKeyValue(kv)
      } else {
        process.stderr.write(`error: ${r.id}: ${r.error ?? 'unknown error'}\n`)
        process.exitCode = 1
      }
    }
  }
})

// ---------------------------------------------------------------------------
// ws close
// ---------------------------------------------------------------------------

registerCommand('ws close', {
  handler: async (ctx) => {
    const id = ctx.positionals[0]
    if (id == null || id === '') {
      printUsageError('usage: ws close <id>')
      return
    }

    let result: unknown
    try {
      result = await sendCommand('workspace.close', { id })
    } catch (err) {
      printError(err)
      return
    }

    const data = result as { workspace: WorkspaceRecord | null } | null
    const ws = data?.workspace ?? null

    printResult(data, () => {
      if (ws != null) {
        printKeyValue({
          id: ws.id,
          name: ws.name,
          status: ws.status,
          closedAt: ws.closedAt != null ? new Date(ws.closedAt).toISOString() : '(none)'
        })
      } else {
        printKeyValue({ id, closed: 'true' })
      }
    })
  }
})

// ---------------------------------------------------------------------------
// ws reopen
// ---------------------------------------------------------------------------

registerCommand('ws reopen', {
  handler: async (ctx) => {
    const id = ctx.positionals[0]
    if (id == null || id === '') {
      printUsageError('usage: ws reopen <id>')
      return
    }

    let result: unknown
    try {
      result = await sendCommand('workspace.reopen', { id })
    } catch (err) {
      printError(err)
      return
    }

    const data = result as { workspace: WorkspaceRecord | null } | null
    const ws = data?.workspace ?? null

    printResult(data, () => {
      if (ws != null) {
        printKeyValue({
          id: ws.id,
          name: ws.name,
          status: ws.status,
          closedAt: ws.closedAt != null ? new Date(ws.closedAt).toISOString() : '(none)'
        })
      } else {
        printKeyValue({ id, reopened: 'true' })
      }
    })
  }
})

// ---------------------------------------------------------------------------
// ws rename
// ---------------------------------------------------------------------------

registerCommand('ws rename', {
  handler: async (ctx) => {
    const id = ctx.positionals[0]
    const name = ctx.positionals[1]
    if (id == null || id === '' || name == null || name === '') {
      printUsageError('usage: ws rename <id> <name>')
      return
    }

    let result: unknown
    try {
      result = await sendCommand('workspace.rename', { id, name })
    } catch (err) {
      printError(err)
      return
    }

    const ws = result as WorkspaceRecord | null

    printResult(ws, () => {
      if (ws != null) {
        printKeyValue({ id: ws.id, name: ws.name })
      } else {
        printKeyValue({ id, name })
      }
    })
  }
})
