/**
 * commands/reviews.ts — `reviews list|resolve|unresolve` command group.
 *
 * The CLI-side half of the agent review loop (Epic G2 / docs/learnings/
 * agent-review-loop.md): local review comments (Orpheus's own
 * `review_comments` table, src/main/reviewStore.ts) are already readable by
 * an agent via the `reviews.list` command-server action and writable via the
 * newly-added `reviews.setResolved` action (src/main/commandServer.ts) — this
 * module is the thin `orpheus reviews ...` wrapper over both, mirroring the
 * shape of `ws send`/`ws-lifecycle.ts` exactly (sendCommand + printResult +
 * not-found classification).
 *
 * USAGE
 * -----
 *   orpheus reviews list [--unresolved] [--workspace <id>]
 *   orpheus reviews resolve <id> [--workspace <id>]
 *   orpheus reviews unresolve <id> [--workspace <id>]
 *
 * WORKSPACE RESOLUTION
 * --------------------
 * `reviews.list`/`reviews.setResolved` (the command-server actions) resolve
 * workspaceId as: context.workspaceId (auto-injected by sendCommand() from
 * $ORPHEUS_WORKSPACE_ID — zero-config for an agent running inside its own
 * workspace) falls back to args.workspaceId. --workspace here is therefore
 * sent as an EXPLICIT context override (not args.workspaceId) so it actually
 * takes priority over any ambient $ORPHEUS_WORKSPACE_ID — see sendCommand's
 * own doc comment: an explicit context argument always wins over the
 * env-var auto-injection. `reviews resolve`/`unresolve` don't need a
 * workspaceId at all (comment ids are globally unique), but --workspace is
 * accepted there too for symmetry/consistency with `reviews list`; it is
 * currently unused by the server for those two actions.
 *
 * OUTPUT
 * ------
 * `reviews list` prints a table (path:line, resolved, author, id, body) in
 * pretty mode, or the full LocalReviewComment[] array in --json mode.
 * `reviews resolve`/`unresolve` print the updated comment.
 *
 * AUTO-LAUNCH
 * -----------
 * Not isRead — these are action commands (they call sendCommand()), so
 * AppNotRunningError triggers the standard auto-launch + retry loop in cli.ts.
 */

import { registerCommand } from '../registry.js'
import { sendCommand } from '../socket-client.js'
import {
  printResult,
  printTable,
  printError,
  printUsageError,
  type TableColumn
} from '../output.js'
import { isNotFoundError } from './ws-lifecycle.js'

// ---------------------------------------------------------------------------
// Shared types (mirrors src/shared/types.ts's LocalReviewComment — duplicated
// here since the CLI package doesn't import src/shared/* directly; keep in
// sync with src/shared/types.ts if that shape ever changes).
// ---------------------------------------------------------------------------

type LocalReviewComment = {
  id: string
  workspaceId: string
  prNumber: number | null
  path: string
  line: number | null
  side: 'LEFT' | 'RIGHT' | null
  body: string
  author: string
  resolved: boolean
  createdAt: number
  updatedAt: number
}

/** Extract a message string from a thrown value the same way printError does. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Build the { workspaceId } context override sendCommand should send, if --workspace was given. */
function contextFor(workspaceFlag: unknown): { workspaceId?: string } | undefined {
  return typeof workspaceFlag === 'string' && workspaceFlag !== ''
    ? { workspaceId: workspaceFlag }
    : undefined
}

// ---------------------------------------------------------------------------
// reviews list
// ---------------------------------------------------------------------------

const LIST_COLUMNS: TableColumn<{
  location: string
  resolved: string
  author: string
  id: string
  body: string
}>[] = [
  { key: 'resolved', header: 'RESOLVED' },
  { key: 'location', header: 'PATH:LINE', width: 30 },
  { key: 'author', header: 'AUTHOR' },
  { key: 'id', header: 'ID' },
  { key: 'body', header: 'BODY' }
]

registerCommand('reviews list', {
  usage: 'reviews list [--unresolved] [--workspace <id>]',
  help: 'List local review comments for a workspace',
  longDesc:
    'Reads the local (Orpheus-owned) review-comment store via the reviews.list ' +
    'command-server action — the same data the Git tab shows inline in the diff ' +
    "viewer. Defaults to the caller's own workspace (via $ORPHEUS_WORKSPACE_ID) " +
    'when run from inside a workspace terminal; pass --workspace to target a ' +
    'different one. --unresolved filters to only unresolved comments — the set ' +
    'an agent should act on. Pair with \'orpheus ws send <id> "<comment>" --submit\' ' +
    "to deliver a comment into a workspace's claude, then 'orpheus reviews resolve " +
    "<id>' once addressed.",
  minPositionals: 0,
  maxPositionals: 0,
  flags: {
    unresolved: {
      type: 'boolean',
      desc: 'Only show unresolved comments (client-side filter).'
    },
    workspace: {
      type: 'string',
      valueHint: '<id>',
      desc:
        "Workspace id to list comments for. Defaults to the caller's own workspace " +
        '($ORPHEUS_WORKSPACE_ID) when omitted.'
    }
  },
  examples: [
    'orpheus reviews list',
    'orpheus reviews list --unresolved',
    'orpheus --json reviews list --unresolved | jq .',
    'orpheus reviews list --workspace abc-123'
  ],
  handler: async (ctx) => {
    const context = contextFor(ctx.flags.workspace)

    let result: unknown
    try {
      result = await sendCommand('reviews.list', undefined, context)
    } catch (err) {
      printError(err, { exitCode: isNotFoundError(errorMessage(err)) ? 3 : 1 })
      return
    }

    const comments = (Array.isArray(result) ? result : []) as LocalReviewComment[]
    const filtered = ctx.flags.unresolved === true ? comments.filter((c) => !c.resolved) : comments

    printResult(filtered, () => {
      const rows = filtered.map((c) => ({
        location: c.line != null ? `${c.path}:${c.line}` : c.path,
        resolved: c.resolved ? 'yes' : 'no',
        author: c.author,
        id: c.id,
        body: c.body
      }))
      printTable(rows, LIST_COLUMNS)
    })
  }
})

// ---------------------------------------------------------------------------
// reviews resolve / unresolve — share a single implementation parameterized
// on the target `resolved` value.
// ---------------------------------------------------------------------------

function registerSetResolvedCommand(
  name: 'reviews resolve' | 'reviews unresolve',
  resolved: boolean
): void {
  registerCommand(name, {
    usage: `${name} <id> [--workspace <id>]`,
    help: resolved
      ? 'Mark a local review comment as resolved'
      : 'Mark a local review comment as unresolved',
    longDesc:
      "Flips a local review comment's resolved flag via the reviews.setResolved " +
      'command-server action — the write-side counterpart to `reviews list`. This ' +
      "is how an agent closes the loop after acting on a comment (e.g. via 'ws " +
      "send'): list unresolved comments, address them, then resolve. The renderer's " +
      'Git tab reflects the change immediately (same underlying reviewStore.ts row).',
    minPositionals: 1,
    maxPositionals: 1,
    argsSpec: [{ name: 'id', required: true, desc: 'Review comment id to update.' }],
    flags: {
      workspace: {
        type: 'string',
        valueHint: '<id>',
        desc: 'Accepted for consistency with `reviews list`; not required (comment ids are globally unique).'
      }
    },
    examples: [`orpheus ${name} 3f9a2b1c-...`],
    handler: async (ctx) => {
      const id = ctx.positionals[0]
      if (id == null || id === '') {
        printUsageError(`usage: ${name} <id> [--workspace <id>]`)
        return
      }

      const context = contextFor(ctx.flags.workspace)

      let result: unknown
      try {
        result = await sendCommand('reviews.setResolved', { id, resolved }, context)
      } catch (err) {
        printError(err, { exitCode: isNotFoundError(errorMessage(err)) ? 3 : 1 })
        return
      }

      const comment = result as LocalReviewComment
      printResult(comment, () => {
        process.stdout.write(
          `  ${comment.id}  resolved=${comment.resolved ? 'yes' : 'no'}  ${comment.path}${
            comment.line != null ? `:${comment.line}` : ''
          }\n`
        )
      })
    }
  })
}

registerSetResolvedCommand('reviews resolve', true)
registerSetResolvedCommand('reviews unresolve', false)
