/**
 * commands/ws-lifecycle.ts — workspace lifecycle commands.
 *
 * Registers the following commands (all ACTION commands — not isRead — so
 * AppNotRunningError triggers auto-launch + retry in cli.ts):
 *
 *   ws open <id> [--focus | --background]
 *     Ask the app to open and mount a workspace. Defaults to --focus (an
 *     explicit "open this workspace" command navigates the GUI to it, same
 *     as clicking it); pass --background to activate/mount the workspace
 *     (making it injectable) WITHOUT navigating the GUI to it. --focus and
 *     --background are mutually exclusive.
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

import { registerCommand } from '../registry.js'
import { sendCommand } from '../socket-client.js'
import { printResult, printKeyValue, printError, printUsageError } from '../output.js'
import { effectiveLifecycleStatus } from '../reads/session-status.js'
import { resolveFocus } from '../focus.js'
import type { WorkspaceRecord } from '../reads/db.js'

// ---------------------------------------------------------------------------
// Not-found classification
// ---------------------------------------------------------------------------

/**
 * Classify an error message as "data not found" (exit 3) vs. a general
 * failure (exit 1). Mirrors the heuristic used elsewhere (e.g. project show /
 * ws status): the server reports missing entities with messages like
 * "workspace not found: <id>".
 */
export function isNotFoundError(msg: string): boolean {
  return msg.toLowerCase().includes('not found')
}

/** Extract a message string from a thrown value the same way printError does. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// ws archive — helpers
// ---------------------------------------------------------------------------

type ArchiveOutcome = { id: string; ok: boolean; error?: string; count?: number }

/** Archive each id in sequence; collect results and any errors. */
async function archiveEach(ids: string[], recursive: boolean): Promise<ArchiveOutcome[]> {
  const results: ArchiveOutcome[] = []
  for (const id of ids) {
    try {
      const result = await sendCommand('workspace.archive', { id, recursive })
      const data = result as { archived: boolean; count?: number } | null
      results.push({ id, ok: true, count: data?.count })
    } catch (err) {
      results.push({ id, ok: false, error: errorMessage(err) })
    }
  }
  return results
}

/**
 * In JSON mode, emit all results as an array. Each entry mirrors the text
 * mode's fields (#13 parity): ok/archived both present so scripts can key
 * off either name, count included whenever known (not just --recursive).
 * Sets non-zero exit if any failed: 3 if ALL failures are not-found errors,
 * 1 otherwise (mirrors printError's per-error classification, aggregated
 * since this command can batch multiple ids).
 */
function printArchiveResultsJson(results: ArchiveOutcome[]): void {
  printResult(
    results.map((r) => ({
      id: r.id,
      ok: r.ok,
      archived: r.ok,
      ...(r.count != null ? { count: r.count } : {}),
      ...(r.error != null ? { error: r.error } : {})
    }))
  )
  const failures = results.filter((r) => !r.ok)
  if (failures.length > 0) {
    process.exitCode = failures.every((r) => isNotFoundError(r.error ?? '')) ? 3 : 1
  }
}

/** Pretty mode: print each result, then set exit code if any failed. */
function printArchiveResultsPretty(results: ArchiveOutcome[], recursive: boolean): void {
  const failedIds: Array<{ error?: string }> = []
  for (const r of results) {
    if (r.ok) {
      const kv: Record<string, unknown> = { id: r.id, archived: true }
      if (recursive && r.count != null) kv.count = r.count
      printKeyValue(kv)
    } else {
      process.stderr.write(`error: ${r.id}: ${r.error ?? 'unknown error'}\n`)
      failedIds.push({ error: r.error })
    }
  }
  if (failedIds.length > 0) {
    process.exitCode = failedIds.every((r) => isNotFoundError(r.error ?? '')) ? 3 : 1
  }
}

// ---------------------------------------------------------------------------
// ws open
// ---------------------------------------------------------------------------

registerCommand('ws open', {
  usage: 'ws open <id> [--focus | --background]',
  help: 'Open a workspace in the app (mounts its terminal surface)',
  minPositionals: 1,
  maxPositionals: 1,
  argsSpec: [{ name: 'id', required: true, desc: 'Workspace id to open.' }],
  flags: {
    focus: {
      type: 'boolean',
      desc: 'Navigate the GUI to this workspace (same as clicking it).',
      default: 'true — this is the default for ws open',
      notes: 'Mutually exclusive with --background.'
    },
    background: {
      type: 'boolean',
      desc: 'Activate/mount the workspace terminal surface WITHOUT navigating the GUI to it.',
      default: 'false (ws open defaults to --focus, unlike ws new/ws send)',
      notes: 'Mutually exclusive with --focus.'
    }
  },
  examples: ['orpheus ws open abc-123', 'orpheus ws open abc-123 --background'],
  handler: async (ctx) => {
    const id = ctx.positionals[0]
    if (id == null || id === '') {
      printUsageError('usage: ws open <id>')
      return
    }

    // --focus/--background: default FOCUS for `ws open` — an explicit "open
    // this workspace" command should show it (same as clicking it in the
    // GUI); pass --background to activate/mount it without navigating there.
    const focusResult = resolveFocus(ctx.flags, true)
    if (!focusResult.ok) {
      printUsageError(focusResult.error)
      return
    }

    let result: unknown
    try {
      result = await sendCommand('workspace.open', { id, focus: focusResult.focus })
    } catch (err) {
      printError(err, { exitCode: isNotFoundError(errorMessage(err)) ? 3 : 1 })
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
  usage: 'ws archive <id...> [--recursive]',
  help: 'Archive one or more workspaces (with --recursive, archives the full subtree)',
  longDesc:
    'Accepts multiple ids in one call so a whole fan-out batch can be cleaned up ' +
    'atomically. The server rejects archiving your OWN workspace (or a subtree ' +
    'containing it) as a self-action guard.',
  minPositionals: 1,
  // Variadic (accepts any number of ids) — maxPositionals intentionally omitted
  // so batch-archiving many workspaces is never rejected as a usage error.
  argsSpec: [
    { name: 'id', required: true, variadic: true, desc: 'One or more workspace ids to archive.' }
  ],
  flags: {
    recursive: {
      type: 'boolean',
      desc: 'Also archive the full subtree rooted at each id (children before parents).',
      default: 'false (only the given ids are archived, not their children)'
    }
  },
  examples: [
    'orpheus ws archive abc-123',
    'orpheus ws archive abc-123 def-456 ghi-789   # batch-archive a fan-out',
    'orpheus ws archive abc-123 --recursive        # also archive its children'
  ],
  handler: async (ctx) => {
    if (ctx.positionals.length === 0) {
      printUsageError('usage: ws archive <id...> [--recursive]')
      return
    }

    const recursive = ctx.flags.recursive === true
    const ids = ctx.positionals

    const results = await archiveEach(ids, recursive)

    if (ctx.jsonMode) {
      printArchiveResultsJson(results)
      return
    }

    printArchiveResultsPretty(results, recursive)
  }
})

// ---------------------------------------------------------------------------
// ws close
// ---------------------------------------------------------------------------

registerCommand('ws close', {
  usage: 'ws close <id>',
  help: 'Close a workspace (sets closedAt without deleting it)',
  longDesc:
    'Closing is lighter-weight than archiving: the workspace is hidden/marked ' +
    'closed but not removed, and can be reopened with ws reopen. The server ' +
    'rejects closing your OWN workspace as a self-action guard.',
  minPositionals: 1,
  maxPositionals: 1,
  argsSpec: [{ name: 'id', required: true, desc: 'Workspace id to close.' }],
  examples: ['orpheus ws close abc-123'],
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
      printError(err, { exitCode: isNotFoundError(errorMessage(err)) ? 3 : 1 })
      return
    }

    const data = result as { workspace: WorkspaceRecord | null } | null
    const ws = data?.workspace ?? null

    printResult(data, () => {
      if (ws != null) {
        printKeyValue({
          id: ws.id,
          name: ws.name,
          status: effectiveLifecycleStatus(ws, ws.status),
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
  usage: 'ws reopen <id>',
  help: 'Reopen a previously-closed workspace (clears closedAt)',
  minPositionals: 1,
  maxPositionals: 1,
  argsSpec: [{ name: 'id', required: true, desc: 'Workspace id to reopen.' }],
  examples: ['orpheus ws reopen abc-123'],
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
      printError(err, { exitCode: isNotFoundError(errorMessage(err)) ? 3 : 1 })
      return
    }

    const data = result as { workspace: WorkspaceRecord | null } | null
    const ws = data?.workspace ?? null

    printResult(data, () => {
      if (ws != null) {
        printKeyValue({
          id: ws.id,
          name: ws.name,
          status: effectiveLifecycleStatus(ws, ws.status),
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
  usage: 'ws rename <id> <name>',
  help: 'Rename a workspace (sets a manual name; wins over auto-naming)',
  minPositionals: 2,
  maxPositionals: 2,
  argsSpec: [
    { name: 'id', required: true, desc: 'Workspace id to rename.' },
    { name: 'name', required: true, desc: 'New display name. Overrides auto-naming.' }
  ],
  examples: ['orpheus ws rename abc-123 "db migration worker"'],
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
      printError(err, { exitCode: isNotFoundError(errorMessage(err)) ? 3 : 1 })
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
