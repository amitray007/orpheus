import Database from 'better-sqlite3'
import { app } from 'electron'
import * as nodePath from 'node:path'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const CURRENT_VERSION = 42

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY NOT NULL,
    path TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    claude_encoded_name TEXT,
    added_at INTEGER NOT NULL,
    last_opened_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    jsonl_path TEXT NOT NULL,
    title TEXT,
    status TEXT NOT NULL DEFAULT 'in_review'
      CHECK (status IN ('in_progress', 'in_review', 'archived')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER,
    model TEXT,
    last_message_role TEXT
  );

  CREATE INDEX IF NOT EXISTS sessions_project_id_idx ON sessions(project_id);
  CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions(status);
  CREATE INDEX IF NOT EXISTS sessions_updated_at_idx ON sessions(updated_at);
`

// CHECK kept in sync with WorkspaceStatus (shared/types.ts). When this drifted
// historically (v21 enum survived past v28's value migration), every dispatch to
// 'awaiting_input'|'attention'|'idle' raised CHECK constraint failed and got
// swallowed in setWorkspaceStatus's catch — leaving rows frozen at 'in_progress'
// and surfacing as a stuck "Claude is thinking" indicator across restarts.
const WORKSPACES_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    cwd TEXT NOT NULL,
    pinned_at INTEGER,
    created_at INTEGER NOT NULL,
    last_opened_at INTEGER,
    archived_at INTEGER,
    status TEXT NOT NULL DEFAULT 'idle'
      CHECK (status IN ('in_progress', 'awaiting_input', 'attention', 'idle', 'archived')),
    name_is_auto INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER,
    claude_session_id TEXT,
    last_title TEXT
  );
  CREATE INDEX IF NOT EXISTS workspaces_project_id_idx ON workspaces(project_id);
  CREATE INDEX IF NOT EXISTS workspaces_pinned_idx ON workspaces(pinned_at);
  CREATE INDEX IF NOT EXISTS idx_workspaces_project_sort
    ON workspaces(project_id, sort_order, created_at DESC);
`

const CLAUDE_SETTINGS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS claude_global_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    model TEXT NOT NULL DEFAULT 'sonnet',
    permission_mode TEXT NOT NULL DEFAULT 'default'
      CHECK (permission_mode IN ('default', 'acceptEdits', 'plan', 'bypassPermissions')),
    effort TEXT NOT NULL DEFAULT 'auto'
      CHECK (effort IN ('auto', 'low', 'medium', 'high', 'xhigh', 'max')),
    auto_memory INTEGER NOT NULL DEFAULT 1 CHECK (auto_memory IN (0, 1)),
    always_thinking INTEGER NOT NULL DEFAULT 0 CHECK (always_thinking IN (0, 1)),
    output_style TEXT NOT NULL DEFAULT 'default'
      CHECK (output_style IN ('default', 'explanatory', 'proactive', 'learning')),
    tui_mode TEXT NOT NULL DEFAULT 'default'
      CHECK (tui_mode IN ('default', 'fullscreen')),
    editor_mode TEXT NOT NULL DEFAULT 'normal'
      CHECK (editor_mode IN ('normal', 'vim')),
    reduce_motion INTEGER NOT NULL DEFAULT 0 CHECK (reduce_motion IN (0, 1)),
    native_cursor INTEGER NOT NULL DEFAULT 0 CHECK (native_cursor IN (0, 1)),
    hide_cwd INTEGER NOT NULL DEFAULT 0 CHECK (hide_cwd IN (0, 1)),
    -- Memory section (v9)
    disable_git_instructions INTEGER NOT NULL DEFAULT 0 CHECK (disable_git_instructions IN (0, 1)),
    max_output_tokens INTEGER,
    max_context_tokens INTEGER,
    compaction_threshold INTEGER,
    -- Developer section (v9)
    debug_logging INTEGER NOT NULL DEFAULT 0 CHECK (debug_logging IN (0, 1)),
    log_level TEXT NOT NULL DEFAULT 'info' CHECK (log_level IN ('debug', 'info', 'warn', 'error')),
    disable_telemetry INTEGER NOT NULL DEFAULT 0 CHECK (disable_telemetry IN (0, 1)),
    disable_error_reporting INTEGER NOT NULL DEFAULT 0 CHECK (disable_error_reporting IN (0, 1)),
    disable_autoupdater INTEGER NOT NULL DEFAULT 0 CHECK (disable_autoupdater IN (0, 1)),
    experimental_agent_teams INTEGER NOT NULL DEFAULT 0 CHECK (experimental_agent_teams IN (0, 1)),
    experimental_forked_subagents INTEGER NOT NULL DEFAULT 0 CHECK (experimental_forked_subagents IN (0, 1)),
    simple_system_prompt INTEGER NOT NULL DEFAULT 0 CHECK (simple_system_prompt IN (0, 1)),
    -- Permissions section (v9)
    auto_approve_edits INTEGER NOT NULL DEFAULT 0 CHECK (auto_approve_edits IN (0, 1)),
    ask_destructive_bash INTEGER NOT NULL DEFAULT 0 CHECK (ask_destructive_bash IN (0, 1)),
    plan_mode_default INTEGER NOT NULL DEFAULT 0 CHECK (plan_mode_default IN (0, 1)),
    permission_allow_rules TEXT NOT NULL DEFAULT '[]',
    permission_ask_rules TEXT NOT NULL DEFAULT '[]',
    permission_deny_rules TEXT NOT NULL DEFAULT '[]',
    permission_additional_dirs TEXT NOT NULL DEFAULT '[]',
    -- Fallback model (v11)
    fallback_model TEXT NOT NULL DEFAULT '',
    -- Auth (v13 / v16 / v17)
    cloud_provider TEXT NOT NULL DEFAULT 'anthropic'
      CHECK (cloud_provider IN ('anthropic', 'bedrock', 'vertex', 'foundry')),
    auth_encrypted_blob BLOB,
    auth_api_key TEXT NOT NULL DEFAULT '',
    auth_token TEXT NOT NULL DEFAULT '',
    auth_base_url TEXT NOT NULL DEFAULT '',
    auth_aws_region TEXT NOT NULL DEFAULT '',
    auth_vertex_project_id TEXT NOT NULL DEFAULT '',
    auth_vertex_region TEXT NOT NULL DEFAULT '',
    -- Tools section (v14)
    bash_default_timeout_ms INTEGER,
    bash_max_timeout_ms INTEGER,
    bash_max_output_length INTEGER,
    tool_concurrency INTEGER,
    browser_integration INTEGER NOT NULL DEFAULT 1 CHECK (browser_integration IN (0, 1)),
    disabled_mcp_servers TEXT NOT NULL DEFAULT '[]',
    -- Foundry + Bedrock bearer token + custom env vars (v22)
    auth_foundry_api_key TEXT NOT NULL DEFAULT '',
    auth_foundry_resource TEXT NOT NULL DEFAULT '',
    auth_foundry_base_url TEXT NOT NULL DEFAULT '',
    auth_bedrock_bearer_token TEXT NOT NULL DEFAULT '',
    custom_env_vars TEXT NOT NULL DEFAULT '{}',
    -- Env-var controls (v23)
    disable_thinking INTEGER NOT NULL DEFAULT 0 CHECK (disable_thinking IN (0, 1)),
    disable_fast_mode INTEGER NOT NULL DEFAULT 0 CHECK (disable_fast_mode IN (0, 1)),
    max_turns INTEGER,
    max_thinking_tokens INTEGER,
    file_read_max_output_tokens INTEGER,
    disable_claude_mds INTEGER NOT NULL DEFAULT 0 CHECK (disable_claude_mds IN (0, 1)),
    bash_maintain_cwd INTEGER NOT NULL DEFAULT 0 CHECK (bash_maintain_cwd IN (0, 1)),
    perforce_mode INTEGER NOT NULL DEFAULT 0 CHECK (perforce_mode IN (0, 1)),
    glob_hidden INTEGER NOT NULL DEFAULT 0 CHECK (glob_hidden IN (0, 1)),
    glob_no_ignore INTEGER NOT NULL DEFAULT 0 CHECK (glob_no_ignore IN (0, 1)),
    glob_timeout_seconds INTEGER,
    api_timeout_ms INTEGER,
    max_retries INTEGER,
    http_proxy TEXT NOT NULL DEFAULT '',
    https_proxy TEXT NOT NULL DEFAULT '',
    disable_nonessential_traffic INTEGER NOT NULL DEFAULT 0 CHECK (disable_nonessential_traffic IN (0, 1)),
    do_not_track INTEGER NOT NULL DEFAULT 0 CHECK (do_not_track IN (0, 1)),
    disable_background_tasks INTEGER NOT NULL DEFAULT 0 CHECK (disable_background_tasks IN (0, 1)),
    disable_agent_view INTEGER NOT NULL DEFAULT 0 CHECK (disable_agent_view IN (0, 1)),
    anthropic_betas TEXT NOT NULL DEFAULT '',
    extra_body_json TEXT NOT NULL DEFAULT '',
    -- More env-var controls (v24)
    no_flicker INTEGER NOT NULL DEFAULT 0 CHECK (no_flicker IN (0, 1)),
    disable_alternate_screen INTEGER NOT NULL DEFAULT 0 CHECK (disable_alternate_screen IN (0, 1)),
    disable_virtual_scroll INTEGER NOT NULL DEFAULT 0 CHECK (disable_virtual_scroll IN (0, 1)),
    disable_mouse INTEGER NOT NULL DEFAULT 0 CHECK (disable_mouse IN (0, 1)),
    disable_terminal_title INTEGER NOT NULL DEFAULT 0 CHECK (disable_terminal_title IN (0, 1)),
    scroll_speed INTEGER,
    code_accessibility INTEGER NOT NULL DEFAULT 0 CHECK (code_accessibility IN (0, 1)),
    omit_attribution_header INTEGER NOT NULL DEFAULT 0 CHECK (omit_attribution_header IN (0, 1)),
    force_sync_output INTEGER NOT NULL DEFAULT 0 CHECK (force_sync_output IN (0, 1)),
    enable_prompt_suggestion INTEGER NOT NULL DEFAULT 0 CHECK (enable_prompt_suggestion IN (0, 1)),
    disable_1m_context INTEGER NOT NULL DEFAULT 0 CHECK (disable_1m_context IN (0, 1)),
    disable_adaptive_thinking INTEGER NOT NULL DEFAULT 0 CHECK (disable_adaptive_thinking IN (0, 1)),
    disable_legacy_model_remap INTEGER NOT NULL DEFAULT 0 CHECK (disable_legacy_model_remap IN (0, 1)),
    auto_compact_window INTEGER,
    autocompact_pct_override INTEGER,
    disable_file_checkpointing INTEGER NOT NULL DEFAULT 0 CHECK (disable_file_checkpointing IN (0, 1)),
    disable_attachments INTEGER NOT NULL DEFAULT 0 CHECK (disable_attachments IN (0, 1)),
    shell_override TEXT NOT NULL DEFAULT '',
    shell_prefix TEXT NOT NULL DEFAULT '',
    enable_fine_grained_tool_streaming INTEGER NOT NULL DEFAULT 0 CHECK (enable_fine_grained_tool_streaming IN (0, 1)),
    disable_nonstreaming_fallback INTEGER NOT NULL DEFAULT 0 CHECK (disable_nonstreaming_fallback IN (0, 1)),
    proxy_resolves_hosts INTEGER NOT NULL DEFAULT 0 CHECK (proxy_resolves_hosts IN (0, 1)),
    enable_gateway_model_discovery INTEGER NOT NULL DEFAULT 0 CHECK (enable_gateway_model_discovery IN (0, 1)),
    auto_background_tasks INTEGER NOT NULL DEFAULT 0 CHECK (auto_background_tasks IN (0, 1)),
    async_agent_stall_timeout_ms INTEGER,
    enable_tasks INTEGER NOT NULL DEFAULT 0 CHECK (enable_tasks IN (0, 1)),
    disable_cron INTEGER NOT NULL DEFAULT 0 CHECK (disable_cron IN (0, 1)),
    exit_after_stop_delay INTEGER,
    disable_feedback_command INTEGER NOT NULL DEFAULT 0 CHECK (disable_feedback_command IN (0, 1)),
    disable_feedback_survey INTEGER NOT NULL DEFAULT 0 CHECK (disable_feedback_survey IN (0, 1)),
    updated_at INTEGER NOT NULL
  );
`

const CLAUDE_PROJECT_SETTINGS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS claude_project_settings (
    project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    overrides_json TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  );
`

const CLAUDE_WORKSPACE_SETTINGS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS claude_workspace_settings (
    workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    overrides_json TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  );
`

const UI_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS app_ui_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    sidebar_collapsed INTEGER NOT NULL DEFAULT 0 CHECK (sidebar_collapsed IN (0, 1)),
    last_view_kind TEXT NOT NULL DEFAULT 'dashboard'
      CHECK (last_view_kind IN ('dashboard', 'sessions', 'project', 'workspace')),
    last_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    last_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
    window_x INTEGER,
    window_y INTEGER,
    window_width INTEGER,
    window_height INTEGER,
    window_fullscreen INTEGER NOT NULL DEFAULT 0 CHECK (window_fullscreen IN (0, 1)),
    -- Window behavior preferences (v11)
    restore_geometry INTEGER NOT NULL DEFAULT 1 CHECK (restore_geometry IN (0, 1)),
    close_hides INTEGER NOT NULL DEFAULT 1 CHECK (close_hides IN (0, 1)),
    open_at_last_view INTEGER NOT NULL DEFAULT 1 CHECK (open_at_last_view IN (0, 1)),
    -- Sidebar behavior preferences (v12)
    pinned_section_visible INTEGER NOT NULL DEFAULT 1 CHECK (pinned_section_visible IN (0, 1)),
    workspace_count_inline INTEGER NOT NULL DEFAULT 1 CHECK (workspace_count_inline IN (0, 1)),
    sidebar_width INTEGER NOT NULL DEFAULT 256 CHECK (sidebar_width BETWEEN 200 AND 480),
    default_project_expanded INTEGER NOT NULL DEFAULT 0 CHECK (default_project_expanded IN (0, 1)),
    -- Launch + hotkey (v18)
    launch_at_login INTEGER NOT NULL DEFAULT 0 CHECK (launch_at_login IN (0, 1)),
    global_hotkey TEXT NOT NULL DEFAULT '',
    -- Archive cap (v25)
    archived_workspace_limit INTEGER NOT NULL DEFAULT 20,
    -- Status polling preferences (v42)
    status_poll_interval_sec INTEGER NOT NULL DEFAULT 1800,
    mute_status_notifications INTEGER NOT NULL DEFAULT 0 CHECK (mute_status_notifications IN (0, 1)),
    updated_at INTEGER NOT NULL
  );
`

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (_db) return _db

  const dbPath = nodePath.join(app.getPath('userData'), 'orpheus.sqlite')
  const db = new Database(dbPath)

  // WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL') // safe under WAL; eliminates fsync per commit
  db.pragma('cache_size = -8000') // 8 MB page cache (negative = KB)
  db.pragma('mmap_size = 268435456') // 256 MB memory-mapped IO
  db.pragma('temp_store = MEMORY') // temp tables in RAM

  // Run migrations
  migrate(db)

  _db = db
  return _db
}

function migrate(db: Database.Database): void {
  // schema_version must exist before we can read it — create it unconditionally
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);')

  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number }
    | undefined

  const currentVersion = row?.version ?? 0

  // Heal the workspaces CHECK before the fast-path check. The CHECK silently
  // drifted from the WorkspaceStatus enum across several version bumps without
  // any version flagging the problem, so versioning it now would just leave
  // existing installs stuck. This is idempotent and a no-op once the table is
  // healthy.
  healWorkspacesCheck(db)

  // Fast path: already up-to-date — skip all DDL and migration steps
  if (currentVersion === CURRENT_VERSION) return

  // Apply base schema (all CREATE IF NOT EXISTS — safe to re-run on new/old installs)
  db.exec(SCHEMA_SQL)
  db.exec(WORKSPACES_SCHEMA_SQL)
  db.exec(CLAUDE_SETTINGS_SCHEMA_SQL)
  db.exec(CLAUDE_PROJECT_SETTINGS_SCHEMA_SQL)
  db.exec(CLAUDE_WORKSPACE_SETTINGS_SCHEMA_SQL)
  db.exec(UI_STATE_SCHEMA_SQL)

  if (!row) {
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(CURRENT_VERSION)
  }

  // Version 2: add projects.pinned_at + workspaces table
  if (currentVersion < 2) {
    // WORKSPACES_SCHEMA_SQL is now executed unconditionally above; skip re-exec here.

    // ALTER TABLE ADD COLUMN is safe to run once — guard with version check
    try {
      db.exec('ALTER TABLE projects ADD COLUMN pinned_at INTEGER')
    } catch {
      // Column may already exist if DB was created fresh with an older version check missed
    }

    if (row) {
      db.prepare('UPDATE schema_version SET version = ?').run(2)
    }
  }

  // Version 3: drop projects.archived_at + add workspaces.name_is_auto
  if (currentVersion < 3) {
    try {
      db.exec('ALTER TABLE projects DROP COLUMN archived_at')
    } catch {
      // Column may already be absent on a fresh DB or previous partial migration
    }

    try {
      db.exec('ALTER TABLE workspaces ADD COLUMN name_is_auto INTEGER NOT NULL DEFAULT 1')
    } catch {
      // Column may already exist if this migration ran partially
    }

    if (row) {
      db.prepare('UPDATE schema_version SET version = ?').run(3)
    }
  }

  // Version 4: drop projects.pinned_at
  if (currentVersion < 4) {
    try {
      db.exec('ALTER TABLE projects DROP COLUMN pinned_at')
    } catch {
      // Already gone
    }
    if (row) {
      db.prepare('UPDATE schema_version SET version = ?').run(4)
    }
  }

  // Version 5: claude_global_settings singleton table + seed row
  if (currentVersion < 5) {
    // Table is already created unconditionally above via CLAUDE_SETTINGS_SCHEMA_SQL.
    // Seed the singleton row (other columns use schema DEFAULT values).
    db.prepare(`INSERT OR IGNORE INTO claude_global_settings (id, updated_at) VALUES (1, ?)`).run(
      Date.now()
    )

    if (row) {
      db.prepare('UPDATE schema_version SET version = ?').run(5)
    }
  }

  // Version 6: app_ui_state singleton table + projects.expanded_in_sidebar column
  if (currentVersion < 6) {
    // Add expanded_in_sidebar column to projects
    try {
      db.exec('ALTER TABLE projects ADD COLUMN expanded_in_sidebar INTEGER NOT NULL DEFAULT 0')
    } catch {
      // Column may already exist if this migration ran partially
    }

    // Seed the app_ui_state singleton row
    db.prepare(`INSERT OR IGNORE INTO app_ui_state (id, updated_at) VALUES (1, ?)`).run(Date.now())

    if (row) {
      db.prepare('UPDATE schema_version SET version = ?').run(6)
    }
  }

  // Version 7: window geometry columns on app_ui_state
  if (currentVersion < 7) {
    try {
      db.exec('ALTER TABLE app_ui_state ADD COLUMN window_x INTEGER')
    } catch {
      /* ignore */
    }
    try {
      db.exec('ALTER TABLE app_ui_state ADD COLUMN window_y INTEGER')
    } catch {
      /* ignore */
    }
    try {
      db.exec('ALTER TABLE app_ui_state ADD COLUMN window_width INTEGER')
    } catch {
      /* ignore */
    }
    try {
      db.exec('ALTER TABLE app_ui_state ADD COLUMN window_height INTEGER')
    } catch {
      /* ignore */
    }
    try {
      db.exec('ALTER TABLE app_ui_state ADD COLUMN window_fullscreen INTEGER NOT NULL DEFAULT 0')
    } catch {
      /* ignore */
    }
    if (row) {
      db.prepare('UPDATE schema_version SET version = ?').run(7)
    }
  }

  // Version 8: Display section columns on claude_global_settings
  if (currentVersion < 8) {
    try {
      db.exec(
        "ALTER TABLE claude_global_settings ADD COLUMN output_style TEXT NOT NULL DEFAULT 'default' CHECK (output_style IN ('default', 'explanatory', 'proactive', 'learning'))"
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        "ALTER TABLE claude_global_settings ADD COLUMN tui_mode TEXT NOT NULL DEFAULT 'default' CHECK (tui_mode IN ('default', 'fullscreen'))"
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        "ALTER TABLE claude_global_settings ADD COLUMN editor_mode TEXT NOT NULL DEFAULT 'normal' CHECK (editor_mode IN ('normal', 'vim'))"
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN reduce_motion INTEGER NOT NULL DEFAULT 0 CHECK (reduce_motion IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN native_cursor INTEGER NOT NULL DEFAULT 0 CHECK (native_cursor IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN hide_cwd INTEGER NOT NULL DEFAULT 0 CHECK (hide_cwd IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    if (row) {
      db.prepare('UPDATE schema_version SET version = ?').run(8)
    }
  }

  // Version 9: Memory, Developer, Permissions columns on claude_global_settings
  if (currentVersion < 9) {
    // Memory section
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN disable_git_instructions INTEGER NOT NULL DEFAULT 0'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec('ALTER TABLE claude_global_settings ADD COLUMN max_output_tokens INTEGER')
    } catch {
      /* ignore */
    }
    try {
      db.exec('ALTER TABLE claude_global_settings ADD COLUMN max_context_tokens INTEGER')
    } catch {
      /* ignore */
    }
    try {
      db.exec('ALTER TABLE claude_global_settings ADD COLUMN compaction_threshold INTEGER')
    } catch {
      /* ignore */
    }
    // Developer section
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN debug_logging INTEGER NOT NULL DEFAULT 0'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        "ALTER TABLE claude_global_settings ADD COLUMN log_level TEXT NOT NULL DEFAULT 'info'"
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN disable_telemetry INTEGER NOT NULL DEFAULT 0'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN disable_error_reporting INTEGER NOT NULL DEFAULT 0'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN disable_autoupdater INTEGER NOT NULL DEFAULT 0'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN experimental_agent_teams INTEGER NOT NULL DEFAULT 0'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN experimental_forked_subagents INTEGER NOT NULL DEFAULT 0'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN simple_system_prompt INTEGER NOT NULL DEFAULT 0'
      )
    } catch {
      /* ignore */
    }
    // Permissions section
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN auto_approve_edits INTEGER NOT NULL DEFAULT 0'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN ask_destructive_bash INTEGER NOT NULL DEFAULT 0'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN plan_mode_default INTEGER NOT NULL DEFAULT 0'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        "ALTER TABLE claude_global_settings ADD COLUMN permission_allow_rules TEXT NOT NULL DEFAULT '[]'"
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        "ALTER TABLE claude_global_settings ADD COLUMN permission_ask_rules TEXT NOT NULL DEFAULT '[]'"
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        "ALTER TABLE claude_global_settings ADD COLUMN permission_deny_rules TEXT NOT NULL DEFAULT '[]'"
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        "ALTER TABLE claude_global_settings ADD COLUMN permission_additional_dirs TEXT NOT NULL DEFAULT '[]'"
      )
    } catch {
      /* ignore */
    }
    db.prepare('UPDATE schema_version SET version = ?').run(9)
  }

  // Version 10: claude_project_settings table (per-project overrides)
  if (currentVersion < 10) {
    // Table is already created unconditionally above via CLAUDE_PROJECT_SETTINGS_SCHEMA_SQL.
    // Nothing else needed — CREATE TABLE IF NOT EXISTS handles both fresh and existing DBs.
    if (row) {
      db.prepare('UPDATE schema_version SET version = ?').run(10)
    }
  }

  // Version 11: window behavior columns on app_ui_state + fallback_model on claude_global_settings
  if (currentVersion < 11) {
    // app_ui_state new columns (window behavior preferences)
    try {
      db.exec(
        'ALTER TABLE app_ui_state ADD COLUMN restore_geometry INTEGER NOT NULL DEFAULT 1 CHECK (restore_geometry IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE app_ui_state ADD COLUMN close_hides INTEGER NOT NULL DEFAULT 1 CHECK (close_hides IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE app_ui_state ADD COLUMN open_at_last_view INTEGER NOT NULL DEFAULT 1 CHECK (open_at_last_view IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    // claude_global_settings new column (fallback model)
    try {
      db.exec(
        "ALTER TABLE claude_global_settings ADD COLUMN fallback_model TEXT NOT NULL DEFAULT ''"
      )
    } catch {
      /* ignore */
    }
    db.prepare('UPDATE schema_version SET version = ?').run(11)
  }

  // Version 12: sidebar behavior columns on app_ui_state
  if (currentVersion < 12) {
    try {
      db.exec(
        'ALTER TABLE app_ui_state ADD COLUMN pinned_section_visible INTEGER NOT NULL DEFAULT 1 CHECK (pinned_section_visible IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE app_ui_state ADD COLUMN workspace_count_inline INTEGER NOT NULL DEFAULT 1 CHECK (workspace_count_inline IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE app_ui_state ADD COLUMN sidebar_width INTEGER NOT NULL DEFAULT 256 CHECK (sidebar_width BETWEEN 200 AND 480)'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE app_ui_state ADD COLUMN default_project_expanded INTEGER NOT NULL DEFAULT 0 CHECK (default_project_expanded IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    db.prepare('UPDATE schema_version SET version = ?').run(12)
  }

  // Version 13: auth columns on claude_global_settings
  if (currentVersion < 13) {
    try {
      db.exec(
        "ALTER TABLE claude_global_settings ADD COLUMN cloud_provider TEXT NOT NULL DEFAULT 'anthropic' CHECK (cloud_provider IN ('anthropic', 'bedrock', 'vertex', 'foundry'))"
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec('ALTER TABLE claude_global_settings ADD COLUMN auth_encrypted_blob BLOB')
    } catch {
      /* ignore */
    }
    db.prepare('UPDATE schema_version SET version = ?').run(13)
  }

  // Version 14: Tools section columns on claude_global_settings
  if (currentVersion < 14) {
    try {
      db.exec('ALTER TABLE claude_global_settings ADD COLUMN bash_default_timeout_ms INTEGER')
    } catch {
      /* ignore */
    }
    try {
      db.exec('ALTER TABLE claude_global_settings ADD COLUMN bash_max_timeout_ms INTEGER')
    } catch {
      /* ignore */
    }
    try {
      db.exec('ALTER TABLE claude_global_settings ADD COLUMN bash_max_output_length INTEGER')
    } catch {
      /* ignore */
    }
    try {
      db.exec('ALTER TABLE claude_global_settings ADD COLUMN tool_concurrency INTEGER')
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN browser_integration INTEGER NOT NULL DEFAULT 1 CHECK (browser_integration IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        "ALTER TABLE claude_global_settings ADD COLUMN disabled_mcp_servers TEXT NOT NULL DEFAULT '[]'"
      )
    } catch {
      /* ignore */
    }
    db.prepare('UPDATE schema_version SET version = ?').run(14)
  }

  // Version 15: claude_workspace_settings table (per-workspace overrides)
  if (currentVersion < 15) {
    // Table is already created unconditionally above via CLAUDE_WORKSPACE_SETTINGS_SCHEMA_SQL.
    // Nothing else needed — CREATE TABLE IF NOT EXISTS handles both fresh and existing DBs.
    if (row) {
      db.prepare('UPDATE schema_version SET version = ?').run(15)
    }
  }

  // Version 16: plaintext auth columns replace safeStorage-encrypted blob
  if (currentVersion < 16) {
    try {
      db.exec("ALTER TABLE claude_global_settings ADD COLUMN auth_api_key TEXT NOT NULL DEFAULT ''")
    } catch {
      /* ignore */
    }
    try {
      db.exec("ALTER TABLE claude_global_settings ADD COLUMN auth_token TEXT NOT NULL DEFAULT ''")
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        "ALTER TABLE claude_global_settings ADD COLUMN auth_base_url TEXT NOT NULL DEFAULT ''"
      )
    } catch {
      /* ignore */
    }
    // Clear the old encrypted blob — we can't decrypt it without the original signing identity
    db.prepare('UPDATE claude_global_settings SET auth_encrypted_blob = NULL WHERE id = 1').run()
    db.prepare('UPDATE schema_version SET version = ?').run(16)
  }

  // Version 17: provider-specific config columns for Bedrock and Vertex
  if (currentVersion < 17) {
    try {
      db.exec(
        "ALTER TABLE claude_global_settings ADD COLUMN auth_aws_region TEXT NOT NULL DEFAULT ''"
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        "ALTER TABLE claude_global_settings ADD COLUMN auth_vertex_project_id TEXT NOT NULL DEFAULT ''"
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        "ALTER TABLE claude_global_settings ADD COLUMN auth_vertex_region TEXT NOT NULL DEFAULT ''"
      )
    } catch {
      /* ignore */
    }
    db.prepare('UPDATE schema_version SET version = ?').run(17)
  }

  // Version 18: launch at login + global hotkey on app_ui_state
  if (currentVersion < 18) {
    try {
      db.exec(
        'ALTER TABLE app_ui_state ADD COLUMN launch_at_login INTEGER NOT NULL DEFAULT 0 CHECK (launch_at_login IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec("ALTER TABLE app_ui_state ADD COLUMN global_hotkey TEXT NOT NULL DEFAULT ''")
    } catch {
      /* ignore */
    }
    db.prepare('UPDATE schema_version SET version = ?').run(18)
  }

  // Version 19: projects.sort_order for drag-to-reorder
  if (currentVersion < 19) {
    try {
      db.exec('ALTER TABLE projects ADD COLUMN sort_order INTEGER')
    } catch {
      /* ignore */
    }
    db.prepare('UPDATE schema_version SET version = ?').run(19)
  }

  // Version 20: workspaces.sort_order for drag-to-reorder within a project
  if (currentVersion < 20) {
    try {
      db.exec('ALTER TABLE workspaces ADD COLUMN sort_order INTEGER')
    } catch {
      /* ignore */
    }
    db.prepare('UPDATE schema_version SET version = ?').run(20)
  }

  // Version 21: workspaces.status — four-stage workflow status
  if (currentVersion < 21) {
    try {
      db.exec(
        "ALTER TABLE workspaces ADD COLUMN status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'in_review', 'completed', 'archived'))"
      )
    } catch {
      /* ignore */
    }
    // Backfill: archived workspaces should have status='archived'
    db.prepare(
      "UPDATE workspaces SET status = 'archived' WHERE archived_at IS NOT NULL AND status != 'archived'"
    ).run()
    db.prepare('UPDATE schema_version SET version = ?').run(21)
  }

  // Version 22: Foundry-specific auth fields, Bedrock bearer token, custom env vars
  if (currentVersion < 22) {
    try {
      db.exec(
        "ALTER TABLE claude_global_settings ADD COLUMN auth_foundry_api_key TEXT NOT NULL DEFAULT ''"
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        "ALTER TABLE claude_global_settings ADD COLUMN auth_foundry_resource TEXT NOT NULL DEFAULT ''"
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        "ALTER TABLE claude_global_settings ADD COLUMN auth_foundry_base_url TEXT NOT NULL DEFAULT ''"
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        "ALTER TABLE claude_global_settings ADD COLUMN auth_bedrock_bearer_token TEXT NOT NULL DEFAULT ''"
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        "ALTER TABLE claude_global_settings ADD COLUMN custom_env_vars TEXT NOT NULL DEFAULT '{}'"
      )
    } catch {
      /* ignore */
    }
    db.prepare('UPDATE schema_version SET version = ?').run(22)
  }

  // Version 23: Typed env-var controls (General, Memory & Context, Tools, Developer)
  if (currentVersion < 23) {
    // General
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN disable_thinking INTEGER NOT NULL DEFAULT 0 CHECK (disable_thinking IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN disable_fast_mode INTEGER NOT NULL DEFAULT 0 CHECK (disable_fast_mode IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec('ALTER TABLE claude_global_settings ADD COLUMN max_turns INTEGER')
    } catch {
      /* ignore */
    }
    // Memory & Context
    try {
      db.exec('ALTER TABLE claude_global_settings ADD COLUMN max_thinking_tokens INTEGER')
    } catch {
      /* ignore */
    }
    try {
      db.exec('ALTER TABLE claude_global_settings ADD COLUMN file_read_max_output_tokens INTEGER')
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN disable_claude_mds INTEGER NOT NULL DEFAULT 0 CHECK (disable_claude_mds IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    // Tools
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN bash_maintain_cwd INTEGER NOT NULL DEFAULT 0 CHECK (bash_maintain_cwd IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN perforce_mode INTEGER NOT NULL DEFAULT 0 CHECK (perforce_mode IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN glob_hidden INTEGER NOT NULL DEFAULT 0 CHECK (glob_hidden IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN glob_no_ignore INTEGER NOT NULL DEFAULT 0 CHECK (glob_no_ignore IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec('ALTER TABLE claude_global_settings ADD COLUMN glob_timeout_seconds INTEGER')
    } catch {
      /* ignore */
    }
    // Developer / Network
    try {
      db.exec('ALTER TABLE claude_global_settings ADD COLUMN api_timeout_ms INTEGER')
    } catch {
      /* ignore */
    }
    try {
      db.exec('ALTER TABLE claude_global_settings ADD COLUMN max_retries INTEGER')
    } catch {
      /* ignore */
    }
    try {
      db.exec("ALTER TABLE claude_global_settings ADD COLUMN http_proxy TEXT NOT NULL DEFAULT ''")
    } catch {
      /* ignore */
    }
    try {
      db.exec("ALTER TABLE claude_global_settings ADD COLUMN https_proxy TEXT NOT NULL DEFAULT ''")
    } catch {
      /* ignore */
    }
    // Developer / Privacy & background
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN disable_nonessential_traffic INTEGER NOT NULL DEFAULT 0 CHECK (disable_nonessential_traffic IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN do_not_track INTEGER NOT NULL DEFAULT 0 CHECK (do_not_track IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN disable_background_tasks INTEGER NOT NULL DEFAULT 0 CHECK (disable_background_tasks IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN disable_agent_view INTEGER NOT NULL DEFAULT 0 CHECK (disable_agent_view IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    // Developer / Advanced
    try {
      db.exec(
        "ALTER TABLE claude_global_settings ADD COLUMN anthropic_betas TEXT NOT NULL DEFAULT ''"
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        "ALTER TABLE claude_global_settings ADD COLUMN extra_body_json TEXT NOT NULL DEFAULT ''"
      )
    } catch {
      /* ignore */
    }
    db.prepare('UPDATE schema_version SET version = ?').run(23)
  }

  // Version 24: More env-var controls (Display rendering, General model capabilities, Memory, Tools, Developer)
  if (currentVersion < 24) {
    // Display / Rendering
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN no_flicker INTEGER NOT NULL DEFAULT 0 CHECK (no_flicker IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN disable_alternate_screen INTEGER NOT NULL DEFAULT 0 CHECK (disable_alternate_screen IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN disable_virtual_scroll INTEGER NOT NULL DEFAULT 0 CHECK (disable_virtual_scroll IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN disable_mouse INTEGER NOT NULL DEFAULT 0 CHECK (disable_mouse IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN disable_terminal_title INTEGER NOT NULL DEFAULT 0 CHECK (disable_terminal_title IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec('ALTER TABLE claude_global_settings ADD COLUMN scroll_speed INTEGER')
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN code_accessibility INTEGER NOT NULL DEFAULT 0 CHECK (code_accessibility IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN omit_attribution_header INTEGER NOT NULL DEFAULT 0 CHECK (omit_attribution_header IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN force_sync_output INTEGER NOT NULL DEFAULT 0 CHECK (force_sync_output IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN enable_prompt_suggestion INTEGER NOT NULL DEFAULT 0 CHECK (enable_prompt_suggestion IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    // General / Model capabilities
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN disable_1m_context INTEGER NOT NULL DEFAULT 0 CHECK (disable_1m_context IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN disable_adaptive_thinking INTEGER NOT NULL DEFAULT 0 CHECK (disable_adaptive_thinking IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN disable_legacy_model_remap INTEGER NOT NULL DEFAULT 0 CHECK (disable_legacy_model_remap IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    // Memory & Context
    try {
      db.exec('ALTER TABLE claude_global_settings ADD COLUMN auto_compact_window INTEGER')
    } catch {
      /* ignore */
    }
    try {
      db.exec('ALTER TABLE claude_global_settings ADD COLUMN autocompact_pct_override INTEGER')
    } catch {
      /* ignore */
    }
    // Tools / File operations
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN disable_file_checkpointing INTEGER NOT NULL DEFAULT 0 CHECK (disable_file_checkpointing IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN disable_attachments INTEGER NOT NULL DEFAULT 0 CHECK (disable_attachments IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    // Tools / Shell
    try {
      db.exec(
        "ALTER TABLE claude_global_settings ADD COLUMN shell_override TEXT NOT NULL DEFAULT ''"
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec("ALTER TABLE claude_global_settings ADD COLUMN shell_prefix TEXT NOT NULL DEFAULT ''")
    } catch {
      /* ignore */
    }
    // Developer / Network
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN enable_fine_grained_tool_streaming INTEGER NOT NULL DEFAULT 0 CHECK (enable_fine_grained_tool_streaming IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN disable_nonstreaming_fallback INTEGER NOT NULL DEFAULT 0 CHECK (disable_nonstreaming_fallback IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN proxy_resolves_hosts INTEGER NOT NULL DEFAULT 0 CHECK (proxy_resolves_hosts IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN enable_gateway_model_discovery INTEGER NOT NULL DEFAULT 0 CHECK (enable_gateway_model_discovery IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    // Developer / Privacy & background tasks
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN auto_background_tasks INTEGER NOT NULL DEFAULT 0 CHECK (auto_background_tasks IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec('ALTER TABLE claude_global_settings ADD COLUMN async_agent_stall_timeout_ms INTEGER')
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN enable_tasks INTEGER NOT NULL DEFAULT 0 CHECK (enable_tasks IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN disable_cron INTEGER NOT NULL DEFAULT 0 CHECK (disable_cron IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec('ALTER TABLE claude_global_settings ADD COLUMN exit_after_stop_delay INTEGER')
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN disable_feedback_command INTEGER NOT NULL DEFAULT 0 CHECK (disable_feedback_command IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE claude_global_settings ADD COLUMN disable_feedback_survey INTEGER NOT NULL DEFAULT 0 CHECK (disable_feedback_survey IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    db.prepare('UPDATE schema_version SET version = ?').run(24)
  }

  // Version 25: archived_workspace_limit on app_ui_state (LRU cap)
  if (currentVersion < 25) {
    try {
      db.exec(
        'ALTER TABLE app_ui_state ADD COLUMN archived_workspace_limit INTEGER NOT NULL DEFAULT 20'
      )
    } catch {
      /* ignore */
    }
    db.prepare('UPDATE schema_version SET version = ?').run(25)
  }

  // Version 26: claude_session_id on workspaces — persists the session ID so
  // subsequent mounts can pass --resume and pick up the conversation.
  if (currentVersion < 26) {
    try {
      db.exec('ALTER TABLE workspaces ADD COLUMN claude_session_id TEXT')
    } catch {
      /* ignore */
    }
    db.prepare('UPDATE schema_version SET version = ?').run(26)
  }

  // Version 27: last_title on workspaces — last terminal title observed via
  // OSC dispatch. Used to seed the sidebar / workspace header on app launch
  // so users see the prior prompt title instead of the default workspace name
  // until Claude (re)emits a fresh title.
  if (currentVersion < 27) {
    try {
      db.exec('ALTER TABLE workspaces ADD COLUMN last_title TEXT')
    } catch {
      /* ignore */
    }
    db.prepare('UPDATE schema_version SET version = ?').run(27)
  }

  if (currentVersion < 28) {
    db.prepare(
      "UPDATE workspaces SET status = 'awaiting_input' WHERE status IN ('in_review', 'completed')"
    ).run()
    db.prepare('UPDATE schema_version SET version = ?').run(28)
  }

  if (currentVersion < 29) {
    try {
      db.exec('ALTER TABLE app_ui_state ADD COLUMN notify_attention BOOLEAN NOT NULL DEFAULT 1')
    } catch {
      /* ignore */
    }
    try {
      db.exec('ALTER TABLE app_ui_state ADD COLUMN notify_stop      BOOLEAN NOT NULL DEFAULT 1')
    } catch {
      /* ignore */
    }
    try {
      db.exec('ALTER TABLE app_ui_state ADD COLUMN notify_always    BOOLEAN NOT NULL DEFAULT 0')
    } catch {
      /* ignore */
    }
    db.prepare('UPDATE schema_version SET version = ?').run(29)
  }

  if (currentVersion < 30) {
    try {
      db.exec(
        'ALTER TABLE app_ui_state ADD COLUMN notify_max_attention_repeats INTEGER NOT NULL DEFAULT 5'
      )
    } catch {
      /* ignore */
    }
    db.prepare('UPDATE schema_version SET version = ?').run(30)
  }

  if (currentVersion < 31) {
    try {
      db.exec(
        'ALTER TABLE app_ui_state ADD COLUMN in_progress_watchdog_sec INTEGER NOT NULL DEFAULT 120'
      )
    } catch {
      /* ignore */
    }
    db.prepare('UPDATE schema_version SET version = ?').run(31)
  }

  // Version 32: app picker preferences on app_ui_state
  if (currentVersion < 32) {
    try {
      db.exec('ALTER TABLE app_ui_state ADD COLUMN preferred_editor_app TEXT')
    } catch {
      /* ignore */
    }
    try {
      db.exec('ALTER TABLE app_ui_state ADD COLUMN preferred_terminal_app TEXT')
    } catch {
      /* ignore */
    }
    db.prepare('UPDATE schema_version SET version = ?').run(32)
  }

  // Version 33: session stats (message_count, jsonl_size_bytes) + auto-prune cap (max_local_sessions)
  if (currentVersion < 33) {
    try {
      db.exec('ALTER TABLE sessions ADD COLUMN message_count INTEGER')
    } catch {
      /* ignore */
    }
    try {
      db.exec('ALTER TABLE sessions ADD COLUMN jsonl_size_bytes INTEGER')
    } catch {
      /* ignore */
    }
    try {
      db.exec('ALTER TABLE app_ui_state ADD COLUMN max_local_sessions INTEGER')
    } catch {
      /* ignore */
    }
    db.prepare('UPDATE schema_version SET version = ?').run(33)
  }

  // Version 34: last-message preview snippet for Sessions page
  if (currentVersion < 34) {
    try {
      db.exec('ALTER TABLE sessions ADD COLUMN last_message_preview TEXT')
    } catch {
      /* ignore */
    }
    db.prepare('UPDATE schema_version SET version = ?').run(34)
  }

  // Version 35: last user-message preview for sidebar workspace rows
  if (currentVersion < 35) {
    try {
      db.exec('ALTER TABLE sessions ADD COLUMN last_user_message_preview TEXT')
    } catch {
      /* ignore */
    }
    db.prepare('UPDATE schema_version SET version = ?').run(35)
  }

  // Version 36: appearance — theme, accent color, font scale
  if (currentVersion < 36) {
    try {
      db.exec(
        "ALTER TABLE app_ui_state ADD COLUMN theme TEXT NOT NULL DEFAULT 'midnight' CHECK (theme IN ('midnight', 'daylight', 'eclipse'))"
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        "ALTER TABLE app_ui_state ADD COLUMN accent_color TEXT CHECK (accent_color IS NULL OR accent_color IN ('gold', 'blue', 'teal', 'orange', 'pink'))"
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        "ALTER TABLE app_ui_state ADD COLUMN ui_font_scale TEXT NOT NULL DEFAULT 'default' CHECK (ui_font_scale IN ('small', 'default', 'large'))"
      )
    } catch {
      /* ignore */
    }
    db.prepare('UPDATE schema_version SET version = ?').run(36)
  }

  // Version 37: per-project GitHub data + global avatar-fetch toggle
  if (currentVersion < 37) {
    try {
      db.exec('ALTER TABLE projects ADD COLUMN github_owner TEXT')
    } catch {
      /* ignore */
    }
    try {
      db.exec('ALTER TABLE projects ADD COLUMN github_repo TEXT')
    } catch {
      /* ignore */
    }
    try {
      db.exec('ALTER TABLE projects ADD COLUMN github_avatar_url TEXT')
    } catch {
      /* ignore */
    }
    try {
      db.exec('ALTER TABLE projects ADD COLUMN github_checked_at INTEGER')
    } catch {
      /* ignore */
    }
    // Global privacy toggle — default 1 (enabled)
    try {
      db.exec(
        'ALTER TABLE app_ui_state ADD COLUMN fetch_github_avatars INTEGER NOT NULL DEFAULT 1 CHECK (fetch_github_avatars IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    db.prepare('UPDATE schema_version SET version = ?').run(37)
  }

  // Version 38: interaction sounds toggle
  if (currentVersion < 38) {
    try {
      db.exec(
        'ALTER TABLE app_ui_state ADD COLUMN play_interaction_sounds INTEGER NOT NULL DEFAULT 1 CHECK (play_interaction_sounds IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    db.prepare('UPDATE schema_version SET version = ?').run(38)
  }

  // Version 39: sound pack picker
  if (currentVersion < 39) {
    try {
      db.exec(
        "ALTER TABLE app_ui_state ADD COLUMN sound_pack TEXT NOT NULL DEFAULT 'core' CHECK (sound_pack IN ('core', 'minimal', 'mechanical', 'retro', 'playful', 'crisp', 'organic', 'soft'))"
      )
    } catch {
      /* ignore */
    }
    db.prepare('UPDATE schema_version SET version = ?').run(39)
  }

  // Version 40: auto-check for updates toggle
  if (currentVersion < 40) {
    try {
      db.exec(
        'ALTER TABLE app_ui_state ADD COLUMN auto_check_updates INTEGER NOT NULL DEFAULT 1 CHECK (auto_check_updates IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    db.prepare('UPDATE schema_version SET version = ?').run(40)
  }

  // Version 41: composite and targeted indexes for common query patterns
  if (currentVersion < 41) {
    // workspaces: covers listWorkspacesForProject(project_id ORDER BY sort_order, created_at DESC)
    try {
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_workspaces_project_sort ON workspaces(project_id, sort_order, created_at DESC)'
      )
    } catch {
      /* ignore */
    }
    // projects: covers WHERE archived_at IS NULL in listAllSessions and similar
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_projects_archived_at ON projects(archived_at)')
    } catch {
      /* ignore */
    }
    // sessions: covers project-scoped search using LOWER(title)
    try {
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_sessions_project_title_lower ON sessions(project_id, LOWER(title))'
      )
    } catch {
      /* ignore */
    }
    // sessions: covers pruneOldSessions ORDER BY updated_at ASC scope
    try {
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_sessions_project_updated ON sessions(project_id, updated_at ASC)'
      )
    } catch {
      /* ignore */
    }
    db.prepare('UPDATE schema_version SET version = ?').run(41)
  }

  // Version 42: status polling preferences on app_ui_state.
  // Default = 1800s (30 min) — matches the allowed Select option set
  // (5/10/15/30 min + 1/2/3 hr) so freshly migrated rows are valid against
  // validateIntervalSec in main/uiState.ts and the UI Select options.
  if (currentVersion < 42) {
    try {
      db.exec(
        'ALTER TABLE app_ui_state ADD COLUMN status_poll_interval_sec INTEGER NOT NULL DEFAULT 1800'
      )
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        'ALTER TABLE app_ui_state ADD COLUMN mute_status_notifications INTEGER NOT NULL DEFAULT 0 CHECK (mute_status_notifications IN (0, 1))'
      )
    } catch {
      /* ignore */
    }
    db.prepare('UPDATE schema_version SET version = ?').run(42)
  }
}

function healWorkspacesCheck(db: Database.Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='workspaces'")
    .get() as { sql: string } | undefined
  if (!row) return
  const sql = row.sql
  // Treat the table as stale if it lacks any current status value or still
  // mentions a removed one. Match the CHECK shape without depending on exact
  // whitespace / quoting.
  const hasAllCurrent =
    sql.includes("'in_progress'") &&
    sql.includes("'awaiting_input'") &&
    sql.includes("'attention'") &&
    sql.includes("'idle'") &&
    sql.includes("'archived'")
  const hasLegacy = sql.includes("'in_review'") || sql.includes("'completed'")
  if (hasAllCurrent && !hasLegacy) return

  console.log('[db] workspaces CHECK is stale — rebuilding via copy-migration to preserve rows')
  db.pragma('foreign_keys = OFF')
  try {
    const rebuild = db.transaction(() => {
      // Create the new table with the canonical CHECK. Inline rather than
      // re-using WORKSPACES_SCHEMA_SQL so we can name it _new for the swap.
      db.exec(`
        CREATE TABLE workspaces_new (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          cwd TEXT NOT NULL,
          pinned_at INTEGER,
          created_at INTEGER NOT NULL,
          last_opened_at INTEGER,
          archived_at INTEGER,
          status TEXT NOT NULL DEFAULT 'idle'
            CHECK (status IN ('in_progress', 'awaiting_input', 'attention', 'idle', 'archived')),
          name_is_auto INTEGER NOT NULL DEFAULT 1,
          sort_order INTEGER,
          claude_session_id TEXT,
          last_title TEXT
        )
      `)
      // Copy every workspace row, normalising any legacy status value that
      // the old CHECK accepted but the new one doesn't. Archived rows keep
      // their state; everything else falls back to 'idle' if unknown (the
      // startup reset will redrive it once the user activates the workspace).
      db.exec(`
        INSERT INTO workspaces_new (
          id, project_id, name, cwd, pinned_at, created_at, last_opened_at,
          archived_at, status, name_is_auto, sort_order, claude_session_id, last_title
        )
        SELECT
          id, project_id, name, cwd, pinned_at, created_at, last_opened_at,
          archived_at,
          CASE
            WHEN status IN ('in_progress', 'awaiting_input', 'attention', 'idle', 'archived')
              THEN status
            WHEN archived_at IS NOT NULL THEN 'archived'
            ELSE 'idle'
          END,
          name_is_auto, sort_order, claude_session_id, last_title
        FROM workspaces
      `)
      db.exec('DROP TABLE workspaces')
      db.exec('ALTER TABLE workspaces_new RENAME TO workspaces')
      db.exec('CREATE INDEX IF NOT EXISTS workspaces_project_id_idx ON workspaces(project_id)')
      db.exec('CREATE INDEX IF NOT EXISTS workspaces_pinned_idx ON workspaces(pinned_at)')
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_workspaces_project_sort ON workspaces(project_id, sort_order, created_at DESC)'
      )
    })
    rebuild()
  } finally {
    db.pragma('foreign_keys = ON')
  }
}
