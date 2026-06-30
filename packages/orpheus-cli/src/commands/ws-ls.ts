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

import { registerCommand } from '../cli.js'
import { openDb } from '../reads/db.js'
import { resolveContext, noProjectMessage } from '../context.js'
import { getLiveStatus } from '../reads/session-status.js'
import { printResult, printTable, printError, printLines, type TableColumn } from '../output.js'
import type { WorkspaceRecord, WorkspaceTreeNode } from '../reads/db.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Overlay live status onto a workspace record, returning the effective status string. */
function effectiveStatus(ws: WorkspaceRecord): string {
  if (ws.claudeSessionId != null) {
    const live = getLiveStatus(ws.claudeSessionId)
    if (live?.status != null) return live.status
  }
  return ws.status
}

/** Render a tree of WorkspaceTreeNodes as indented lines to stdout. */
function renderTree(
  nodes: WorkspaceTreeNode[],
  depth: number,
  callerWsId: string | undefined
): void {
  const indent = '  '.repeat(depth)
  for (const node of nodes) {
    const ws = node.workspace
    const status = effectiveStatus(ws)
    const isOwned = callerWsId != null && ws.parentWorkspaceId === callerWsId
    const ownedMark = isOwned ? '  *' : ''
    process.stdout.write(`${indent}${ws.name}  [${status}]${ownedMark}\n`)
    if (node.children.length > 0) {
      renderTree(node.children, depth + 1, callerWsId)
    }
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

registerCommand('ws ls', {
  isRead: true,
  flags: {
    tree: 'boolean',
    status: 'string',
    project: 'string',
    'all-projects': 'boolean'
  },
  handler: async (ctx) => {
    const db = openDb()
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
        // For simplicity: if a status filter is active, flatten instead of pruning.
        if (statusFilter != null) {
          // Fall back to flat list with a note
          printLines('Note: --status filter is not applied in --tree mode; showing full tree.')
        }

        const callerWsId = process.env.ORPHEUS_WORKSPACE_ID

        if (ctx.jsonMode) {
          // JSON: serialize tree with live status overlaid
          function serializeNode(node: WorkspaceTreeNode): Record<string, unknown> {
            const ws = node.workspace
            return {
              id: ws.id,
              name: ws.name,
              status: effectiveStatus(ws),
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
            renderTree(nodes, 0, callerWsId)
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
          name: ws.name,
          status: effectiveStatus(ws),
          parentWorkspaceId: ws.parentWorkspaceId ?? '',
          isOwnedChild: callerWsId != null && ws.parentWorkspaceId === callerWsId ? 'yes' : ''
        }))

        if (ctx.jsonMode) {
          printResult(
            workspaces.map((ws) => ({
              id: ws.id,
              name: ws.name,
              status: effectiveStatus(ws),
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
      printError(err)
    } finally {
      db.close()
    }
  }
})
