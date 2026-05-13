import Database from 'better-sqlite3'
import { app } from 'electron'
import * as nodePath from 'node:path'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const CURRENT_VERSION = 23

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
    status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'in_review', 'completed', 'archived')),
    name_is_auto INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER
  );
  CREATE INDEX IF NOT EXISTS workspaces_project_id_idx ON workspaces(project_id);
  CREATE INDEX IF NOT EXISTS workspaces_pinned_idx ON workspaces(pinned_at);
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

  // Run migrations
  migrate(db)

  _db = db
  return _db
}

function migrate(db: Database.Database): void {
  // Apply base schema (all CREATE IF NOT EXISTS — safe to re-run)
  db.exec(SCHEMA_SQL)
  db.exec(WORKSPACES_SCHEMA_SQL)
  db.exec(CLAUDE_SETTINGS_SCHEMA_SQL)
  db.exec(CLAUDE_PROJECT_SETTINGS_SCHEMA_SQL)
  db.exec(CLAUDE_WORKSPACE_SETTINGS_SCHEMA_SQL)
  db.exec(UI_STATE_SCHEMA_SQL)

  // Check / set schema version
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number }
    | undefined

  const currentVersion = row?.version ?? 0

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
    db.prepare(
      `INSERT OR IGNORE INTO claude_global_settings (id, updated_at) VALUES (1, ?)`
    ).run(Date.now())

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
    db.prepare(
      `INSERT OR IGNORE INTO app_ui_state (id, updated_at) VALUES (1, ?)`
    ).run(Date.now())

    if (row) {
      db.prepare('UPDATE schema_version SET version = ?').run(6)
    }
  }

  // Version 7: window geometry columns on app_ui_state
  if (currentVersion < 7) {
    try { db.exec('ALTER TABLE app_ui_state ADD COLUMN window_x INTEGER') } catch {}
    try { db.exec('ALTER TABLE app_ui_state ADD COLUMN window_y INTEGER') } catch {}
    try { db.exec('ALTER TABLE app_ui_state ADD COLUMN window_width INTEGER') } catch {}
    try { db.exec('ALTER TABLE app_ui_state ADD COLUMN window_height INTEGER') } catch {}
    try { db.exec('ALTER TABLE app_ui_state ADD COLUMN window_fullscreen INTEGER NOT NULL DEFAULT 0') } catch {}
    if (row) {
      db.prepare('UPDATE schema_version SET version = ?').run(7)
    }
  }

  // Version 8: Display section columns on claude_global_settings
  if (currentVersion < 8) {
    try { db.exec("ALTER TABLE claude_global_settings ADD COLUMN output_style TEXT NOT NULL DEFAULT 'default' CHECK (output_style IN ('default', 'explanatory', 'proactive', 'learning'))") } catch {}
    try { db.exec("ALTER TABLE claude_global_settings ADD COLUMN tui_mode TEXT NOT NULL DEFAULT 'default' CHECK (tui_mode IN ('default', 'fullscreen'))") } catch {}
    try { db.exec("ALTER TABLE claude_global_settings ADD COLUMN editor_mode TEXT NOT NULL DEFAULT 'normal' CHECK (editor_mode IN ('normal', 'vim'))") } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN reduce_motion INTEGER NOT NULL DEFAULT 0 CHECK (reduce_motion IN (0, 1))') } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN native_cursor INTEGER NOT NULL DEFAULT 0 CHECK (native_cursor IN (0, 1))') } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN hide_cwd INTEGER NOT NULL DEFAULT 0 CHECK (hide_cwd IN (0, 1))') } catch {}
    if (row) {
      db.prepare('UPDATE schema_version SET version = ?').run(8)
    }
  }

  // Version 9: Memory, Developer, Permissions columns on claude_global_settings
  if (currentVersion < 9) {
    // Memory section
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN disable_git_instructions INTEGER NOT NULL DEFAULT 0') } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN max_output_tokens INTEGER') } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN max_context_tokens INTEGER') } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN compaction_threshold INTEGER') } catch {}
    // Developer section
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN debug_logging INTEGER NOT NULL DEFAULT 0') } catch {}
    try { db.exec("ALTER TABLE claude_global_settings ADD COLUMN log_level TEXT NOT NULL DEFAULT 'info'") } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN disable_telemetry INTEGER NOT NULL DEFAULT 0') } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN disable_error_reporting INTEGER NOT NULL DEFAULT 0') } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN disable_autoupdater INTEGER NOT NULL DEFAULT 0') } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN experimental_agent_teams INTEGER NOT NULL DEFAULT 0') } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN experimental_forked_subagents INTEGER NOT NULL DEFAULT 0') } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN simple_system_prompt INTEGER NOT NULL DEFAULT 0') } catch {}
    // Permissions section
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN auto_approve_edits INTEGER NOT NULL DEFAULT 0') } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN ask_destructive_bash INTEGER NOT NULL DEFAULT 0') } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN plan_mode_default INTEGER NOT NULL DEFAULT 0') } catch {}
    try { db.exec("ALTER TABLE claude_global_settings ADD COLUMN permission_allow_rules TEXT NOT NULL DEFAULT '[]'") } catch {}
    try { db.exec("ALTER TABLE claude_global_settings ADD COLUMN permission_ask_rules TEXT NOT NULL DEFAULT '[]'") } catch {}
    try { db.exec("ALTER TABLE claude_global_settings ADD COLUMN permission_deny_rules TEXT NOT NULL DEFAULT '[]'") } catch {}
    try { db.exec("ALTER TABLE claude_global_settings ADD COLUMN permission_additional_dirs TEXT NOT NULL DEFAULT '[]'") } catch {}
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
    try { db.exec('ALTER TABLE app_ui_state ADD COLUMN restore_geometry INTEGER NOT NULL DEFAULT 1 CHECK (restore_geometry IN (0, 1))') } catch {}
    try { db.exec('ALTER TABLE app_ui_state ADD COLUMN close_hides INTEGER NOT NULL DEFAULT 1 CHECK (close_hides IN (0, 1))') } catch {}
    try { db.exec('ALTER TABLE app_ui_state ADD COLUMN open_at_last_view INTEGER NOT NULL DEFAULT 1 CHECK (open_at_last_view IN (0, 1))') } catch {}
    // claude_global_settings new column (fallback model)
    try { db.exec("ALTER TABLE claude_global_settings ADD COLUMN fallback_model TEXT NOT NULL DEFAULT ''") } catch {}
    db.prepare('UPDATE schema_version SET version = ?').run(11)
  }

  // Version 12: sidebar behavior columns on app_ui_state
  if (currentVersion < 12) {
    try { db.exec('ALTER TABLE app_ui_state ADD COLUMN pinned_section_visible INTEGER NOT NULL DEFAULT 1 CHECK (pinned_section_visible IN (0, 1))') } catch {}
    try { db.exec('ALTER TABLE app_ui_state ADD COLUMN workspace_count_inline INTEGER NOT NULL DEFAULT 1 CHECK (workspace_count_inline IN (0, 1))') } catch {}
    try { db.exec('ALTER TABLE app_ui_state ADD COLUMN sidebar_width INTEGER NOT NULL DEFAULT 256 CHECK (sidebar_width BETWEEN 200 AND 480)') } catch {}
    try { db.exec('ALTER TABLE app_ui_state ADD COLUMN default_project_expanded INTEGER NOT NULL DEFAULT 0 CHECK (default_project_expanded IN (0, 1))') } catch {}
    db.prepare('UPDATE schema_version SET version = ?').run(12)
  }

  // Version 13: auth columns on claude_global_settings
  if (currentVersion < 13) {
    try { db.exec("ALTER TABLE claude_global_settings ADD COLUMN cloud_provider TEXT NOT NULL DEFAULT 'anthropic' CHECK (cloud_provider IN ('anthropic', 'bedrock', 'vertex', 'foundry'))") } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN auth_encrypted_blob BLOB') } catch {}
    db.prepare('UPDATE schema_version SET version = ?').run(13)
  }

  // Version 14: Tools section columns on claude_global_settings
  if (currentVersion < 14) {
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN bash_default_timeout_ms INTEGER') } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN bash_max_timeout_ms INTEGER') } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN bash_max_output_length INTEGER') } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN tool_concurrency INTEGER') } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN browser_integration INTEGER NOT NULL DEFAULT 1 CHECK (browser_integration IN (0, 1))') } catch {}
    try { db.exec("ALTER TABLE claude_global_settings ADD COLUMN disabled_mcp_servers TEXT NOT NULL DEFAULT '[]'") } catch {}
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
    try { db.exec("ALTER TABLE claude_global_settings ADD COLUMN auth_api_key TEXT NOT NULL DEFAULT ''") } catch {}
    try { db.exec("ALTER TABLE claude_global_settings ADD COLUMN auth_token TEXT NOT NULL DEFAULT ''") } catch {}
    try { db.exec("ALTER TABLE claude_global_settings ADD COLUMN auth_base_url TEXT NOT NULL DEFAULT ''") } catch {}
    // Clear the old encrypted blob — we can't decrypt it without the original signing identity
    db.prepare('UPDATE claude_global_settings SET auth_encrypted_blob = NULL WHERE id = 1').run()
    db.prepare('UPDATE schema_version SET version = ?').run(16)
  }

  // Version 17: provider-specific config columns for Bedrock and Vertex
  if (currentVersion < 17) {
    try { db.exec("ALTER TABLE claude_global_settings ADD COLUMN auth_aws_region TEXT NOT NULL DEFAULT ''") } catch {}
    try { db.exec("ALTER TABLE claude_global_settings ADD COLUMN auth_vertex_project_id TEXT NOT NULL DEFAULT ''") } catch {}
    try { db.exec("ALTER TABLE claude_global_settings ADD COLUMN auth_vertex_region TEXT NOT NULL DEFAULT ''") } catch {}
    db.prepare('UPDATE schema_version SET version = ?').run(17)
  }

  // Version 18: launch at login + global hotkey on app_ui_state
  if (currentVersion < 18) {
    try { db.exec("ALTER TABLE app_ui_state ADD COLUMN launch_at_login INTEGER NOT NULL DEFAULT 0 CHECK (launch_at_login IN (0, 1))") } catch {}
    try { db.exec("ALTER TABLE app_ui_state ADD COLUMN global_hotkey TEXT NOT NULL DEFAULT ''") } catch {}
    db.prepare('UPDATE schema_version SET version = ?').run(18)
  }

  // Version 19: projects.sort_order for drag-to-reorder
  if (currentVersion < 19) {
    try { db.exec('ALTER TABLE projects ADD COLUMN sort_order INTEGER') } catch {}
    db.prepare('UPDATE schema_version SET version = ?').run(19)
  }

  // Version 20: workspaces.sort_order for drag-to-reorder within a project
  if (currentVersion < 20) {
    try { db.exec('ALTER TABLE workspaces ADD COLUMN sort_order INTEGER') } catch {}
    db.prepare('UPDATE schema_version SET version = ?').run(20)
  }

  // Version 21: workspaces.status — four-stage workflow status
  if (currentVersion < 21) {
    try { db.exec("ALTER TABLE workspaces ADD COLUMN status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'in_review', 'completed', 'archived'))") } catch {}
    // Backfill: archived workspaces should have status='archived'
    db.prepare("UPDATE workspaces SET status = 'archived' WHERE archived_at IS NOT NULL AND status != 'archived'").run()
    db.prepare('UPDATE schema_version SET version = ?').run(21)
  }

  // Version 22: Foundry-specific auth fields, Bedrock bearer token, custom env vars
  if (currentVersion < 22) {
    try { db.exec("ALTER TABLE claude_global_settings ADD COLUMN auth_foundry_api_key TEXT NOT NULL DEFAULT ''") } catch {}
    try { db.exec("ALTER TABLE claude_global_settings ADD COLUMN auth_foundry_resource TEXT NOT NULL DEFAULT ''") } catch {}
    try { db.exec("ALTER TABLE claude_global_settings ADD COLUMN auth_foundry_base_url TEXT NOT NULL DEFAULT ''") } catch {}
    try { db.exec("ALTER TABLE claude_global_settings ADD COLUMN auth_bedrock_bearer_token TEXT NOT NULL DEFAULT ''") } catch {}
    try { db.exec("ALTER TABLE claude_global_settings ADD COLUMN custom_env_vars TEXT NOT NULL DEFAULT '{}'") } catch {}
    db.prepare('UPDATE schema_version SET version = ?').run(22)
  }

  // Version 23: Typed env-var controls (General, Memory & Context, Tools, Developer)
  if (currentVersion < 23) {
    // General
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN disable_thinking INTEGER NOT NULL DEFAULT 0 CHECK (disable_thinking IN (0, 1))') } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN disable_fast_mode INTEGER NOT NULL DEFAULT 0 CHECK (disable_fast_mode IN (0, 1))') } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN max_turns INTEGER') } catch {}
    // Memory & Context
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN max_thinking_tokens INTEGER') } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN file_read_max_output_tokens INTEGER') } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN disable_claude_mds INTEGER NOT NULL DEFAULT 0 CHECK (disable_claude_mds IN (0, 1))') } catch {}
    // Tools
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN bash_maintain_cwd INTEGER NOT NULL DEFAULT 0 CHECK (bash_maintain_cwd IN (0, 1))') } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN perforce_mode INTEGER NOT NULL DEFAULT 0 CHECK (perforce_mode IN (0, 1))') } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN glob_hidden INTEGER NOT NULL DEFAULT 0 CHECK (glob_hidden IN (0, 1))') } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN glob_no_ignore INTEGER NOT NULL DEFAULT 0 CHECK (glob_no_ignore IN (0, 1))') } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN glob_timeout_seconds INTEGER') } catch {}
    // Developer / Network
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN api_timeout_ms INTEGER') } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN max_retries INTEGER') } catch {}
    try { db.exec("ALTER TABLE claude_global_settings ADD COLUMN http_proxy TEXT NOT NULL DEFAULT ''") } catch {}
    try { db.exec("ALTER TABLE claude_global_settings ADD COLUMN https_proxy TEXT NOT NULL DEFAULT ''") } catch {}
    // Developer / Privacy & background
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN disable_nonessential_traffic INTEGER NOT NULL DEFAULT 0 CHECK (disable_nonessential_traffic IN (0, 1))') } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN do_not_track INTEGER NOT NULL DEFAULT 0 CHECK (do_not_track IN (0, 1))') } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN disable_background_tasks INTEGER NOT NULL DEFAULT 0 CHECK (disable_background_tasks IN (0, 1))') } catch {}
    try { db.exec('ALTER TABLE claude_global_settings ADD COLUMN disable_agent_view INTEGER NOT NULL DEFAULT 0 CHECK (disable_agent_view IN (0, 1))') } catch {}
    // Developer / Advanced
    try { db.exec("ALTER TABLE claude_global_settings ADD COLUMN anthropic_betas TEXT NOT NULL DEFAULT ''") } catch {}
    try { db.exec("ALTER TABLE claude_global_settings ADD COLUMN extra_body_json TEXT NOT NULL DEFAULT ''") } catch {}
    db.prepare('UPDATE schema_version SET version = ?').run(23)
  }
}
