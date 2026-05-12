import Database from 'better-sqlite3'
import { app } from 'electron'
import * as nodePath from 'node:path'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const CURRENT_VERSION = 9

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
    name_is_auto INTEGER NOT NULL DEFAULT 1
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
}
