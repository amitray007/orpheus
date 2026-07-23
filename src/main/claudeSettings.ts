import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { getDb } from './db'
import { CLAUDE_EFFORT_VALUES } from '../shared/types'
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
import { encodePathToClaudeDir } from './claudeProjectDir'
import { FLAG_DELIMITER, mergeFlagScopes, parseFlagEntry } from '../shared/cliFlags'
import { validateCustomCliFlagsValue, validateCustomEnvVarsValue } from './overridesStore'
import { shouldEmitFallbackModel } from './modelRouting'

// One-way-true cache for session JSONL existence checks.
// Key: `${cwd}:${sessionId}`. Once a JSONL is confirmed to exist (true), it
// is permanent — claude never deletes a transcript mid-session — so we can
// skip the fs.statSync on every subsequent mount. We only cache the TRUE
// result; false entries are re-checked on the next mount because the file may
// appear once claude writes its first message.
const sessionJsonlExistsCache = new Map<string, true>()

// Returns true if claude's transcript file for this session already exists on
// disk. The path follows claude's encoding: slashes AND dots become dashes.
function sessionJsonlExists(cwd: string, sessionId: string): boolean {
  const key = `${cwd}:${sessionId}`
  if (sessionJsonlExistsCache.has(key)) return true
  const encoded = encodePathToClaudeDir(cwd)
  const path = nodePath.join(os.homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`)
  try {
    const exists = fs.statSync(path).isFile()
    if (exists) sessionJsonlExistsCache.set(key, true)
    return exists
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
  custom_cli_flags: string
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
  // Env-var controls (v52) — new feature toggles
  disable_bundled_skills: number
  disable_workflows: number
  enable_away_summary: number
  disable_artifact: number
  disable_advisor_tool: number
  screen_reader: number
  additional_dirs_claude_md: number
  // Guardrail settings (v64)
  max_workspace_depth: number | null
  max_workspace_children: number | null
  // Env-var controls (v66)
  tool_call_timeout_ms: number | null
  max_tool_output_length: number | null
  disable_mouse_clicks: number
  rewind_on_error_enabled: number
  low_power_mode: number
  updated_at: number
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed as string[]
    return []
  } catch {
    return []
  }
}

function parseJsonRecord(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
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
    customCliFlags: parseJsonArray(row.custom_cli_flags),
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
    // Env-var controls (v52) — new feature toggles
    disableBundledSkills: row.disable_bundled_skills === 1,
    disableWorkflows: row.disable_workflows === 1,
    enableAwaySummary: row.enable_away_summary === 1,
    disableArtifact: row.disable_artifact === 1,
    disableAdvisorTool: row.disable_advisor_tool === 1,
    screenReader: row.screen_reader === 1,
    additionalDirsClaudeMd: row.additional_dirs_claude_md === 1,
    // Guardrail settings (v64) — apply defaults when null (pre-v64 rows)
    maxWorkspaceDepth: row.max_workspace_depth ?? 3,
    maxWorkspaceChildren: row.max_workspace_children ?? 10,
    // Env-var controls (v66)
    toolCallTimeoutMs: row.tool_call_timeout_ms ?? null,
    maxToolOutputLength: row.max_tool_output_length ?? null,
    disableMouseClicks: row.disable_mouse_clicks === 1,
    rewindOnErrorEnabled: row.rewind_on_error_enabled === 1,
    lowPowerMode: row.low_power_mode === 1,
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
  'disableFeedbackSurvey',
  // Env-var controls (v52)
  'disableBundledSkills',
  'disableWorkflows',
  'enableAwaySummary',
  'disableArtifact',
  'disableAdvisorTool',
  'screenReader',
  'additionalDirsClaudeMd',
  // Env-var controls (v66)
  'disableMouseClicks',
  'rewindOnErrorEnabled',
  'lowPowerMode'
]

const STRING_ARRAY_KEYS: (keyof ClaudeGlobalSettingsPatch)[] = [
  'permissionAllowRules',
  'permissionAskRules',
  'permissionDenyRules',
  'permissionAdditionalDirs',
  'disabledMcpServers'
]

// Throws `claudeSettings: <label> must be a positive integer or null` when the
// patch has `key` set and its value is neither null nor a positive integer.
// Used for every numeric key whose validation + message are byte-identical to
// this pattern. Keys with a different bound or message (compactionThreshold,
// scrollSpeed, autocompactPctOverride, exitAfterStopDelay,
// maxWorkspaceDepth/Children) are validated separately below.
function validatePositiveIntOrNull(
  patch: ClaudeGlobalSettingsPatch,
  key: keyof ClaudeGlobalSettingsPatch,
  label: string
): void {
  if (!(key in patch)) return
  const v = patch[key] as number | null
  if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 1)) {
    throw new Error(`claudeSettings: ${label} must be a positive integer or null`)
  }
}

// Throws `claudeSettings: <label> must be one of ...` when the patch has `key`
// set and its value isn't in `validValues`. Used for the six enum keys whose
// error message format is byte-identical to this pattern.
function validateEnum<T extends string>(
  patch: ClaudeGlobalSettingsPatch,
  key: keyof ClaudeGlobalSettingsPatch,
  validValues: readonly T[],
  label: string
): void {
  if (!(key in patch)) return
  if (!validValues.includes(patch[key] as T)) {
    throw new Error(`claudeSettings: ${label} must be one of ${validValues.join(', ')}`)
  }
}

// Throws `claudeSettings: <label> must be a string` when the patch has `key`
// set and its value isn't a string.
function validateStringKey(
  patch: ClaudeGlobalSettingsPatch,
  key: keyof ClaudeGlobalSettingsPatch,
  label: string
): void {
  if (!(key in patch)) return
  if (typeof patch[key] !== 'string') {
    throw new Error(`claudeSettings: ${label} must be a string`)
  }
}

// model: non-empty-string check, byte-identical message. Its own helper since
// no other key shares this exact "non-empty" predicate/message.
function validateModelKey(patch: ClaudeGlobalSettingsPatch): void {
  if (!('model' in patch)) return
  if (typeof patch.model !== 'string' || patch.model.trim() === '') {
    throw new Error('claudeSettings: model must be a non-empty string')
  }
}

// compactionThreshold: positive-integer-or-null PLUS an upper bound of 100,
// with its own message — deliberately kept separate from
// validatePositiveIntOrNull per the task instructions.
function validateCompactionThreshold(patch: ClaudeGlobalSettingsPatch): void {
  if (!('compactionThreshold' in patch)) return
  const v = patch.compactionThreshold
  if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 100)) {
    throw new Error('claudeSettings: compactionThreshold must be an integer 1–100 or null')
  }
}

// extraBodyJson: string check, then (if non-empty after trim) must parse as JSON.
function validateExtraBodyJson(patch: ClaudeGlobalSettingsPatch): void {
  if (!('extraBodyJson' in patch)) return
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

// scrollSpeed: integer 1–20 or null, own message.
function validateScrollSpeed(patch: ClaudeGlobalSettingsPatch): void {
  if (!('scrollSpeed' in patch)) return
  const v = patch.scrollSpeed
  if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 20)) {
    throw new Error('claudeSettings: scrollSpeed must be an integer 1–20 or null')
  }
}

// autocompactPctOverride: integer 0–100 or null (note: lower bound 0, not 1), own message.
function validateAutocompactPctOverride(patch: ClaudeGlobalSettingsPatch): void {
  if (!('autocompactPctOverride' in patch)) return
  const v = patch.autocompactPctOverride
  if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 100)) {
    throw new Error('claudeSettings: autocompactPctOverride must be an integer 0–100 or null')
  }
}

// exitAfterStopDelay: non-negative integer or null (v < 0, not v < 1), own message.
function validateExitAfterStopDelay(patch: ClaudeGlobalSettingsPatch): void {
  if (!('exitAfterStopDelay' in patch)) return
  const v = patch.exitAfterStopDelay
  if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 0)) {
    throw new Error('claudeSettings: exitAfterStopDelay must be a non-negative integer or null')
  }
}

// maxWorkspaceDepth / maxWorkspaceChildren: positive integer, NOT nullable
// (unlike the POSITIVE_INT_OR_NULL family), each with its own message.
function validateMaxWorkspaceDepth(patch: ClaudeGlobalSettingsPatch): void {
  if (!('maxWorkspaceDepth' in patch)) return
  const v = patch.maxWorkspaceDepth
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new Error('claudeSettings: maxWorkspaceDepth must be a positive integer')
  }
}

function validateMaxWorkspaceChildren(patch: ClaudeGlobalSettingsPatch): void {
  if (!('maxWorkspaceChildren' in patch)) return
  const v = patch.maxWorkspaceChildren
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new Error('claudeSettings: maxWorkspaceChildren must be a positive integer')
  }
}

// STRING_ARRAY_KEYS loop body, extracted so the loop itself doesn't add
// nested-if complexity inside validatePatch's own body.
function validateStringArrayKeys(patch: ClaudeGlobalSettingsPatch): void {
  for (const key of STRING_ARRAY_KEYS) {
    if (key in patch) {
      const v = patch[key]
      if (!Array.isArray(v) || !(v as unknown[]).every((item) => typeof item === 'string')) {
        throw new Error(`claudeSettings: ${key} must be a string[]`)
      }
    }
  }
}

// BOOLEAN_KEYS loop body, extracted for the same reason.
function validateBooleanKeys(patch: ClaudeGlobalSettingsPatch): void {
  for (const key of BOOLEAN_KEYS) {
    if (key in patch && typeof patch[key] !== 'boolean') {
      throw new Error(`claudeSettings: ${key} must be a boolean`)
    }
  }
}

function validatePatch(patch: ClaudeGlobalSettingsPatch): void {
  validateModelKey(patch)
  validateEnum(patch, 'permissionMode', VALID_PERMISSION_MODES, 'permissionMode')
  validateEnum(patch, 'effort', CLAUDE_EFFORT_VALUES, 'effort')
  validateEnum(patch, 'outputStyle', VALID_OUTPUT_STYLES, 'outputStyle')
  validateEnum(patch, 'tuiMode', VALID_TUI_MODES, 'tuiMode')
  validateEnum(patch, 'editorMode', VALID_EDITOR_MODES, 'editorMode')
  validateEnum(patch, 'logLevel', VALID_LOG_LEVELS, 'logLevel')
  validateBooleanKeys(patch)
  validatePositiveIntOrNull(patch, 'maxOutputTokens', 'maxOutputTokens')
  validatePositiveIntOrNull(patch, 'maxContextTokens', 'maxContextTokens')
  validateCompactionThreshold(patch)
  validateStringArrayKeys(patch)
  validateStringKey(patch, 'fallbackModel', 'fallbackModel')
  validatePositiveIntOrNull(patch, 'bashDefaultTimeoutMs', 'bashDefaultTimeoutMs')
  validatePositiveIntOrNull(patch, 'bashMaxTimeoutMs', 'bashMaxTimeoutMs')
  validatePositiveIntOrNull(patch, 'bashMaxOutputLength', 'bashMaxOutputLength')
  validatePositiveIntOrNull(patch, 'toolConcurrency', 'toolConcurrency')
  validatePositiveIntOrNull(patch, 'maxTurns', 'maxTurns')
  validatePositiveIntOrNull(patch, 'maxThinkingTokens', 'maxThinkingTokens')
  validatePositiveIntOrNull(patch, 'fileReadMaxOutputTokens', 'fileReadMaxOutputTokens')
  validatePositiveIntOrNull(patch, 'globTimeoutSeconds', 'globTimeoutSeconds')
  validatePositiveIntOrNull(patch, 'apiTimeoutMs', 'apiTimeoutMs')
  validatePositiveIntOrNull(patch, 'maxRetries', 'maxRetries')
  validateStringKey(patch, 'httpProxy', 'httpProxy')
  validateStringKey(patch, 'httpsProxy', 'httpsProxy')
  validateStringKey(patch, 'anthropicBetas', 'anthropicBetas')
  validateExtraBodyJson(patch)
  validateScrollSpeed(patch)
  validatePositiveIntOrNull(patch, 'autoCompactWindow', 'autoCompactWindow')
  validateAutocompactPctOverride(patch)
  validateStringKey(patch, 'shellOverride', 'shellOverride')
  validateStringKey(patch, 'shellPrefix', 'shellPrefix')
  validatePositiveIntOrNull(patch, 'asyncAgentStallTimeoutMs', 'asyncAgentStallTimeoutMs')
  validateExitAfterStopDelay(patch)
  validateMaxWorkspaceDepth(patch)
  validateMaxWorkspaceChildren(patch)
  validatePositiveIntOrNull(patch, 'toolCallTimeoutMs', 'toolCallTimeoutMs')
  validatePositiveIntOrNull(patch, 'maxToolOutputLength', 'maxToolOutputLength')
  if ('customEnvVars' in patch) {
    validateCustomEnvVarsValue(patch.customEnvVars, 'claudeSettings')
  }
  if ('customCliFlags' in patch) {
    validateCustomCliFlagsValue(patch.customCliFlags, 'claudeSettings')
  }
}

// ---------------------------------------------------------------------------
// Launch composition
// ---------------------------------------------------------------------------

// Flattens one raw customCliFlags entry (e.g. "--model opus") into its argv
// tokens via the shared lexer. Entries are validated at write time
// (validateCustomCliFlags), so a parse failure here should be unreachable in
// practice — but launch composition must never throw on stored data, so a
// failed entry is silently skipped rather than surfaced.
function flagEntryToTokens(entry: string): string[] {
  const parsed = parseFlagEntry(entry)
  return 'error' in parsed ? [] : parsed.tokens
}

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
  /** Effective resolved model id (workspace → project → global), the same
   *  value emitted as the --model flag. Callers (buildMountEnv's routing
   *  conditional) use this to decide isClaude(model) without re-parsing
   *  `flags`. Empty string means claude's own default (bare sonnet). */
  model: string
}

// Applies a scope's scalar overrides (model, permissionMode, effort) on top
// of `s` — the exact three-key spread used for both project and workspace
// override layers. Returns `s` unchanged (by reference) when `ov` is empty,
// otherwise a new merged object, matching the original inline `if
// (Object.keys(ov).length > 0) { s = {...} }` behavior exactly.
function applyScalarOverrides(
  s: ClaudeGlobalSettings,
  ov: {
    model?: string
    permissionMode?: ClaudePermissionMode
    effort?: ClaudeEffort
  }
): ClaudeGlobalSettings {
  if (Object.keys(ov).length === 0) return s
  return {
    ...s,
    ...(ov.model !== undefined ? { model: ov.model } : {}),
    ...(ov.permissionMode !== undefined ? { permissionMode: ov.permissionMode } : {}),
    ...(ov.effort !== undefined ? { effort: ov.effort } : {})
  }
}

type OverrideScope = {
  s: ClaudeGlobalSettings
  customFlags: string[]
  envVars: Record<string, string>
}

// Merge project-level overrides (model, permissionMode, effort) on top of
// global. customCliFlags is deliberately NOT spread into `s` alongside
// these scalar overrides — it needs append/override merge semantics via
// mergeFlagScopes (below), not last-wins replacement, so it's captured
// into its own local instead.
function mergeProjectOverrides(global: ClaudeGlobalSettings, projectId?: string): OverrideScope {
  if (!projectId) return { s: global, customFlags: [], envVars: {} }
  const proj = getClaudeProjectSettings(projectId)
  const ov = proj.overrides
  return {
    s: applyScalarOverrides(global, ov),
    customFlags: ov.customCliFlags ?? [],
    envVars: ov.customEnvVars ?? {}
  }
}

// Workspace overrides sit above project overrides — highest precedence before
// CLI flags. customCliFlags is deliberately NOT spread into `s` here either,
// for the same reason as projectCustomFlags above — it's captured into its
// own local and merged via mergeFlagScopes (below), not last-wins replacement.
function mergeWorkspaceOverrides(s: ClaudeGlobalSettings, workspaceId?: string): OverrideScope {
  if (!workspaceId) return { s, customFlags: [], envVars: {} }
  const ws = getClaudeWorkspaceSettings(workspaceId)
  const wov = ws.overrides
  return {
    s: applyScalarOverrides(s, wov),
    customFlags: wov.customCliFlags ?? [],
    envVars: wov.customEnvVars ?? {}
  }
}

// Session continuity: every workspace ships with a pre-generated UUID
// (assigned in createWorkspace). On first launch, no .jsonl exists yet, so
// we pass --session-id <uuid> to tell claude "create a new session with
// this ID". On every subsequent launch the .jsonl exists, so we switch to
// --resume <uuid> which attaches to the existing transcript. This is
// deterministic and survives Orpheus restarts even if the user quits
// immediately after the first message.
//
// Fork support (Plan A — validated 2025-05): when forked_from_session_id is
// set, the first launch emits --session-id <our-uuid> --resume <parent-uuid>
// --fork-session so claude creates an independent branch of the parent
// transcript under our UUID. Subsequent launches switch to bare --resume
// once the .jsonl exists (same as any other workspace).
function pushSessionContinuityFlags(flagTokens: string[], workspaceId?: string): void {
  if (!workspaceId) return
  const ws = getWorkspace(workspaceId)
  if (!ws?.claudeSessionId) return
  if (sessionJsonlExists(ws.cwd, ws.claudeSessionId)) {
    // Session already exists — normal resume
    flagTokens.push('--resume', ws.claudeSessionId)
  } else if (ws.forkedFromSessionId) {
    // Plan A fork: pre-assign our UUID and branch from parent. Reuse the
    // already-loaded workspace record's field instead of a second DB query.
    flagTokens.push(
      '--session-id',
      ws.claudeSessionId,
      '--resume',
      ws.forkedFromSessionId,
      '--fork-session'
    )
  } else {
    // Normal first launch
    flagTokens.push('--session-id', ws.claudeSessionId)
  }
}

// -------------------------------------------------------------------------
// 1. CLI flags
// -------------------------------------------------------------------------
// A token array, not space-joined strings: each push contributes one or
// more argv tokens directly, so a value containing whitespace (e.g. a
// custom --append-system-prompt) never has to survive a shell re-split.
// The array is joined with FLAG_DELIMITER (0x1F) below and split back into
// argv by resources/orpheus-claude.sh via zsh's `${(@ps:\x1f:)VAR}` — see
// that script's comment block and src/shared/cliFlags.ts for why.
function composeFlagTokens(
  s: ClaudeGlobalSettings,
  workspaceId: string | undefined,
  global: ClaudeGlobalSettings,
  projectCustomFlags: string[],
  workspaceCustomFlags: string[]
): string[] {
  const flagTokens: string[] = []

  // --model: always pass when set. Skipping the flag for 'sonnet' (claude's
  // own default) made picking "Sonnet" indistinguishable from "no override",
  // and let an ambient ANTHROPIC_MODEL env var silently win over the user's
  // explicit choice. Passing it always also makes the command in scrollback
  // reflect exactly what claude will run with.
  if (s.model) {
    flagTokens.push('--model', s.model)
  }

  // --permission-mode: skip 'default' (claude's default mode)
  // planModeDefault quick-toggle overrides if General permissionMode is still 'default'
  const effectivePermissionMode =
    s.permissionMode !== 'default' ? s.permissionMode : s.planModeDefault ? 'plan' : 'default'
  if (effectivePermissionMode !== 'default') {
    flagTokens.push('--permission-mode', effectivePermissionMode)
  }

  // --effort: skip 'auto' (let claude pick the effort level)
  if (s.effort && s.effort !== 'auto') {
    flagTokens.push('--effort', s.effort)
  }

  // --debug: enable verbose debug logging
  if (s.debugLogging) {
    flagTokens.push('--debug')
  }

  // --fallback-model: only emit when non-empty AND the launch model is not
  // routed. --fallback-model is a Claude-CLI-native concept (Anthropic
  // overload fallback) with no meaning against a third-party routed backend
  // — see shouldEmitFallbackModel's doc comment in modelRouting.ts for the
  // full rationale (unknown-provider errors, or worse, a silent backend
  // switch mid-session). Claude launches (s.model unrouted, including the ''
  // default) are unaffected: shouldEmitFallbackModel returns true for them,
  // so this is byte-for-byte identical to the prior unconditional check.
  if (s.fallbackModel && s.fallbackModel.trim() !== '' && shouldEmitFallbackModel(s.model)) {
    flagTokens.push('--fallback-model', s.fallbackModel.trim())
  }

  // --no-chrome: disable claude's browser integration (default is enabled)
  // Note: claude CLI flag name not confirmed in published docs; stored in DB,
  // compose is a no-op until the stable flag name is verified.
  // Uncomment when confirmed:
  // if (!s.browserIntegration) {
  //   flagTokens.push('--no-chrome')
  // }

  pushSessionContinuityFlags(flagTokens, workspaceId)

  // customCliFlags (global + project + workspace scope — see
  // docs/superpowers/specs/2026-07-15-workspace-settings-popover-design.md,
  // which supersedes the earlier "workspace scope does NOT participate"
  // non-goal). Each stored entry is a raw user-typed string (e.g.
  // "--model opus"); flatten to argv tokens via parseFlagEntry before merging
  // scopes, then append the merged tokens AFTER all of Orpheus's own typed
  // flags above, so a user's override wins by last-flag-wins in claude's own
  // parser (intentional — the escape hatch is an escape hatch). validatePatch
  // already guarantees every stored entry parses cleanly; entries that
  // somehow fail here (e.g. stale/corrupt DB data written before this
  // validation existed) are skipped rather than throwing, since a malformed
  // flag must never block the whole launch. mergeFlagScopes takes scopes
  // lowest-precedence-first, so workspace (highest) goes last.
  const globalCustomTokens = global.customCliFlags.flatMap(flagEntryToTokens)
  const projectCustomTokens = projectCustomFlags.flatMap(flagEntryToTokens)
  const workspaceCustomTokens = workspaceCustomFlags.flatMap(flagEntryToTokens)
  flagTokens.push(
    ...mergeFlagScopes(globalCustomTokens, projectCustomTokens, workspaceCustomTokens)
  )

  return flagTokens
}

// Compose permission arrays: merge stored rules with quick-control toggles,
// then assemble the settings.json `permissions` object. Extracted from
// composeSettingsJson's body since it's the single most complex sub-step.
function composePermissionsObj(s: ClaudeGlobalSettings): Record<string, unknown> {
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

  return permissionsObj
}

// -------------------------------------------------------------------------
// 2. settings.json blob (keys with no CLI flag equivalent)
// -------------------------------------------------------------------------
function composeSettingsJson(s: ClaudeGlobalSettings): string {
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
  const permissionsObj = composePermissionsObj(s)
  if (Object.keys(permissionsObj).length > 0) {
    settingsObj['permissions'] = permissionsObj
  }

  // disabledMcpServers — settings.json key: 'disabledMcpjsonServers' (see claude docs).
  // We only set it when there are actually disabled servers to avoid overriding claude's defaults.
  if (s.disabledMcpServers.length > 0) {
    settingsObj['disabledMcpjsonServers'] = s.disabledMcpServers
  }

  return Object.keys(settingsObj).length > 0 ? JSON.stringify(settingsObj) : ''
}

// Top-level UI toggles (native cursor / hide cwd / auto-memory) + the Memory
// section env vars — first half of the original applyCoreLaunchEnv, split
// further to stay under the complexity ceiling. Mutates `env` in place.
function applySurfaceAndMemoryLaunchEnv(
  env: Record<string, string>,
  s: ClaudeGlobalSettings
): void {
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
}

// Developer section + Tools (v14) env vars — second half of the original
// applyCoreLaunchEnv. Mutates `env` in place.
function applyDeveloperAndToolsLaunchEnv(
  env: Record<string, string>,
  s: ClaudeGlobalSettings
): void {
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
}

// Memory + Developer + Tools (v14) env vars — the first block of
// composeLaunchEnv. Delegates to two sub-helpers to stay under the
// complexity ceiling. Mutates `env` in place.
function applyCoreLaunchEnv(env: Record<string, string>, s: ClaudeGlobalSettings): void {
  applySurfaceAndMemoryLaunchEnv(env, s)
  applyDeveloperAndToolsLaunchEnv(env, s)
}

// Env-var controls (v23) — General / Memory & Context / Tools. First half of
// the original applyV23LaunchEnv, split further to stay under the
// complexity ceiling. Mutates `env` in place.
function applyV23GeneralAndToolsLaunchEnv(
  env: Record<string, string>,
  s: ClaudeGlobalSettings
): void {
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
  if (s.bashMaintainCwd) env['CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR'] = '1'
  if (s.perforceMode) env['CLAUDE_CODE_PERFORCE_MODE'] = '1'
  if (s.globHidden) env['CLAUDE_CODE_GLOB_HIDDEN'] = '1'
  if (s.globNoIgnore) env['CLAUDE_CODE_GLOB_NO_IGNORE'] = '1'
  if (s.globTimeoutSeconds !== null)
    env['CLAUDE_CODE_GLOB_TIMEOUT_SECONDS'] = String(s.globTimeoutSeconds)
}

// Env-var controls (v23) — Developer (Network / Privacy & background /
// Advanced). Second half of the original applyV23LaunchEnv. Mutates `env`
// in place.
function applyV23DeveloperLaunchEnv(env: Record<string, string>, s: ClaudeGlobalSettings): void {
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
}

// Env-var controls (v23) — full block. Delegates to two sub-helpers to stay
// under the complexity ceiling. Mutates `env` in place.
function applyV23LaunchEnv(env: Record<string, string>, s: ClaudeGlobalSettings): void {
  applyV23GeneralAndToolsLaunchEnv(env, s)
  applyV23DeveloperLaunchEnv(env, s)
}

// Env-var controls (v24) — Display/Rendering, General/Model capabilities,
// Memory & Context. First half of the original applyV24LaunchEnv, split
// further to stay under the complexity ceiling. Mutates `env` in place.
function applyV24DisplayAndModelLaunchEnv(
  env: Record<string, string>,
  s: ClaudeGlobalSettings
): void {
  // Env-var controls (v24) — Display / Rendering
  if (s.noFlicker) env['CLAUDE_CODE_NO_FLICKER'] = '1'
  if (s.disableAlternateScreen) env['CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN'] = '1'
  if (s.disableVirtualScroll) env['CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL'] = '1'
  if (s.disableMouse) env['CLAUDE_CODE_DISABLE_MOUSE'] = '1'
  if (s.disableTerminalTitle) env['CLAUDE_CODE_DISABLE_TERMINAL_TITLE'] = '1'
  if (s.scrollSpeed !== null) env['CLAUDE_CODE_SCROLL_SPEED'] = String(s.scrollSpeed)
  if (s.codeAccessibility) env['CLAUDE_CODE_ACCESSIBILITY'] = '1'
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
}

// Env-var controls (v24) — Tools/File+Shell, Developer/Network+Privacy.
// Second half of the original applyV24LaunchEnv. Mutates `env` in place.
function applyV24ToolsAndDeveloperLaunchEnv(
  env: Record<string, string>,
  s: ClaudeGlobalSettings
): void {
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
  if (s.autoBackgroundTasks) env['CLAUDE_AUTO_BACKGROUND_TASKS'] = '1'
  if (s.asyncAgentStallTimeoutMs !== null)
    env['CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS'] = String(s.asyncAgentStallTimeoutMs)
  if (s.enableTasks) env['CLAUDE_CODE_ENABLE_TASKS'] = '1'
  if (s.disableCron) env['CLAUDE_CODE_DISABLE_CRON'] = '1'
  if (s.exitAfterStopDelay !== null)
    env['CLAUDE_CODE_EXIT_AFTER_STOP_DELAY'] = String(s.exitAfterStopDelay)
  if (s.disableFeedbackCommand) env['DISABLE_FEEDBACK_COMMAND'] = '1'
  if (s.disableFeedbackSurvey) env['CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY'] = '1'
}

// Env-var controls (v24) — full block. Delegates to two sub-helpers to stay
// under the complexity ceiling. Mutates `env` in place.
function applyV24LaunchEnv(env: Record<string, string>, s: ClaudeGlobalSettings): void {
  applyV24DisplayAndModelLaunchEnv(env, s)
  applyV24ToolsAndDeveloperLaunchEnv(env, s)
}

// Env-var controls (v52) and (v66) — the newest feature toggles. Mutates
// `env` in place.
function applyLatestLaunchEnv(env: Record<string, string>, s: ClaudeGlobalSettings): void {
  // Env-var controls (v52) — General / Model behavior
  if (s.disableBundledSkills) env['CLAUDE_CODE_DISABLE_BUNDLED_SKILLS'] = '1'
  if (s.disableWorkflows) env['CLAUDE_CODE_DISABLE_WORKFLOWS'] = '1'

  // Env-var controls (v52) — General
  if (s.enableAwaySummary) env['CLAUDE_CODE_ENABLE_AWAY_SUMMARY'] = '1'

  // Env-var controls (v52) — Tools
  if (s.disableArtifact) env['CLAUDE_CODE_DISABLE_ARTIFACT'] = '1'
  if (s.disableAdvisorTool) env['CLAUDE_CODE_DISABLE_ADVISOR_TOOL'] = '1'

  // Env-var controls (v52) — Display
  if (s.screenReader) env['CLAUDE_AX_SCREEN_READER'] = '1'

  // Env-var controls (v52) — Memory & Context
  if (s.additionalDirsClaudeMd) env['CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD'] = '1'

  // Env-var controls (v66) — Tools
  if (s.toolCallTimeoutMs !== null && s.toolCallTimeoutMs !== undefined) {
    env['CLAUDE_CODE_TOOL_CALL_TIMEOUT_MS'] = String(s.toolCallTimeoutMs)
  }
  if (s.maxToolOutputLength !== null && s.maxToolOutputLength !== undefined) {
    env['CLAUDE_CODE_MAX_TOOL_OUTPUT_LENGTH'] = String(s.maxToolOutputLength)
  }

  // Env-var controls (v66) — Display / Rendering
  if (s.disableMouseClicks) env['CLAUDE_CODE_DISABLE_MOUSE_CLICKS'] = '1'

  // Env-var controls (v66) — Tools / File operations
  if (s.rewindOnErrorEnabled) env['CLAUDE_CODE_REWIND_ON_ERROR_ENABLED'] = '1'

  // Env-var controls (v66) — General / Model behavior
  if (s.lowPowerMode) env['CLAUDE_CODE_LOW_POWER_MODE'] = '1'
}

// Custom env vars — merged last-wins across all three scopes (global →
// project → workspace, lowest precedence first; workspace wins on same-key
// conflict), then that combined map is applied last within compose's own
// `env` output so user keys win over the typed emissions above. Note this
// is only the layering within composeClaudeLaunch's own `env` output:
// downstream, buildMountEnv (orpheusSurfaceAdapter.ts:118-120) spreads
// authEnv AFTER launch.env when assembling the final mount env, so auth
// keys (e.g. ANTHROPIC_API_KEY) still win over these custom values. Unlike
// customCliFlags, this is a plain Record spread (last-wins), not an
// append/override algebra — so it's fine to combine scopes with a single
// object spread rather than mergeFlagScopes. Mutates `env` in place.
function applyCustomEnvVars(
  env: Record<string, string>,
  global: ClaudeGlobalSettings,
  projectEnvVars: Record<string, string>,
  workspaceEnvVars: Record<string, string>
): void {
  for (const [k, v] of Object.entries({
    ...global.customEnvVars,
    ...projectEnvVars,
    ...workspaceEnvVars
  })) {
    if (k && typeof v === 'string') env[k] = v
  }
}

// -------------------------------------------------------------------------
// 3. Environment variables
// -------------------------------------------------------------------------
function composeLaunchEnv(
  s: ClaudeGlobalSettings,
  global: ClaudeGlobalSettings,
  projectEnvVars: Record<string, string>,
  workspaceEnvVars: Record<string, string>
): Record<string, string> {
  const env: Record<string, string> = {}
  applyCoreLaunchEnv(env, s)
  applyV23LaunchEnv(env, s)
  applyV24LaunchEnv(env, s)
  applyLatestLaunchEnv(env, s)
  applyCustomEnvVars(env, global, projectEnvVars, workspaceEnvVars)
  return env
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

  const projectScope = mergeProjectOverrides(global, projectId)
  const workspaceScope = mergeWorkspaceOverrides(projectScope.s, workspaceId)
  const s = workspaceScope.s
  const projectCustomFlags = projectScope.customFlags
  const projectEnvVars = projectScope.envVars
  const workspaceCustomFlags = workspaceScope.customFlags
  const workspaceEnvVars = workspaceScope.envVars

  const flagTokens = composeFlagTokens(
    s,
    workspaceId,
    global,
    projectCustomFlags,
    workspaceCustomFlags
  )
  const flags = flagTokens.join(FLAG_DELIMITER)

  const settingsJson = composeSettingsJson(s)

  const env = composeLaunchEnv(s, global, projectEnvVars, workspaceEnvVars)

  return { flags, settingsJson, env, model: s.model }
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
    customCliFlags: 'custom_cli_flags',
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
    disableFeedbackSurvey: 'disable_feedback_survey',
    // Env-var controls (v52)
    disableBundledSkills: 'disable_bundled_skills',
    disableWorkflows: 'disable_workflows',
    enableAwaySummary: 'enable_away_summary',
    disableArtifact: 'disable_artifact',
    disableAdvisorTool: 'disable_advisor_tool',
    screenReader: 'screen_reader',
    additionalDirsClaudeMd: 'additional_dirs_claude_md',
    // Guardrail settings (v64)
    maxWorkspaceDepth: 'max_workspace_depth',
    maxWorkspaceChildren: 'max_workspace_children',
    // Env-var controls (v66)
    toolCallTimeoutMs: 'tool_call_timeout_ms',
    maxToolOutputLength: 'max_tool_output_length',
    disableMouseClicks: 'disable_mouse_clicks',
    rewindOnErrorEnabled: 'rewind_on_error_enabled',
    lowPowerMode: 'low_power_mode'
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
