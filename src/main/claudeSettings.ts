import { getDb } from './db'
import type {
  ClaudeGlobalSettings,
  ClaudeGlobalSettingsPatch,
  ClaudePermissionMode,
  ClaudeEffort
} from '../shared/types'

// ---------------------------------------------------------------------------
// DB row ↔ type mapping
// ---------------------------------------------------------------------------

type ClaudeSettingsRow = {
  id: number
  model: string
  permission_mode: string
  effort: string
  auto_memory: number
  always_thinking: number
  updated_at: number
}

function rowToRecord(row: ClaudeSettingsRow): ClaudeGlobalSettings {
  return {
    model: row.model,
    permissionMode: row.permission_mode as ClaudePermissionMode,
    effort: row.effort as ClaudeEffort,
    autoMemory: row.auto_memory === 1,
    alwaysThinking: row.always_thinking === 1,
    updatedAt: row.updated_at
  }
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

function validatePatch(patch: ClaudeGlobalSettingsPatch): void {
  if ('model' in patch) {
    if (typeof patch.model !== 'string' || patch.model.trim() === '') {
      throw new Error('claudeSettings: model must be a non-empty string')
    }
  }
  if ('permissionMode' in patch) {
    if (!VALID_PERMISSION_MODES.includes(patch.permissionMode as ClaudePermissionMode)) {
      throw new Error(
        `claudeSettings: permissionMode must be one of ${VALID_PERMISSION_MODES.join(', ')}`
      )
    }
  }
  if ('effort' in patch) {
    if (!VALID_EFFORTS.includes(patch.effort as ClaudeEffort)) {
      throw new Error(`claudeSettings: effort must be one of ${VALID_EFFORTS.join(', ')}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getClaudeGlobalSettings(): ClaudeGlobalSettings {
  const db = getDb()
  const row = db
    .prepare('SELECT * FROM claude_global_settings WHERE id = 1')
    .get() as ClaudeSettingsRow
  return rowToRecord(row)
}

export function updateClaudeGlobalSettings(
  patch: ClaudeGlobalSettingsPatch
): ClaudeGlobalSettings {
  validatePatch(patch)

  const db = getDb()
  const now = Date.now()

  // Build a dynamic SET clause covering only the provided keys
  const columnMap: Record<keyof ClaudeGlobalSettingsPatch, string> = {
    model: 'model',
    permissionMode: 'permission_mode',
    effort: 'effort',
    autoMemory: 'auto_memory',
    alwaysThinking: 'always_thinking'
  }

  const setClauses: string[] = []
  const values: unknown[] = []

  for (const key of Object.keys(patch) as (keyof ClaudeGlobalSettingsPatch)[]) {
    const col = columnMap[key]
    if (!col) continue
    setClauses.push(`${col} = ?`)
    const val = patch[key]
    // Coerce booleans to integers for SQLite
    values.push(typeof val === 'boolean' ? (val ? 1 : 0) : val)
  }

  if (setClauses.length === 0) {
    // Nothing to update — just return current state
    return getClaudeGlobalSettings()
  }

  setClauses.push('updated_at = ?')
  values.push(now)
  values.push(1) // WHERE id = 1

  db.prepare(
    `UPDATE claude_global_settings SET ${setClauses.join(', ')} WHERE id = ?`
  ).run(...values)

  const row = db
    .prepare('SELECT * FROM claude_global_settings WHERE id = 1')
    .get() as ClaudeSettingsRow
  return rowToRecord(row)
}
