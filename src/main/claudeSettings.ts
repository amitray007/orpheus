import { getDb } from './db'
import type {
  ClaudeGlobalSettings,
  ClaudeGlobalSettingsPatch,
  ClaudePermissionMode,
  ClaudeEffort,
  ClaudeOutputStyle,
  ClaudeTuiMode,
  ClaudeEditorMode,
  ClaudeLogLevel
} from '../shared/types'
import { getClaudeProjectSettings } from './claudeProjectSettings'
import { getClaudeWorkspaceSettings } from './claudeWorkspaceSettings'

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
  // Memory section (v9)
  disable_git_instructions: number
  max_output_tokens: number | null
  max_context_tokens: number | null
  compaction_threshold: number | null
  // Developer section (v9)
  debug_logging: number
  log_level: string
  disable_telemetry: number
  disable_error_reporting: number
  disable_autoupdater: number
  experimental_agent_teams: number
  experimental_forked_subagents: number
  simple_system_prompt: number
  // Permissions section (v9)
  auto_approve_edits: number
  ask_destructive_bash: number
  plan_mode_default: number
  permission_allow_rules: string
  permission_ask_rules: string
  permission_deny_rules: string
  permission_additional_dirs: string
  // Fallback model (v11)
  fallback_model: string
  // Tools section (v14)
  bash_default_timeout_ms: number | null
  bash_max_timeout_ms: number | null
  bash_max_output_length: number | null
  tool_concurrency: number | null
  browser_integration: number
  disabled_mcp_servers: string
  custom_env_vars: string
  updated_at: number
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed as string[]
    return []
  } catch {
    return []
  }
}

function parseJsonRecord(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>
    }
    return {}
  } catch {
    return {}
  }
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
    // Memory section
    disableGitInstructions: row.disable_git_instructions === 1,
    maxOutputTokens: row.max_output_tokens ?? null,
    maxContextTokens: row.max_context_tokens ?? null,
    compactionThreshold: row.compaction_threshold ?? null,
    // Developer section
    debugLogging: row.debug_logging === 1,
    logLevel: (row.log_level ?? 'info') as ClaudeLogLevel,
    disableTelemetry: row.disable_telemetry === 1,
    disableErrorReporting: row.disable_error_reporting === 1,
    disableAutoupdater: row.disable_autoupdater === 1,
    experimentalAgentTeams: row.experimental_agent_teams === 1,
    experimentalForkedSubagents: row.experimental_forked_subagents === 1,
    simpleSystemPrompt: row.simple_system_prompt === 1,
    // Permissions section
    autoApproveEdits: row.auto_approve_edits === 1,
    askDestructiveBash: row.ask_destructive_bash === 1,
    planModeDefault: row.plan_mode_default === 1,
    permissionAllowRules: parseJsonArray(row.permission_allow_rules),
    permissionAskRules: parseJsonArray(row.permission_ask_rules),
    permissionDenyRules: parseJsonArray(row.permission_deny_rules),
    permissionAdditionalDirs: parseJsonArray(row.permission_additional_dirs),
    // Fallback model (v11)
    fallbackModel: row.fallback_model ?? '',
    // Tools section (v14)
    bashDefaultTimeoutMs: row.bash_default_timeout_ms ?? null,
    bashMaxTimeoutMs: row.bash_max_timeout_ms ?? null,
    bashMaxOutputLength: row.bash_max_output_length ?? null,
    toolConcurrency: row.tool_concurrency ?? null,
    browserIntegration: (row.browser_integration ?? 1) === 1,
    disabledMcpServers: parseJsonArray(row.disabled_mcp_servers),
    customEnvVars: parseJsonRecord(row.custom_env_vars),
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
const VALID_LOG_LEVELS: ClaudeLogLevel[] = ['debug', 'info', 'warn', 'error']

const BOOLEAN_KEYS: (keyof ClaudeGlobalSettingsPatch)[] = [
  'autoMemory', 'alwaysThinking', 'reduceMotion', 'nativeCursor', 'hideCwd',
  'disableGitInstructions', 'debugLogging', 'disableTelemetry', 'disableErrorReporting',
  'disableAutoupdater', 'experimentalAgentTeams', 'experimentalForkedSubagents',
  'simpleSystemPrompt', 'autoApproveEdits', 'askDestructiveBash', 'planModeDefault',
  'browserIntegration'
]

const STRING_ARRAY_KEYS: (keyof ClaudeGlobalSettingsPatch)[] = [
  'permissionAllowRules', 'permissionAskRules', 'permissionDenyRules', 'permissionAdditionalDirs',
  'disabledMcpServers'
]

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
  if ('logLevel' in patch) {
    if (!VALID_LOG_LEVELS.includes(patch.logLevel as ClaudeLogLevel)) {
      throw new Error(`claudeSettings: logLevel must be one of ${VALID_LOG_LEVELS.join(', ')}`)
    }
  }
  for (const key of BOOLEAN_KEYS) {
    if (key in patch && typeof patch[key] !== 'boolean') {
      throw new Error(`claudeSettings: ${key} must be a boolean`)
    }
  }
  if ('maxOutputTokens' in patch) {
    const v = patch.maxOutputTokens
    if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 1)) {
      throw new Error('claudeSettings: maxOutputTokens must be a positive integer or null')
    }
  }
  if ('maxContextTokens' in patch) {
    const v = patch.maxContextTokens
    if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 1)) {
      throw new Error('claudeSettings: maxContextTokens must be a positive integer or null')
    }
  }
  if ('compactionThreshold' in patch) {
    const v = patch.compactionThreshold
    if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 100)) {
      throw new Error('claudeSettings: compactionThreshold must be an integer 1–100 or null')
    }
  }
  for (const key of STRING_ARRAY_KEYS) {
    if (key in patch) {
      const v = patch[key]
      if (!Array.isArray(v) || !(v as unknown[]).every((item) => typeof item === 'string')) {
        throw new Error(`claudeSettings: ${key} must be a string[]`)
      }
    }
  }
  if ('fallbackModel' in patch) {
    if (typeof patch.fallbackModel !== 'string') {
      throw new Error('claudeSettings: fallbackModel must be a string')
    }
  }
  if ('bashDefaultTimeoutMs' in patch) {
    const v = patch.bashDefaultTimeoutMs
    if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 1)) {
      throw new Error('claudeSettings: bashDefaultTimeoutMs must be a positive integer or null')
    }
  }
  if ('bashMaxTimeoutMs' in patch) {
    const v = patch.bashMaxTimeoutMs
    if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 1)) {
      throw new Error('claudeSettings: bashMaxTimeoutMs must be a positive integer or null')
    }
  }
  if ('bashMaxOutputLength' in patch) {
    const v = patch.bashMaxOutputLength
    if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 1)) {
      throw new Error('claudeSettings: bashMaxOutputLength must be a positive integer or null')
    }
  }
  if ('toolConcurrency' in patch) {
    const v = patch.toolConcurrency
    if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 1)) {
      throw new Error('claudeSettings: toolConcurrency must be a positive integer or null')
    }
  }
  if ('customEnvVars' in patch) {
    const v = patch.customEnvVars
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      throw new Error('claudeSettings: customEnvVars must be a Record<string, string>')
    }
    const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (!KEY_RE.test(k)) {
        throw new Error(`claudeSettings: customEnvVars key "${k}" is not a valid env var name`)
      }
      if (typeof val !== 'string') {
        throw new Error(`claudeSettings: customEnvVars value for "${k}" must be a string`)
      }
    }
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
 * Read the current ClaudeGlobalSettings (and optional per-project overrides) and
 * produce the three buckets needed to wire them into the claude invocation at
 * workspace launch time.
 *
 * Invariant: for the seeded default state (all fields at DB defaults, no project
 * overrides), flags === '' && settingsJson === '' && env === {}
 * which means the wrapper runs bare `claude` with no extra arguments.
 */
export function composeClaudeLaunch(projectId?: string, workspaceId?: string): ClaudeLaunch {
  const global = getClaudeGlobalSettings()

  // Merge project-level overrides (model, permissionMode, effort) on top of global
  let s = global
  if (projectId) {
    const proj = getClaudeProjectSettings(projectId)
    const ov = proj.overrides
    if (Object.keys(ov).length > 0) {
      s = {
        ...s,
        ...(ov.model !== undefined ? { model: ov.model } : {}),
        ...(ov.permissionMode !== undefined ? { permissionMode: ov.permissionMode } : {}),
        ...(ov.effort !== undefined ? { effort: ov.effort } : {})
      }
    }
  }

  // Workspace overrides sit above project overrides — highest precedence before CLI flags
  if (workspaceId) {
    const ws = getClaudeWorkspaceSettings(workspaceId)
    const wov = ws.overrides
    if (Object.keys(wov).length > 0) {
      s = {
        ...s,
        ...(wov.model !== undefined ? { model: wov.model } : {}),
        ...(wov.permissionMode !== undefined ? { permissionMode: wov.permissionMode } : {}),
        ...(wov.effort !== undefined ? { effort: wov.effort } : {})
      }
    }
  }

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
  // planModeDefault quick-toggle overrides if General permissionMode is still 'default'
  const effectivePermissionMode =
    s.permissionMode !== 'default'
      ? s.permissionMode
      : s.planModeDefault
        ? 'plan'
        : 'default'
  if (effectivePermissionMode !== 'default') {
    flagParts.push(`--permission-mode ${effectivePermissionMode}`)
  }

  // --effort: skip 'auto' (let claude pick the effort level)
  if (s.effort && s.effort !== 'auto') {
    flagParts.push(`--effort ${s.effort}`)
  }

  // --debug: enable verbose debug logging
  if (s.debugLogging) {
    flagParts.push('--debug')
  }

  // --fallback-model: only emit when non-empty
  if (s.fallbackModel && s.fallbackModel.trim() !== '') {
    flagParts.push(`--fallback-model ${s.fallbackModel.trim()}`)
  }

  // --no-chrome: disable claude's browser integration (default is enabled)
  // Note: claude CLI flag name not confirmed in published docs; stored in DB,
  // compose is a no-op until the stable flag name is verified.
  // Uncomment when confirmed:
  // if (!s.browserIntegration) {
  //   flagParts.push('--no-chrome')
  // }

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

  // simpleSystemPrompt — settings.json key
  if (s.simpleSystemPrompt) {
    settingsObj['simpleSystemPrompt'] = true
  }

  // Permission rules — settings.json keys: permissions.allow / .ask / .deny / .additionalDirectories
  // Compose permission arrays: merge stored rules with quick-control toggles
  const allowRules = [...s.permissionAllowRules]
  const askRules = [...s.permissionAskRules]
  const denyRules = [...s.permissionDenyRules]

  // autoApproveEdits: adds "Edit" to allow list (lets claude edit files without prompting)
  // Design note: we inject at compose time so the raw stored list stays clean
  if (s.autoApproveEdits && !allowRules.includes('Edit')) {
    allowRules.push('Edit')
  }

  // askDestructiveBash: adds common destructive patterns to the ask list
  if (s.askDestructiveBash) {
    const destructivePatterns = [
      'Bash(rm *)',
      'Bash(rmdir *)',
      'Bash(git reset *)',
      'Bash(git push --force*)',
      'Bash(git clean *)',
      'Bash(DROP TABLE*)',
      'Bash(truncate *)',
    ]
    for (const p of destructivePatterns) {
      if (!askRules.includes(p)) askRules.push(p)
    }
  }

  const permissionsObj: Record<string, unknown> = {}
  if (allowRules.length > 0) permissionsObj['allow'] = allowRules
  if (askRules.length > 0) permissionsObj['ask'] = askRules
  if (denyRules.length > 0) permissionsObj['deny'] = denyRules
  if (s.permissionAdditionalDirs.length > 0) {
    permissionsObj['additionalDirectories'] = s.permissionAdditionalDirs
  }

  if (Object.keys(permissionsObj).length > 0) {
    settingsObj['permissions'] = permissionsObj
  }

  // disabledMcpServers — settings.json key: 'disabledMcpjsonServers' (see claude docs).
  // We only set it when there are actually disabled servers to avoid overriding claude's defaults.
  if (s.disabledMcpServers.length > 0) {
    settingsObj['disabledMcpjsonServers'] = s.disabledMcpServers
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

  // Memory section env vars
  if (s.disableGitInstructions) {
    env['CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS'] = '1'
  }
  if (s.maxOutputTokens !== null) {
    env['CLAUDE_CODE_MAX_OUTPUT_TOKENS'] = String(s.maxOutputTokens)
  }
  if (s.maxContextTokens !== null) {
    env['CLAUDE_CODE_MAX_CONTEXT_TOKENS'] = String(s.maxContextTokens)
  }
  if (s.compactionThreshold !== null) {
    env['CLAUDE_CODE_AUTO_COMPACT_THRESHOLD'] = String(s.compactionThreshold)
  }

  // Developer section env vars
  if (s.debugLogging && s.logLevel !== 'info') {
    // Only set the log level env var when debug logging is active and non-default
    env['CLAUDE_CODE_DEBUG_LOG_LEVEL'] = s.logLevel
  }
  if (s.disableTelemetry) {
    env['DISABLE_TELEMETRY'] = '1'
  }
  if (s.disableErrorReporting) {
    env['DISABLE_ERROR_REPORTING'] = '1'
  }
  if (s.disableAutoupdater) {
    env['DISABLE_AUTOUPDATER'] = '1'
  }
  if (s.experimentalAgentTeams) {
    env['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'] = '1'
  }
  if (s.experimentalForkedSubagents) {
    env['CLAUDE_CODE_FORK_SUBAGENT'] = '1'
  }

  // Tools section env vars (v14)
  if (s.toolConcurrency !== null) {
    env['CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY'] = String(s.toolConcurrency)
  }
  if (s.bashDefaultTimeoutMs !== null) {
    env['BASH_DEFAULT_TIMEOUT_MS'] = String(s.bashDefaultTimeoutMs)
  }
  if (s.bashMaxTimeoutMs !== null) {
    env['BASH_MAX_TIMEOUT_MS'] = String(s.bashMaxTimeoutMs)
  }
  if (s.bashMaxOutputLength !== null) {
    env['BASH_MAX_OUTPUT_LENGTH'] = String(s.bashMaxOutputLength)
  }

  // Custom env vars — merged last; user's keys win on conflict
  for (const [k, v] of Object.entries(s.customEnvVars)) {
    if (k && typeof v === 'string') env[k] = v
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
    hideCwd: 'hide_cwd',
    // Memory section
    disableGitInstructions: 'disable_git_instructions',
    maxOutputTokens: 'max_output_tokens',
    maxContextTokens: 'max_context_tokens',
    compactionThreshold: 'compaction_threshold',
    // Developer section
    debugLogging: 'debug_logging',
    logLevel: 'log_level',
    disableTelemetry: 'disable_telemetry',
    disableErrorReporting: 'disable_error_reporting',
    disableAutoupdater: 'disable_autoupdater',
    experimentalAgentTeams: 'experimental_agent_teams',
    experimentalForkedSubagents: 'experimental_forked_subagents',
    simpleSystemPrompt: 'simple_system_prompt',
    // Permissions section
    autoApproveEdits: 'auto_approve_edits',
    askDestructiveBash: 'ask_destructive_bash',
    planModeDefault: 'plan_mode_default',
    permissionAllowRules: 'permission_allow_rules',
    permissionAskRules: 'permission_ask_rules',
    permissionDenyRules: 'permission_deny_rules',
    permissionAdditionalDirs: 'permission_additional_dirs',
    // Fallback model (v11)
    fallbackModel: 'fallback_model',
    // Tools section (v14)
    bashDefaultTimeoutMs: 'bash_default_timeout_ms',
    bashMaxTimeoutMs: 'bash_max_timeout_ms',
    bashMaxOutputLength: 'bash_max_output_length',
    toolConcurrency: 'tool_concurrency',
    browserIntegration: 'browser_integration',
    disabledMcpServers: 'disabled_mcp_servers',
    customEnvVars: 'custom_env_vars'
  }

  const setClauses: string[] = []
  const values: unknown[] = []

  for (const key of Object.keys(patch) as (keyof ClaudeGlobalSettingsPatch)[]) {
    const col = columnMap[key]
    if (!col) continue
    setClauses.push(`${col} = ?`)
    const val = patch[key]
    // Coerce booleans to integers for SQLite; arrays and objects to JSON strings
    if (typeof val === 'boolean') {
      values.push(val ? 1 : 0)
    } else if (Array.isArray(val)) {
      values.push(JSON.stringify(val))
    } else if (val !== null && typeof val === 'object') {
      values.push(JSON.stringify(val))
    } else {
      values.push(val)
    }
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
