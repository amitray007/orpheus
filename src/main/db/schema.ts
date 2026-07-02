import type { ColumnDef, SchemaDef } from './types'
import { enumCheck } from './render'

// Shared enum arrays — exported for reuse by app code (renderer/main) so the
// set of valid values lives in exactly one place. Values copied verbatim from
// the CHECK clauses in docs/superpowers/plans/_db-surface.md.

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

export const schema: SchemaDef = {
  // ---------------------------------------------------------------------
  // projects
  // ---------------------------------------------------------------------
  projects: {
    columns: {
      id: 'TEXT PRIMARY KEY NOT NULL',
      path: 'TEXT UNIQUE NOT NULL',
      name: 'TEXT NOT NULL',
      claude_encoded_name: 'TEXT',
      added_at: 'INTEGER NOT NULL',
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
      id: 'TEXT PRIMARY KEY NOT NULL',
      project_id: 'TEXT NOT NULL',
      jsonl_path: 'TEXT NOT NULL',
      title: 'TEXT',
      status: {
        type: 'TEXT',
        notNull: true,
        default: "'in_review'",
        check: enumCheck('status', SESSION_STATUS)
      },
      created_at: 'INTEGER NOT NULL',
      updated_at: 'INTEGER NOT NULL',
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
      status: `CASE WHEN status IN (${SESSION_STATUS.map((v) => `'${v}'`).join(', ')}) THEN status ELSE 'in_review' END`
    }
  },

  // ---------------------------------------------------------------------
  // workspaces
  // ---------------------------------------------------------------------
  workspaces: {
    columns: {
      id: 'TEXT PRIMARY KEY NOT NULL',
      project_id: 'TEXT NOT NULL',
      name: 'TEXT NOT NULL',
      cwd: 'TEXT NOT NULL',
      pinned_at: 'INTEGER',
      created_at: 'INTEGER NOT NULL',
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
      forked_from_session_id: 'TEXT'
    },
    foreignKeys: [{ columns: ['project_id'], ref: 'projects(id)', onDelete: 'CASCADE' }],
    indexes: {
      workspaces_project_id_idx: ['project_id'],
      workspaces_pinned_idx: ['pinned_at'],
      idx_workspaces_project_sort: ['project_id', 'sort_order', 'created_at DESC']
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
  // claude_global_settings (110 columns)
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
      updated_at: 'INTEGER NOT NULL'
    }
  },

  // ---------------------------------------------------------------------
  // claude_project_settings
  // ---------------------------------------------------------------------
  claude_project_settings: {
    columns: {
      project_id: 'TEXT PRIMARY KEY NOT NULL',
      overrides_json: { type: 'TEXT', notNull: true, default: "'{}'" },
      updated_at: 'INTEGER NOT NULL'
    },
    foreignKeys: [{ columns: ['project_id'], ref: 'projects(id)', onDelete: 'CASCADE' }]
  },

  // ---------------------------------------------------------------------
  // claude_workspace_settings
  // ---------------------------------------------------------------------
  claude_workspace_settings: {
    columns: {
      workspace_id: 'TEXT PRIMARY KEY NOT NULL',
      overrides_json: { type: 'TEXT', notNull: true, default: "'{}'" },
      updated_at: 'INTEGER NOT NULL'
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
        default: "'dashboard'",
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
      archived_workspace_limit: { type: 'INTEGER', notNull: true, default: '20' },
      // Status polling preferences (v42)
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
        check: `CHECK (accent_color IS NULL OR ${enumCheck('accent_color', ACCENT_COLOR).replace('CHECK ', '')})`
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
      stale_after_minutes: { type: 'INTEGER', notNull: true, default: '60' },
      updated_at: 'INTEGER NOT NULL'
    }
  },

  // ---------------------------------------------------------------------
  // action_audit_log
  // ---------------------------------------------------------------------
  action_audit_log: {
    columns: {
      id: { type: 'INTEGER', primaryKey: true },
      workspace_id: 'TEXT NOT NULL',
      action_id: 'TEXT NOT NULL',
      params_json: 'TEXT NOT NULL',
      result_code: 'TEXT NOT NULL',
      consumer_hint: 'TEXT NOT NULL',
      created_at: 'INTEGER NOT NULL'
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
      ts: 'INTEGER NOT NULL',
      process: 'TEXT NOT NULL',
      category: 'TEXT NOT NULL',
      level: 'TEXT NOT NULL',
      event: 'TEXT NOT NULL',
      workspace_id: 'TEXT',
      session_id: 'TEXT',
      duration_ms: 'INTEGER',
      message: 'TEXT',
      data: 'TEXT',
      seq: 'INTEGER NOT NULL',
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
      label: 'TEXT NOT NULL',
      icon: 'TEXT',
      action_id: 'TEXT NOT NULL',
      params_json: { type: 'TEXT', notNull: true, default: "'{}'" },
      visible_when: { type: 'TEXT', notNull: true, default: "'always'" },
      position: 'INTEGER NOT NULL',
      created_at: 'INTEGER NOT NULL',
      updated_at: 'INTEGER NOT NULL',
      prompts_json: 'TEXT'
    }
  },

  // ---------------------------------------------------------------------
  // footer_actions_project
  // ---------------------------------------------------------------------
  footer_actions_project: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      project_id: 'TEXT NOT NULL',
      label: 'TEXT NOT NULL',
      icon: 'TEXT',
      action_id: 'TEXT NOT NULL',
      params_json: { type: 'TEXT', notNull: true, default: "'{}'" },
      visible_when: { type: 'TEXT', notNull: true, default: "'always'" },
      position: 'INTEGER NOT NULL',
      created_at: 'INTEGER NOT NULL',
      updated_at: 'INTEGER NOT NULL',
      prompts_json: 'TEXT'
    },
    foreignKeys: [{ columns: ['project_id'], ref: 'projects(id)', onDelete: 'CASCADE' }],
    indexes: {
      idx_footer_actions_project_project_id: ['project_id']
    }
  },

  // ---------------------------------------------------------------------
  // footer_actions_workspace
  // ---------------------------------------------------------------------
  footer_actions_workspace: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      workspace_id: 'TEXT NOT NULL',
      label: 'TEXT NOT NULL',
      icon: 'TEXT',
      action_id: 'TEXT NOT NULL',
      params_json: { type: 'TEXT', notNull: true, default: "'{}'" },
      visible_when: { type: 'TEXT', notNull: true, default: "'always'" },
      position: 'INTEGER NOT NULL',
      created_at: 'INTEGER NOT NULL',
      updated_at: 'INTEGER NOT NULL',
      prompts_json: 'TEXT'
    },
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
      mode: `CASE WHEN mode IN (${KEEP_AWAKE_MODE.map((v) => `'${v}'`).join(', ')}) THEN mode ELSE 'auto' END`
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
