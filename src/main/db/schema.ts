import type { ColumnDef, SchemaDef, TableDef } from './types'
import { enumCheck, enumClause } from './render'

// Shared enum arrays — exported for reuse by app code (renderer/main) so the
// set of valid values lives in exactly one place. Values copied verbatim from
// the CHECK clauses in docs/superpowers/plans/_db-surface.md.

// 'archived' is vestigial-but-load-bearing for workspaces: kept because
// legacy data-step rows carry it AND the renderer's WorkspaceActivityDetail
// union (src/shared/types.ts) still includes 'archived'. Do not remove it.
const WORKSPACE_STATUS = ['in_progress', 'awaiting_input', 'attention', 'idle', 'archived'] as const
const SESSION_STATUS = ['in_progress', 'in_review', 'archived'] as const
const KEEP_AWAKE_MODE = ['off', 'auto', 'on'] as const

const PERMISSION_MODE = ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const
const EFFORT = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const OUTPUT_STYLE = ['default', 'explanatory', 'proactive', 'learning'] as const
const TUI_MODE = ['default', 'fullscreen'] as const
const EDITOR_MODE = ['normal', 'vim'] as const
const CLOUD_PROVIDER = ['anthropic', 'bedrock', 'vertex', 'foundry'] as const
const LOG_LEVEL = ['debug', 'info', 'warn', 'error'] as const

const LAST_VIEW_KIND = ['dashboard', 'sessions', 'project', 'workspace'] as const
// Mirrors VALID_FILES_SORT_ORDERS / TreeSortOrder in
// src/shared/uiStateDefaults.ts / TreeOptionsPopover.tsx.
const FILES_SORT_ORDER = ['default', 'name'] as const
const THEME = ['midnight', 'daylight', 'eclipse'] as const
const ACCENT_COLOR = ['gold', 'blue', 'teal', 'orange', 'pink'] as const
const UI_FONT_SCALE = ['small', 'default', 'large'] as const
const SOUND_PACK = [
  'core',
  'minimal',
  'mechanical',
  'retro',
  'playful',
  'crisp',
  'organic',
  'soft'
] as const

// A boolean stored as INTEGER CHECK (col IN (0,1)) — reused across the many
// flag columns in claude_global_settings / app_ui_state. Takes the column
// name explicitly since the CHECK text must reference it.
function bool(name: string, def: '0' | '1' = '0'): ColumnDef {
  return {
    type: 'INTEGER',
    notNull: true,
    default: def,
    check: enumCheck(name, ['0', '1'])
  }
}

// A normalizeOnRebuild CASE expression that coerces an out-of-range enum
// value to `fallback` (the column's own DEFAULT) during a rebuild's
// shadow-table copy. Built from the same shared enum array the CHECK itself
// is built from, so the IN-list can never drift from enumCheck's. Mirrors
// the hand-written CASE expressions already used for workspaces.status /
// sessions.status / keep_awake_settings.mode.
function enumCoerce(col: string, values: readonly string[], fallback: string): string {
  return `CASE WHEN ${col} IN (${values.map((v) => `'${v}'`).join(', ')}) THEN ${col} ELSE '${fallback}' END`
}

// Shorthand column-type literals reused across many table definitions below —
// hoisted so the literal string exists exactly once (sonarjs/no-duplicate-string).
const TEXT_PK = 'TEXT PRIMARY KEY NOT NULL'
const TEXT_NOT_NULL = 'TEXT NOT NULL'
const INTEGER_NOT_NULL = 'INTEGER NOT NULL'

// footer_actions_project and footer_actions_workspace share an identical
// columns shape apart from which parent id column they scope to — factor it
// out so the two tables can't drift from each other on edits.
function footerActionsColumns(parentIdCol: string): TableDef['columns'] {
  return {
    id: 'TEXT PRIMARY KEY',
    [parentIdCol]: TEXT_NOT_NULL,
    label: TEXT_NOT_NULL,
    icon: 'TEXT',
    action_id: TEXT_NOT_NULL,
    params_json: { type: 'TEXT', notNull: true, default: "'{}'" },
    visible_when: { type: 'TEXT', notNull: true, default: "'always'" },
    position: INTEGER_NOT_NULL,
    created_at: INTEGER_NOT_NULL,
    updated_at: INTEGER_NOT_NULL,
    prompts_json: 'TEXT'
  }
}

export const schema: SchemaDef = {
  // ---------------------------------------------------------------------
  // projects
  // ---------------------------------------------------------------------
  projects: {
    columns: {
      id: TEXT_PK,
      path: 'TEXT UNIQUE NOT NULL',
      name: TEXT_NOT_NULL,
      claude_encoded_name: 'TEXT',
      added_at: INTEGER_NOT_NULL,
      last_opened_at: 'INTEGER',
      pinned_at: 'INTEGER',
      expanded_in_sidebar: { type: 'INTEGER', notNull: true, default: '0' },
      sort_order: 'INTEGER',
      github_owner: 'TEXT',
      github_repo: 'TEXT',
      github_avatar_url: 'TEXT',
      github_checked_at: 'INTEGER',
      // Dropped at v3, re-added by healProjectsArchivedAt on every boot;
      // app queries it (listAllSessions, idx_projects_archived_at). Not in
      // the fresh-install CREATE TABLE constant but must be part of desired
      // state so a fresh build has it too.
      archived_at: 'INTEGER'
    },
    indexes: {
      idx_projects_archived_at: ['archived_at'],
      projects_pinned_idx: ['pinned_at']
    }
  },

  // ---------------------------------------------------------------------
  // sessions
  // ---------------------------------------------------------------------
  sessions: {
    columns: {
      id: TEXT_PK,
      project_id: TEXT_NOT_NULL,
      jsonl_path: TEXT_NOT_NULL,
      title: 'TEXT',
      status: {
        type: 'TEXT',
        notNull: true,
        default: "'in_review'",
        check: enumCheck('status', SESSION_STATUS)
      },
      created_at: INTEGER_NOT_NULL,
      updated_at: INTEGER_NOT_NULL,
      archived_at: 'INTEGER',
      model: 'TEXT',
      last_message_role: 'TEXT',
      jsonl_mtime: 'INTEGER',
      message_count: 'INTEGER',
      jsonl_size_bytes: 'INTEGER',
      last_message_preview: 'TEXT',
      last_user_message_preview: 'TEXT'
    },
    foreignKeys: [{ columns: ['project_id'], ref: 'projects(id)', onDelete: 'CASCADE' }],
    indexes: {
      sessions_project_id_idx: ['project_id'],
      sessions_status_idx: ['status'],
      sessions_updated_at_idx: ['updated_at'],
      idx_sessions_project_active: {
        columns: ['project_id', 'updated_at ASC'],
        where: "status != 'archived'"
      },
      idx_sessions_project_title_lower: ['project_id', 'LOWER(title)'],
      idx_sessions_project_updated: ['project_id', 'updated_at ASC']
    },
    normalizeOnRebuild: {
      // Legacy CHECKs never allowed anything outside in_progress/in_review/
      // archived historically, but keep a coercion in case a future rebuild
      // is triggered against a drifted live row so unknown values don't
      // block convergence.
      status: enumCoerce('status', SESSION_STATUS, 'in_review')
    }
  },

  // ---------------------------------------------------------------------
  // workspaces
  // ---------------------------------------------------------------------
  workspaces: {
    columns: {
      id: TEXT_PK,
      project_id: TEXT_NOT_NULL,
      name: TEXT_NOT_NULL,
      cwd: TEXT_NOT_NULL,
      pinned_at: 'INTEGER',
      created_at: INTEGER_NOT_NULL,
      last_opened_at: 'INTEGER',
      archived_at: 'INTEGER',
      closed_at: 'INTEGER',
      status: {
        type: 'TEXT',
        notNull: true,
        default: "'idle'",
        check: enumCheck('status', WORKSPACE_STATUS)
      },
      name_is_auto: { type: 'INTEGER', notNull: true, default: '1' },
      sort_order: 'INTEGER',
      claude_session_id: 'TEXT',
      last_title: 'TEXT',
      forked_from_session_id: 'TEXT',
      // parent workspace lineage (v64)
      parent_workspace_id: 'TEXT',
      // worktree-native workspaces (v64)
      worktree_parent_cwd: 'TEXT',
      worktree_branch: 'TEXT'
    },
    foreignKeys: [{ columns: ['project_id'], ref: 'projects(id)', onDelete: 'CASCADE' }],
    indexes: {
      workspaces_project_id_idx: ['project_id'],
      workspaces_pinned_idx: ['pinned_at'],
      idx_workspaces_project_sort: ['project_id', 'sort_order', 'created_at DESC'],
      idx_workspaces_parent: ['parent_workspace_id']
    },
    normalizeOnRebuild: {
      // Copied from healWorkspacesCheck's CASE (src/main/db.ts:2380): valid
      // values pass through; archived rows land on 'archived'; everything
      // else (e.g. legacy 'in_review'/'completed') falls back to 'idle'.
      status: `CASE
            WHEN status IN (${WORKSPACE_STATUS.map((v) => `'${v}'`).join(', ')}) THEN status
            WHEN archived_at IS NOT NULL THEN 'archived'
            ELSE 'idle'
          END`
    }
  },

  // ---------------------------------------------------------------------
  // claude_global_settings (117 columns)
  // ---------------------------------------------------------------------
  claude_global_settings: {
    columns: {
      id: { type: 'INTEGER', primaryKey: true, check: 'CHECK (id = 1)' },
      model: { type: 'TEXT', notNull: true, default: "'sonnet'" },
      permission_mode: {
        type: 'TEXT',
        notNull: true,
        default: "'default'",
        check: enumCheck('permission_mode', PERMISSION_MODE)
      },
      effort: {
        type: 'TEXT',
        notNull: true,
        default: "'auto'",
        check: enumCheck('effort', EFFORT)
      },
      auto_memory: bool('auto_memory', '1'),
      always_thinking: bool('always_thinking', '0'),
      output_style: {
        type: 'TEXT',
        notNull: true,
        default: "'default'",
        check: enumCheck('output_style', OUTPUT_STYLE)
      },
      tui_mode: {
        type: 'TEXT',
        notNull: true,
        default: "'default'",
        check: enumCheck('tui_mode', TUI_MODE)
      },
      editor_mode: {
        type: 'TEXT',
        notNull: true,
        default: "'normal'",
        check: enumCheck('editor_mode', EDITOR_MODE)
      },
      reduce_motion: bool('reduce_motion', '0'),
      native_cursor: bool('native_cursor', '0'),
      hide_cwd: bool('hide_cwd', '0'),
      // Memory section (v9)
      disable_git_instructions: bool('disable_git_instructions', '0'),
      max_output_tokens: 'INTEGER',
      max_context_tokens: 'INTEGER',
      compaction_threshold: 'INTEGER',
      // Developer section (v9)
      debug_logging: bool('debug_logging', '0'),
      log_level: {
        type: 'TEXT',
        notNull: true,
        default: "'info'",
        check: enumCheck('log_level', LOG_LEVEL)
      },
      disable_telemetry: bool('disable_telemetry', '0'),
      disable_error_reporting: bool('disable_error_reporting', '0'),
      disable_autoupdater: bool('disable_autoupdater', '0'),
      experimental_agent_teams: bool('experimental_agent_teams', '0'),
      experimental_forked_subagents: bool('experimental_forked_subagents', '0'),
      simple_system_prompt: bool('simple_system_prompt', '0'),
      // Permissions section (v9)
      auto_approve_edits: bool('auto_approve_edits', '0'),
      ask_destructive_bash: bool('ask_destructive_bash', '0'),
      plan_mode_default: bool('plan_mode_default', '0'),
      permission_allow_rules: { type: 'TEXT', notNull: true, default: "'[]'" },
      permission_ask_rules: { type: 'TEXT', notNull: true, default: "'[]'" },
      permission_deny_rules: { type: 'TEXT', notNull: true, default: "'[]'" },
      permission_additional_dirs: { type: 'TEXT', notNull: true, default: "'[]'" },
      // Fallback model (v11)
      fallback_model: { type: 'TEXT', notNull: true, default: "''" },
      // Auth (v13 / v16 / v17)
      cloud_provider: {
        type: 'TEXT',
        notNull: true,
        default: "'anthropic'",
        check: enumCheck('cloud_provider', CLOUD_PROVIDER)
      },
      auth_encrypted_blob: 'BLOB',
      auth_api_key: { type: 'TEXT', notNull: true, default: "''" },
      auth_token: { type: 'TEXT', notNull: true, default: "''" },
      auth_base_url: { type: 'TEXT', notNull: true, default: "''" },
      auth_aws_region: { type: 'TEXT', notNull: true, default: "''" },
      auth_vertex_project_id: { type: 'TEXT', notNull: true, default: "''" },
      auth_vertex_region: { type: 'TEXT', notNull: true, default: "''" },
      // Tools section (v14)
      bash_default_timeout_ms: 'INTEGER',
      bash_max_timeout_ms: 'INTEGER',
      bash_max_output_length: 'INTEGER',
      tool_concurrency: 'INTEGER',
      browser_integration: bool('browser_integration', '1'),
      disabled_mcp_servers: { type: 'TEXT', notNull: true, default: "'[]'" },
      // Foundry + Bedrock bearer token + custom env vars (v22)
      auth_foundry_api_key: { type: 'TEXT', notNull: true, default: "''" },
      auth_foundry_resource: { type: 'TEXT', notNull: true, default: "''" },
      auth_foundry_base_url: { type: 'TEXT', notNull: true, default: "''" },
      auth_bedrock_bearer_token: { type: 'TEXT', notNull: true, default: "''" },
      custom_env_vars: { type: 'TEXT', notNull: true, default: "'{}'" },
      // Env-var controls (v23)
      disable_thinking: bool('disable_thinking', '0'),
      disable_fast_mode: bool('disable_fast_mode', '0'),
      max_turns: 'INTEGER',
      max_thinking_tokens: 'INTEGER',
      file_read_max_output_tokens: 'INTEGER',
      disable_claude_mds: bool('disable_claude_mds', '0'),
      bash_maintain_cwd: bool('bash_maintain_cwd', '0'),
      perforce_mode: bool('perforce_mode', '0'),
      glob_hidden: bool('glob_hidden', '0'),
      glob_no_ignore: bool('glob_no_ignore', '0'),
      glob_timeout_seconds: 'INTEGER',
      api_timeout_ms: 'INTEGER',
      max_retries: 'INTEGER',
      http_proxy: { type: 'TEXT', notNull: true, default: "''" },
      https_proxy: { type: 'TEXT', notNull: true, default: "''" },
      disable_nonessential_traffic: bool('disable_nonessential_traffic', '0'),
      do_not_track: bool('do_not_track', '0'),
      disable_background_tasks: bool('disable_background_tasks', '0'),
      disable_agent_view: bool('disable_agent_view', '0'),
      anthropic_betas: { type: 'TEXT', notNull: true, default: "''" },
      extra_body_json: { type: 'TEXT', notNull: true, default: "''" },
      // More env-var controls (v24)
      no_flicker: bool('no_flicker', '0'),
      disable_alternate_screen: bool('disable_alternate_screen', '0'),
      disable_virtual_scroll: bool('disable_virtual_scroll', '0'),
      disable_mouse: bool('disable_mouse', '0'),
      disable_terminal_title: bool('disable_terminal_title', '0'),
      scroll_speed: 'INTEGER',
      code_accessibility: bool('code_accessibility', '0'),
      omit_attribution_header: bool('omit_attribution_header', '0'),
      force_sync_output: bool('force_sync_output', '0'),
      enable_prompt_suggestion: bool('enable_prompt_suggestion', '0'),
      disable_1m_context: bool('disable_1m_context', '0'),
      disable_adaptive_thinking: bool('disable_adaptive_thinking', '0'),
      disable_legacy_model_remap: bool('disable_legacy_model_remap', '0'),
      auto_compact_window: 'INTEGER',
      autocompact_pct_override: 'INTEGER',
      disable_file_checkpointing: bool('disable_file_checkpointing', '0'),
      disable_attachments: bool('disable_attachments', '0'),
      shell_override: { type: 'TEXT', notNull: true, default: "''" },
      shell_prefix: { type: 'TEXT', notNull: true, default: "''" },
      enable_fine_grained_tool_streaming: bool('enable_fine_grained_tool_streaming', '0'),
      disable_nonstreaming_fallback: bool('disable_nonstreaming_fallback', '0'),
      proxy_resolves_hosts: bool('proxy_resolves_hosts', '0'),
      enable_gateway_model_discovery: bool('enable_gateway_model_discovery', '0'),
      auto_background_tasks: bool('auto_background_tasks', '0'),
      async_agent_stall_timeout_ms: 'INTEGER',
      enable_tasks: bool('enable_tasks', '0'),
      disable_cron: bool('disable_cron', '0'),
      exit_after_stop_delay: 'INTEGER',
      disable_feedback_command: bool('disable_feedback_command', '0'),
      disable_feedback_survey: bool('disable_feedback_survey', '0'),
      // Env-var controls (v52) — new feature toggles
      disable_bundled_skills: bool('disable_bundled_skills', '0'),
      disable_workflows: bool('disable_workflows', '0'),
      enable_away_summary: bool('enable_away_summary', '0'),
      disable_artifact: bool('disable_artifact', '0'),
      disable_advisor_tool: bool('disable_advisor_tool', '0'),
      screen_reader: bool('screen_reader', '0'),
      additional_dirs_claude_md: bool('additional_dirs_claude_md', '0'),
      ghostty_config_json: { type: 'TEXT', notNull: true, default: "'{}'" },
      // Guardrail settings (v64) — spawn caps for workspace lineage
      max_workspace_depth: { type: 'INTEGER', notNull: true, default: '3' },
      max_workspace_children: { type: 'INTEGER', notNull: true, default: '10' },
      // Env-var controls (v66)
      tool_call_timeout_ms: 'INTEGER',
      max_tool_output_length: 'INTEGER',
      disable_mouse_clicks: bool('disable_mouse_clicks', '0'),
      rewind_on_error_enabled: bool('rewind_on_error_enabled', '0'),
      low_power_mode: bool('low_power_mode', '0'),
      updated_at: INTEGER_NOT_NULL
    },
    normalizeOnRebuild: {
      // Defensive backstop for a table holding plaintext secrets (id=1
      // singleton): if a pre-existing DB somehow has an out-of-range enum
      // value in one of these columns (e.g. a legacy column added via ALTER
      // before it had a CHECK), a rebuild's shadow-table copy would throw
      // "CHECK constraint failed" and brick app startup with no fallback.
      // Coerce out-of-range values to each column's own DEFAULT instead —
      // mirrors workspaces.status's existing backstop.
      permission_mode: enumCoerce('permission_mode', PERMISSION_MODE, 'default'),
      effort: enumCoerce('effort', EFFORT, 'auto'),
      output_style: enumCoerce('output_style', OUTPUT_STYLE, 'default'),
      tui_mode: enumCoerce('tui_mode', TUI_MODE, 'default'),
      editor_mode: enumCoerce('editor_mode', EDITOR_MODE, 'normal'),
      log_level: enumCoerce('log_level', LOG_LEVEL, 'info'),
      cloud_provider: enumCoerce('cloud_provider', CLOUD_PROVIDER, 'anthropic')
    }
  },

  // ---------------------------------------------------------------------
  // claude_project_settings
  // ---------------------------------------------------------------------
  claude_project_settings: {
    columns: {
      project_id: TEXT_PK,
      overrides_json: { type: 'TEXT', notNull: true, default: "'{}'" },
      updated_at: INTEGER_NOT_NULL
    },
    foreignKeys: [{ columns: ['project_id'], ref: 'projects(id)', onDelete: 'CASCADE' }]
  },

  // ---------------------------------------------------------------------
  // claude_workspace_settings
  // ---------------------------------------------------------------------
  claude_workspace_settings: {
    columns: {
      workspace_id: TEXT_PK,
      overrides_json: { type: 'TEXT', notNull: true, default: "'{}'" },
      updated_at: INTEGER_NOT_NULL
    },
    foreignKeys: [{ columns: ['workspace_id'], ref: 'workspaces(id)', onDelete: 'CASCADE' }]
  },

  // ---------------------------------------------------------------------
  // app_ui_state (33 columns in the fresh-install constant + drift columns
  // that were also folded back into it)
  // ---------------------------------------------------------------------
  app_ui_state: {
    columns: {
      id: { type: 'INTEGER', primaryKey: true, check: 'CHECK (id = 1)' },
      sidebar_collapsed: bool('sidebar_collapsed', '0'),
      last_view_kind: {
        type: 'TEXT',
        notNull: true,
        default: "'sessions'",
        check: enumCheck('last_view_kind', LAST_VIEW_KIND)
      },
      last_project_id: 'TEXT REFERENCES projects(id) ON DELETE SET NULL',
      last_workspace_id: 'TEXT REFERENCES workspaces(id) ON DELETE SET NULL',
      window_x: 'INTEGER',
      window_y: 'INTEGER',
      window_width: 'INTEGER',
      window_height: 'INTEGER',
      window_fullscreen: bool('window_fullscreen', '0'),
      // Window behavior preferences (v11)
      restore_geometry: bool('restore_geometry', '1'),
      close_hides: bool('close_hides', '1'),
      open_at_last_view: bool('open_at_last_view', '1'),
      // Sidebar behavior preferences (v12)
      pinned_section_visible: bool('pinned_section_visible', '1'),
      workspace_count_inline: bool('workspace_count_inline', '1'),
      // mirrors UI_STATE_DEFAULTS.sidebarWidth / SIDEBAR_WIDTH_MIN..MAX in src/shared/uiStateDefaults.ts
      sidebar_width: {
        type: 'INTEGER',
        notNull: true,
        default: '256',
        check: 'CHECK (sidebar_width BETWEEN 200 AND 480)'
      },
      default_project_expanded: bool('default_project_expanded', '0'),
      // Launch + hotkey (v18)
      launch_at_login: bool('launch_at_login', '0'),
      global_hotkey: { type: 'TEXT', notNull: true, default: "''" },
      // Archive cap (v25)
      // mirrors UI_STATE_DEFAULTS.archivedWorkspaceLimit in src/shared/uiStateDefaults.ts
      archived_workspace_limit: { type: 'INTEGER', notNull: true, default: '20' },
      // Status polling preferences (v42)
      // mirrors UI_STATE_DEFAULTS.statusPollIntervalSec in src/shared/uiStateDefaults.ts
      status_poll_interval_sec: { type: 'INTEGER', notNull: true, default: '1800' },
      mute_status_notifications: bool('mute_status_notifications', '0'),
      // Workspace footer visibility (v45)
      show_workspace_footer: bool('show_workspace_footer', '1'),
      // Diagnostics capture toggles (v56) — plain INTEGER, no CHECK in source
      diag_error: { type: 'INTEGER', notNull: true, default: '1' },
      diag_lifecycle: { type: 'INTEGER', notNull: true, default: '0' },
      diag_perf: { type: 'INTEGER', notNull: true, default: '0' },
      diag_anomaly: { type: 'INTEGER', notNull: true, default: '0' },
      // Trace capture (v61) — off by default
      diag_trace: { type: 'INTEGER', notNull: true, default: '0' },
      auto_close_after_minutes: 'INTEGER',
      // Notification enrichment (v59)
      notify_rich_summary: { type: 'BOOLEAN', notNull: true, default: '1' },
      notify_suppress_when_focused: { type: 'BOOLEAN', notNull: true, default: '0' },
      // Hooks integration (v60) — default 0 (off); opt-in to socket server + settings.json hooks
      hooks_integration_enabled: { type: 'INTEGER', notNull: true, default: '0' },
      // Files-tab editor save mode (v62) — default 0 (manual save via Cmd/Ctrl+S).
      files_auto_save: bool('files_auto_save', '0'),
      // ALTER-only columns folded into desired state (drift vs the fresh-install
      // constant per _db-surface.md's "Columns added ONLY via later ALTER" list)
      notify_attention: { type: 'BOOLEAN', notNull: true, default: '1' },
      notify_stop: { type: 'BOOLEAN', notNull: true, default: '1' },
      notify_always: { type: 'BOOLEAN', notNull: true, default: '0' },
      notify_max_attention_repeats: { type: 'INTEGER', notNull: true, default: '5' },
      in_progress_watchdog_sec: { type: 'INTEGER', notNull: true, default: '120' },
      preferred_editor_app: 'TEXT',
      preferred_terminal_app: 'TEXT',
      max_local_sessions: 'INTEGER',
      theme: {
        type: 'TEXT',
        notNull: true,
        default: "'midnight'",
        check: enumCheck('theme', THEME)
      },
      accent_color: {
        type: 'TEXT',
        check: `CHECK (accent_color IS NULL OR (${enumClause('accent_color', ACCENT_COLOR)}))`
      },
      ui_font_scale: {
        type: 'TEXT',
        notNull: true,
        default: "'default'",
        check: enumCheck('ui_font_scale', UI_FONT_SCALE)
      },
      fetch_github_avatars: bool('fetch_github_avatars', '1'),
      play_interaction_sounds: bool('play_interaction_sounds', '1'),
      sound_pack: {
        type: 'TEXT',
        notNull: true,
        default: "'core'",
        check: enumCheck('sound_pack', SOUND_PACK)
      },
      auto_check_updates: bool('auto_check_updates', '1'),
      // mirrors UI_STATE_DEFAULTS.staleAfterMinutes in src/shared/uiStateDefaults.ts
      stale_after_minutes: { type: 'INTEGER', notNull: true, default: '60' },
      // Files-tab tree VIEW preferences (v67) — moved out of the in-memory
      // per-workspace filesTabStore so they're app-wide + survive restart
      // (mirrors UI_STATE_DEFAULTS.filesShowHidden/… in
      // src/shared/uiStateDefaults.ts). files_flatten_empty_dirs is a SHARED
      // Files+Git setting (Git tab's ⚙ "Flatten empty folders" toggle reads/
      // writes this same column — see GitDiffOptionsPopover.tsx) and now
      // defaults to 0/OFF — each folder is its own expandable row rather than
      // collapsing single-child dir chains into an unreadable breadcrumb.
      files_show_hidden: bool('files_show_hidden', '0'),
      files_dim_gitignored: bool('files_dim_gitignored', '1'),
      files_wrap_lines: bool('files_wrap_lines', '1'),
      files_sort_order: {
        type: 'TEXT',
        notNull: true,
        default: "'default'",
        check: enumCheck('files_sort_order', FILES_SORT_ORDER)
      },
      files_flatten_empty_dirs: bool('files_flatten_empty_dirs', '0'),
      // Workbench Git-tab diff VIEW preferences (v68) — app-wide, same
      // pattern as the files_* columns above: the Git tab's ⚙ options
      // popover's "Wrap lines" toggle (mirrors UI_STATE_DEFAULTS.gitDiffWrapLines
      // in src/shared/uiStateDefaults.ts). Default 1 (wrap on).
      git_diff_wrap_lines: bool('git_diff_wrap_lines', '1'),
      // Workbench tree/code split pane width (v69) — draggable divider width,
      // SHARED between FilesTab's tree and GitTab's DiffTreePane (mirrors
      // UI_STATE_DEFAULTS.workbenchTreeWidth / WORKBENCH_TREE_WIDTH_MIN..MAX
      // in src/shared/uiStateDefaults.ts — same clamp-at-read pattern as
      // sidebar_width above).
      workbench_tree_width: {
        type: 'INTEGER',
        notNull: true,
        default: '240',
        check: 'CHECK (workbench_tree_width BETWEEN 160 AND 560)'
      },
      updated_at: INTEGER_NOT_NULL
    },
    // workbench_enabled (Workbench feature flag) was removed once the
    // Workbench became always-on. Listed here (rather than just omitted from
    // `columns` above) so the declarative engine actually drops it via
    // ALTER TABLE ... DROP COLUMN on existing DBs — omitting a column from
    // `columns` alone leaves it as a tolerated stray live column forever.
    dropColumns: ['workbench_enabled']
  },

  // ---------------------------------------------------------------------
  // action_audit_log
  // ---------------------------------------------------------------------
  action_audit_log: {
    columns: {
      id: { type: 'INTEGER', primaryKey: true },
      workspace_id: TEXT_NOT_NULL,
      action_id: TEXT_NOT_NULL,
      params_json: TEXT_NOT_NULL,
      result_code: TEXT_NOT_NULL,
      consumer_hint: TEXT_NOT_NULL,
      created_at: INTEGER_NOT_NULL
    },
    indexes: {
      idx_action_audit_workspace_created: ['workspace_id', 'created_at DESC']
    }
  },

  // ---------------------------------------------------------------------
  // diagnostics_events
  // ---------------------------------------------------------------------
  diagnostics_events: {
    columns: {
      id: { type: 'INTEGER', primaryKey: true },
      ts: INTEGER_NOT_NULL,
      process: TEXT_NOT_NULL,
      category: TEXT_NOT_NULL,
      level: TEXT_NOT_NULL,
      event: TEXT_NOT_NULL,
      workspace_id: 'TEXT',
      session_id: 'TEXT',
      duration_ms: 'INTEGER',
      message: 'TEXT',
      data: 'TEXT',
      seq: INTEGER_NOT_NULL,
      trace_id: 'TEXT',
      span_id: 'TEXT',
      parent_span_id: 'TEXT',
      name: 'TEXT',
      kind: 'TEXT'
    },
    indexes: {
      idx_diag_ts: ['ts'],
      idx_diag_cat_ts: ['category', 'ts'],
      idx_diag_ws_ts: ['workspace_id', 'ts'],
      idx_diag_event_ts: ['event', 'ts'],
      idx_diag_trace: ['trace_id', 'ts']
    }
  },

  // ---------------------------------------------------------------------
  // footer_actions_global
  // ---------------------------------------------------------------------
  footer_actions_global: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      label: TEXT_NOT_NULL,
      icon: 'TEXT',
      action_id: TEXT_NOT_NULL,
      params_json: { type: 'TEXT', notNull: true, default: "'{}'" },
      visible_when: { type: 'TEXT', notNull: true, default: "'always'" },
      position: INTEGER_NOT_NULL,
      created_at: INTEGER_NOT_NULL,
      updated_at: INTEGER_NOT_NULL,
      prompts_json: 'TEXT'
    }
  },

  // ---------------------------------------------------------------------
  // footer_actions_project
  // ---------------------------------------------------------------------
  footer_actions_project: {
    columns: footerActionsColumns('project_id'),
    foreignKeys: [{ columns: ['project_id'], ref: 'projects(id)', onDelete: 'CASCADE' }],
    indexes: {
      idx_footer_actions_project_project_id: ['project_id']
    }
  },

  // ---------------------------------------------------------------------
  // footer_actions_workspace
  // ---------------------------------------------------------------------
  footer_actions_workspace: {
    columns: footerActionsColumns('workspace_id'),
    foreignKeys: [{ columns: ['workspace_id'], ref: 'workspaces(id)', onDelete: 'CASCADE' }],
    indexes: {
      idx_footer_actions_workspace_workspace_id: ['workspace_id']
    }
  },

  // ---------------------------------------------------------------------
  // keep_awake_settings
  // ---------------------------------------------------------------------
  // SEED: handled by keep-awake-seed data step (Task 9) — renderCreateTable
  // can't emit the `INSERT OR IGNORE` that ships alongside KEEP_AWAKE_SCHEMA_SQL
  // in db.ts, so structure only here.
  keep_awake_settings: {
    columns: {
      id: { type: 'INTEGER', primaryKey: true, check: 'CHECK (id = 1)' },
      mode: {
        type: 'TEXT',
        notNull: true,
        default: "'auto'",
        check: enumCheck('mode', KEEP_AWAKE_MODE)
      },
      display_on: bool('display_on', '0'),
      timer_minutes: { type: 'INTEGER', notNull: true, default: '120' }
    },
    normalizeOnRebuild: {
      // No historical CHECK drift observed for this table (introduced at
      // v62 already at its final shape), but provide a safe coercion in
      // case a future rebuild encounters an unknown value.
      mode: enumCoerce('mode', KEEP_AWAKE_MODE, 'auto')
    }
  },

  // ---------------------------------------------------------------------
  // review_comments — Workbench Git tab, Phase 4d. The LOCAL (Orpheus-owned)
  // review-comment store, completing the 3-source comment model alongside
  // GitHub's own review comments (github-from-others / my-github / LOCAL —
  // see src/main/reviewStore.ts's own header). A local comment can exist
  // with no PR at all (`pr_number` nullable) — it's anchored to a workspace +
  // file/line, not to a GitHub PR. `line`/`side` are nullable to allow a
  // file-level (not line-anchored) comment, mirroring GhReviewCommentThread's
  // own `subjectType: 'file'` case (shared/types.ts).
  // ---------------------------------------------------------------------
  review_comments: {
    columns: {
      id: TEXT_PK,
      workspace_id: TEXT_NOT_NULL,
      pr_number: 'INTEGER',
      path: TEXT_NOT_NULL,
      line: 'INTEGER',
      side: 'TEXT',
      body: TEXT_NOT_NULL,
      author: TEXT_NOT_NULL,
      resolved: { type: 'INTEGER', notNull: true, default: '0' },
      created_at: INTEGER_NOT_NULL,
      updated_at: INTEGER_NOT_NULL
    },
    foreignKeys: [{ columns: ['workspace_id'], ref: 'workspaces(id)', onDelete: 'CASCADE' }],
    indexes: {
      idx_review_comments_workspace_path: ['workspace_id', 'path'],
      idx_review_comments_workspace: ['workspace_id']
    }
  }
}

export {
  WORKSPACE_STATUS,
  SESSION_STATUS,
  KEEP_AWAKE_MODE,
  PERMISSION_MODE,
  EFFORT,
  OUTPUT_STYLE,
  TUI_MODE,
  EDITOR_MODE,
  CLOUD_PROVIDER,
  LOG_LEVEL,
  LAST_VIEW_KIND,
  THEME,
  ACCENT_COLOR,
  UI_FONT_SCALE,
  SOUND_PACK
}
