import { getDb } from './db'
import type {
  ClaudeGlobalSettings,
  ClaudeGlobalSettingsPatch,
  ClaudePermissionMode,
  ClaudeEffort,
  ClaudeOutputStyle,
  ClaudeTuiMode,
  ClaudeEditorMode
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
  output_style: string
  tui_mode: string
  editor_mode: string
  reduce_motion: number
  native_cursor: number
  hide_cwd: number
  updated_at: number
}

function rowToRecord(row: ClaudeSettingsRow): ClaudeGlobalSettings {
  return {
    model: row.model,
    permissionMode: row.permission_mode as ClaudePermissionMode,
    effort: row.effort as ClaudeEffort,
    autoMemory: row.auto_memory === 1,
    alwaysThinking: row.always_thinking === 1,
    outputStyle: row.output_style as ClaudeOutputStyle,
    tuiMode: row.tui_mode as ClaudeTuiMode,
    editorMode: row.editor_mode as ClaudeEditorMode,
    reduceMotion: row.reduce_motion === 1,
    nativeCursor: row.native_cursor === 1,
    hideCwd: row.hide_cwd === 1,
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
const VALID_OUTPUT_STYLES: ClaudeOutputStyle[] = ['default', 'explanatory', 'proactive', 'learning']
const VALID_TUI_MODES: ClaudeTuiMode[] = ['default', 'fullscreen']
const VALID_EDITOR_MODES: ClaudeEditorMode[] = ['normal', 'vim']

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
  if ('outputStyle' in patch) {
    if (!VALID_OUTPUT_STYLES.includes(patch.outputStyle as ClaudeOutputStyle)) {
      throw new Error(`claudeSettings: outputStyle must be one of ${VALID_OUTPUT_STYLES.join(', ')}`)
    }
  }
  if ('tuiMode' in patch) {
    if (!VALID_TUI_MODES.includes(patch.tuiMode as ClaudeTuiMode)) {
      throw new Error(`claudeSettings: tuiMode must be one of ${VALID_TUI_MODES.join(', ')}`)
    }
  }
  if ('editorMode' in patch) {
    if (!VALID_EDITOR_MODES.includes(patch.editorMode as ClaudeEditorMode)) {
      throw new Error(`claudeSettings: editorMode must be one of ${VALID_EDITOR_MODES.join(', ')}`)
    }
  }
  if ('reduceMotion' in patch && typeof patch.reduceMotion !== 'boolean') {
    throw new Error('claudeSettings: reduceMotion must be a boolean')
  }
  if ('nativeCursor' in patch && typeof patch.nativeCursor !== 'boolean') {
    throw new Error('claudeSettings: nativeCursor must be a boolean')
  }
  if ('hideCwd' in patch && typeof patch.hideCwd !== 'boolean') {
    throw new Error('claudeSettings: hideCwd must be a boolean')
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
    alwaysThinking: 'always_thinking',
    outputStyle: 'output_style',
    tuiMode: 'tui_mode',
    editorMode: 'editor_mode',
    reduceMotion: 'reduce_motion',
    nativeCursor: 'native_cursor',
    hideCwd: 'hide_cwd'
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
