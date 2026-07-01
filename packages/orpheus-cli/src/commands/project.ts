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
 *
 * NAME RESOLUTION + LIFECYCLE (#9)
 * ---------------------------------
 * Workspace rows shown here go through the same resolveWorkspaceDisplayName()
 * ladder and effectiveLifecycleStatus() fold as ws-ls/ws-status, so a project's
 * workspace list is consistent with those commands (raw `name` + `status` are
 * still exposed in --json; `displayName`/effective `status` drive text output).
 *
 * TEXT/JSON PARITY (#13, extended by QA fix #5)
 * ------------------------------------------------
 * `project show`'s --json now includes `githubOwner`/`githubRepo` (previously
 * only shown in text as a combined `github` string) so both modes expose the
 * same underlying fields — text keeps the human-friendly combined string,
 * json keeps the raw parts. Dates are ISO strings in text, epoch ms in json
 * (same underlying value, formatted per mode).
 *
 * The workspaces sub-table (text) previously showed only id/name(display)/
 * status/lastOpenedAt while --json's `workspaces[]` also had runStatus/
 * createdAt/parentWorkspaceId — those are now columns in the text table too
 * (same field names as json; NAME is intentionally labelled DISPLAY NAME since
 * it shows the resolved displayName value, matching json's `displayName` key,
 * not the raw `name` field).
 */

import * as fs from 'node:fs'
import { registerCommand } from '../registry.js'
import { openDb } from '../reads/db.js'
import { effectiveLifecycleStatus } from '../reads/session-status.js'
import { resolveWorkspaceDisplayName, extractSessionTitle } from '../reads/resolve-name.js'
import {
  printResult,
  printKeyValue,
  printTable,
  printError,
  printNotFoundError,
  printLines,
  truncateForDisplay,
  type TableColumn
} from '../output.js'
import type { ProjectRecord, WorkspaceRecord } from '../reads/db.js'

/**
 * Max width (in chars) for the DISPLAY NAME column in the `project show`
 * workspaces sub-table. Same rationale/value as ws-ls.ts's
 * MAX_NAME_COL_WIDTH — kept as a separate const since these are two
 * independent command modules, but intentionally the same number so a long
 * workspace name renders consistently across `ws ls` and `project show`.
 * DISPLAY-ONLY: --json emits the full, untruncated `displayName` below.
 */
const MAX_NAME_COL_WIDTH = 48

/** Resolve a workspace's display name, reading the transcript only when needed. */
function displayNameOf(ws: WorkspaceRecord, project: ProjectRecord): string {
  let sessionTitle: string | null = null
  if (ws.nameIsAuto && !ws.lastTitle && ws.closedAt === null) {
    sessionTitle = extractSessionTitle(ws, project)
  }
  return resolveWorkspaceDisplayName(ws, sessionTitle)
}

// ---------------------------------------------------------------------------
// project ls
// ---------------------------------------------------------------------------

registerCommand('project ls', {
  isRead: true,
  usage: 'project ls',
  help: 'List all registered Orpheus projects',
  maxPositionals: 0,
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
  usage: 'project show <id|name|path>',
  help: 'Show project details and its (non-archived) workspaces',
  minPositionals: 1,
  maxPositionals: 1,
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
            displayName: displayNameOf(ws, project),
            status: effectiveLifecycleStatus(ws, ws.status),
            runStatus: ws.status,
            createdAt: ws.createdAt,
            lastOpenedAt: ws.lastOpenedAt,
            parentWorkspaceId: ws.parentWorkspaceId
          }))
        })
      } else {
        // Pretty output: key/value block then workspace table
        // (githubOwner/githubRepo also exposed in json above — #13 parity)
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

          // Same field NAMES as the --json `workspaces[]` entries (QA fix #5):
          // status/runStatus/createdAt/parentWorkspaceId are all present in both
          // modes now (previously the table silently dropped runStatus/createdAt/
          // parentWorkspaceId). The table's NAME column shows displayName (the
          // human-friendly resolved name, same value as json's `displayName`
          // field) — header says DISPLAY NAME to avoid implying it's the raw
          // `name` field, which text intentionally doesn't duplicate in the table
          // (available via `ws ls`/`ws status` for the raw value if needed).
          type WsRow = {
            id: string
            displayName: string
            status: string
            runStatus: string
            createdAt: string
            parentWorkspaceId: string
            lastOpenedAt: string
          }

          const wsRows: WsRow[] = workspaces.map((ws) => ({
            id: ws.id,
            // Truncated for pretty/table display only — the --json branch
            // above calls displayNameOf() directly and emits the full,
            // untruncated value.
            displayName: truncateForDisplay(displayNameOf(ws, project), MAX_NAME_COL_WIDTH),
            status: effectiveLifecycleStatus(ws, ws.status),
            runStatus: ws.status,
            createdAt: new Date(ws.createdAt).toISOString(),
            parentWorkspaceId: ws.parentWorkspaceId ?? '(none)',
            lastOpenedAt: ws.lastOpenedAt != null ? new Date(ws.lastOpenedAt).toISOString() : ''
          }))

          // DISPLAY NAME has no explicit `width` floor: printTable's width is
          // a *minimum* (expands to fit the widest cell), and displayName
          // values are already truncated to MAX_NAME_COL_WIDTH above, so the
          // column naturally caps there without padding short names out to 48
          // chars unnecessarily.
          const columns: TableColumn<WsRow>[] = [
            { key: 'id', header: 'ID', width: 36 },
            { key: 'displayName', header: 'DISPLAY NAME' },
            { key: 'status', header: 'STATUS', width: 14 },
            { key: 'runStatus', header: 'RUN STATUS', width: 10 },
            { key: 'createdAt', header: 'CREATED', width: 24 },
            { key: 'parentWorkspaceId', header: 'PARENT', width: 36 },
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
