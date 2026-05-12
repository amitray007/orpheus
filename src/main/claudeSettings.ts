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
// Launch composition
// ---------------------------------------------------------------------------

export type ClaudeLaunch = {
  /** Whitespace-separated CLI flags, e.g. "--model opus --permission-mode acceptEdits".
   *  Empty string when all settings are at their claude defaults. */
  flags: string
  /** Inline JSON blob for --settings, covering keys with no CLI flag equivalent
   *  (alwaysThinkingEnabled, outputStyle, tui, editorMode, prefersReducedMotion).
   *  Empty string when no such keys differ from claude's defaults. */
  settingsJson: string
  /** Environment variables to set in the surface process, e.g.
   *  { CLAUDE_CODE_NATIVE_CURSOR: '1' }. Empty object when all at defaults. */
  env: Record<string, string>
}

/**
 * Read the current ClaudeGlobalSettings and produce the three buckets needed
 * to wire them into the claude invocation at workspace launch time.
 *
 * Invariant: for the seeded default state (all fields at DB defaults),
 *   flags === '' && settingsJson === '' && env === {}
 * which means the wrapper runs bare `claude` with no extra arguments.
 */
export function composeClaudeLaunch(): ClaudeLaunch {
  const s = getClaudeGlobalSettings()

  // -------------------------------------------------------------------------
  // 1. CLI flags
  // -------------------------------------------------------------------------
  const flagParts: string[] = []

  // --model: always pass for explicitness; 'sonnet' is claude's default but
  // being explicit avoids any ambient ANTHROPIC_MODEL env var surprises.
  // Only skip for the literal default 'sonnet' so bare claude is preserved
  // when the user hasn't changed anything.
  if (s.model && s.model !== 'sonnet') {
    flagParts.push(`--model ${s.model}`)
  }

  // --permission-mode: skip 'default' (claude's default mode)
  if (s.permissionMode && s.permissionMode !== 'default') {
    flagParts.push(`--permission-mode ${s.permissionMode}`)
  }

  // --effort: skip 'auto' (let claude pick the effort level)
  if (s.effort && s.effort !== 'auto') {
    flagParts.push(`--effort ${s.effort}`)
  }

  const flags = flagParts.join(' ')

  // -------------------------------------------------------------------------
  // 2. settings.json blob (keys with no CLI flag equivalent)
  // -------------------------------------------------------------------------
  const settingsObj: Record<string, unknown> = {}

  // alwaysThinkingEnabled — only set when true (default is false)
  if (s.alwaysThinking) {
    settingsObj['alwaysThinkingEnabled'] = true
  }

  // outputStyle — capitalize first letter; skip 'default' (claude's default)
  // Claude expects capitalized values: "Explanatory", "Proactive", "Learning"
  if (s.outputStyle && s.outputStyle !== 'default') {
    const capitalized = s.outputStyle.charAt(0).toUpperCase() + s.outputStyle.slice(1)
    settingsObj['outputStyle'] = capitalized
  }

  // tui — settings.json key is "tui"; skip 'default'
  if (s.tuiMode && s.tuiMode !== 'default') {
    settingsObj['tui'] = s.tuiMode
  }

  // editorMode — skip 'normal' (claude's default)
  if (s.editorMode && s.editorMode !== 'normal') {
    settingsObj['editorMode'] = s.editorMode
  }

  // prefersReducedMotion — only set when true (default is false)
  if (s.reduceMotion) {
    settingsObj['prefersReducedMotion'] = true
  }

  const settingsJson = Object.keys(settingsObj).length > 0 ? JSON.stringify(settingsObj) : ''

  // -------------------------------------------------------------------------
  // 3. Environment variables
  // -------------------------------------------------------------------------
  const env: Record<string, string> = {}

  // CLAUDE_CODE_DISABLE_AUTO_MEMORY: set when autoMemory is explicitly false
  if (!s.autoMemory) {
    env['CLAUDE_CODE_DISABLE_AUTO_MEMORY'] = '1'
  }

  // CLAUDE_CODE_NATIVE_CURSOR: set when nativeCursor is true
  if (s.nativeCursor) {
    env['CLAUDE_CODE_NATIVE_CURSOR'] = '1'
  }

  // CLAUDE_CODE_HIDE_CWD: set when hideCwd is true
  if (s.hideCwd) {
    env['CLAUDE_CODE_HIDE_CWD'] = '1'
  }

  return { flags, settingsJson, env }
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
