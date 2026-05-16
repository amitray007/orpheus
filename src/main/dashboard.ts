import { exec as execCb } from 'node:child_process'
import { promisify } from 'node:util'
import { getDb } from './db'
import type { HeatmapEntry, ProjectRecord, WorkspaceRecord } from '../shared/types'

const exec = promisify(execCb)

// ---------------------------------------------------------------------------
// DB row types (mirrors shapes in projects.ts / workspaces.ts without coupling)
// ---------------------------------------------------------------------------

type ProjectRow = {
  id: string
  path: string
  name: string
  claude_encoded_name: string | null
  added_at: number
  last_opened_at: number | null
  expanded_in_sidebar: number
  sort_order: number | null
}

type WorkspaceRow = {
  id: string
  project_id: string
  name: string
  name_is_auto: number
  cwd: string
  pinned_at: number | null
  created_at: number
  last_opened_at: number | null
  archived_at: number | null
  status: string
  sort_order: number | null
  claude_session_id: string | null
  last_title: string | null
}

function projectRowToRecord(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    claudeEncodedName: row.claude_encoded_name,
    addedAt: row.added_at,
    lastOpenedAt: row.last_opened_at,
    expandedInSidebar: row.expanded_in_sidebar === 1,
    sortOrder: row.sort_order ?? null
  }
}

function workspaceRowToRecord(row: WorkspaceRow): WorkspaceRecord {
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
    sortOrder: row.sort_order ?? null,
    status: (row.status as WorkspaceRecord['status']) ?? 'idle',
    claudeSessionId: row.claude_session_id ?? null
  }
}

// ---------------------------------------------------------------------------
// Activity heatmap
// ---------------------------------------------------------------------------

function computeLevel(count: number): 0 | 1 | 2 | 3 | 4 {
  if (count >= 11) return 4
  if (count >= 6) return 3
  if (count >= 3) return 2
  if (count >= 1) return 1
  return 0
}

/**
 * Aggregates git commit dates across all tracked projects for the last `days`
 * days and returns a heatmap-ready array with the full window filled in.
 *
 * Safety: `days` is a number under our control — it's interpolated directly
 * into the command string. `p.path` is used only as `cwd`, never interpolated
 * into the shell command string.
 */
export async function getActivityHeatmap(days: number = 30): Promise<HeatmapEntry[]> {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM projects').all() as ProjectRow[]

  const perRepoDates = await Promise.all(
    rows.map(async (p) => {
      try {
        const { stdout } = await exec(
          `git log --since="${days} days ago" --pretty=format:"%aI" --no-merges`,
          { cwd: p.path, timeout: 5000 }
        )
        return stdout
          .split('\n')
          .filter(Boolean)
          .map((d) => d.slice(0, 10))
      } catch {
        return []
      }
    })
  )

  const counts: Record<string, number> = {}
  for (const dates of perRepoDates) {
    for (const d of dates) {
      counts[d] = (counts[d] ?? 0) + 1
    }
  }

  const out: HeatmapEntry[] = []
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10)
    const c = counts[date] ?? 0
    out.push({ date, count: c, level: computeLevel(c) })
  }
  return out
}

// ---------------------------------------------------------------------------
// Recent projects
// ---------------------------------------------------------------------------

export function listRecentProjects(limit: number = 5): ProjectRecord[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT * FROM projects
       ORDER BY last_opened_at DESC NULLS LAST, added_at DESC
       LIMIT ?`
    )
    .all(limit) as ProjectRow[]
  return rows.map(projectRowToRecord)
}

// ---------------------------------------------------------------------------
// Recent workspaces
// ---------------------------------------------------------------------------

export function listRecentWorkspaces(limit: number = 5): WorkspaceRecord[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT * FROM workspaces
       WHERE archived_at IS NULL
       ORDER BY last_opened_at DESC NULLS LAST, created_at DESC
       LIMIT ?`
    )
    .all(limit) as WorkspaceRow[]
  return rows.map(workspaceRowToRecord)
}
