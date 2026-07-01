/**
 * commands/ws-ls.ts — `ws ls` command implementation.
 *
 * Lists workspaces, optionally filtered by project and/or status.
 * Supports --tree for indented parent→children hierarchy.
 *
 * STATUS OVERLAY
 * --------------
 * DB status is the authoritative source (always available). When the Orpheus
 * app is live, getLiveStatus() may return a fresher signal; it overlays the
 * DB value when present. The overlay is best-effort; failures are silently
 * ignored and the DB value is used instead.
 *
 * The overlaid run-status is then folded through effectiveLifecycleStatus()
 * (#9) so closed/archived workspaces show 'closed'/'archived' rather than a
 * stale run-status like 'idle'. See reads/session-status.ts.
 *
 * NAME RESOLUTION
 * ---------------
 * The raw `name` column is not what the GUI shows for auto-named workspaces.
 * `displayName` is resolved via resolveWorkspaceDisplayName() (see
 * reads/resolve-name.ts) and is what's shown in pretty/tree output; `name`
 * (raw) is still exposed in --json for scripts that want the stored value.
 *
 * TREE FORMAT
 * -----------
 * Indented with two spaces per depth level. Workspaces whose
 * parent_workspace_id equals the caller's ORPHEUS_WORKSPACE_ID are marked
 * with " *" to indicate they are direct children of the current workspace.
 *
 * Example:
 *   root-ws  [in_progress]
 *     child-a  [idle]  *
 *     child-b  [awaiting_input]
 *       grandchild  [idle]
 */

import { registerCommand } from '../registry.js'
import { openDb, type OrpheusDb } from '../reads/db.js'
import { resolveContext, noProjectMessage, ProjectNotFoundError } from '../context.js'
import { getLiveStatus, effectiveLifecycleStatus } from '../reads/session-status.js'
import { resolveWorkspaceDisplayName, extractSessionTitle } from '../reads/resolve-name.js'
import {
  printResult,
  printTable,
  printError,
  printNotFoundError,
  printLines,
  truncateForDisplay,
  type TableColumn
} from '../output.js'
import type { WorkspaceRecord, WorkspaceTreeNode, ProjectRecord } from '../reads/db.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Max width (in chars) for the workspace NAME column in pretty/table/tree
 * output. Long enough to be useful, short enough that ID (36) + NAME (48) +
 * STATUS (~14) + YOURS (~5) plus column gutters stays within ~110 cols,
 * keeping STATUS/YOURS on-screen on a standard 80-120 col terminal instead of
 * being pushed off by a pathologically long workspace name. This is
 * DISPLAY-ONLY — --json always emits the full, untruncated name/displayName
 * (see the JSON branches below, which never call truncateForDisplay).
 */
const MAX_NAME_COL_WIDTH = 48

/** Overlay live status onto a workspace record, returning the run-status string. */
function runStatusOf(ws: WorkspaceRecord): string {
  if (ws.claudeSessionId != null) {
    const live = getLiveStatus(ws.claudeSessionId)
    if (live?.status != null) return live.status
  }
  return ws.status
}

/** Effective (lifecycle-aware) status: run-status folded through archived/closed. */
function effectiveStatus(ws: WorkspaceRecord): string {
  return effectiveLifecycleStatus(ws, runStatusOf(ws))
}

/**
 * Resolve the display name for a workspace, only paying for the transcript
 * read (extractSessionTitle) when a cheaper rung of the ladder hasn't already
 * decided the name. `projectCache` avoids re-fetching the same project's
 * record for every workspace in a list.
 */
function displayNameOf(
  ws: WorkspaceRecord,
  db: OrpheusDb,
  projectCache: Map<string, ProjectRecord | null>
): string {
  let sessionTitle: string | null = null
  if (ws.nameIsAuto && !ws.lastTitle && ws.closedAt === null) {
    let project = projectCache.get(ws.projectId)
    if (project === undefined) {
      project = db.getProjectFull(ws.projectId)
      projectCache.set(ws.projectId, project)
    }
    if (project != null) sessionTitle = extractSessionTitle(ws, project)
  }
  return resolveWorkspaceDisplayName(ws, sessionTitle)
}

/** Render a tree of WorkspaceTreeNodes as indented lines to stdout. */
function renderTree(
  nodes: WorkspaceTreeNode[],
  depth: number,
  callerWsId: string | undefined,
  db: OrpheusDb,
  projectCache: Map<string, ProjectRecord | null>
): void {
  const indent = '  '.repeat(depth)
  for (const node of nodes) {
    const ws = node.workspace
    const status = effectiveStatus(ws)
    const name = truncateForDisplay(displayNameOf(ws, db, projectCache), MAX_NAME_COL_WIDTH)
    const isOwned = callerWsId != null && ws.parentWorkspaceId === callerWsId
    const ownedMark = isOwned ? '  *' : ''
    process.stdout.write(`${indent}${name}  [${status}]${ownedMark}\n`)
    if (node.children.length > 0) {
      renderTree(node.children, depth + 1, callerWsId, db, projectCache)
    }
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

registerCommand('ws ls', {
  isRead: true,
  usage: 'ws ls [--tree] [--status <s>] [--project <p>] [--all-projects]',
  help: 'List workspaces (flat or --tree), scoped to the current/given project by default',
  longDesc:
    'A pure read — never triggers auto-launch. Scoped to the current project by ' +
    'default (resolved the same way as --project everywhere else); pass ' +
    '--all-projects to see every workspace across every registered project. ' +
    '--tree shows the parent/child hierarchy, marking workspaces spawned by the ' +
    'calling workspace (via ORPHEUS_WORKSPACE_ID) with " *".',
  maxPositionals: 0,
  flags: {
    tree: {
      type: 'boolean',
      desc: 'Show workspaces as an indented parent/child tree instead of a flat list.',
      default: 'false',
      notes:
        '--status is not applied in --tree mode (a note is printed in text mode; suppressed in --json).'
    },
    status: {
      type: 'string',
      valueHint: '<status>',
      desc: 'Filter the flat list to workspaces with this status.',
      values: ['in_progress', 'attention', 'awaiting_input', 'idle', 'closed', 'archived'],
      notes: 'Ignored in --tree mode.'
    },
    project: {
      type: 'string',
      valueHint: '<id|name|path>',
      desc: 'Project context override (same as the global --project flag).'
    },
    'all-projects': {
      type: 'boolean',
      desc: 'List workspaces across ALL registered projects instead of scoping to one.',
      default: 'false (scoped to the current/given project)'
    }
  },
  examples: [
    'orpheus ws ls',
    'orpheus ws ls --tree',
    'orpheus ws ls --status attention   # find workspaces blocked on a decision',
    'orpheus ws ls --all-projects --json'
  ],
  handler: async (ctx) => {
    const db = openDb()
    const projectCache = new Map<string, ProjectRecord | null>()
    try {
      const allProjects = ctx.flags['all-projects'] === true

      // Resolve project context unless --all-projects
      let projectId: string | undefined
      if (!allProjects) {
        const resolved = resolveContext({ project: ctx.project }, db)
        if (resolved.projectId == null) {
          printError(noProjectMessage(), { exitCode: 2 })
          return
        }
        projectId = resolved.projectId
      }

      // Status filter
      const statusFilter = typeof ctx.flags.status === 'string' ? ctx.flags.status : undefined

      if (ctx.flags.tree === true) {
        // Tree mode
        let nodes: WorkspaceTreeNode[]
        if (projectId != null) {
          nodes = db.buildProjectLineageTree(projectId)
        } else {
          nodes = db.buildLineageTree()
        }

        // Filter by status if requested (prune non-matching leaves, keep parents)
        // For simplicity: if a status filter is active in human mode, print a note.
        // In JSON mode we suppress the note to keep output parseable.
        if (statusFilter != null && !ctx.jsonMode) {
          printLines('Note: --status filter is not applied in --tree mode; showing full tree.')
        }

        const callerWsId = process.env.ORPHEUS_WORKSPACE_ID

        if (ctx.jsonMode) {
          // JSON: serialize tree with live status + display name overlaid
          function serializeNode(node: WorkspaceTreeNode): Record<string, unknown> {
            const ws = node.workspace
            return {
              id: ws.id,
              name: ws.name,
              displayName: displayNameOf(ws, db, projectCache),
              status: effectiveStatus(ws),
              runStatus: runStatusOf(ws),
              parentWorkspaceId: ws.parentWorkspaceId,
              isOwnedChild: callerWsId != null && ws.parentWorkspaceId === callerWsId,
              children: node.children.map(serializeNode)
            }
          }
          printResult(nodes.map(serializeNode))
        } else {
          if (nodes.length === 0) {
            printLines('  (none)')
          } else {
            renderTree(nodes, 0, callerWsId, db, projectCache)
          }
        }
      } else {
        // Flat list mode
        const workspaces = db.listWorkspaces({
          projectId,
          ...(statusFilter != null
            ? { status: statusFilter as WorkspaceRecord['status'] }
            : undefined)
        })

        const callerWsId = process.env.ORPHEUS_WORKSPACE_ID

        type WsRow = {
          id: string
          name: string
          status: string
          parentWorkspaceId: string
          isOwnedChild: string
        }

        const rows: WsRow[] = workspaces.map((ws) => ({
          id: ws.id,
          // Truncated for pretty/table display only — the --json branch below
          // calls displayNameOf() directly and emits the full, untruncated value.
          name: truncateForDisplay(displayNameOf(ws, db, projectCache), MAX_NAME_COL_WIDTH),
          status: effectiveStatus(ws),
          parentWorkspaceId: ws.parentWorkspaceId ?? '',
          isOwnedChild: callerWsId != null && ws.parentWorkspaceId === callerWsId ? 'yes' : ''
        }))

        if (ctx.jsonMode) {
          printResult(
            workspaces.map((ws) => ({
              id: ws.id,
              name: ws.name,
              displayName: displayNameOf(ws, db, projectCache),
              status: effectiveStatus(ws),
              runStatus: runStatusOf(ws),
              parentWorkspaceId: ws.parentWorkspaceId,
              isOwnedChild: callerWsId != null && ws.parentWorkspaceId === callerWsId
            }))
          )
        } else {
          // NAME has no explicit `width` floor here: printTable's width is a
          // *minimum* (it expands to fit the widest cell), and the `name`
          // values are already truncated to MAX_NAME_COL_WIDTH above, so the
          // column naturally caps there without padding short names out to 48
          // chars unnecessarily.
          const columns: TableColumn<WsRow>[] = [
            { key: 'id', header: 'ID', width: 36 },
            { key: 'name', header: 'NAME' },
            { key: 'status', header: 'STATUS', width: 14 },
            { key: 'isOwnedChild', header: 'YOURS', width: 5 }
          ]
          printTable(rows, columns)
        }
      }
    } catch (err: unknown) {
      // Explicit --project value that didn't resolve to any project (QA fix #2)
      // gets a targeted not-found error (exit 3), distinct from the generic
      // noProjectMessage() usage error (exit 2) used when --project was absent.
      if (err instanceof ProjectNotFoundError) {
        printNotFoundError(err.message)
      } else {
        printError(err)
      }
    } finally {
      db.close()
    }
  }
})
