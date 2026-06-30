/**
 * commands/project.ts — `project ls` and `project show <id|name|path>` commands.
 *
 * project ls:
 *   Lists all registered Orpheus projects with id, name, path, and workspace
 *   count (computed with a secondary query, still a fast indexed lookup).
 *
 * project show <id|name|path>:
 *   Shows full detail for a single project, resolved in this order:
 *     1. by id (exact UUID match)
 *     2. by name (exact case-sensitive match)
 *     3. by path (realpath-normalised)
 *   Also shows the project's workspaces (non-archived) as a sub-table.
 */

import * as fs from 'node:fs'
import { registerCommand } from '../cli.js'
import { openDb } from '../reads/db.js'
import {
  printResult,
  printKeyValue,
  printTable,
  printError,
  printNotFoundError,
  printLines,
  type TableColumn
} from '../output.js'
import type { ProjectRecord } from '../reads/db.js'

// ---------------------------------------------------------------------------
// project ls
// ---------------------------------------------------------------------------

registerCommand('project ls', {
  isRead: true,
  handler: async (ctx) => {
    const db = openDb()
    try {
      const projects = db.listProjectsFull()

      type ProjectRow = {
        id: string
        name: string
        path: string
        workspaces: number
      }

      // Count workspaces per project (one listWorkspaces call per project would be
      // N+1; instead we do a single listWorkspaces with no filter and group in JS).
      const all = db.listWorkspaces({ includeArchived: false })
      const countByProject = new Map<string, number>()
      for (const ws of all) {
        countByProject.set(ws.projectId, (countByProject.get(ws.projectId) ?? 0) + 1)
      }

      const rows: ProjectRow[] = projects.map((p) => ({
        id: p.id,
        name: p.name,
        path: p.path,
        workspaces: countByProject.get(p.id) ?? 0
      }))

      if (ctx.jsonMode) {
        printResult(rows)
      } else {
        const columns: TableColumn<ProjectRow>[] = [
          { key: 'id', header: 'ID', width: 36 },
          { key: 'name', header: 'NAME', width: 20 },
          { key: 'workspaces', header: 'WS', width: 4 },
          { key: 'path', header: 'PATH', width: 30 }
        ]
        printTable(rows, columns)
      }
    } catch (err: unknown) {
      printError(err)
    } finally {
      db.close()
    }
  }
})

// ---------------------------------------------------------------------------
// project show
// ---------------------------------------------------------------------------

/** Attempt to resolve a project by id, name, or path. Returns null if not found. */
function resolveProject(db: ReturnType<typeof openDb>, query: string): ProjectRecord | null {
  // 1. by id
  let proj = db.getProjectFull(query)
  if (proj != null) return proj

  // 2. by name — use ContextDb's getProjectByName then fetch full record
  const byName = db.getProjectByName(query)
  if (byName != null) {
    proj = db.getProjectFull(byName.id)
    if (proj != null) return proj
  }

  // 3. by path (normalised)
  let normalised = query
  try {
    normalised = fs.realpathSync(query)
  } catch {
    // path doesn't exist on disk — try as-is
  }
  const byPath = db.getProjectByPath(normalised)
  if (byPath != null) {
    proj = db.getProjectFull(byPath.id)
    if (proj != null) return proj
  }

  return null
}

registerCommand('project show', {
  isRead: true,
  handler: async (ctx) => {
    const query = ctx.positionals[0]
    if (query == null || query === '') {
      printError('project id, name, or path is required: project show <id|name|path>', {
        exitCode: 2
      })
      return
    }

    const db = openDb()
    try {
      const project = resolveProject(db, query)
      if (project == null) {
        printNotFoundError(`project not found: ${query}`)
        return
      }

      // Fetch workspaces for this project
      const workspaces = db.listWorkspaces({ projectId: project.id })

      if (ctx.jsonMode) {
        printResult({
          id: project.id,
          name: project.name,
          path: project.path,
          addedAt: project.addedAt,
          lastOpenedAt: project.lastOpenedAt,
          githubOwner: project.githubOwner,
          githubRepo: project.githubRepo,
          workspaces: workspaces.map((ws) => ({
            id: ws.id,
            name: ws.name,
            status: ws.status,
            createdAt: ws.createdAt,
            lastOpenedAt: ws.lastOpenedAt,
            parentWorkspaceId: ws.parentWorkspaceId
          }))
        })
      } else {
        // Pretty output: key/value block then workspace table
        const detail: Record<string, unknown> = {
          id: project.id,
          name: project.name,
          path: project.path,
          addedAt: project.addedAt != null ? new Date(project.addedAt).toISOString() : null,
          lastOpenedAt:
            project.lastOpenedAt != null ? new Date(project.lastOpenedAt).toISOString() : null
        }
        if (project.githubOwner != null) {
          detail.github = `${project.githubOwner}/${project.githubRepo ?? ''}`
        }

        printKeyValue(detail)
        process.stdout.write('\n')

        if (workspaces.length === 0) {
          printLines('  workspaces: (none)')
        } else {
          process.stdout.write('  workspaces:\n')

          type WsRow = {
            id: string
            name: string
            status: string
            lastOpenedAt: string
          }

          const wsRows: WsRow[] = workspaces.map((ws) => ({
            id: ws.id,
            name: ws.name,
            status: ws.status,
            lastOpenedAt: ws.lastOpenedAt != null ? new Date(ws.lastOpenedAt).toISOString() : ''
          }))

          const columns: TableColumn<WsRow>[] = [
            { key: 'id', header: 'ID', width: 36 },
            { key: 'name', header: 'NAME', width: 20 },
            { key: 'status', header: 'STATUS', width: 14 },
            { key: 'lastOpenedAt', header: 'LAST OPENED', width: 24 }
          ]
          printTable(wsRows, columns)
        }
      }
    } catch (err: unknown) {
      printError(err)
    } finally {
      db.close()
    }
  }
})
