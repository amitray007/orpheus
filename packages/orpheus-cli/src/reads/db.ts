/**
 * reads/db.ts — read-only SQLite access layer for the Orpheus CLI.
 *
 * Opens the app's SQLite database in read-only mode. The app uses WAL mode,
 * so concurrent readers are safe while the app holds the write lock.
 *
 * WorkspaceRecord, ProjectRecord, and WorkspaceStatus are imported from
 * src/shared/types.ts via the @shared/* path alias defined in tsconfig.json.
 * The alias resolves to ../../src/shared/* (relative to packages/orpheus-cli/)
 * for both tsc (via paths) and esbuild (via --alias flag in build:cli). The
 * import is type-only, so it fully erases at runtime with no bundle impact.
 */

import * as fs from 'node:fs'
import Database from 'better-sqlite3'
import { getSqlitePath } from '../paths.js'
import type { ContextDb, ProjectRow, WorkspaceRow } from '../context.js'
import type { WorkspaceRecord, ProjectRecord, WorkspaceStatus } from '@shared/types'

// Re-export the shared types so callers that previously imported them from
// this module continue to work without changes.
export type { WorkspaceRecord, ProjectRecord, WorkspaceStatus }

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class OrpheusDataNotFoundError extends Error {
  constructor(path: string) {
    super(`no Orpheus data found at ${path} (is the app installed / has it run?)`)
    this.name = 'OrpheusDataNotFoundError'
  }
}

// ---------------------------------------------------------------------------
// Lineage tree type
// ---------------------------------------------------------------------------

export type WorkspaceTreeNode = {
  workspace: WorkspaceRecord
  children: WorkspaceTreeNode[]
}

// ---------------------------------------------------------------------------
// Raw DB row shapes (snake_case from SQLite)
// ---------------------------------------------------------------------------

type DbWorkspaceRow = {
  id: string
  project_id: string
  name: string
  name_is_auto: number
  cwd: string
  pinned_at: number | null
  created_at: number
  last_opened_at: number | null
  archived_at: number | null
  closed_at: number | null
  sort_order: number | null
  status: WorkspaceStatus
  claude_session_id: string | null
  forked_from_session_id: string | null
  last_title: string | null
  parent_workspace_id: string | null
}

type DbProjectRow = {
  id: string
  path: string
  name: string
  claude_encoded_name: string | null
  added_at: number
  last_opened_at: number | null
  expanded_in_sidebar: number
  sort_order: number | null
  pinned_at: number | null
  github_owner: string | null
  github_repo: string | null
  github_avatar_url: string | null
  github_checked_at: number | null
}

// ---------------------------------------------------------------------------
// Mappers (mirror rowToWorkspaceRecord / rowToProjectRecord in src/main/)
// ---------------------------------------------------------------------------

function mapWorkspaceRow(row: DbWorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    nameIsAuto: row.name_is_auto === 1,
    cwd: row.cwd,
    pinnedAt: row.pinned_at,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
    archivedAt: row.archived_at,
    closedAt: row.closed_at,
    sortOrder: row.sort_order ?? null,
    status: row.status ?? 'idle',
    claudeSessionId: row.claude_session_id ?? null,
    forkedFromSessionId: row.forked_from_session_id ?? null,
    lastTitle: row.last_title ?? null,
    parentWorkspaceId: row.parent_workspace_id ?? null
  }
}

function mapProjectRow(row: DbProjectRow): ProjectRecord {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    claudeEncodedName: row.claude_encoded_name,
    addedAt: row.added_at,
    lastOpenedAt: row.last_opened_at,
    expandedInSidebar: row.expanded_in_sidebar === 1,
    sortOrder: row.sort_order ?? null,
    pinnedAt: row.pinned_at ?? null,
    githubOwner: row.github_owner ?? null,
    githubRepo: row.github_repo ?? null,
    githubAvatarUrl: row.github_avatar_url ?? null,
    githubCheckedAt: row.github_checked_at ?? null
  }
}

// ---------------------------------------------------------------------------
// listWorkspaces options
// ---------------------------------------------------------------------------

export type ListWorkspacesOpts = {
  projectId?: string
  status?: WorkspaceStatus
  includeArchived?: boolean
}

// ---------------------------------------------------------------------------
// OrpheusDb — read-only DB access class
// ---------------------------------------------------------------------------

export class OrpheusDb implements ContextDb {
  private readonly db: Database.Database

  // Prepared statements — initialised lazily on first use to avoid unnecessary
  // work when only a subset of methods are called.
  private stmts: {
    projectById?: Database.Statement
    projectByName?: Database.Statement
    projectByPath?: Database.Statement
    listProjectsNarrow?: Database.Statement
    workspaceById?: Database.Statement
    listProjectsFull?: Database.Statement
    projectFull?: Database.Statement
    getWorkspace?: Database.Statement
    listChildWorkspaces?: Database.Statement
    allWorkspaces?: Database.Statement
    allWorkspacesForProject?: Database.Statement
  } = {}

  // Cache for listWorkspaces() prepared statements, keyed by the composed SQL string.
  private listWorkspacesCache = new Map<string, Database.Statement>()

  constructor() {
    const dbPath = getSqlitePath()
    // Precheck with existsSync so we get a friendly error for the common case
    // (app never run / not installed). better-sqlite3's missing-file error is
    // SQLITE_CANTOPEN 'unable to open database file', not ENOENT, so the catch
    // below would miss it without this precheck.
    if (!fs.existsSync(dbPath)) {
      throw new OrpheusDataNotFoundError(dbPath)
    }
    try {
      this.db = new Database(dbPath, { readonly: true, fileMustExist: true })
    } catch (err: unknown) {
      // Fallback: catch ENOENT or "does not exist" variants just in case.
      if (
        err instanceof Error &&
        (err.message.includes('ENOENT') ||
          err.message.includes('does not exist') ||
          err.message.includes('unable to open database file'))
      ) {
        throw new OrpheusDataNotFoundError(dbPath)
      }
      throw err
    }
    // Do NOT set WAL or any write pragma — readonly connection must not mutate.
    // A readonly connection can still READ a WAL database fine.
  }

  // -------------------------------------------------------------------------
  // ContextDb interface
  // -------------------------------------------------------------------------

  getProjectById(id: string): ProjectRow | null {
    this.stmts.projectById ??= this.db.prepare('SELECT id, path, name FROM projects WHERE id = ?')
    const row = this.stmts.projectById.get(id) as ProjectRow | undefined
    return row ?? null
  }

  getProjectByName(name: string): ProjectRow | null {
    this.stmts.projectByName ??= this.db.prepare(
      'SELECT id, path, name FROM projects WHERE name = ?'
    )
    const row = this.stmts.projectByName.get(name) as ProjectRow | undefined
    return row ?? null
  }

  getProjectByPath(normalizedPath: string): ProjectRow | null {
    this.stmts.projectByPath ??= this.db.prepare(
      'SELECT id, path, name FROM projects WHERE path = ?'
    )
    const row = this.stmts.projectByPath.get(normalizedPath) as ProjectRow | undefined
    return row ?? null
  }

  listProjects(): ProjectRow[] {
    this.stmts.listProjectsNarrow ??= this.db.prepare('SELECT id, path, name FROM projects')
    return this.stmts.listProjectsNarrow.all() as ProjectRow[]
  }

  getWorkspaceById(id: string): WorkspaceRow | null {
    this.stmts.workspaceById ??= this.db.prepare(
      'SELECT id, project_id AS projectId FROM workspaces WHERE id = ?'
    )
    const row = this.stmts.workspaceById.get(id) as WorkspaceRow | undefined
    return row ?? null
  }

  // -------------------------------------------------------------------------
  // Broader read API
  // -------------------------------------------------------------------------

  /** Return the full ProjectRecord for a project by id, or null. */
  getProjectFull(id: string): ProjectRecord | null {
    this.stmts.projectFull ??= this.db.prepare('SELECT * FROM projects WHERE id = ?')
    const row = this.stmts.projectFull.get(id) as DbProjectRow | undefined
    return row != null ? mapProjectRow(row) : null
  }

  /** Return all projects with full field set, stable ordered. */
  listProjectsFull(): ProjectRecord[] {
    this.stmts.listProjectsFull ??= this.db.prepare(
      `SELECT * FROM projects
       ORDER BY pinned_at IS NULL, sort_order ASC NULLS LAST, added_at DESC`
    )
    return (this.stmts.listProjectsFull.all() as DbProjectRow[]).map(mapProjectRow)
  }

  /**
   * Return workspaces, with optional filtering.
   *
   * - projectId: restrict to a specific project
   * - status: exact match against workspace status column
   * - includeArchived: when false (default), excludes archived_at IS NOT NULL rows
   */
  listWorkspaces(opts: ListWorkspacesOpts = {}): WorkspaceRecord[] {
    const { projectId, status, includeArchived = false } = opts

    const conditions: string[] = []
    const bindings: unknown[] = []

    if (projectId != null) {
      conditions.push('project_id = ?')
      bindings.push(projectId)
    }

    if (status != null) {
      conditions.push('status = ?')
      bindings.push(status)
    }

    if (!includeArchived && status !== 'archived') {
      conditions.push('archived_at IS NULL')
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const sql = `SELECT * FROM workspaces ${where} ORDER BY pinned_at IS NULL, sort_order ASC NULLS LAST, created_at DESC`

    // Reuse a cached prepared statement for this exact SQL string; prepare once per unique variant.
    let stmt = this.listWorkspacesCache.get(sql)
    if (stmt == null) {
      stmt = this.db.prepare(sql)
      this.listWorkspacesCache.set(sql, stmt)
    }
    return (stmt.all(...bindings) as DbWorkspaceRow[]).map(mapWorkspaceRow)
  }

  /** Return a single WorkspaceRecord by id, or null. */
  getWorkspace(id: string): WorkspaceRecord | null {
    this.stmts.getWorkspace ??= this.db.prepare('SELECT * FROM workspaces WHERE id = ?')
    const row = this.stmts.getWorkspace.get(id) as DbWorkspaceRow | undefined
    return row != null ? mapWorkspaceRow(row) : null
  }

  /** Return direct children of a workspace (where parent_workspace_id = parentId), excluding archived. */
  listChildWorkspaces(parentId: string): WorkspaceRecord[] {
    this.stmts.listChildWorkspaces ??= this.db.prepare(
      `SELECT * FROM workspaces
       WHERE parent_workspace_id = ? AND archived_at IS NULL
       ORDER BY sort_order ASC NULLS LAST, created_at DESC`
    )
    return (this.stmts.listChildWorkspaces.all(parentId) as DbWorkspaceRow[]).map(mapWorkspaceRow)
  }

  /**
   * Build a parent→children lineage tree.
   *
   * If rootId is given, returns the subtree rooted at that workspace as a
   * single-element array. If rootId is omitted, returns the forest of all
   * root workspaces (those with parent_workspace_id IS NULL).
   *
   * Assembles the full tree in one pass to avoid N+1 queries:
   *   1. Fetch all workspaces (scoped to project if needed via opts)
   *   2. Index by id
   *   3. Wire children into parents
   */
  buildLineageTree(rootId?: string): WorkspaceTreeNode[] {
    // Fetch non-archived workspaces only so the tree matches what the CLI exposes.
    this.stmts.allWorkspaces ??= this.db.prepare(
      'SELECT * FROM workspaces WHERE archived_at IS NULL ORDER BY sort_order ASC NULLS LAST, created_at DESC'
    )
    const allRows = (this.stmts.allWorkspaces.all() as DbWorkspaceRow[]).map(mapWorkspaceRow)

    return this._assembleTree(allRows, rootId)
  }

  /**
   * Build a lineage tree scoped to a single project.
   * Equivalent to buildLineageTree() but only includes workspaces for the
   * given project, avoiding a full-table scan when large datasets are expected.
   */
  buildProjectLineageTree(projectId: string, rootId?: string): WorkspaceTreeNode[] {
    this.stmts.allWorkspacesForProject ??= this.db.prepare(
      `SELECT * FROM workspaces
       WHERE project_id = ? AND archived_at IS NULL
       ORDER BY sort_order ASC NULLS LAST, created_at DESC`
    )
    const rows = (this.stmts.allWorkspacesForProject.all(projectId) as DbWorkspaceRow[]).map(
      mapWorkspaceRow
    )

    return this._assembleTree(rows, rootId)
  }

  /** Shared tree-assembly logic used by both buildLineageTree variants. */
  private _assembleTree(workspaces: WorkspaceRecord[], rootId?: string): WorkspaceTreeNode[] {
    // Build a node map and adjacency list
    const nodeMap = new Map<string, WorkspaceTreeNode>()
    for (const ws of workspaces) {
      nodeMap.set(ws.id, { workspace: ws, children: [] })
    }

    // Wire children into their parents, guarding against cycles.
    // For each workspace, walk the ancestor chain; if attaching this node would
    // create a cycle (i.e. we'd reach ws.id again), skip the attachment so the
    // node still appears in the output but without forming a circular reference.
    for (const ws of workspaces) {
      if (ws.parentWorkspaceId == null) continue
      const parent = nodeMap.get(ws.parentWorkspaceId)
      const self = nodeMap.get(ws.id)
      if (parent == null || self == null) continue

      // Check whether attaching self under parent would form a cycle by
      // walking upward from parent to see if we'd encounter ws.id.
      const ancestorPath = new Set<string>()
      let cursor: string | null = ws.parentWorkspaceId
      let hasCycle = false
      while (cursor != null) {
        if (cursor === ws.id) {
          hasCycle = true
          break
        }
        if (ancestorPath.has(cursor)) break // already-detected upstream cycle — stop walking
        ancestorPath.add(cursor)
        const cursorNode = nodeMap.get(cursor)
        cursor = cursorNode?.workspace.parentWorkspaceId ?? null
      }

      if (!hasCycle) {
        parent.children.push(self)
      }
    }

    if (rootId != null) {
      const root = nodeMap.get(rootId)
      return root != null ? [root] : []
    }

    // Return all roots (workspaces with no parent, or whose parent isn't in the set)
    return workspaces
      .filter((ws) => ws.parentWorkspaceId == null || !nodeMap.has(ws.parentWorkspaceId))
      .map((ws) => nodeMap.get(ws.id)!)
  }

  /** Close the database connection. */
  close(): void {
    this.db.close()
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Open a read-only connection to the Orpheus SQLite database.
 * Throws OrpheusDataNotFoundError if the DB file doesn't exist.
 */
export function openDb(): OrpheusDb {
  return new OrpheusDb()
}
