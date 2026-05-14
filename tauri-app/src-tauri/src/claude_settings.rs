// Settings layer for claude_global_settings singleton and launch composition.
// Mirrors src/main/claudeSettings.ts. Schema v31.

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

use crate::db::{Db, DbError};

// ---------------------------------------------------------------------------
// Enum newtypes (mirror TS union types)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    Default,
    AcceptEdits,
    Plan,
    BypassPermissions,
}

impl PermissionMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            PermissionMode::Default => "default",
            PermissionMode::AcceptEdits => "acceptEdits",
            PermissionMode::Plan => "plan",
            PermissionMode::BypassPermissions => "bypassPermissions",
        }
    }
}

impl TryFrom<&str> for PermissionMode {
    type Error = String;
    fn try_from(s: &str) -> Result<Self, Self::Error> {
        match s {
            "default" => Ok(PermissionMode::Default),
            "acceptEdits" => Ok(PermissionMode::AcceptEdits),
            "plan" => Ok(PermissionMode::Plan),
            "bypassPermissions" => Ok(PermissionMode::BypassPermissions),
            other => Err(format!("claudeSettings: permissionMode must be one of default, acceptEdits, plan, bypassPermissions; got {other}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    Auto,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl Effort {
    pub fn as_str(&self) -> &'static str {
        match self {
            Effort::Auto => "auto",
            Effort::Low => "low",
            Effort::Medium => "medium",
            Effort::High => "high",
            Effort::Xhigh => "xhigh",
            Effort::Max => "max",
        }
    }
}

impl TryFrom<&str> for Effort {
    type Error = String;
    fn try_from(s: &str) -> Result<Self, Self::Error> {
        match s {
            "auto" => Ok(Effort::Auto),
            "low" => Ok(Effort::Low),
            "medium" => Ok(Effort::Medium),
            "high" => Ok(Effort::High),
            "xhigh" => Ok(Effort::Xhigh),
            "max" => Ok(Effort::Max),
            other => Err(format!("claudeSettings: effort must be one of auto, low, medium, high, xhigh, max; got {other}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputStyle {
    Default,
    Explanatory,
    Proactive,
    Learning,
}

impl OutputStyle {
    pub fn as_str(&self) -> &'static str {
        match self {
            OutputStyle::Default => "default",
            OutputStyle::Explanatory => "explanatory",
            OutputStyle::Proactive => "proactive",
            OutputStyle::Learning => "learning",
        }
    }
}

impl TryFrom<&str> for OutputStyle {
    type Error = String;
    fn try_from(s: &str) -> Result<Self, Self::Error> {
        match s {
            "default" => Ok(OutputStyle::Default),
            "explanatory" => Ok(OutputStyle::Explanatory),
            "proactive" => Ok(OutputStyle::Proactive),
            "learning" => Ok(OutputStyle::Learning),
            other => Err(format!("claudeSettings: outputStyle must be one of default, explanatory, proactive, learning; got {other}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TuiMode {
    Default,
    Fullscreen,
}

impl TuiMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            TuiMode::Default => "default",
            TuiMode::Fullscreen => "fullscreen",
        }
    }
}

impl TryFrom<&str> for TuiMode {
    type Error = String;
    fn try_from(s: &str) -> Result<Self, Self::Error> {
        match s {
            "default" => Ok(TuiMode::Default),
            "fullscreen" => Ok(TuiMode::Fullscreen),
            other => Err(format!("claudeSettings: tuiMode must be one of default, fullscreen; got {other}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EditorMode {
    Normal,
    Vim,
}

impl EditorMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            EditorMode::Normal => "normal",
            EditorMode::Vim => "vim",
        }
    }
}

impl TryFrom<&str> for EditorMode {
    type Error = String;
    fn try_from(s: &str) -> Result<Self, Self::Error> {
        match s {
            "normal" => Ok(EditorMode::Normal),
            "vim" => Ok(EditorMode::Vim),
            other => Err(format!("claudeSettings: editorMode must be one of normal, vim; got {other}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    // Variant named LevelError to avoid collision with TryFrom::Error associated type.
    #[serde(rename = "error")]
    LevelError,
}

impl LogLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            LogLevel::Debug => "debug",
            LogLevel::Info => "info",
            LogLevel::Warn => "warn",
            LogLevel::LevelError => "error",
        }
    }
}

impl TryFrom<&str> for LogLevel {
    type Error = String;
    fn try_from(s: &str) -> Result<Self, <LogLevel as TryFrom<&str>>::Error> {
        match s {
            "debug" => Ok(LogLevel::Debug),
            "info" => Ok(LogLevel::Info),
            "warn" => Ok(LogLevel::Warn),
            "error" => Ok(LogLevel::LevelError),
            other => Err(format!("claudeSettings: logLevel must be one of debug, info, warn, error; got {other}")),
        }
    }
}

// ---------------------------------------------------------------------------
// Main settings struct
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeGlobalSettings {
    pub model: String,
    pub permission_mode: PermissionMode,
    pub effort: Effort,
    pub auto_memory: bool,
    pub always_thinking: bool,
    pub output_style: OutputStyle,
    pub tui_mode: TuiMode,
    pub editor_mode: EditorMode,
    pub reduce_motion: bool,
    pub native_cursor: bool,
    pub hide_cwd: bool,
    // Memory
    pub disable_git_instructions: bool,
    pub max_output_tokens: Option<i64>,
    pub max_context_tokens: Option<i64>,
    pub compaction_threshold: Option<i64>,
    // Developer
    pub debug_logging: bool,
    pub log_level: LogLevel,
    pub disable_telemetry: bool,
    pub disable_error_reporting: bool,
    pub disable_autoupdater: bool,
    pub experimental_agent_teams: bool,
    pub experimental_forked_subagents: bool,
    pub simple_system_prompt: bool,
    // Permissions
    pub auto_approve_edits: bool,
    pub ask_destructive_bash: bool,
    pub plan_mode_default: bool,
    pub permission_allow_rules: Vec<String>,
    pub permission_ask_rules: Vec<String>,
    pub permission_deny_rules: Vec<String>,
    pub permission_additional_dirs: Vec<String>,
    // Fallback model (v11)
    pub fallback_model: String,
    // Tools (v14)
    pub bash_default_timeout_ms: Option<i64>,
    pub bash_max_timeout_ms: Option<i64>,
    pub bash_max_output_length: Option<i64>,
    pub tool_concurrency: Option<i64>,
    pub browser_integration: bool,
    pub disabled_mcp_servers: Vec<String>,
    pub custom_env_vars: HashMap<String, String>,
    // Env-var controls (v23)
    pub disable_thinking: bool,
    pub disable_fast_mode: bool,
    pub max_turns: Option<i64>,
    pub max_thinking_tokens: Option<i64>,
    pub file_read_max_output_tokens: Option<i64>,
    pub disable_claude_mds: bool,
    pub bash_maintain_cwd: bool,
    pub perforce_mode: bool,
    pub glob_hidden: bool,
    pub glob_no_ignore: bool,
    pub glob_timeout_seconds: Option<i64>,
    pub api_timeout_ms: Option<i64>,
    pub max_retries: Option<i64>,
    pub http_proxy: String,
    pub https_proxy: String,
    pub disable_nonessential_traffic: bool,
    pub do_not_track: bool,
    pub disable_background_tasks: bool,
    pub disable_agent_view: bool,
    pub anthropic_betas: String,
    pub extra_body_json: String,
    // Env-var controls (v24)
    pub no_flicker: bool,
    pub disable_alternate_screen: bool,
    pub disable_virtual_scroll: bool,
    pub disable_mouse: bool,
    pub disable_terminal_title: bool,
    pub scroll_speed: Option<i64>,
    pub code_accessibility: bool,
    pub omit_attribution_header: bool,
    pub force_sync_output: bool,
    pub enable_prompt_suggestion: bool,
    pub disable_1m_context: bool,
    pub disable_adaptive_thinking: bool,
    pub disable_legacy_model_remap: bool,
    pub auto_compact_window: Option<i64>,
    pub autocompact_pct_override: Option<i64>,
    pub disable_file_checkpointing: bool,
    pub disable_attachments: bool,
    pub shell_override: String,
    pub shell_prefix: String,
    pub enable_fine_grained_tool_streaming: bool,
    pub disable_nonstreaming_fallback: bool,
    pub proxy_resolves_hosts: bool,
    pub enable_gateway_model_discovery: bool,
    pub auto_background_tasks: bool,
    pub async_agent_stall_timeout_ms: Option<i64>,
    pub enable_tasks: bool,
    pub disable_cron: bool,
    pub exit_after_stop_delay: Option<i64>,
    pub disable_feedback_command: bool,
    pub disable_feedback_survey: bool,
    pub updated_at: i64,
}

// ---------------------------------------------------------------------------
// Sparse patch type (all fields Option)
// ---------------------------------------------------------------------------

/// All fields optional — only supplied fields are written on update.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeGlobalSettingsPatch {
    pub model: Option<String>,
    pub permission_mode: Option<PermissionMode>,
    pub effort: Option<Effort>,
    pub auto_memory: Option<bool>,
    pub always_thinking: Option<bool>,
    pub output_style: Option<OutputStyle>,
    pub tui_mode: Option<TuiMode>,
    pub editor_mode: Option<EditorMode>,
    pub reduce_motion: Option<bool>,
    pub native_cursor: Option<bool>,
    pub hide_cwd: Option<bool>,
    pub disable_git_instructions: Option<bool>,
    pub max_output_tokens: Option<Option<i64>>,
    pub max_context_tokens: Option<Option<i64>>,
    pub compaction_threshold: Option<Option<i64>>,
    pub debug_logging: Option<bool>,
    pub log_level: Option<LogLevel>,
    pub disable_telemetry: Option<bool>,
    pub disable_error_reporting: Option<bool>,
    pub disable_autoupdater: Option<bool>,
    pub experimental_agent_teams: Option<bool>,
    pub experimental_forked_subagents: Option<bool>,
    pub simple_system_prompt: Option<bool>,
    pub auto_approve_edits: Option<bool>,
    pub ask_destructive_bash: Option<bool>,
    pub plan_mode_default: Option<bool>,
    pub permission_allow_rules: Option<Vec<String>>,
    pub permission_ask_rules: Option<Vec<String>>,
    pub permission_deny_rules: Option<Vec<String>>,
    pub permission_additional_dirs: Option<Vec<String>>,
    pub fallback_model: Option<String>,
    pub bash_default_timeout_ms: Option<Option<i64>>,
    pub bash_max_timeout_ms: Option<Option<i64>>,
    pub bash_max_output_length: Option<Option<i64>>,
    pub tool_concurrency: Option<Option<i64>>,
    pub browser_integration: Option<bool>,
    pub disabled_mcp_servers: Option<Vec<String>>,
    pub custom_env_vars: Option<HashMap<String, String>>,
    pub disable_thinking: Option<bool>,
    pub disable_fast_mode: Option<bool>,
    pub max_turns: Option<Option<i64>>,
    pub max_thinking_tokens: Option<Option<i64>>,
    pub file_read_max_output_tokens: Option<Option<i64>>,
    pub disable_claude_mds: Option<bool>,
    pub bash_maintain_cwd: Option<bool>,
    pub perforce_mode: Option<bool>,
    pub glob_hidden: Option<bool>,
    pub glob_no_ignore: Option<bool>,
    pub glob_timeout_seconds: Option<Option<i64>>,
    pub api_timeout_ms: Option<Option<i64>>,
    pub max_retries: Option<Option<i64>>,
    pub http_proxy: Option<String>,
    pub https_proxy: Option<String>,
    pub disable_nonessential_traffic: Option<bool>,
    pub do_not_track: Option<bool>,
    pub disable_background_tasks: Option<bool>,
    pub disable_agent_view: Option<bool>,
    pub anthropic_betas: Option<String>,
    pub extra_body_json: Option<String>,
    pub no_flicker: Option<bool>,
    pub disable_alternate_screen: Option<bool>,
    pub disable_virtual_scroll: Option<bool>,
    pub disable_mouse: Option<bool>,
    pub disable_terminal_title: Option<bool>,
    pub scroll_speed: Option<Option<i64>>,
    pub code_accessibility: Option<bool>,
    pub omit_attribution_header: Option<bool>,
    pub force_sync_output: Option<bool>,
    pub enable_prompt_suggestion: Option<bool>,
    pub disable_1m_context: Option<bool>,
    pub disable_adaptive_thinking: Option<bool>,
    pub disable_legacy_model_remap: Option<bool>,
    pub auto_compact_window: Option<Option<i64>>,
    pub autocompact_pct_override: Option<Option<i64>>,
    pub disable_file_checkpointing: Option<bool>,
    pub disable_attachments: Option<bool>,
    pub shell_override: Option<String>,
    pub shell_prefix: Option<String>,
    pub enable_fine_grained_tool_streaming: Option<bool>,
    pub disable_nonstreaming_fallback: Option<bool>,
    pub proxy_resolves_hosts: Option<bool>,
    pub enable_gateway_model_discovery: Option<bool>,
    pub auto_background_tasks: Option<bool>,
    pub async_agent_stall_timeout_ms: Option<Option<i64>>,
    pub enable_tasks: Option<bool>,
    pub disable_cron: Option<bool>,
    pub exit_after_stop_delay: Option<Option<i64>>,
    pub disable_feedback_command: Option<bool>,
    pub disable_feedback_survey: Option<bool>,
}

// ---------------------------------------------------------------------------
// Launch composition output
// ---------------------------------------------------------------------------

/// The three buckets needed to wire settings into a claude CLI invocation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeLaunch {
    /// Whitespace-separated CLI flags, e.g. "--model opus --permission-mode acceptEdits".
    /// Empty string when all settings are at their claude defaults.
    pub flags: String,
    /// Inline JSON blob for --settings, covering keys with no CLI flag equivalent.
    /// Empty string when no such keys differ from claude's defaults.
    pub settings_json: String,
    /// Env vars to set in the surface process. Empty map when all at defaults.
    pub env: HashMap<String, String>,
}

// ---------------------------------------------------------------------------
// Project/workspace override shapes (minimal — Phase 1D owns full tables)
// ---------------------------------------------------------------------------

/// The subset of overrides Phase 1C needs to compose effective settings.
/// Only model, permissionMode, effort are overrideable at project/workspace level.
#[derive(Debug, Default)]
pub struct SettingsOverrides {
    pub model: Option<String>,
    pub permission_mode: Option<PermissionMode>,
    pub effort: Option<Effort>,
}

// ---------------------------------------------------------------------------
// Internal: row → struct
// ---------------------------------------------------------------------------

fn parse_json_array(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

fn parse_json_map(raw: &str) -> HashMap<String, String> {
    serde_json::from_str::<HashMap<String, String>>(raw).unwrap_or_default()
}

fn b2b(v: i64) -> bool {
    v != 0
}

#[allow(clippy::too_many_arguments)]
fn row_to_settings(r: &rusqlite::Row<'_>) -> rusqlite::Result<ClaudeGlobalSettings> {
    // Index assignments mirror SELECT_COLS order exactly:
    // 0:model 1:permission_mode 2:effort 3:auto_memory 4:always_thinking
    // 5:output_style 6:tui_mode 7:editor_mode 8:reduce_motion 9:native_cursor
    // 10:hide_cwd 11:disable_git_instructions 12:max_output_tokens
    // 13:max_context_tokens 14:compaction_threshold 15:debug_logging
    // 16:disable_telemetry 17:disable_error_reporting 18:log_level
    // 19:disable_autoupdater 20:experimental_agent_teams
    // 21:experimental_forked_subagents 22:simple_system_prompt
    // 23:auto_approve_edits 24:ask_destructive_bash 25:plan_mode_default
    // 26:permission_allow_rules 27:permission_ask_rules 28:permission_deny_rules
    // 29:permission_additional_dirs 30:fallback_model 31:bash_default_timeout_ms
    // 32:bash_max_timeout_ms 33:bash_max_output_length 34:tool_concurrency
    // 35:browser_integration 36:disabled_mcp_servers 37:custom_env_vars
    // 38:disable_thinking 39:disable_fast_mode 40:max_turns
    // 41:max_thinking_tokens 42:file_read_max_output_tokens 43:disable_claude_mds
    // 44:bash_maintain_cwd 45:perforce_mode 46:glob_hidden 47:glob_no_ignore
    // 48:glob_timeout_seconds 49:api_timeout_ms 50:max_retries
    // 51:http_proxy 52:https_proxy 53:disable_nonessential_traffic
    // 54:do_not_track 55:disable_background_tasks 56:disable_agent_view
    // 57:anthropic_betas 58:extra_body_json
    // 59:no_flicker 60:disable_alternate_screen 61:disable_virtual_scroll
    // 62:disable_mouse 63:disable_terminal_title 64:scroll_speed
    // 65:code_accessibility 66:omit_attribution_header 67:force_sync_output
    // 68:enable_prompt_suggestion 69:disable_1m_context
    // 70:disable_adaptive_thinking 71:disable_legacy_model_remap
    // 72:auto_compact_window 73:autocompact_pct_override
    // 74:disable_file_checkpointing 75:disable_attachments
    // 76:shell_override 77:shell_prefix
    // 78:enable_fine_grained_tool_streaming 79:disable_nonstreaming_fallback
    // 80:proxy_resolves_hosts 81:enable_gateway_model_discovery
    // 82:auto_background_tasks 83:async_agent_stall_timeout_ms
    // 84:enable_tasks 85:disable_cron 86:exit_after_stop_delay
    // 87:disable_feedback_command 88:disable_feedback_survey 89:updated_at
    let permission_mode_raw: String = r.get(1)?;
    let effort_raw: String = r.get(2)?;
    let output_style_raw: String = r.get(5)?;
    let tui_mode_raw: String = r.get(6)?;
    let editor_mode_raw: String = r.get(7)?;
    let log_level_raw: String = r.get(18)?;
    let permission_allow_rules_raw: String = r.get(26)?;
    let permission_ask_rules_raw: String = r.get(27)?;
    let permission_deny_rules_raw: String = r.get(28)?;
    let permission_additional_dirs_raw: String = r.get(29)?;
    let disabled_mcp_servers_raw: String = r.get(36)?;
    let custom_env_vars_raw: String = r.get(37)?;

    Ok(ClaudeGlobalSettings {
        model: r.get(0)?,
        permission_mode: PermissionMode::try_from(permission_mode_raw.as_str())
            .unwrap_or(PermissionMode::Default),
        effort: Effort::try_from(effort_raw.as_str()).unwrap_or(Effort::Auto),
        auto_memory: b2b(r.get::<_, i64>(3)?),
        always_thinking: b2b(r.get::<_, i64>(4)?),
        output_style: OutputStyle::try_from(output_style_raw.as_str())
            .unwrap_or(OutputStyle::Default),
        tui_mode: TuiMode::try_from(tui_mode_raw.as_str()).unwrap_or(TuiMode::Default),
        editor_mode: EditorMode::try_from(editor_mode_raw.as_str())
            .unwrap_or(EditorMode::Normal),
        reduce_motion: b2b(r.get::<_, i64>(8)?),
        native_cursor: b2b(r.get::<_, i64>(9)?),
        hide_cwd: b2b(r.get::<_, i64>(10)?),
        disable_git_instructions: b2b(r.get::<_, i64>(11)?),
        max_output_tokens: r.get(12)?,
        max_context_tokens: r.get(13)?,
        compaction_threshold: r.get(14)?,
        debug_logging: b2b(r.get::<_, i64>(15)?),
        disable_telemetry: b2b(r.get::<_, i64>(16)?),
        disable_error_reporting: b2b(r.get::<_, i64>(17)?),
        log_level: LogLevel::try_from(log_level_raw.as_str()).unwrap_or(LogLevel::Info),
        disable_autoupdater: b2b(r.get::<_, i64>(19)?),
        experimental_agent_teams: b2b(r.get::<_, i64>(20)?),
        experimental_forked_subagents: b2b(r.get::<_, i64>(21)?),
        simple_system_prompt: b2b(r.get::<_, i64>(22)?),
        auto_approve_edits: b2b(r.get::<_, i64>(23)?),
        ask_destructive_bash: b2b(r.get::<_, i64>(24)?),
        plan_mode_default: b2b(r.get::<_, i64>(25)?),
        permission_allow_rules: parse_json_array(&permission_allow_rules_raw),
        permission_ask_rules: parse_json_array(&permission_ask_rules_raw),
        permission_deny_rules: parse_json_array(&permission_deny_rules_raw),
        permission_additional_dirs: parse_json_array(&permission_additional_dirs_raw),
        fallback_model: r.get::<_, Option<String>>(30)?.unwrap_or_default(),
        bash_default_timeout_ms: r.get(31)?,
        bash_max_timeout_ms: r.get(32)?,
        bash_max_output_length: r.get(33)?,
        tool_concurrency: r.get(34)?,
        browser_integration: b2b(r.get::<_, i64>(35)?),
        disabled_mcp_servers: parse_json_array(&disabled_mcp_servers_raw),
        custom_env_vars: parse_json_map(&custom_env_vars_raw),
        disable_thinking: b2b(r.get::<_, i64>(38)?),
        disable_fast_mode: b2b(r.get::<_, i64>(39)?),
        max_turns: r.get(40)?,
        max_thinking_tokens: r.get(41)?,
        file_read_max_output_tokens: r.get(42)?,
        disable_claude_mds: b2b(r.get::<_, i64>(43)?),
        bash_maintain_cwd: b2b(r.get::<_, i64>(44)?),
        perforce_mode: b2b(r.get::<_, i64>(45)?),
        glob_hidden: b2b(r.get::<_, i64>(46)?),
        glob_no_ignore: b2b(r.get::<_, i64>(47)?),
        glob_timeout_seconds: r.get(48)?,
        api_timeout_ms: r.get(49)?,
        max_retries: r.get(50)?,
        http_proxy: r.get::<_, Option<String>>(51)?.unwrap_or_default(),
        https_proxy: r.get::<_, Option<String>>(52)?.unwrap_or_default(),
        disable_nonessential_traffic: b2b(r.get::<_, i64>(53)?),
        do_not_track: b2b(r.get::<_, i64>(54)?),
        disable_background_tasks: b2b(r.get::<_, i64>(55)?),
        disable_agent_view: b2b(r.get::<_, i64>(56)?),
        anthropic_betas: r.get::<_, Option<String>>(57)?.unwrap_or_default(),
        extra_body_json: r.get::<_, Option<String>>(58)?.unwrap_or_default(),
        no_flicker: b2b(r.get::<_, i64>(59)?),
        disable_alternate_screen: b2b(r.get::<_, i64>(60)?),
        disable_virtual_scroll: b2b(r.get::<_, i64>(61)?),
        disable_mouse: b2b(r.get::<_, i64>(62)?),
        disable_terminal_title: b2b(r.get::<_, i64>(63)?),
        scroll_speed: r.get(64)?,
        code_accessibility: b2b(r.get::<_, i64>(65)?),
        omit_attribution_header: b2b(r.get::<_, i64>(66)?),
        force_sync_output: b2b(r.get::<_, i64>(67)?),
        enable_prompt_suggestion: b2b(r.get::<_, i64>(68)?),
        disable_1m_context: b2b(r.get::<_, i64>(69)?),
        disable_adaptive_thinking: b2b(r.get::<_, i64>(70)?),
        disable_legacy_model_remap: b2b(r.get::<_, i64>(71)?),
        auto_compact_window: r.get(72)?,
        autocompact_pct_override: r.get(73)?,
        disable_file_checkpointing: b2b(r.get::<_, i64>(74)?),
        disable_attachments: b2b(r.get::<_, i64>(75)?),
        shell_override: r.get::<_, Option<String>>(76)?.unwrap_or_default(),
        shell_prefix: r.get::<_, Option<String>>(77)?.unwrap_or_default(),
        enable_fine_grained_tool_streaming: b2b(r.get::<_, i64>(78)?),
        disable_nonstreaming_fallback: b2b(r.get::<_, i64>(79)?),
        proxy_resolves_hosts: b2b(r.get::<_, i64>(80)?),
        enable_gateway_model_discovery: b2b(r.get::<_, i64>(81)?),
        auto_background_tasks: b2b(r.get::<_, i64>(82)?),
        async_agent_stall_timeout_ms: r.get(83)?,
        enable_tasks: b2b(r.get::<_, i64>(84)?),
        disable_cron: b2b(r.get::<_, i64>(85)?),
        exit_after_stop_delay: r.get(86)?,
        disable_feedback_command: b2b(r.get::<_, i64>(87)?),
        disable_feedback_survey: b2b(r.get::<_, i64>(88)?),
        updated_at: r.get(89)?,
    })
}

// The ordered column list must match the index offsets used in row_to_settings above.
const SELECT_COLS: &str =
    "model, permission_mode, effort, auto_memory, always_thinking, output_style, \
     tui_mode, editor_mode, reduce_motion, native_cursor, hide_cwd, \
     disable_git_instructions, max_output_tokens, max_context_tokens, compaction_threshold, \
     debug_logging, disable_telemetry, disable_error_reporting, log_level, disable_autoupdater, \
     experimental_agent_teams, experimental_forked_subagents, simple_system_prompt, \
     auto_approve_edits, ask_destructive_bash, plan_mode_default, \
     permission_allow_rules, permission_ask_rules, permission_deny_rules, permission_additional_dirs, \
     fallback_model, bash_default_timeout_ms, bash_max_timeout_ms, bash_max_output_length, \
     tool_concurrency, browser_integration, disabled_mcp_servers, custom_env_vars, \
     disable_thinking, disable_fast_mode, max_turns, max_thinking_tokens, \
     file_read_max_output_tokens, disable_claude_mds, bash_maintain_cwd, perforce_mode, \
     glob_hidden, glob_no_ignore, glob_timeout_seconds, api_timeout_ms, max_retries, \
     http_proxy, https_proxy, disable_nonessential_traffic, do_not_track, \
     disable_background_tasks, disable_agent_view, anthropic_betas, extra_body_json, \
     no_flicker, disable_alternate_screen, disable_virtual_scroll, disable_mouse, \
     disable_terminal_title, scroll_speed, code_accessibility, omit_attribution_header, \
     force_sync_output, enable_prompt_suggestion, disable_1m_context, disable_adaptive_thinking, \
     disable_legacy_model_remap, auto_compact_window, autocompact_pct_override, \
     disable_file_checkpointing, disable_attachments, shell_override, shell_prefix, \
     enable_fine_grained_tool_streaming, disable_nonstreaming_fallback, proxy_resolves_hosts, \
     enable_gateway_model_discovery, auto_background_tasks, async_agent_stall_timeout_ms, \
     enable_tasks, disable_cron, exit_after_stop_delay, disable_feedback_command, \
     disable_feedback_survey, updated_at";

// ---------------------------------------------------------------------------
// Public API — read / write
// ---------------------------------------------------------------------------

/// Read the current global settings.
pub fn get_global_settings(db: &Db) -> Result<ClaudeGlobalSettings, DbError> {
    db.conn()
        .query_row(
            &format!("SELECT {SELECT_COLS} FROM claude_global_settings WHERE id = 1"),
            [],
            row_to_settings,
        )
        .map_err(DbError::from)
}

/// Apply a sparse patch to the global settings, return the new state.
pub fn update_global_settings(
    db: &Db,
    patch: ClaudeGlobalSettingsPatch,
) -> Result<ClaudeGlobalSettings, DbError> {
    let now = now_ms();
    // Build SET clause dynamically — only supplied fields.
    let mut set_clauses: Vec<String> = Vec::new();
    // We use a Vec<Box<dyn ToSql>> by converting to json/int/null and building a
    // positional params tuple manually.  Since rusqlite expects either a &[_] or
    // params![], we collect named (col, value_as_json_or_primitive) pairs and
    // build the SQL + positional vec at the same time.
    let mut bindings: Vec<(&'static str, ColValue)> = Vec::new();

    macro_rules! push_bool {
        ($field:expr, $col:literal) => {
            if let Some(v) = $field {
                set_clauses.push(format!("{} = ?{}", $col, set_clauses.len() + 1));
                bindings.push(($col, ColValue::Int(if v { 1 } else { 0 })));
            }
        };
    }
    macro_rules! push_str {
        ($field:expr, $col:literal) => {
            if let Some(v) = $field {
                set_clauses.push(format!("{} = ?{}", $col, set_clauses.len() + 1));
                bindings.push(($col, ColValue::Str(v)));
            }
        };
    }
    macro_rules! push_opt_int {
        ($field:expr, $col:literal) => {
            if let Some(v) = $field {
                set_clauses.push(format!("{} = ?{}", $col, set_clauses.len() + 1));
                bindings.push(($col, ColValue::OptInt(v)));
            }
        };
    }
    macro_rules! push_enum_str {
        ($field:expr, $col:literal) => {
            if let Some(v) = $field {
                set_clauses.push(format!("{} = ?{}", $col, set_clauses.len() + 1));
                bindings.push(($col, ColValue::Str(v.as_str().to_owned())));
            }
        };
    }
    macro_rules! push_json_arr {
        ($field:expr, $col:literal) => {
            if let Some(v) = $field {
                let json = serde_json::to_string(&v).unwrap_or_else(|_| "[]".into());
                set_clauses.push(format!("{} = ?{}", $col, set_clauses.len() + 1));
                bindings.push(($col, ColValue::Str(json)));
            }
        };
    }
    macro_rules! push_json_map {
        ($field:expr, $col:literal) => {
            if let Some(v) = $field {
                let json = serde_json::to_string(&v).unwrap_or_else(|_| "{}".into());
                set_clauses.push(format!("{} = ?{}", $col, set_clauses.len() + 1));
                bindings.push(($col, ColValue::Str(json)));
            }
        };
    }

    if let Some(v) = patch.model {
        if v.trim().is_empty() {
            return Err(DbError::Migration(0, "model must be a non-empty string".into()));
        }
        set_clauses.push(format!("model = ?{}", set_clauses.len() + 1));
        bindings.push(("model", ColValue::Str(v)));
    }

    push_enum_str!(patch.permission_mode, "permission_mode");
    push_enum_str!(patch.effort, "effort");
    push_bool!(patch.auto_memory, "auto_memory");
    push_bool!(patch.always_thinking, "always_thinking");
    push_enum_str!(patch.output_style, "output_style");
    push_enum_str!(patch.tui_mode, "tui_mode");
    push_enum_str!(patch.editor_mode, "editor_mode");
    push_bool!(patch.reduce_motion, "reduce_motion");
    push_bool!(patch.native_cursor, "native_cursor");
    push_bool!(patch.hide_cwd, "hide_cwd");
    push_bool!(patch.disable_git_instructions, "disable_git_instructions");
    push_opt_int!(patch.max_output_tokens, "max_output_tokens");
    push_opt_int!(patch.max_context_tokens, "max_context_tokens");
    push_opt_int!(patch.compaction_threshold, "compaction_threshold");
    push_bool!(patch.debug_logging, "debug_logging");
    push_enum_str!(patch.log_level, "log_level");
    push_bool!(patch.disable_telemetry, "disable_telemetry");
    push_bool!(patch.disable_error_reporting, "disable_error_reporting");
    push_bool!(patch.disable_autoupdater, "disable_autoupdater");
    push_bool!(patch.experimental_agent_teams, "experimental_agent_teams");
    push_bool!(patch.experimental_forked_subagents, "experimental_forked_subagents");
    push_bool!(patch.simple_system_prompt, "simple_system_prompt");
    push_bool!(patch.auto_approve_edits, "auto_approve_edits");
    push_bool!(patch.ask_destructive_bash, "ask_destructive_bash");
    push_bool!(patch.plan_mode_default, "plan_mode_default");
    push_json_arr!(patch.permission_allow_rules, "permission_allow_rules");
    push_json_arr!(patch.permission_ask_rules, "permission_ask_rules");
    push_json_arr!(patch.permission_deny_rules, "permission_deny_rules");
    push_json_arr!(patch.permission_additional_dirs, "permission_additional_dirs");
    push_str!(patch.fallback_model, "fallback_model");
    push_opt_int!(patch.bash_default_timeout_ms, "bash_default_timeout_ms");
    push_opt_int!(patch.bash_max_timeout_ms, "bash_max_timeout_ms");
    push_opt_int!(patch.bash_max_output_length, "bash_max_output_length");
    push_opt_int!(patch.tool_concurrency, "tool_concurrency");
    push_bool!(patch.browser_integration, "browser_integration");
    push_json_arr!(patch.disabled_mcp_servers, "disabled_mcp_servers");
    push_json_map!(patch.custom_env_vars, "custom_env_vars");
    push_bool!(patch.disable_thinking, "disable_thinking");
    push_bool!(patch.disable_fast_mode, "disable_fast_mode");
    push_opt_int!(patch.max_turns, "max_turns");
    push_opt_int!(patch.max_thinking_tokens, "max_thinking_tokens");
    push_opt_int!(patch.file_read_max_output_tokens, "file_read_max_output_tokens");
    push_bool!(patch.disable_claude_mds, "disable_claude_mds");
    push_bool!(patch.bash_maintain_cwd, "bash_maintain_cwd");
    push_bool!(patch.perforce_mode, "perforce_mode");
    push_bool!(patch.glob_hidden, "glob_hidden");
    push_bool!(patch.glob_no_ignore, "glob_no_ignore");
    push_opt_int!(patch.glob_timeout_seconds, "glob_timeout_seconds");
    push_opt_int!(patch.api_timeout_ms, "api_timeout_ms");
    push_opt_int!(patch.max_retries, "max_retries");
    push_str!(patch.http_proxy, "http_proxy");
    push_str!(patch.https_proxy, "https_proxy");
    push_bool!(patch.disable_nonessential_traffic, "disable_nonessential_traffic");
    push_bool!(patch.do_not_track, "do_not_track");
    push_bool!(patch.disable_background_tasks, "disable_background_tasks");
    push_bool!(patch.disable_agent_view, "disable_agent_view");
    push_str!(patch.anthropic_betas, "anthropic_betas");
    push_str!(patch.extra_body_json, "extra_body_json");
    push_bool!(patch.no_flicker, "no_flicker");
    push_bool!(patch.disable_alternate_screen, "disable_alternate_screen");
    push_bool!(patch.disable_virtual_scroll, "disable_virtual_scroll");
    push_bool!(patch.disable_mouse, "disable_mouse");
    push_bool!(patch.disable_terminal_title, "disable_terminal_title");
    push_opt_int!(patch.scroll_speed, "scroll_speed");
    push_bool!(patch.code_accessibility, "code_accessibility");
    push_bool!(patch.omit_attribution_header, "omit_attribution_header");
    push_bool!(patch.force_sync_output, "force_sync_output");
    push_bool!(patch.enable_prompt_suggestion, "enable_prompt_suggestion");
    push_bool!(patch.disable_1m_context, "disable_1m_context");
    push_bool!(patch.disable_adaptive_thinking, "disable_adaptive_thinking");
    push_bool!(patch.disable_legacy_model_remap, "disable_legacy_model_remap");
    push_opt_int!(patch.auto_compact_window, "auto_compact_window");
    push_opt_int!(patch.autocompact_pct_override, "autocompact_pct_override");
    push_bool!(patch.disable_file_checkpointing, "disable_file_checkpointing");
    push_bool!(patch.disable_attachments, "disable_attachments");
    push_str!(patch.shell_override, "shell_override");
    push_str!(patch.shell_prefix, "shell_prefix");
    push_bool!(patch.enable_fine_grained_tool_streaming, "enable_fine_grained_tool_streaming");
    push_bool!(patch.disable_nonstreaming_fallback, "disable_nonstreaming_fallback");
    push_bool!(patch.proxy_resolves_hosts, "proxy_resolves_hosts");
    push_bool!(patch.enable_gateway_model_discovery, "enable_gateway_model_discovery");
    push_bool!(patch.auto_background_tasks, "auto_background_tasks");
    push_opt_int!(patch.async_agent_stall_timeout_ms, "async_agent_stall_timeout_ms");
    push_bool!(patch.enable_tasks, "enable_tasks");
    push_bool!(patch.disable_cron, "disable_cron");
    push_opt_int!(patch.exit_after_stop_delay, "exit_after_stop_delay");
    push_bool!(patch.disable_feedback_command, "disable_feedback_command");
    push_bool!(patch.disable_feedback_survey, "disable_feedback_survey");

    if set_clauses.is_empty() {
        return get_global_settings(db);
    }

    // updated_at is always appended last
    let updated_at_idx = set_clauses.len() + 1;
    set_clauses.push(format!("updated_at = ?{updated_at_idx}"));
    let where_idx = updated_at_idx + 1;

    let sql = format!(
        "UPDATE claude_global_settings SET {} WHERE id = ?{where_idx}",
        set_clauses.join(", ")
    );

    // Execute with dynamic params via rusqlite's execute_named workaround:
    // build a Vec of rusqlite::types::Value and call execute with a slice.
    let mut param_vals: Vec<rusqlite::types::Value> = bindings
        .into_iter()
        .map(|(_, cv)| cv.into_sql_value())
        .collect();
    param_vals.push(rusqlite::types::Value::Integer(now));
    param_vals.push(rusqlite::types::Value::Integer(1)); // WHERE id = 1

    let mut stmt = db.conn().prepare(&sql)?;
    stmt.execute(rusqlite::params_from_iter(param_vals))?;

    get_global_settings(db)
}

// Tiny value wrapper so we can collect mixed types into a Vec.
enum ColValue {
    Int(i64),
    OptInt(Option<i64>),
    Str(String),
}

impl ColValue {
    fn into_sql_value(self) -> rusqlite::types::Value {
        match self {
            ColValue::Int(i) => rusqlite::types::Value::Integer(i),
            ColValue::OptInt(Some(i)) => rusqlite::types::Value::Integer(i),
            ColValue::OptInt(None) => rusqlite::types::Value::Null,
            ColValue::Str(s) => rusqlite::types::Value::Text(s),
        }
    }
}

// ---------------------------------------------------------------------------
// Launch composition
// ---------------------------------------------------------------------------

/// Compose the three buckets needed to wire settings into a claude invocation.
///
/// Layering: global → project overrides → workspace overrides.
/// For the seeded default state with no overrides the invariant holds:
///   flags == "" && settings_json == "" && env is empty.
///
/// `workspace_claude_session_id` is passed separately because it lives in
/// the workspaces table, not in settings — the caller provides it after
/// looking up the workspace row.
pub fn compose_claude_launch(
    db: &Db,
    project_overrides: Option<&SettingsOverrides>,
    workspace_overrides: Option<&SettingsOverrides>,
    workspace_claude_session_id: Option<&str>,
) -> Result<ClaudeLaunch, DbError> {
    let global = get_global_settings(db)?;

    // Resolve effective model/permissionMode/effort after overlay chain.
    let model = workspace_overrides
        .and_then(|o| o.model.as_deref())
        .or_else(|| project_overrides.and_then(|o| o.model.as_deref()))
        .unwrap_or(&global.model)
        .to_owned();

    let permission_mode = workspace_overrides
        .and_then(|o| o.permission_mode.clone())
        .or_else(|| project_overrides.and_then(|o| o.permission_mode.clone()))
        .unwrap_or_else(|| global.permission_mode.clone());

    let effort = workspace_overrides
        .and_then(|o| o.effort.clone())
        .or_else(|| project_overrides.and_then(|o| o.effort.clone()))
        .unwrap_or_else(|| global.effort.clone());

    // -------------------------------------------------------------------------
    // 1. CLI flags
    // -------------------------------------------------------------------------
    let mut flag_parts: Vec<String> = Vec::new();

    if model != "sonnet" {
        flag_parts.push(format!("--model {model}"));
    }

    let effective_permission_mode = if permission_mode != PermissionMode::Default {
        permission_mode.as_str().to_owned()
    } else if global.plan_mode_default {
        "plan".into()
    } else {
        String::new()
    };
    if !effective_permission_mode.is_empty() {
        flag_parts.push(format!("--permission-mode {effective_permission_mode}"));
    }

    if effort != Effort::Auto {
        flag_parts.push(format!("--effort {}", effort.as_str()));
    }

    if global.debug_logging {
        flag_parts.push("--debug".into());
    }

    if !global.fallback_model.trim().is_empty() {
        flag_parts.push(format!("--fallback-model {}", global.fallback_model.trim()));
    }

    if let Some(session_id) = workspace_claude_session_id {
        if !session_id.is_empty() {
            flag_parts.push(format!("--resume {session_id}"));
        }
    }

    let flags = flag_parts.join(" ");

    // -------------------------------------------------------------------------
    // 2. settings.json blob
    // -------------------------------------------------------------------------
    let mut settings_obj: serde_json::Map<String, JsonValue> = serde_json::Map::new();

    if global.always_thinking {
        settings_obj.insert("alwaysThinkingEnabled".into(), JsonValue::Bool(true));
    }

    if global.output_style != OutputStyle::Default {
        let raw = global.output_style.as_str();
        let capitalized = {
            let mut chars = raw.chars();
            chars.next().map(|c| c.to_uppercase().to_string() + chars.as_str()).unwrap_or_default()
        };
        settings_obj.insert("outputStyle".into(), JsonValue::String(capitalized));
    }

    if global.tui_mode != TuiMode::Default {
        settings_obj.insert("tui".into(), JsonValue::String(global.tui_mode.as_str().into()));
    }

    if global.editor_mode != EditorMode::Normal {
        settings_obj.insert("editorMode".into(), JsonValue::String(global.editor_mode.as_str().into()));
    }

    if global.reduce_motion {
        settings_obj.insert("prefersReducedMotion".into(), JsonValue::Bool(true));
    }

    if global.simple_system_prompt {
        settings_obj.insert("simpleSystemPrompt".into(), JsonValue::Bool(true));
    }

    // Permission rules — inject autoApproveEdits and askDestructiveBash at compose time.
    let mut allow_rules = global.permission_allow_rules.clone();
    let mut ask_rules = global.permission_ask_rules.clone();
    let deny_rules = global.permission_deny_rules.clone();

    if global.auto_approve_edits && !allow_rules.iter().any(|r| r == "Edit") {
        allow_rules.push("Edit".into());
    }

    if global.ask_destructive_bash {
        let destructive = [
            "Bash(rm *)", "Bash(rmdir *)", "Bash(git reset *)",
            "Bash(git push --force*)", "Bash(git clean *)",
            "Bash(DROP TABLE*)", "Bash(truncate *)",
        ];
        for p in &destructive {
            if !ask_rules.iter().any(|r| r == p) {
                ask_rules.push((*p).into());
            }
        }
    }

    let mut permissions_obj: serde_json::Map<String, JsonValue> = serde_json::Map::new();
    if !allow_rules.is_empty() {
        permissions_obj.insert("allow".into(), JsonValue::Array(allow_rules.into_iter().map(JsonValue::String).collect()));
    }
    if !ask_rules.is_empty() {
        permissions_obj.insert("ask".into(), JsonValue::Array(ask_rules.into_iter().map(JsonValue::String).collect()));
    }
    if !deny_rules.is_empty() {
        permissions_obj.insert("deny".into(), JsonValue::Array(deny_rules.into_iter().map(JsonValue::String).collect()));
    }
    if !global.permission_additional_dirs.is_empty() {
        permissions_obj.insert(
            "additionalDirectories".into(),
            JsonValue::Array(global.permission_additional_dirs.clone().into_iter().map(JsonValue::String).collect()),
        );
    }
    if !permissions_obj.is_empty() {
        settings_obj.insert("permissions".into(), JsonValue::Object(permissions_obj));
    }

    if !global.disabled_mcp_servers.is_empty() {
        settings_obj.insert(
            "disabledMcpjsonServers".into(),
            JsonValue::Array(global.disabled_mcp_servers.clone().into_iter().map(JsonValue::String).collect()),
        );
    }

    let settings_json = if settings_obj.is_empty() {
        String::new()
    } else {
        serde_json::to_string(&settings_obj).unwrap_or_default()
    };

    // -------------------------------------------------------------------------
    // 3. Environment variables
    // -------------------------------------------------------------------------
    let mut env: HashMap<String, String> = HashMap::new();

    if !global.auto_memory {
        env.insert("CLAUDE_CODE_DISABLE_AUTO_MEMORY".into(), "1".into());
    }
    if global.native_cursor {
        env.insert("CLAUDE_CODE_NATIVE_CURSOR".into(), "1".into());
    }
    if global.hide_cwd {
        env.insert("CLAUDE_CODE_HIDE_CWD".into(), "1".into());
    }
    if global.disable_git_instructions {
        env.insert("CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS".into(), "1".into());
    }
    if let Some(v) = global.max_output_tokens {
        env.insert("CLAUDE_CODE_MAX_OUTPUT_TOKENS".into(), v.to_string());
    }
    if let Some(v) = global.max_context_tokens {
        env.insert("CLAUDE_CODE_MAX_CONTEXT_TOKENS".into(), v.to_string());
    }
    if let Some(v) = global.compaction_threshold {
        env.insert("CLAUDE_CODE_AUTO_COMPACT_THRESHOLD".into(), v.to_string());
    }
    if global.debug_logging && global.log_level != LogLevel::Info {
        env.insert("CLAUDE_CODE_DEBUG_LOG_LEVEL".into(), global.log_level.as_str().into());
    }
    if global.disable_telemetry {
        env.insert("DISABLE_TELEMETRY".into(), "1".into());
    }
    if global.disable_error_reporting {
        env.insert("DISABLE_ERROR_REPORTING".into(), "1".into());
    }
    if global.disable_autoupdater {
        env.insert("DISABLE_AUTOUPDATER".into(), "1".into());
    }
    if global.experimental_agent_teams {
        env.insert("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS".into(), "1".into());
    }
    if global.experimental_forked_subagents {
        env.insert("CLAUDE_CODE_FORK_SUBAGENT".into(), "1".into());
    }
    if let Some(v) = global.tool_concurrency {
        env.insert("CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY".into(), v.to_string());
    }
    if let Some(v) = global.bash_default_timeout_ms {
        env.insert("BASH_DEFAULT_TIMEOUT_MS".into(), v.to_string());
    }
    if let Some(v) = global.bash_max_timeout_ms {
        env.insert("BASH_MAX_TIMEOUT_MS".into(), v.to_string());
    }
    if let Some(v) = global.bash_max_output_length {
        env.insert("BASH_MAX_OUTPUT_LENGTH".into(), v.to_string());
    }
    if global.disable_thinking {
        env.insert("CLAUDE_CODE_DISABLE_THINKING".into(), "1".into());
    }
    if global.disable_fast_mode {
        env.insert("CLAUDE_CODE_DISABLE_FAST_MODE".into(), "1".into());
    }
    if let Some(v) = global.max_turns {
        env.insert("CLAUDE_CODE_MAX_TURNS".into(), v.to_string());
    }
    if let Some(v) = global.max_thinking_tokens {
        env.insert("MAX_THINKING_TOKENS".into(), v.to_string());
    }
    if let Some(v) = global.file_read_max_output_tokens {
        env.insert("CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS".into(), v.to_string());
    }
    if global.disable_claude_mds {
        env.insert("CLAUDE_CODE_DISABLE_CLAUDE_MDS".into(), "1".into());
    }
    if global.bash_maintain_cwd {
        env.insert("CLAUDE_CODE_BASH_MAINTAIN_PROJECT_WORKING_DIR".into(), "1".into());
    }
    if global.perforce_mode {
        env.insert("CLAUDE_CODE_PERFORCE_MODE".into(), "1".into());
    }
    if global.glob_hidden {
        env.insert("CLAUDE_CODE_GLOB_HIDDEN".into(), "1".into());
    }
    if global.glob_no_ignore {
        env.insert("CLAUDE_CODE_GLOB_NO_IGNORE".into(), "1".into());
    }
    if let Some(v) = global.glob_timeout_seconds {
        env.insert("CLAUDE_CODE_GLOB_TIMEOUT_SECONDS".into(), v.to_string());
    }
    if let Some(v) = global.api_timeout_ms {
        env.insert("API_TIMEOUT_MS".into(), v.to_string());
    }
    if let Some(v) = global.max_retries {
        env.insert("CLAUDE_CODE_MAX_RETRIES".into(), v.to_string());
    }
    if !global.http_proxy.is_empty() {
        env.insert("HTTP_PROXY".into(), global.http_proxy.clone());
    }
    if !global.https_proxy.is_empty() {
        env.insert("HTTPS_PROXY".into(), global.https_proxy.clone());
    }
    if global.disable_nonessential_traffic {
        env.insert("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(), "1".into());
    }
    if global.do_not_track {
        env.insert("DO_NOT_TRACK".into(), "1".into());
    }
    if global.disable_background_tasks {
        env.insert("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS".into(), "1".into());
    }
    if global.disable_agent_view {
        env.insert("CLAUDE_CODE_DISABLE_AGENT_VIEW".into(), "1".into());
    }
    if !global.anthropic_betas.is_empty() {
        env.insert("ANTHROPIC_BETAS".into(), global.anthropic_betas.clone());
    }
    if !global.extra_body_json.is_empty() {
        env.insert("CLAUDE_CODE_EXTRA_BODY".into(), global.extra_body_json.clone());
    }
    if global.no_flicker {
        env.insert("CLAUDE_CODE_NO_FLICKER".into(), "1".into());
    }
    if global.disable_alternate_screen {
        env.insert("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN".into(), "1".into());
    }
    if global.disable_virtual_scroll {
        env.insert("CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL".into(), "1".into());
    }
    if global.disable_mouse {
        env.insert("CLAUDE_CODE_DISABLE_MOUSE".into(), "1".into());
    }
    if global.disable_terminal_title {
        env.insert("CLAUDE_CODE_DISABLE_TERMINAL_TITLE".into(), "1".into());
    }
    if let Some(v) = global.scroll_speed {
        env.insert("CLAUDE_CODE_SCROLL_SPEED".into(), v.to_string());
    }
    if global.code_accessibility {
        env.insert("CLAUDE_CODE_CODE_ACCESSIBILITY".into(), "1".into());
    }
    if global.omit_attribution_header {
        env.insert("CLAUDE_CODE_ATTRIBUTION_HEADER".into(), "1".into());
    }
    if global.force_sync_output {
        env.insert("CLAUDE_CODE_FORCE_SYNC_OUTPUT".into(), "1".into());
    }
    if global.enable_prompt_suggestion {
        env.insert("CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION".into(), "1".into());
    }
    if global.disable_1m_context {
        env.insert("CLAUDE_CODE_DISABLE_1M_CONTEXT".into(), "1".into());
    }
    if global.disable_adaptive_thinking {
        env.insert("CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING".into(), "1".into());
    }
    if global.disable_legacy_model_remap {
        env.insert("CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP".into(), "1".into());
    }
    if let Some(v) = global.auto_compact_window {
        env.insert("CLAUDE_CODE_AUTO_COMPACT_WINDOW".into(), v.to_string());
    }
    if let Some(v) = global.autocompact_pct_override {
        env.insert("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE".into(), v.to_string());
    }
    if global.disable_file_checkpointing {
        env.insert("CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING".into(), "1".into());
    }
    if global.disable_attachments {
        env.insert("CLAUDE_CODE_DISABLE_ATTACHMENTS".into(), "1".into());
    }
    if !global.shell_override.is_empty() {
        env.insert("CLAUDE_CODE_SHELL".into(), global.shell_override.clone());
    }
    if !global.shell_prefix.is_empty() {
        env.insert("CLAUDE_CODE_SHELL_PREFIX".into(), global.shell_prefix.clone());
    }
    if global.enable_fine_grained_tool_streaming {
        env.insert("CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING".into(), "1".into());
    }
    if global.disable_nonstreaming_fallback {
        env.insert("CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK".into(), "1".into());
    }
    if global.proxy_resolves_hosts {
        env.insert("CLAUDE_CODE_PROXY_RESOLVES_HOSTS".into(), "1".into());
    }
    if global.enable_gateway_model_discovery {
        env.insert("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY".into(), "1".into());
    }
    if global.auto_background_tasks {
        env.insert("CLAUDE_CODE_AUTO_BACKGROUND_TASKS".into(), "1".into());
    }
    if let Some(v) = global.async_agent_stall_timeout_ms {
        env.insert("CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS".into(), v.to_string());
    }
    if global.enable_tasks {
        env.insert("CLAUDE_CODE_ENABLE_TASKS".into(), "1".into());
    }
    if global.disable_cron {
        env.insert("CLAUDE_CODE_DISABLE_CRON".into(), "1".into());
    }
    if let Some(v) = global.exit_after_stop_delay {
        env.insert("CLAUDE_CODE_EXIT_AFTER_STOP_DELAY".into(), v.to_string());
    }
    if global.disable_feedback_command {
        env.insert("DISABLE_FEEDBACK_COMMAND".into(), "1".into());
    }
    if global.disable_feedback_survey {
        env.insert("CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY".into(), "1".into());
    }

    // Custom env vars — user's keys win on conflict.
    for (k, v) in &global.custom_env_vars {
        if !k.is_empty() {
            env.insert(k.clone(), v.clone());
        }
    }

    Ok(ClaudeLaunch { flags, settings_json, env })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn temp_db() -> (Db, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("test.sqlite");
        let db = Db::open_at(&path).expect("open_at");
        (db, dir)
    }

    #[test]
    fn default_state_reads_clean() {
        let (db, _dir) = temp_db();
        let s = get_global_settings(&db).expect("get");
        assert_eq!(s.model, "sonnet");
        assert_eq!(s.permission_mode, PermissionMode::Default);
        assert_eq!(s.effort, Effort::Auto);
        assert!(s.auto_memory);
        assert!(!s.always_thinking);
    }

    #[test]
    fn round_trip_model() {
        let (db, _dir) = temp_db();
        let patch = ClaudeGlobalSettingsPatch {
            model: Some("opus".into()),
            ..Default::default()
        };
        let s = update_global_settings(&db, patch).expect("update");
        assert_eq!(s.model, "opus");
    }

    #[test]
    fn round_trip_permission_mode() {
        let (db, _dir) = temp_db();
        let patch = ClaudeGlobalSettingsPatch {
            permission_mode: Some(PermissionMode::AcceptEdits),
            ..Default::default()
        };
        let s = update_global_settings(&db, patch).expect("update");
        assert_eq!(s.permission_mode, PermissionMode::AcceptEdits);
    }

    #[test]
    fn round_trip_fast_mode() {
        let (db, _dir) = temp_db();
        let patch = ClaudeGlobalSettingsPatch {
            disable_fast_mode: Some(true),
            ..Default::default()
        };
        let s = update_global_settings(&db, patch).expect("update");
        assert!(s.disable_fast_mode);

        let patch2 = ClaudeGlobalSettingsPatch {
            disable_fast_mode: Some(false),
            ..Default::default()
        };
        let s2 = update_global_settings(&db, patch2).expect("update2");
        assert!(!s2.disable_fast_mode);
    }

    #[test]
    fn empty_patch_is_noop() {
        let (db, _dir) = temp_db();
        let before = get_global_settings(&db).expect("before");
        let after = update_global_settings(&db, Default::default()).expect("after");
        assert_eq!(before.model, after.model);
        assert_eq!(before.permission_mode, after.permission_mode);
    }

    #[test]
    fn compose_default_is_empty() {
        let (db, _dir) = temp_db();
        let launch = compose_claude_launch(&db, None, None, None).expect("compose");
        assert_eq!(launch.flags, "", "default flags should be empty");
        assert_eq!(launch.settings_json, "", "default settings_json should be empty");
        assert!(launch.env.is_empty(), "default env should be empty");
    }

    #[test]
    fn compose_no_overrides_model_opus() {
        let (db, _dir) = temp_db();
        update_global_settings(&db, ClaudeGlobalSettingsPatch {
            model: Some("opus".into()),
            ..Default::default()
        }).expect("update");
        let launch = compose_claude_launch(&db, None, None, None).expect("compose");
        assert!(launch.flags.contains("--model opus"), "flags: {}", launch.flags);
    }

    #[test]
    fn compose_plan_mode_default_injects_flag() {
        let (db, _dir) = temp_db();
        update_global_settings(&db, ClaudeGlobalSettingsPatch {
            plan_mode_default: Some(true),
            ..Default::default()
        }).expect("update");
        let launch = compose_claude_launch(&db, None, None, None).expect("compose");
        assert!(launch.flags.contains("--permission-mode plan"), "flags: {}", launch.flags);
    }

    #[test]
    fn compose_project_override_wins_over_global() {
        let (db, _dir) = temp_db();
        update_global_settings(&db, ClaudeGlobalSettingsPatch {
            model: Some("opus".into()),
            ..Default::default()
        }).expect("update");
        let proj_ovr = SettingsOverrides {
            model: Some("haiku".into()),
            ..Default::default()
        };
        let launch = compose_claude_launch(&db, Some(&proj_ovr), None, None).expect("compose");
        assert!(launch.flags.contains("--model haiku"), "project override should win: {}", launch.flags);
    }

    #[test]
    fn compose_workspace_override_wins_over_project() {
        let (db, _dir) = temp_db();
        update_global_settings(&db, ClaudeGlobalSettingsPatch {
            model: Some("opus".into()),
            ..Default::default()
        }).expect("update");
        let proj_ovr = SettingsOverrides {
            model: Some("haiku".into()),
            ..Default::default()
        };
        let ws_ovr = SettingsOverrides {
            model: Some("sonnet".into()),
            ..Default::default()
        };
        let launch = compose_claude_launch(&db, Some(&proj_ovr), Some(&ws_ovr), None).expect("compose");
        // workspace override is sonnet, which is the default → no --model flag
        assert!(!launch.flags.contains("--model"), "ws override sonnet should suppress --model: {}", launch.flags);
    }

    #[test]
    fn compose_auto_memory_off_injects_env() {
        let (db, _dir) = temp_db();
        update_global_settings(&db, ClaudeGlobalSettingsPatch {
            auto_memory: Some(false),
            ..Default::default()
        }).expect("update");
        let launch = compose_claude_launch(&db, None, None, None).expect("compose");
        assert_eq!(launch.env.get("CLAUDE_CODE_DISABLE_AUTO_MEMORY").map(|s| s.as_str()), Some("1"));
    }

    #[test]
    fn compose_always_thinking_goes_to_settings_json() {
        let (db, _dir) = temp_db();
        update_global_settings(&db, ClaudeGlobalSettingsPatch {
            always_thinking: Some(true),
            ..Default::default()
        }).expect("update");
        let launch = compose_claude_launch(&db, None, None, None).expect("compose");
        let json: serde_json::Value = serde_json::from_str(&launch.settings_json).expect("parse");
        assert_eq!(json.get("alwaysThinkingEnabled").and_then(|v| v.as_bool()), Some(true));
    }

    #[test]
    fn compose_auto_approve_edits_injects_allow_rule() {
        let (db, _dir) = temp_db();
        update_global_settings(&db, ClaudeGlobalSettingsPatch {
            auto_approve_edits: Some(true),
            ..Default::default()
        }).expect("update");
        let launch = compose_claude_launch(&db, None, None, None).expect("compose");
        let json: serde_json::Value = serde_json::from_str(&launch.settings_json).expect("parse");
        let allow = json["permissions"]["allow"].as_array().expect("allow array");
        assert!(allow.iter().any(|v| v.as_str() == Some("Edit")));
    }

    #[test]
    fn compose_session_id_becomes_resume_flag() {
        let (db, _dir) = temp_db();
        let launch = compose_claude_launch(&db, None, None, Some("sess-abc-123")).expect("compose");
        assert!(launch.flags.contains("--resume sess-abc-123"), "flags: {}", launch.flags);
    }

    #[test]
    fn compose_custom_env_vars_merged_last() {
        let (db, _dir) = temp_db();
        let mut custom = HashMap::new();
        custom.insert("MY_CUSTOM_VAR".to_owned(), "hello".to_owned());
        update_global_settings(&db, ClaudeGlobalSettingsPatch {
            custom_env_vars: Some(custom),
            ..Default::default()
        }).expect("update");
        let launch = compose_claude_launch(&db, None, None, None).expect("compose");
        assert_eq!(launch.env.get("MY_CUSTOM_VAR").map(|s| s.as_str()), Some("hello"));
    }

    /// Open the real Electron DB and verify get_global_settings returns a row.
    /// Run with: cargo test -- --include-ignored
    #[test]
    #[ignore]
    fn real_db_global_settings_populated() {
        use directories::ProjectDirs;
        let real_path = ProjectDirs::from("com", "Orpheus", "Orpheus")
            .map(|d| d.data_dir().join("orpheus.sqlite"))
            .expect("dirs");
        if !real_path.exists() {
            eprintln!("Real DB not found at {:?}, skipping.", real_path);
            return;
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let copy_path = dir.path().join("orpheus_copy.sqlite");
        std::fs::copy(&real_path, &copy_path).expect("copy");
        let wal = real_path.with_extension("sqlite-wal");
        if wal.exists() {
            std::fs::copy(&wal, copy_path.with_extension("sqlite-wal")).ok();
        }
        let db = Db::open_at(&copy_path).expect("open");
        let s = get_global_settings(&db).expect("get");
        eprintln!("model={} permission_mode={:?} effort={:?}", s.model, s.permission_mode, s.effort);
        assert!(!s.model.is_empty(), "model should be non-empty");
    }
}
