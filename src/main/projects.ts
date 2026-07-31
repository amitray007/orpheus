import { BrowserWindow } from 'electron'
import { getDb } from './db'
import type { ProjectRecord, WorkspaceStatus } from '../shared/types'
import { importSessionsForProject } from './sessions'
import { createWorkspace } from './workspaces'
import { refreshGithubData } from './githubAvatar'
import * as nodePath from 'node:path'
import { invalidateClaudeProjectSettingsCache } from './claudeProjectSettings'
import { encodePathToClaudeDir } from './claudeProjectDir'
import { markRuntimeResourceScopeChanged } from './controlPlane/runtimeResourceScopeRevision'
import { PUSH_CHANNELS } from '../shared/ipc'

// ---------------------------------------------------------------------------
// DB row ↔ type mapping
// ---------------------------------------------------------------------------

// Hoisted: this exact SELECT is reused across addProject/openProject/getProject/
// setProjectPinned (5 call sites) — sonarjs/no-duplicate-string flags 5+ repeats
// of the same literal.
const SELECT_PROJECT_BY_ID = 'SELECT * FROM projects WHERE id = ?'

type ProjectRow = {
  id: string
  path: string
  name: string
  claude_encoded_name: string | null
  added_at: number
  last_opened_at: number | null
  expanded_in_sidebar: number
  sort_order: number | null
  pinned_at: number | null
  // v37
  github_owner: string | null
  github_repo: string | null
  github_avatar_url: string | null
  github_checked_at: number | null
  // v66
  classified: number
  hidden: number
}

function rowToRecord(row: ProjectRow): ProjectRecord {
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
    // v37
    githubOwner: row.github_owner ?? null,
    githubRepo: row.github_repo ?? null,
    githubAvatarUrl: row.github_avatar_url ?? null,
    githubCheckedAt: row.github_checked_at ?? null,
    // v66
    classified: (row.classified ?? 0) === 1,
    hidden: (row.hidden ?? 0) === 1
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function listProjects(): ProjectRecord[] {
  const db = getDb()
  // Stable ordering: explicit sort_order first (NULLS LAST), then added_at DESC.
  // last_opened_at is intentionally NOT a tiebreaker — using it reshuffles the
  // sidebar every time a project is opened, which makes positions feel random
  // across restarts. added_at never changes after insert.
  const rows = db
    .prepare(
      `SELECT * FROM projects
       ORDER BY pinned_at IS NULL, sort_order ASC NULLS LAST, added_at DESC`
    )
    .all() as ProjectRow[]
  return rows.map(rowToRecord)
}

export function reorderProjects(orderedIds: string[]): void {
  const db = getDb()
  const tx = db.transaction((ids: string[]) => {
    const stmt = db.prepare('UPDATE projects SET sort_order = ? WHERE id = ?')
    ids.forEach((id, idx) => stmt.run(idx, id))
  })
  tx(orderedIds)
}

// Activity-rank priority for reorderProjectsByActivity, best (lowest number)
// first. This mirrors the WorkspaceStatus enum (src/shared/types.ts) /
// WORKSPACE_STATUS (src/main/db/schema.ts) but is deliberately its OWN table:
// it's a UI ranking preference, not a 1:1 mirror of the status enum's
// declaration order, and re-ordering the schema enum must not silently
// reorder the sidebar. 'archived' is intentionally absent — archived
// workspaces are excluded by the `archived_at IS NULL` filter before this
// ranking is ever consulted, so they can never contribute a project's rank.
const ACTIVITY_RANK: Record<Exclude<WorkspaceStatus, 'archived'>, number> = {
  in_progress: 0, // an agent is actively working — most actionable for the user to jump into
  attention: 1, // blocked, needs the user (ranked below in_progress per product decision — see task notes)
  awaiting_input: 2,
  idle: 3
}
// Projects with no non-archived workspaces at all rank after every real
// status (worse than 'idle') — an empty project has nothing to resume.
const NO_WORKSPACES_RANK = 4

/**
 * Reorders projects so that, WITHIN EACH TIER SEPARATELY (pinned / unpinned —
 * the tiers never merge, pinned always sorts first via listProjects()'s own
 * `pinned_at IS NULL` primary ORDER BY key), projects rank by their BEST
 * (highest-priority) non-archived workspace status — see ACTIVITY_RANK.
 * This replaces the old binary "has any active workspace" test, which tied
 * every project with at least one workspace regardless of whether that
 * workspace was actually busy or just sitting idle. Order is stable within
 * each rank — current relative order among projects sharing a rank is
 * preserved. Persists via the same sort_order mechanism as reorderProjects.
 * Returns the new ordered id list so the renderer can apply it optimistically.
 */
export function reorderProjectsByActivity(): string[] {
  const db = getDb()
  const projects = listProjects() // current display order: pinned first, then sort_order/added_at

  // One grouped query rather than N per-project lookups: pull every
  // non-archived workspace's status per project, then reduce to the best
  // (lowest-rank) status per project in JS. MIN() over a CASE-mapped rank
  // would work in SQL too, but doing the reduce here keeps ACTIVITY_RANK as
  // the single source of truth for the ordering (no duplicated CASE
  // expression to keep in sync with it).
  const statusRows = db
    .prepare(`SELECT project_id, status FROM workspaces WHERE archived_at IS NULL`)
    .all() as { project_id: string; status: WorkspaceStatus }[]

  const bestRankById = new Map<string, number>()
  for (const row of statusRows) {
    const rank = ACTIVITY_RANK[row.status as Exclude<WorkspaceStatus, 'archived'>]
    if (rank === undefined) continue // defensive: archived rows are excluded by the WHERE clause already
    const current = bestRankById.get(row.project_id)
    if (current === undefined || rank < current) bestRankById.set(row.project_id, rank)
  }

  function rankOf(p: ProjectRecord): number {
    return bestRankById.get(p.id) ?? NO_WORKSPACES_RANK
  }

  // Stable sort by rank — Array.prototype.sort is stable per spec (Node/V8),
  // so projects sharing a rank keep their current relative order.
  function sortByRank(list: ProjectRecord[]): ProjectRecord[] {
    return [...list].sort((a, b) => rankOf(a) - rankOf(b))
  }

  const pinned = projects.filter((p) => p.pinnedAt != null)
  const unpinned = projects.filter((p) => p.pinnedAt == null)
  const newOrder = [...sortByRank(pinned), ...sortByRank(unpinned)]
  const orderedIds = newOrder.map((p) => p.id)
  reorderProjects(orderedIds)
  return orderedIds
}

export function addProject(path: string): ProjectRecord {
  const db = getDb()

  // Dedup: if a project with this path already exists, bump last_opened_at
  // and return it instead of inserting a duplicate.
  const existing = db.prepare('SELECT * FROM projects WHERE path = ?').get(path) as
    | ProjectRow
    | undefined

  if (existing) {
    db.prepare('UPDATE projects SET last_opened_at = ? WHERE id = ?').run(Date.now(), existing.id)
    const updated = db.prepare(SELECT_PROJECT_BY_ID).get(existing.id) as ProjectRow
    return rowToRecord(updated)
  }

  const id = crypto.randomUUID()
  const name = nodePath.basename(path)
  // Encode absolute path to Claude Code's directory-name format: slashes and dots -> dashes (see claudeProjectDir.ts).
  const claudeEncodedName = encodePathToClaudeDir(path)
  const addedAt = Date.now()

  // Insert project + default workspace atomically.
  const insertProject = db.transaction(() => {
    // New projects need a concrete sort_order, not NULL: listProjects() orders
    // by `sort_order ASC NULLS LAST`, so once ANY project in the tier has a
    // real integer sort_order (e.g. after a manual drag or an activity sort),
    // a NULL new project silently drops to the bottom of that ordering on the
    // next reload. The renderer's optimistic insert (Dashboard.tsx
    // handleAddProject) places new projects at the TOP of the unpinned tier —
    // so we match that here by taking one below the current minimum
    // sort_order among unpinned projects, keeping the optimistic position and
    // the post-reload position in agreement. Pinned projects are irrelevant
    // (a fresh project is always unpinned) and are excluded from the MIN.
    const minRow = db
      .prepare(
        `SELECT MIN(sort_order) as minOrder FROM projects WHERE pinned_at IS NULL AND sort_order IS NOT NULL`
      )
      .get() as { minOrder: number | null }
    const sortOrder = minRow.minOrder == null ? 0 : minRow.minOrder - 1

    db.prepare(
      `INSERT INTO projects (id, path, name, claude_encoded_name, added_at, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, path, name, claudeEncodedName, addedAt, sortOrder)

    const newProject = rowToRecord(db.prepare(SELECT_PROJECT_BY_ID).get(id) as ProjectRow)

    // Auto-create the Default workspace (cwd = project root)
    createWorkspace({ projectId: id, name: 'Default', cwd: path })

    return newProject
  })

  const project = insertProject()

  // Import sessions async so the main thread isn't blocked on N file reads
  // during project addition. Fire-and-forget; errors are non-fatal.
  importSessionsForProject(project).catch((err) => {
    console.warn('[sessions] importSessionsForProject failed for', project.id, err)
  })

  // Fire-and-forget: fetch GitHub avatar in the background after insert.
  void refreshGithubData(project.id).catch((err) => {
    console.warn('[github] initial avatar fetch failed for', project.id, err)
  })

  return project
}

export function openProject(id: string): ProjectRecord {
  const db = getDb()
  db.prepare('UPDATE projects SET last_opened_at = ? WHERE id = ?').run(Date.now(), id)
  const row = db.prepare(SELECT_PROJECT_BY_ID).get(id) as ProjectRow
  return rowToRecord(row)
}

/** Fetch a single project by id without touching last_opened_at. */
export function getProject(id: string): ProjectRecord | null {
  const db = getDb()
  const row = db.prepare(SELECT_PROJECT_BY_ID).get(id) as ProjectRow | undefined
  return row ? rowToRecord(row) : null
}

export function deleteProject(id: string): void {
  const db = getDb()
  // ON DELETE CASCADE in the schema removes associated workspaces and sessions.
  const result = db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  if (result.changes > 0) markRuntimeResourceScopeChanged()
  // Evict the settings cache entry so a stale value can't be served after the
  // row (and its CASCADE-deleted workspace settings) is gone.
  invalidateClaudeProjectSettingsCache(id)
}

export function renameProject(id: string, name: string): void {
  const db = getDb()
  db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, id)
}

export function setProjectExpandedInSidebar(id: string, expanded: boolean): void {
  const db = getDb()
  db.prepare('UPDATE projects SET expanded_in_sidebar = ? WHERE id = ?').run(expanded ? 1 : 0, id)
}

/**
 * Flip a project's pinned state AND renumber sort_order so both tiers stay
 * internally consistent afterward.
 *
 * WHY this is needed: reorderProjects() writes sort_order as a single FLAT
 * namespace (0..N-1) across BOTH tiers combined — it has no notion of tier
 * boundaries, because it's driven by listProjects()'s already-tiered display
 * order. setProjectPinned only used to flip pinned_at and leave sort_order
 * untouched. That meant a project kept whatever index it was assigned while
 * it lived in its OLD tier; moving it to the other tier could land it at an
 * arbitrary position (e.g. index 0, jumping to the very top) once
 * listProjects() re-sorts within the new tier. The result: sorting once,
 * then pinning/unpinning something unrelated days later, silently scrambled
 * the sidebar — a delayed, confusing symptom.
 *
 * THE RULE (chosen for predictability): after flipping pinned_at, renumber
 * BOTH tiers' sort_order contiguously from their current display order, with
 * the moved project placed at the END of its new tier. "Pinning moves a
 * project to the bottom of the pinned group; unpinning moves it to the
 * bottom of the unpinned group" is an easy mental model, doesn't require
 * guessing where in the middle of the other tier it "should" go, and leaves
 * every other project's relative order exactly as the user last arranged it.
 * Renumbering BOTH tiers (not just the destination one) keeps sort_order
 * gap-free and monotonic in both, so future reorderProjects() calls and
 * listProjects() reads stay simple and predictable.
 *
 * Wrapped in a transaction, same as reorderProjects, so a crash mid-write
 * can't leave sort_order partially renumbered.
 */
export function setProjectPinned(id: string, pinned: boolean): ProjectRecord {
  const db = getDb()
  const pinnedAt = pinned ? Date.now() : null

  const tx = db.transaction((): ProjectRow => {
    const updated = db
      .prepare('UPDATE projects SET pinned_at = ? WHERE id = ? RETURNING *')
      .get(pinnedAt, id) as ProjectRow | undefined
    if (!updated) throw new Error(`setProjectPinned: project not found: ${id}`)

    // Re-derive tiers from the post-flip state, using the CURRENT display
    // order (listProjects()'s own ordering) as the base — this preserves
    // every other project's relative position. Then pull the moved project
    // out of its tier and re-append it at the end, so it lands at the bottom
    // of its new tier rather than wherever its old sort_order happened to
    // place it.
    const projects = listProjects()
    const pinnedTier = projects.filter((p) => p.pinnedAt != null)
    const unpinnedTier = projects.filter((p) => p.pinnedAt == null)

    function moveToEnd(list: ProjectRecord[]): ProjectRecord[] {
      const rest = list.filter((p) => p.id !== id)
      const moved = list.find((p) => p.id === id)
      return moved ? [...rest, moved] : rest
    }

    const newPinnedTier = pinned ? moveToEnd(pinnedTier) : pinnedTier
    const newUnpinnedTier = pinned ? unpinnedTier : moveToEnd(unpinnedTier)

    const stmt = db.prepare('UPDATE projects SET sort_order = ? WHERE id = ?')
    let idx = 0
    for (const p of newPinnedTier) stmt.run(idx++, p.id)
    idx = 0
    for (const p of newUnpinnedTier) stmt.run(idx++, p.id)

    return db.prepare(SELECT_PROJECT_BY_ID).get(id) as ProjectRow
  })

  const row = tx()
  return rowToRecord(row)
}

// Broadcast helper — fan out a projects:changed event to all renderer windows
// so any component holding its own copy of the projects list (e.g. Dashboard's
// sidebar-driving state) can patch the record in place, mirroring
// broadcastWorkspaceChanged in workspaces.ts. Settings → Privacy already
// patches its own local list from the returned ProjectRecord; this covers
// every OTHER subscriber.
function broadcastProjectChanged(project: ProjectRecord): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(PUSH_CHANNELS.projectsChanged, { project })
    }
  }
}

export function setProjectClassified(id: string, classified: boolean): ProjectRecord {
  const db = getDb()
  const row = db
    .prepare('UPDATE projects SET classified = ? WHERE id = ? RETURNING *')
    .get(classified ? 1 : 0, id) as ProjectRow | undefined
  if (!row) throw new Error(`setProjectClassified: project not found: ${id}`)
  const record = rowToRecord(row)
  broadcastProjectChanged(record)
  return record
}

export function setProjectHidden(id: string, hidden: boolean): ProjectRecord {
  const db = getDb()
  const row = db
    .prepare('UPDATE projects SET hidden = ? WHERE id = ? RETURNING *')
    .get(hidden ? 1 : 0, id) as ProjectRow | undefined
  if (!row) throw new Error(`setProjectHidden: project not found: ${id}`)
  const record = rowToRecord(row)
  broadcastProjectChanged(record)
  return record
}
