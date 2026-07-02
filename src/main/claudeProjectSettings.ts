import { getDb } from './db'
import { logDiagMain } from './diagnostics'
import { DIAG_EVENTS } from '../shared/diagEvents'
import type {
  ClaudeProjectSettings,
  ClaudeProjectSettingsOverrides,
  ClaudePermissionMode,
  ClaudeEffort
} from '../shared/types'

// ---------------------------------------------------------------------------
// DB row ↔ type mapping
// ---------------------------------------------------------------------------

type Row = { project_id: string; overrides_json: string; updated_at: number }

function rowToRecord(row: Row): ClaudeProjectSettings {
  let overrides: ClaudeProjectSettingsOverrides = {}
  try {
    const parsed = JSON.parse(row.overrides_json)
    if (parsed && typeof parsed === 'object') overrides = parsed
  } catch (err) {
    // corrupt JSON; treat as empty
    logDiagMain({
      category: 'anomaly',
      level: 'warn',
      event: DIAG_EVENTS.OVERRIDES_PARSE_FAILED,
      message: 'corrupt overrides_json',
      data: { id: row.project_id, err: String(err) }
    })
  }
  return { projectId: row.project_id, overrides, updatedAt: row.updated_at }
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

function validatePatch(patch: ClaudeProjectSettingsOverrides): void {
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
// Module-level cache — keyed by projectId. Invalidated on write.
// ---------------------------------------------------------------------------

const cachedProjectSettings = new Map<string, ClaudeProjectSettings>()

export function invalidateClaudeProjectSettingsCache(projectId: string): void {
  cachedProjectSettings.delete(projectId)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getClaudeProjectSettings(projectId: string): ClaudeProjectSettings {
  const cached = cachedProjectSettings.get(projectId)
  if (cached) return cached

  const db = getDb()
  const row = db
    .prepare('SELECT * FROM claude_project_settings WHERE project_id = ?')
    .get(projectId) as Row | undefined
  const result = row ? rowToRecord(row) : { projectId, overrides: {}, updatedAt: 0 }
  cachedProjectSettings.set(projectId, result)
  return result
}

export function updateClaudeProjectSettings(
  projectId: string,
  patch: ClaudeProjectSettingsOverrides
): ClaudeProjectSettings {
  validatePatch(patch)

  const db = getDb()
  const existing = getClaudeProjectSettings(projectId)

  // Merge: explicit `undefined` or `null` in patch means "clear that override"
  const merged: ClaudeProjectSettingsOverrides = { ...existing.overrides }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) {
      delete merged[key as keyof ClaudeProjectSettingsOverrides]
    } else {
      ;(merged as Record<string, unknown>)[key] = value
    }
  }

  const json = JSON.stringify(merged)
  const now = Date.now()
  db.prepare(
    `INSERT INTO claude_project_settings (project_id, overrides_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET overrides_json = excluded.overrides_json, updated_at = excluded.updated_at`
  ).run(projectId, json, now)

  // Invalidate cache so next read (recomputeDirty, terminal:mount) sees fresh data
  invalidateClaudeProjectSettingsCache(projectId)
  return getClaudeProjectSettings(projectId)
}
