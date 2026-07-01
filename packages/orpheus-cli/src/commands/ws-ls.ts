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
  type TableColumn
} from '../output.js'
import type { WorkspaceRecord, WorkspaceTreeNode, ProjectRecord } from '../reads/db.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    const name = displayNameOf(ws, db, projectCache)
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
  maxPositionals: 0,
  flags: {
    tree: 'boolean',
    status: 'string',
    project: 'string',
    'all-projects': 'boolean'
  },
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
          name: displayNameOf(ws, db, projectCache),
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
          const columns: TableColumn<WsRow>[] = [
            { key: 'id', header: 'ID', width: 36 },
            { key: 'name', header: 'NAME', width: 20 },
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
