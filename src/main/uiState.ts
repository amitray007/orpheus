import { getDb } from './db'
import type { AppUiState, AppUiStatePatch, AppViewKind } from '../shared/types'

// ---------------------------------------------------------------------------
// DB row ↔ type mapping
// ---------------------------------------------------------------------------

type AppUiStateRow = {
  id: number
  sidebar_collapsed: number
  last_view_kind: string
  last_project_id: string | null
  last_workspace_id: string | null
  updated_at: number
}

function rowToRecord(row: AppUiStateRow): AppUiState {
  return {
    sidebarCollapsed: row.sidebar_collapsed === 1,
    lastViewKind: row.last_view_kind as AppViewKind,
    lastProjectId: row.last_project_id,
    lastWorkspaceId: row.last_workspace_id,
    updatedAt: row.updated_at
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_VIEW_KINDS: AppViewKind[] = ['dashboard', 'sessions', 'project', 'workspace']

function validatePatch(patch: AppUiStatePatch): void {
  if ('lastViewKind' in patch) {
    if (!VALID_VIEW_KINDS.includes(patch.lastViewKind as AppViewKind)) {
      throw new Error(
        `uiState: lastViewKind must be one of ${VALID_VIEW_KINDS.join(', ')}`
      )
    }
  }
  if ('lastProjectId' in patch) {
    if (patch.lastProjectId !== null && typeof patch.lastProjectId !== 'string') {
      throw new Error('uiState: lastProjectId must be a string or null')
    }
  }
  if ('lastWorkspaceId' in patch) {
    if (patch.lastWorkspaceId !== null && typeof patch.lastWorkspaceId !== 'string') {
      throw new Error('uiState: lastWorkspaceId must be a string or null')
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getAppUiState(): AppUiState {
  const db = getDb()
  const row = db
    .prepare('SELECT * FROM app_ui_state WHERE id = 1')
    .get() as AppUiStateRow
  return rowToRecord(row)
}

export function updateAppUiState(patch: AppUiStatePatch): AppUiState {
  validatePatch(patch)

  const db = getDb()
  const now = Date.now()

  // Build a dynamic SET clause covering only the provided keys
  const columnMap: Record<keyof AppUiStatePatch, string> = {
    sidebarCollapsed: 'sidebar_collapsed',
    lastViewKind: 'last_view_kind',
    lastProjectId: 'last_project_id',
    lastWorkspaceId: 'last_workspace_id'
  }

  const setClauses: string[] = []
  const values: unknown[] = []

  for (const key of Object.keys(patch) as (keyof AppUiStatePatch)[]) {
    const col = columnMap[key]
    if (!col) continue
    setClauses.push(`${col} = ?`)
    const val = patch[key]
    // Coerce booleans to integers for SQLite
    values.push(typeof val === 'boolean' ? (val ? 1 : 0) : val)
  }

  if (setClauses.length === 0) {
    // Nothing to update — just return current state
    return getAppUiState()
  }

  setClauses.push('updated_at = ?')
  values.push(now)
  values.push(1) // WHERE id = 1

  db.prepare(
    `UPDATE app_ui_state SET ${setClauses.join(', ')} WHERE id = ?`
  ).run(...values)

  const row = db
    .prepare('SELECT * FROM app_ui_state WHERE id = 1')
    .get() as AppUiStateRow
  return rowToRecord(row)
}
