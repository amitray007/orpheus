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
  window_x: number | null
  window_y: number | null
  window_width: number | null
  window_height: number | null
  window_fullscreen: number
  // Window behavior preferences (v11)
  restore_geometry: number
  close_hides: number
  open_at_last_view: number
  // Sidebar behavior preferences (v12)
  pinned_section_visible: number
  workspace_count_inline: number
  sidebar_width: number
  default_project_expanded: number
  // Launch + hotkey (v18)
  launch_at_login: number
  global_hotkey: string
  // Archive cap (v25)
  archived_workspace_limit: number
  // Notification preferences (v29)
  notify_attention: number
  notify_stop: number
  notify_always: number
  // Persistent attention reminders (v30)
  notify_max_attention_repeats: number
  updated_at: number
}

function rowToRecord(row: AppUiStateRow): AppUiState {
  // Clamp sidebar_width to valid range at read time — guards against manual DB edits
  const rawWidth = row.sidebar_width ?? 256
  const clampedWidth = Math.min(480, Math.max(200, rawWidth))
  return {
    sidebarCollapsed: row.sidebar_collapsed === 1,
    lastViewKind: row.last_view_kind as AppViewKind,
    lastProjectId: row.last_project_id,
    lastWorkspaceId: row.last_workspace_id,
    windowX: row.window_x,
    windowY: row.window_y,
    windowWidth: row.window_width,
    windowHeight: row.window_height,
    windowFullscreen: row.window_fullscreen === 1,
    // Window behavior preferences (v11) — default 1 matches schema DEFAULT
    restoreGeometry: (row.restore_geometry ?? 1) === 1,
    closeHides: (row.close_hides ?? 1) === 1,
    openAtLastView: (row.open_at_last_view ?? 1) === 1,
    // Sidebar behavior preferences (v12)
    pinnedSectionVisible: (row.pinned_section_visible ?? 1) === 1,
    workspaceCountInline: (row.workspace_count_inline ?? 1) === 1,
    sidebarWidth: clampedWidth,
    defaultProjectExpanded: (row.default_project_expanded ?? 0) === 1,
    // Launch + hotkey (v18)
    launchAtLogin: (row.launch_at_login ?? 0) === 1,
    globalHotkey: row.global_hotkey ?? '',
    // Archive cap (v25)
    archivedWorkspaceLimit: row.archived_workspace_limit ?? 20,
    // Notification preferences (v29)
    notifyAttention: (row.notify_attention ?? 1) === 1,
    notifyStop: (row.notify_stop ?? 1) === 1,
    notifyAlways: (row.notify_always ?? 0) === 1,
    notifyMaxAttentionRepeats: row.notify_max_attention_repeats ?? 5,
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
    lastWorkspaceId: 'last_workspace_id',
    windowX: 'window_x',
    windowY: 'window_y',
    windowWidth: 'window_width',
    windowHeight: 'window_height',
    windowFullscreen: 'window_fullscreen',
    // Window behavior preferences (v11)
    restoreGeometry: 'restore_geometry',
    closeHides: 'close_hides',
    openAtLastView: 'open_at_last_view',
    // Sidebar behavior preferences (v12)
    pinnedSectionVisible: 'pinned_section_visible',
    workspaceCountInline: 'workspace_count_inline',
    sidebarWidth: 'sidebar_width',
    defaultProjectExpanded: 'default_project_expanded',
    // Launch + hotkey (v18)
    launchAtLogin: 'launch_at_login',
    globalHotkey: 'global_hotkey',
    // Archive cap (v25)
    archivedWorkspaceLimit: 'archived_workspace_limit',
    // Notification preferences (v29)
    notifyAttention: 'notify_attention',
    notifyStop: 'notify_stop',
    notifyAlways: 'notify_always',
    // Persistent attention reminders (v30)
    notifyMaxAttentionRepeats: 'notify_max_attention_repeats'
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
