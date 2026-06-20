import { getDb } from './db'
import type {
  ClaudeWorkspaceSettings,
  ClaudeWorkspaceSettingsOverrides,
  ClaudePermissionMode,
  ClaudeEffort
} from '../shared/types'

// ---------------------------------------------------------------------------
// DB row ↔ type mapping
// ---------------------------------------------------------------------------

type Row = { workspace_id: string; overrides_json: string; updated_at: number }

function rowToRecord(row: Row): ClaudeWorkspaceSettings {
  let overrides: ClaudeWorkspaceSettingsOverrides = {}
  try {
    const parsed = JSON.parse(row.overrides_json)
    if (parsed && typeof parsed === 'object') overrides = parsed
  } catch {
    // corrupt JSON; treat as empty
  }
  return { workspaceId: row.workspace_id, overrides, updatedAt: row.updated_at }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_PERMISSION_MODES: ClaudePermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions'
]
const VALID_EFFORTS: ClaudeEffort[] = ['auto', 'low', 'medium', 'high', 'xhigh', 'max']

function validatePatch(patch: ClaudeWorkspaceSettingsOverrides): void {
  if (
    patch.permissionMode !== undefined &&
    !VALID_PERMISSION_MODES.includes(patch.permissionMode)
  ) {
    throw new Error(`Invalid permissionMode: ${patch.permissionMode}`)
  }
  if (patch.effort !== undefined && !VALID_EFFORTS.includes(patch.effort)) {
    throw new Error(`Invalid effort: ${patch.effort}`)
  }
  if (patch.model !== undefined && typeof patch.model !== 'string') {
    throw new Error('model must be a string')
  }
}

// ---------------------------------------------------------------------------
// Module-level cache — keyed by workspaceId. Invalidated on write.
// ---------------------------------------------------------------------------

const cachedWorkspaceSettings = new Map<string, ClaudeWorkspaceSettings>()

export function invalidateClaudeWorkspaceSettingsCache(workspaceId: string): void {
  cachedWorkspaceSettings.delete(workspaceId)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getClaudeWorkspaceSettings(workspaceId: string): ClaudeWorkspaceSettings {
  const cached = cachedWorkspaceSettings.get(workspaceId)
  if (cached) return cached

  const db = getDb()
  const row = db
    .prepare('SELECT * FROM claude_workspace_settings WHERE workspace_id = ?')
    .get(workspaceId) as Row | undefined
  const result = row ? rowToRecord(row) : { workspaceId, overrides: {}, updatedAt: 0 }
  cachedWorkspaceSettings.set(workspaceId, result)
  return result
}

export function updateClaudeWorkspaceSettings(
  workspaceId: string,
  patch: ClaudeWorkspaceSettingsOverrides
): ClaudeWorkspaceSettings {
  validatePatch(patch)

  const db = getDb()
  const existing = getClaudeWorkspaceSettings(workspaceId)

  // Merge: explicit `undefined` or `null` in patch means "clear that override"
  const merged: ClaudeWorkspaceSettingsOverrides = { ...existing.overrides }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) {
      delete merged[key as keyof ClaudeWorkspaceSettingsOverrides]
    } else {
      ;(merged as Record<string, unknown>)[key] = value
    }
  }

  const json = JSON.stringify(merged)
  const now = Date.now()
  db.prepare(
    `INSERT INTO claude_workspace_settings (workspace_id, overrides_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET overrides_json = excluded.overrides_json, updated_at = excluded.updated_at`
  ).run(workspaceId, json, now)

  // Invalidate cache so next read (recomputeDirty, terminal:mount) sees fresh data
  invalidateClaudeWorkspaceSettingsCache(workspaceId)
  return getClaudeWorkspaceSettings(workspaceId)
}
