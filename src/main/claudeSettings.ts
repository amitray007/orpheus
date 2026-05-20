import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
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
import { getWorkspace } from './workspaces'

// Returns true if claude's transcript file for this session already exists on
// disk. The path follows claude's encoding: slashes in the cwd become dashes.
// Called once per terminal:mount — fs.statSync is cheap enough to skip caching,
// and any cache would race against claude writing the JSONL between mounts.
function sessionJsonlExists(cwd: string, sessionId: string): boolean {
  const encoded = cwd.replace(/\//g, '-')
  const path = nodePath.join(os.homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`)
  try {
    return fs.statSync(path).isFile()
  } catch {
    return false
  }
}

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
  // Env-var controls (v23)
  disable_thinking: number
  disable_fast_mode: number
  max_turns: number | null
  max_thinking_tokens: number | null
  file_read_max_output_tokens: number | null
  disable_claude_mds: number
  bash_maintain_cwd: number
  perforce_mode: number
  glob_hidden: number
  glob_no_ignore: number
  glob_timeout_seconds: number | null
  api_timeout_ms: number | null
  max_retries: number | null
  http_proxy: string
  https_proxy: string
  disable_nonessential_traffic: number
  do_not_track: number
  disable_background_tasks: number
  disable_agent_view: number
  anthropic_betas: string
  extra_body_json: string
  // More env-var controls (v24)
  no_flicker: number
  disable_alternate_screen: number
  disable_virtual_scroll: number
  disable_mouse: number
  disable_terminal_title: number
  scroll_speed: number | null
  code_accessibility: number
  omit_attribution_header: number
  force_sync_output: number
  enable_prompt_suggestion: number
  disable_1m_context: number
  disable_adaptive_thinking: number
  disable_legacy_model_remap: number
  auto_compact_window: number | null
  autocompact_pct_override: number | null
  disable_file_checkpointing: number
  disable_attachments: number
  shell_override: string
  shell_prefix: string
  enable_fine_grained_tool_streaming: number
  disable_nonstreaming_fallback: number
  proxy_resolves_hosts: number
  enable_gateway_model_discovery: number
  auto_background_tasks: number
  async_agent_stall_timeout_ms: number | null
  enable_tasks: number
  disable_cron: number
  exit_after_stop_delay: number | null
  disable_feedback_command: number
  disable_feedback_survey: number
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
    // Env-var controls (v23) — General
    disableThinking: row.disable_thinking === 1,
    disableFastMode: row.disable_fast_mode === 1,
    maxTurns: row.max_turns ?? null,
    // Env-var controls (v23) — Memory & Context
    maxThinkingTokens: row.max_thinking_tokens ?? null,
    fileReadMaxOutputTokens: row.file_read_max_output_tokens ?? null,
    disableClaudeMds: row.disable_claude_mds === 1,
    // Env-var controls (v23) — Tools
    bashMaintainCwd: row.bash_maintain_cwd === 1,
    perforceMode: row.perforce_mode === 1,
    globHidden: row.glob_hidden === 1,
    globNoIgnore: row.glob_no_ignore === 1,
    globTimeoutSeconds: row.glob_timeout_seconds ?? null,
    // Env-var controls (v23) — Developer
    apiTimeoutMs: row.api_timeout_ms ?? null,
    maxRetries: row.max_retries ?? null,
    httpProxy: row.http_proxy ?? '',
    httpsProxy: row.https_proxy ?? '',
    disableNonessentialTraffic: row.disable_nonessential_traffic === 1,
    doNotTrack: row.do_not_track === 1,
    disableBackgroundTasks: row.disable_background_tasks === 1,
    disableAgentView: row.disable_agent_view === 1,
    anthropicBetas: row.anthropic_betas ?? '',
    extraBodyJson: row.extra_body_json ?? '',
    // Env-var controls (v24) — Display / Rendering
    noFlicker: row.no_flicker === 1,
    disableAlternateScreen: row.disable_alternate_screen === 1,
    disableVirtualScroll: row.disable_virtual_scroll === 1,
    disableMouse: row.disable_mouse === 1,
    disableTerminalTitle: row.disable_terminal_title === 1,
    scrollSpeed: row.scroll_speed ?? null,
    codeAccessibility: row.code_accessibility === 1,
    omitAttributionHeader: row.omit_attribution_header === 1,
    forceSyncOutput: row.force_sync_output === 1,
    enablePromptSuggestion: row.enable_prompt_suggestion === 1,
    // Env-var controls (v24) — General / Model capabilities
    disable1mContext: row.disable_1m_context === 1,
    disableAdaptiveThinking: row.disable_adaptive_thinking === 1,
    disableLegacyModelRemap: row.disable_legacy_model_remap === 1,
    // Env-var controls (v24) — Memory & Context
    autoCompactWindow: row.auto_compact_window ?? null,
    autocompactPctOverride: row.autocompact_pct_override ?? null,
    // Env-var controls (v24) — Tools / File operations & Shell
    disableFileCheckpointing: row.disable_file_checkpointing === 1,
    disableAttachments: row.disable_attachments === 1,
    shellOverride: row.shell_override ?? '',
    shellPrefix: row.shell_prefix ?? '',
    // Env-var controls (v24) — Developer / Network
    enableFineGrainedToolStreaming: row.enable_fine_grained_tool_streaming === 1,
    disableNonstreamingFallback: row.disable_nonstreaming_fallback === 1,
    proxyResolvesHosts: row.proxy_resolves_hosts === 1,
    enableGatewayModelDiscovery: row.enable_gateway_model_discovery === 1,
    // Env-var controls (v24) — Developer / Privacy & background tasks
    autoBackgroundTasks: row.auto_background_tasks === 1,
    asyncAgentStallTimeoutMs: row.async_agent_stall_timeout_ms ?? null,
    enableTasks: row.enable_tasks === 1,
    disableCron: row.disable_cron === 1,
    exitAfterStopDelay: row.exit_after_stop_delay ?? null,
    disableFeedbackCommand: row.disable_feedback_command === 1,
    disableFeedbackSurvey: row.disable_feedback_survey === 1,
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
  'autoMemory',
  'alwaysThinking',
  'reduceMotion',
  'nativeCursor',
  'hideCwd',
  'disableGitInstructions',
  'debugLogging',
  'disableTelemetry',
  'disableErrorReporting',
  'disableAutoupdater',
  'experimentalAgentTeams',
  'experimentalForkedSubagents',
  'simpleSystemPrompt',
  'autoApproveEdits',
  'askDestructiveBash',
  'planModeDefault',
  'browserIntegration',
  // Env-var controls (v23)
  'disableThinking',
  'disableFastMode',
  'disableClaudeMds',
  'bashMaintainCwd',
  'perforceMode',
  'globHidden',
  'globNoIgnore',
  'disableNonessentialTraffic',
  'doNotTrack',
  'disableBackgroundTasks',
  'disableAgentView',
  // Env-var controls (v24)
  'noFlicker',
  'disableAlternateScreen',
  'disableVirtualScroll',
  'disableMouse',
  'disableTerminalTitle',
  'codeAccessibility',
  'omitAttributionHeader',
  'forceSyncOutput',
  'enablePromptSuggestion',
  'disable1mContext',
  'disableAdaptiveThinking',
  'disableLegacyModelRemap',
  'disableFileCheckpointing',
  'disableAttachments',
  'enableFineGrainedToolStreaming',
  'disableNonstreamingFallback',
  'proxyResolvesHosts',
  'enableGatewayModelDiscovery',
  'autoBackgroundTasks',
  'enableTasks',
  'disableCron',
  'disableFeedbackCommand',
  'disableFeedbackSurvey'
]

const STRING_ARRAY_KEYS: (keyof ClaudeGlobalSettingsPatch)[] = [
  'permissionAllowRules',
  'permissionAskRules',
  'permissionDenyRules',
  'permissionAdditionalDirs',
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
      throw new Error(
        `claudeSettings: outputStyle must be one of ${VALID_OUTPUT_STYLES.join(', ')}`
      )
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
  if ('maxTurns' in patch) {
    const v = patch.maxTurns
    if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 1)) {
      throw new Error('claudeSettings: maxTurns must be a positive integer or null')
    }
  }
  if ('maxThinkingTokens' in patch) {
    const v = patch.maxThinkingTokens
    if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 1)) {
      throw new Error('claudeSettings: maxThinkingTokens must be a positive integer or null')
    }
  }
  if ('fileReadMaxOutputTokens' in patch) {
    const v = patch.fileReadMaxOutputTokens
    if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 1)) {
      throw new Error('claudeSettings: fileReadMaxOutputTokens must be a positive integer or null')
    }
  }
  if ('globTimeoutSeconds' in patch) {
    const v = patch.globTimeoutSeconds
    if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 1)) {
      throw new Error('claudeSettings: globTimeoutSeconds must be a positive integer or null')
    }
  }
  if ('apiTimeoutMs' in patch) {
    const v = patch.apiTimeoutMs
    if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 1)) {
      throw new Error('claudeSettings: apiTimeoutMs must be a positive integer or null')
    }
  }
  if ('maxRetries' in patch) {
    const v = patch.maxRetries
    if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 1)) {
      throw new Error('claudeSettings: maxRetries must be a positive integer or null')
    }
  }
  if ('httpProxy' in patch) {
    if (typeof patch.httpProxy !== 'string') {
      throw new Error('claudeSettings: httpProxy must be a string')
    }
  }
  if ('httpsProxy' in patch) {
    if (typeof patch.httpsProxy !== 'string') {
      throw new Error('claudeSettings: httpsProxy must be a string')
    }
  }
  if ('anthropicBetas' in patch) {
    if (typeof patch.anthropicBetas !== 'string') {
      throw new Error('claudeSettings: anthropicBetas must be a string')
    }
  }
  if ('extraBodyJson' in patch) {
    const v = patch.extraBodyJson
    if (typeof v !== 'string') {
      throw new Error('claudeSettings: extraBodyJson must be a string')
    }
    if (v.trim() !== '') {
      try {
        JSON.parse(v)
      } catch {
        throw new Error('claudeSettings: extraBodyJson must be empty or valid JSON')
      }
    }
  }
  if ('scrollSpeed' in patch) {
    const v = patch.scrollSpeed
    if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 20)) {
      throw new Error('claudeSettings: scrollSpeed must be an integer 1–20 or null')
    }
  }
  if ('autoCompactWindow' in patch) {
    const v = patch.autoCompactWindow
    if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 1)) {
      throw new Error('claudeSettings: autoCompactWindow must be a positive integer or null')
    }
  }
  if ('autocompactPctOverride' in patch) {
    const v = patch.autocompactPctOverride
    if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 100)) {
      throw new Error('claudeSettings: autocompactPctOverride must be an integer 0–100 or null')
    }
  }
  if ('shellOverride' in patch) {
    if (typeof patch.shellOverride !== 'string') {
      throw new Error('claudeSettings: shellOverride must be a string')
    }
  }
  if ('shellPrefix' in patch) {
    if (typeof patch.shellPrefix !== 'string') {
      throw new Error('claudeSettings: shellPrefix must be a string')
    }
  }
  if ('asyncAgentStallTimeoutMs' in patch) {
    const v = patch.asyncAgentStallTimeoutMs
    if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 1)) {
      throw new Error('claudeSettings: asyncAgentStallTimeoutMs must be a positive integer or null')
    }
  }
  if ('exitAfterStopDelay' in patch) {
    const v = patch.exitAfterStopDelay
    if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 0)) {
      throw new Error('claudeSettings: exitAfterStopDelay must be a non-negative integer or null')
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
 *
 * @param precomputedGlobal — caller-provided global settings to avoid a redundant
 *   DB fetch when composing for many workspaces in a loop (e.g. recomputeDirty).
 *   Pass undefined to let the function fetch fresh.
 */
export function composeClaudeLaunch(
  projectId?: string,
  workspaceId?: string,
  precomputedGlobal?: ClaudeGlobalSettings
): ClaudeLaunch {
  const global = precomputedGlobal ?? getClaudeGlobalSettings()

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

  // --model: always pass when set. Skipping the flag for 'sonnet' (claude's
  // own default) made picking "Sonnet" indistinguishable from "no override",
  // and let an ambient ANTHROPIC_MODEL env var silently win over the user's
  // explicit choice. Passing it always also makes the command in scrollback
  // reflect exactly what claude will run with.
  if (s.model) {
    flagParts.push(`--model ${s.model}`)
  }

  // --permission-mode: skip 'default' (claude's default mode)
  // planModeDefault quick-toggle overrides if General permissionMode is still 'default'
  const effectivePermissionMode =
    s.permissionMode !== 'default' ? s.permissionMode : s.planModeDefault ? 'plan' : 'default'
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

  // Session continuity: every workspace ships with a pre-generated UUID
  // (assigned in createWorkspace). On first launch, no .jsonl exists yet, so
  // we pass --session-id <uuid> to tell claude "create a new session with
  // this ID". On every subsequent launch the .jsonl exists, so we switch to
  // --resume <uuid> which attaches to the existing transcript. This is
  // deterministic and survives Orpheus restarts even if the user quits
  // immediately after the first message.
  if (workspaceId) {
    const ws = getWorkspace(workspaceId)
    if (ws?.claudeSessionId) {
      if (sessionJsonlExists(ws.cwd, ws.claudeSessionId)) {
        flagParts.push(`--resume ${ws.claudeSessionId}`)
      } else {
        flagParts.push(`--session-id ${ws.claudeSessionId}`)
      }
    }
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
      'Bash(truncate *)'
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

  // Env-var controls (v23) — General
  if (s.disableThinking) env['CLAUDE_CODE_DISABLE_THINKING'] = '1'
  if (s.disableFastMode) env['CLAUDE_CODE_DISABLE_FAST_MODE'] = '1'
  if (s.maxTurns !== null) env['CLAUDE_CODE_MAX_TURNS'] = String(s.maxTurns)

  // Env-var controls (v23) — Memory & Context
  if (s.maxThinkingTokens !== null) env['MAX_THINKING_TOKENS'] = String(s.maxThinkingTokens)
  if (s.fileReadMaxOutputTokens !== null)
    env['CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS'] = String(s.fileReadMaxOutputTokens)
  if (s.disableClaudeMds) env['CLAUDE_CODE_DISABLE_CLAUDE_MDS'] = '1'

  // Env-var controls (v23) — Tools
  if (s.bashMaintainCwd) env['CLAUDE_CODE_BASH_MAINTAIN_PROJECT_WORKING_DIR'] = '1'
  if (s.perforceMode) env['CLAUDE_CODE_PERFORCE_MODE'] = '1'
  if (s.globHidden) env['CLAUDE_CODE_GLOB_HIDDEN'] = '1'
  if (s.globNoIgnore) env['CLAUDE_CODE_GLOB_NO_IGNORE'] = '1'
  if (s.globTimeoutSeconds !== null)
    env['CLAUDE_CODE_GLOB_TIMEOUT_SECONDS'] = String(s.globTimeoutSeconds)

  // Env-var controls (v23) — Developer / Network
  if (s.apiTimeoutMs !== null) env['API_TIMEOUT_MS'] = String(s.apiTimeoutMs)
  if (s.maxRetries !== null) env['CLAUDE_CODE_MAX_RETRIES'] = String(s.maxRetries)
  if (s.httpProxy) env['HTTP_PROXY'] = s.httpProxy
  if (s.httpsProxy) env['HTTPS_PROXY'] = s.httpsProxy

  // Env-var controls (v23) — Developer / Privacy & background
  if (s.disableNonessentialTraffic) env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] = '1'
  if (s.doNotTrack) env['DO_NOT_TRACK'] = '1'
  if (s.disableBackgroundTasks) env['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'] = '1'
  if (s.disableAgentView) env['CLAUDE_CODE_DISABLE_AGENT_VIEW'] = '1'

  // Env-var controls (v23) — Developer / Advanced
  if (s.anthropicBetas) env['ANTHROPIC_BETAS'] = s.anthropicBetas
  if (s.extraBodyJson) env['CLAUDE_CODE_EXTRA_BODY'] = s.extraBodyJson

  // Env-var controls (v24) — Display / Rendering
  if (s.noFlicker) env['CLAUDE_CODE_NO_FLICKER'] = '1'
  if (s.disableAlternateScreen) env['CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN'] = '1'
  if (s.disableVirtualScroll) env['CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL'] = '1'
  if (s.disableMouse) env['CLAUDE_CODE_DISABLE_MOUSE'] = '1'
  if (s.disableTerminalTitle) env['CLAUDE_CODE_DISABLE_TERMINAL_TITLE'] = '1'
  if (s.scrollSpeed !== null) env['CLAUDE_CODE_SCROLL_SPEED'] = String(s.scrollSpeed)
  if (s.codeAccessibility) env['CLAUDE_CODE_CODE_ACCESSIBILITY'] = '1'
  if (s.omitAttributionHeader) env['CLAUDE_CODE_ATTRIBUTION_HEADER'] = '1'
  if (s.forceSyncOutput) env['CLAUDE_CODE_FORCE_SYNC_OUTPUT'] = '1'
  if (s.enablePromptSuggestion) env['CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION'] = '1'

  // Env-var controls (v24) — General / Model capabilities
  if (s.disable1mContext) env['CLAUDE_CODE_DISABLE_1M_CONTEXT'] = '1'
  if (s.disableAdaptiveThinking) env['CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING'] = '1'
  if (s.disableLegacyModelRemap) env['CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP'] = '1'

  // Env-var controls (v24) — Memory & Context
  if (s.autoCompactWindow !== null)
    env['CLAUDE_CODE_AUTO_COMPACT_WINDOW'] = String(s.autoCompactWindow)
  if (s.autocompactPctOverride !== null)
    env['CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'] = String(s.autocompactPctOverride)

  // Env-var controls (v24) — Tools / File operations & Shell
  if (s.disableFileCheckpointing) env['CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING'] = '1'
  if (s.disableAttachments) env['CLAUDE_CODE_DISABLE_ATTACHMENTS'] = '1'
  if (s.shellOverride) env['CLAUDE_CODE_SHELL'] = s.shellOverride
  if (s.shellPrefix) env['CLAUDE_CODE_SHELL_PREFIX'] = s.shellPrefix

  // Env-var controls (v24) — Developer / Network
  if (s.enableFineGrainedToolStreaming) env['CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING'] = '1'
  if (s.disableNonstreamingFallback) env['CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK'] = '1'
  if (s.proxyResolvesHosts) env['CLAUDE_CODE_PROXY_RESOLVES_HOSTS'] = '1'
  if (s.enableGatewayModelDiscovery) env['CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'] = '1'

  // Env-var controls (v24) — Developer / Privacy & background tasks
  if (s.autoBackgroundTasks) env['CLAUDE_CODE_AUTO_BACKGROUND_TASKS'] = '1'
  if (s.asyncAgentStallTimeoutMs !== null)
    env['CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS'] = String(s.asyncAgentStallTimeoutMs)
  if (s.enableTasks) env['CLAUDE_CODE_ENABLE_TASKS'] = '1'
  if (s.disableCron) env['CLAUDE_CODE_DISABLE_CRON'] = '1'
  if (s.exitAfterStopDelay !== null)
    env['CLAUDE_CODE_EXIT_AFTER_STOP_DELAY'] = String(s.exitAfterStopDelay)
  if (s.disableFeedbackCommand) env['DISABLE_FEEDBACK_COMMAND'] = '1'
  if (s.disableFeedbackSurvey) env['CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY'] = '1'

  // Custom env vars — merged last; user's keys win on conflict
  for (const [k, v] of Object.entries(s.customEnvVars)) {
    if (k && typeof v === 'string') env[k] = v
  }

  return { flags, settingsJson, env }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Module-level cache — the global settings row is hot on every terminal:mount
// and every settings UI read. Invalidated by updateClaudeGlobalSettings below.
let cachedGlobalSettings: ClaudeGlobalSettings | null = null

export function invalidateClaudeGlobalSettingsCache(): void {
  cachedGlobalSettings = null
}

export function getClaudeGlobalSettings(): ClaudeGlobalSettings {
  if (cachedGlobalSettings) return cachedGlobalSettings
  const db = getDb()
  const row = db
    .prepare('SELECT * FROM claude_global_settings WHERE id = 1')
    .get() as ClaudeSettingsRow
  cachedGlobalSettings = rowToRecord(row)
  return cachedGlobalSettings
}

export function updateClaudeGlobalSettings(patch: ClaudeGlobalSettingsPatch): ClaudeGlobalSettings {
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
    customEnvVars: 'custom_env_vars',
    // Env-var controls (v23)
    disableThinking: 'disable_thinking',
    disableFastMode: 'disable_fast_mode',
    maxTurns: 'max_turns',
    maxThinkingTokens: 'max_thinking_tokens',
    fileReadMaxOutputTokens: 'file_read_max_output_tokens',
    disableClaudeMds: 'disable_claude_mds',
    bashMaintainCwd: 'bash_maintain_cwd',
    perforceMode: 'perforce_mode',
    globHidden: 'glob_hidden',
    globNoIgnore: 'glob_no_ignore',
    globTimeoutSeconds: 'glob_timeout_seconds',
    apiTimeoutMs: 'api_timeout_ms',
    maxRetries: 'max_retries',
    httpProxy: 'http_proxy',
    httpsProxy: 'https_proxy',
    disableNonessentialTraffic: 'disable_nonessential_traffic',
    doNotTrack: 'do_not_track',
    disableBackgroundTasks: 'disable_background_tasks',
    disableAgentView: 'disable_agent_view',
    anthropicBetas: 'anthropic_betas',
    extraBodyJson: 'extra_body_json',
    // Env-var controls (v24)
    noFlicker: 'no_flicker',
    disableAlternateScreen: 'disable_alternate_screen',
    disableVirtualScroll: 'disable_virtual_scroll',
    disableMouse: 'disable_mouse',
    disableTerminalTitle: 'disable_terminal_title',
    scrollSpeed: 'scroll_speed',
    codeAccessibility: 'code_accessibility',
    omitAttributionHeader: 'omit_attribution_header',
    forceSyncOutput: 'force_sync_output',
    enablePromptSuggestion: 'enable_prompt_suggestion',
    disable1mContext: 'disable_1m_context',
    disableAdaptiveThinking: 'disable_adaptive_thinking',
    disableLegacyModelRemap: 'disable_legacy_model_remap',
    autoCompactWindow: 'auto_compact_window',
    autocompactPctOverride: 'autocompact_pct_override',
    disableFileCheckpointing: 'disable_file_checkpointing',
    disableAttachments: 'disable_attachments',
    shellOverride: 'shell_override',
    shellPrefix: 'shell_prefix',
    enableFineGrainedToolStreaming: 'enable_fine_grained_tool_streaming',
    disableNonstreamingFallback: 'disable_nonstreaming_fallback',
    proxyResolvesHosts: 'proxy_resolves_hosts',
    enableGatewayModelDiscovery: 'enable_gateway_model_discovery',
    autoBackgroundTasks: 'auto_background_tasks',
    asyncAgentStallTimeoutMs: 'async_agent_stall_timeout_ms',
    enableTasks: 'enable_tasks',
    disableCron: 'disable_cron',
    exitAfterStopDelay: 'exit_after_stop_delay',
    disableFeedbackCommand: 'disable_feedback_command',
    disableFeedbackSurvey: 'disable_feedback_survey'
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

  db.prepare(`UPDATE claude_global_settings SET ${setClauses.join(', ')} WHERE id = ?`).run(
    ...values
  )

  const row = db
    .prepare('SELECT * FROM claude_global_settings WHERE id = 1')
    .get() as ClaudeSettingsRow
  const fresh = rowToRecord(row)
  // Refresh the module cache so subsequent readers (terminal:mount,
  // recomputeDirty) see the new values immediately.
  cachedGlobalSettings = fresh
  return fresh
}
