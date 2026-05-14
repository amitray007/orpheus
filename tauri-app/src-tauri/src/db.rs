// Database layer: opens/creates the Orpheus SQLite DB and runs the v0→v31
// migration ladder that mirrors src/main/db.ts.
//
// Uses rusqlite (blocking, matches better-sqlite3 semantics). Callers share the
// Db via Arc<Mutex<Db>> in tauri::State.

use std::path::{Path, PathBuf};

use directories::ProjectDirs;
use rusqlite::Connection;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error(transparent)]
    Rusqlite(#[from] rusqlite::Error),

    #[error("migration failed at v{0}: {1}")]
    Migration(u32, String),

    #[error("cannot determine app data directory")]
    NoDataDir,
}

// ---------------------------------------------------------------------------
// Public struct
// ---------------------------------------------------------------------------

pub struct Db {
    conn: Connection,
}

impl Db {
    /// Open (or create) the DB at the platform-specific path and migrate.
    pub fn open() -> Result<Self, DbError> {
        let path = db_path().ok_or(DbError::NoDataDir)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        Self::open_at(&path)
    }

    /// Open (or create) a DB at an explicit path — used in tests and for custom paths.
    pub fn open_at(path: &Path) -> Result<Self, DbError> {
        let conn = Connection::open(path)?;

        // Match Electron: WAL mode + foreign keys on.
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;

        let mut db = Db { conn };
        db.migrate()?;
        Ok(db)
    }

    /// Current schema version (from schema_version table).
    pub fn current_version(&self) -> i64 {
        self.conn
            .query_row(
                "SELECT version FROM schema_version LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0)
    }

    /// Borrow the underlying connection for prepared statements.
    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    /// Mutably borrow the underlying connection.
    pub fn conn_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }

    // -----------------------------------------------------------------------
    // Migration ladder — mirrors db.ts migrate() exactly
    // -----------------------------------------------------------------------

    fn migrate(&mut self) -> Result<(), DbError> {
        // Base schema: all CREATE IF NOT EXISTS — safe to re-run.
        self.conn.execute_batch(SCHEMA_SQL)?;
        self.conn.execute_batch(WORKSPACES_SCHEMA_SQL)?;
        self.conn.execute_batch(CLAUDE_SETTINGS_SCHEMA_SQL)?;
        self.conn.execute_batch(CLAUDE_PROJECT_SETTINGS_SCHEMA_SQL)?;
        self.conn.execute_batch(CLAUDE_WORKSPACE_SETTINGS_SCHEMA_SQL)?;
        self.conn.execute_batch(UI_STATE_SCHEMA_SQL)?;

        // Read current version from schema_version.
        let row: Option<i64> = self
            .conn
            .query_row(
                "SELECT version FROM schema_version LIMIT 1",
                [],
                |r| r.get(0),
            )
            .ok();

        let current_version = row.unwrap_or(0);

        if row.is_none() {
            // Fresh DB: seed at current target version.
            self.conn.execute(
                "INSERT INTO schema_version (version) VALUES (?1)",
                [CURRENT_VERSION],
            )?;
        }

        // v2: projects.pinned_at + workspaces table (table already created above)
        if current_version < 2 {
            let _ = self.conn.execute_batch("ALTER TABLE projects ADD COLUMN pinned_at INTEGER");
            if row.is_some() {
                self.conn.execute("UPDATE schema_version SET version = 2", [])?;
            }
        }

        // v3: drop projects.archived_at + workspaces.name_is_auto
        if current_version < 3 {
            let _ = self.conn.execute_batch("ALTER TABLE projects DROP COLUMN archived_at");
            let _ = self.conn.execute_batch(
                "ALTER TABLE workspaces ADD COLUMN name_is_auto INTEGER NOT NULL DEFAULT 1",
            );
            if row.is_some() {
                self.conn.execute("UPDATE schema_version SET version = 3", [])?;
            }
        }

        // v4: drop projects.pinned_at
        if current_version < 4 {
            let _ = self.conn.execute_batch("ALTER TABLE projects DROP COLUMN pinned_at");
            if row.is_some() {
                self.conn.execute("UPDATE schema_version SET version = 4", [])?;
            }
        }

        // v5: seed claude_global_settings singleton row
        if current_version < 5 {
            let now = now_ms();
            self.conn.execute(
                "INSERT OR IGNORE INTO claude_global_settings (id, updated_at) VALUES (1, ?1)",
                [now],
            )?;
            if row.is_some() {
                self.conn.execute("UPDATE schema_version SET version = 5", [])?;
            }
        }

        // v6: projects.expanded_in_sidebar + seed app_ui_state singleton
        if current_version < 6 {
            let _ = self.conn.execute_batch(
                "ALTER TABLE projects ADD COLUMN expanded_in_sidebar INTEGER NOT NULL DEFAULT 0",
            );
            let now = now_ms();
            self.conn.execute(
                "INSERT OR IGNORE INTO app_ui_state (id, updated_at) VALUES (1, ?1)",
                [now],
            )?;
            if row.is_some() {
                self.conn.execute("UPDATE schema_version SET version = 6", [])?;
            }
        }

        // v7: window geometry columns on app_ui_state
        if current_version < 7 {
            let _ = self.conn.execute_batch("ALTER TABLE app_ui_state ADD COLUMN window_x INTEGER");
            let _ = self.conn.execute_batch("ALTER TABLE app_ui_state ADD COLUMN window_y INTEGER");
            let _ = self.conn.execute_batch("ALTER TABLE app_ui_state ADD COLUMN window_width INTEGER");
            let _ = self.conn.execute_batch("ALTER TABLE app_ui_state ADD COLUMN window_height INTEGER");
            let _ = self.conn.execute_batch(
                "ALTER TABLE app_ui_state ADD COLUMN window_fullscreen INTEGER NOT NULL DEFAULT 0",
            );
            if row.is_some() {
                self.conn.execute("UPDATE schema_version SET version = 7", [])?;
            }
        }

        // v8: display section on claude_global_settings
        if current_version < 8 {
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN output_style TEXT NOT NULL DEFAULT 'default' CHECK (output_style IN ('default', 'explanatory', 'proactive', 'learning'))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN tui_mode TEXT NOT NULL DEFAULT 'default' CHECK (tui_mode IN ('default', 'fullscreen'))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN editor_mode TEXT NOT NULL DEFAULT 'normal' CHECK (editor_mode IN ('normal', 'vim'))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN reduce_motion INTEGER NOT NULL DEFAULT 0 CHECK (reduce_motion IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN native_cursor INTEGER NOT NULL DEFAULT 0 CHECK (native_cursor IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN hide_cwd INTEGER NOT NULL DEFAULT 0 CHECK (hide_cwd IN (0, 1))");
            if row.is_some() {
                self.conn.execute("UPDATE schema_version SET version = 8", [])?;
            }
        }

        // v9: Memory, Developer, Permissions sections on claude_global_settings
        if current_version < 9 {
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN disable_git_instructions INTEGER NOT NULL DEFAULT 0");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN max_output_tokens INTEGER");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN max_context_tokens INTEGER");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN compaction_threshold INTEGER");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN debug_logging INTEGER NOT NULL DEFAULT 0");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN log_level TEXT NOT NULL DEFAULT 'info'");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN disable_telemetry INTEGER NOT NULL DEFAULT 0");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN disable_error_reporting INTEGER NOT NULL DEFAULT 0");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN disable_autoupdater INTEGER NOT NULL DEFAULT 0");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN experimental_agent_teams INTEGER NOT NULL DEFAULT 0");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN experimental_forked_subagents INTEGER NOT NULL DEFAULT 0");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN simple_system_prompt INTEGER NOT NULL DEFAULT 0");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN auto_approve_edits INTEGER NOT NULL DEFAULT 0");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN ask_destructive_bash INTEGER NOT NULL DEFAULT 0");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN plan_mode_default INTEGER NOT NULL DEFAULT 0");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN permission_allow_rules TEXT NOT NULL DEFAULT '[]'");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN permission_ask_rules TEXT NOT NULL DEFAULT '[]'");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN permission_deny_rules TEXT NOT NULL DEFAULT '[]'");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN permission_additional_dirs TEXT NOT NULL DEFAULT '[]'");
            // v9 always updates version (note: TS code does this unconditionally)
            self.conn.execute("UPDATE schema_version SET version = 9", [])?;
        }

        // v10: claude_project_settings table (already created above)
        if current_version < 10 {
            if row.is_some() {
                self.conn.execute("UPDATE schema_version SET version = 10", [])?;
            }
        }

        // v11: window behavior on app_ui_state + fallback_model
        if current_version < 11 {
            let _ = self.conn.execute_batch("ALTER TABLE app_ui_state ADD COLUMN restore_geometry INTEGER NOT NULL DEFAULT 1 CHECK (restore_geometry IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE app_ui_state ADD COLUMN close_hides INTEGER NOT NULL DEFAULT 1 CHECK (close_hides IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE app_ui_state ADD COLUMN open_at_last_view INTEGER NOT NULL DEFAULT 1 CHECK (open_at_last_view IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN fallback_model TEXT NOT NULL DEFAULT ''");
            self.conn.execute("UPDATE schema_version SET version = 11", [])?;
        }

        // v12: sidebar behavior on app_ui_state
        if current_version < 12 {
            let _ = self.conn.execute_batch("ALTER TABLE app_ui_state ADD COLUMN pinned_section_visible INTEGER NOT NULL DEFAULT 1 CHECK (pinned_section_visible IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE app_ui_state ADD COLUMN workspace_count_inline INTEGER NOT NULL DEFAULT 1 CHECK (workspace_count_inline IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE app_ui_state ADD COLUMN sidebar_width INTEGER NOT NULL DEFAULT 256 CHECK (sidebar_width BETWEEN 200 AND 480)");
            let _ = self.conn.execute_batch("ALTER TABLE app_ui_state ADD COLUMN default_project_expanded INTEGER NOT NULL DEFAULT 0 CHECK (default_project_expanded IN (0, 1))");
            self.conn.execute("UPDATE schema_version SET version = 12", [])?;
        }

        // v13: auth columns on claude_global_settings
        if current_version < 13 {
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN cloud_provider TEXT NOT NULL DEFAULT 'anthropic' CHECK (cloud_provider IN ('anthropic', 'bedrock', 'vertex', 'foundry'))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN auth_encrypted_blob BLOB");
            self.conn.execute("UPDATE schema_version SET version = 13", [])?;
        }

        // v14: Tools section on claude_global_settings
        if current_version < 14 {
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN bash_default_timeout_ms INTEGER");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN bash_max_timeout_ms INTEGER");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN bash_max_output_length INTEGER");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN tool_concurrency INTEGER");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN browser_integration INTEGER NOT NULL DEFAULT 1 CHECK (browser_integration IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN disabled_mcp_servers TEXT NOT NULL DEFAULT '[]'");
            self.conn.execute("UPDATE schema_version SET version = 14", [])?;
        }

        // v15: claude_workspace_settings table (already created above)
        if current_version < 15 {
            if row.is_some() {
                self.conn.execute("UPDATE schema_version SET version = 15", [])?;
            }
        }

        // v16: plaintext auth columns; clear old encrypted blob
        if current_version < 16 {
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN auth_api_key TEXT NOT NULL DEFAULT ''");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN auth_token TEXT NOT NULL DEFAULT ''");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN auth_base_url TEXT NOT NULL DEFAULT ''");
            self.conn.execute(
                "UPDATE claude_global_settings SET auth_encrypted_blob = NULL WHERE id = 1",
                [],
            )?;
            self.conn.execute("UPDATE schema_version SET version = 16", [])?;
        }

        // v17: Bedrock + Vertex config columns
        if current_version < 17 {
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN auth_aws_region TEXT NOT NULL DEFAULT ''");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN auth_vertex_project_id TEXT NOT NULL DEFAULT ''");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN auth_vertex_region TEXT NOT NULL DEFAULT ''");
            self.conn.execute("UPDATE schema_version SET version = 17", [])?;
        }

        // v18: launch_at_login + global_hotkey on app_ui_state
        if current_version < 18 {
            let _ = self.conn.execute_batch("ALTER TABLE app_ui_state ADD COLUMN launch_at_login INTEGER NOT NULL DEFAULT 0 CHECK (launch_at_login IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE app_ui_state ADD COLUMN global_hotkey TEXT NOT NULL DEFAULT ''");
            self.conn.execute("UPDATE schema_version SET version = 18", [])?;
        }

        // v19: projects.sort_order
        if current_version < 19 {
            let _ = self.conn.execute_batch("ALTER TABLE projects ADD COLUMN sort_order INTEGER");
            self.conn.execute("UPDATE schema_version SET version = 19", [])?;
        }

        // v20: workspaces.sort_order
        if current_version < 20 {
            let _ = self.conn.execute_batch("ALTER TABLE workspaces ADD COLUMN sort_order INTEGER");
            self.conn.execute("UPDATE schema_version SET version = 20", [])?;
        }

        // v21: workspaces.status + backfill archived rows
        if current_version < 21 {
            let _ = self.conn.execute_batch("ALTER TABLE workspaces ADD COLUMN status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'in_review', 'completed', 'archived'))");
            self.conn.execute(
                "UPDATE workspaces SET status = 'archived' WHERE archived_at IS NOT NULL AND status != 'archived'",
                [],
            )?;
            self.conn.execute("UPDATE schema_version SET version = 21", [])?;
        }

        // v22: Foundry auth fields, Bedrock bearer token, custom env vars
        if current_version < 22 {
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN auth_foundry_api_key TEXT NOT NULL DEFAULT ''");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN auth_foundry_resource TEXT NOT NULL DEFAULT ''");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN auth_foundry_base_url TEXT NOT NULL DEFAULT ''");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN auth_bedrock_bearer_token TEXT NOT NULL DEFAULT ''");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN custom_env_vars TEXT NOT NULL DEFAULT '{}'");
            self.conn.execute("UPDATE schema_version SET version = 22", [])?;
        }

        // v23: Typed env-var controls (General, Memory, Tools, Developer, Network, Privacy)
        if current_version < 23 {
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN disable_thinking INTEGER NOT NULL DEFAULT 0 CHECK (disable_thinking IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN disable_fast_mode INTEGER NOT NULL DEFAULT 0 CHECK (disable_fast_mode IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN max_turns INTEGER");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN max_thinking_tokens INTEGER");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN file_read_max_output_tokens INTEGER");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN disable_claude_mds INTEGER NOT NULL DEFAULT 0 CHECK (disable_claude_mds IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN bash_maintain_cwd INTEGER NOT NULL DEFAULT 0 CHECK (bash_maintain_cwd IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN perforce_mode INTEGER NOT NULL DEFAULT 0 CHECK (perforce_mode IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN glob_hidden INTEGER NOT NULL DEFAULT 0 CHECK (glob_hidden IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN glob_no_ignore INTEGER NOT NULL DEFAULT 0 CHECK (glob_no_ignore IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN glob_timeout_seconds INTEGER");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN api_timeout_ms INTEGER");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN max_retries INTEGER");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN http_proxy TEXT NOT NULL DEFAULT ''");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN https_proxy TEXT NOT NULL DEFAULT ''");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN disable_nonessential_traffic INTEGER NOT NULL DEFAULT 0 CHECK (disable_nonessential_traffic IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN do_not_track INTEGER NOT NULL DEFAULT 0 CHECK (do_not_track IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN disable_background_tasks INTEGER NOT NULL DEFAULT 0 CHECK (disable_background_tasks IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN disable_agent_view INTEGER NOT NULL DEFAULT 0 CHECK (disable_agent_view IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN anthropic_betas TEXT NOT NULL DEFAULT ''");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN extra_body_json TEXT NOT NULL DEFAULT ''");
            self.conn.execute("UPDATE schema_version SET version = 23", [])?;
        }

        // v24: More env-var controls (Display, Model capabilities, Memory, Tools, Developer)
        if current_version < 24 {
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN no_flicker INTEGER NOT NULL DEFAULT 0 CHECK (no_flicker IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN disable_alternate_screen INTEGER NOT NULL DEFAULT 0 CHECK (disable_alternate_screen IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN disable_virtual_scroll INTEGER NOT NULL DEFAULT 0 CHECK (disable_virtual_scroll IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN disable_mouse INTEGER NOT NULL DEFAULT 0 CHECK (disable_mouse IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN disable_terminal_title INTEGER NOT NULL DEFAULT 0 CHECK (disable_terminal_title IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN scroll_speed INTEGER");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN code_accessibility INTEGER NOT NULL DEFAULT 0 CHECK (code_accessibility IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN omit_attribution_header INTEGER NOT NULL DEFAULT 0 CHECK (omit_attribution_header IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN force_sync_output INTEGER NOT NULL DEFAULT 0 CHECK (force_sync_output IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN enable_prompt_suggestion INTEGER NOT NULL DEFAULT 0 CHECK (enable_prompt_suggestion IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN disable_1m_context INTEGER NOT NULL DEFAULT 0 CHECK (disable_1m_context IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN disable_adaptive_thinking INTEGER NOT NULL DEFAULT 0 CHECK (disable_adaptive_thinking IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN disable_legacy_model_remap INTEGER NOT NULL DEFAULT 0 CHECK (disable_legacy_model_remap IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN auto_compact_window INTEGER");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN autocompact_pct_override INTEGER");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN disable_file_checkpointing INTEGER NOT NULL DEFAULT 0 CHECK (disable_file_checkpointing IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN disable_attachments INTEGER NOT NULL DEFAULT 0 CHECK (disable_attachments IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN shell_override TEXT NOT NULL DEFAULT ''");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN shell_prefix TEXT NOT NULL DEFAULT ''");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN enable_fine_grained_tool_streaming INTEGER NOT NULL DEFAULT 0 CHECK (enable_fine_grained_tool_streaming IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN disable_nonstreaming_fallback INTEGER NOT NULL DEFAULT 0 CHECK (disable_nonstreaming_fallback IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN proxy_resolves_hosts INTEGER NOT NULL DEFAULT 0 CHECK (proxy_resolves_hosts IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN enable_gateway_model_discovery INTEGER NOT NULL DEFAULT 0 CHECK (enable_gateway_model_discovery IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN auto_background_tasks INTEGER NOT NULL DEFAULT 0 CHECK (auto_background_tasks IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN async_agent_stall_timeout_ms INTEGER");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN enable_tasks INTEGER NOT NULL DEFAULT 0 CHECK (enable_tasks IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN disable_cron INTEGER NOT NULL DEFAULT 0 CHECK (disable_cron IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN exit_after_stop_delay INTEGER");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN disable_feedback_command INTEGER NOT NULL DEFAULT 0 CHECK (disable_feedback_command IN (0, 1))");
            let _ = self.conn.execute_batch("ALTER TABLE claude_global_settings ADD COLUMN disable_feedback_survey INTEGER NOT NULL DEFAULT 0 CHECK (disable_feedback_survey IN (0, 1))");
            self.conn.execute("UPDATE schema_version SET version = 24", [])?;
        }

        // v25: archived_workspace_limit on app_ui_state
        if current_version < 25 {
            let _ = self.conn.execute_batch("ALTER TABLE app_ui_state ADD COLUMN archived_workspace_limit INTEGER NOT NULL DEFAULT 20");
            self.conn.execute("UPDATE schema_version SET version = 25", [])?;
        }

        // v26: workspaces.claude_session_id
        if current_version < 26 {
            let _ = self.conn.execute_batch("ALTER TABLE workspaces ADD COLUMN claude_session_id TEXT");
            self.conn.execute("UPDATE schema_version SET version = 26", [])?;
        }

        // v27: workspaces.last_title
        if current_version < 27 {
            let _ = self.conn.execute_batch("ALTER TABLE workspaces ADD COLUMN last_title TEXT");
            self.conn.execute("UPDATE schema_version SET version = 27", [])?;
        }

        // v28: rename in_review/completed → awaiting_input (data migration only)
        if current_version < 28 {
            self.conn.execute(
                "UPDATE workspaces SET status = 'awaiting_input' WHERE status IN ('in_review', 'completed')",
                [],
            )?;
            self.conn.execute("UPDATE schema_version SET version = 28", [])?;
        }

        // v29: notification prefs on app_ui_state
        if current_version < 29 {
            let _ = self.conn.execute_batch("ALTER TABLE app_ui_state ADD COLUMN notify_attention BOOLEAN NOT NULL DEFAULT 1");
            let _ = self.conn.execute_batch("ALTER TABLE app_ui_state ADD COLUMN notify_stop      BOOLEAN NOT NULL DEFAULT 1");
            let _ = self.conn.execute_batch("ALTER TABLE app_ui_state ADD COLUMN notify_always    BOOLEAN NOT NULL DEFAULT 0");
            self.conn.execute("UPDATE schema_version SET version = 29", [])?;
        }

        // v30: notify_max_attention_repeats
        if current_version < 30 {
            let _ = self.conn.execute_batch("ALTER TABLE app_ui_state ADD COLUMN notify_max_attention_repeats INTEGER NOT NULL DEFAULT 5");
            self.conn.execute("UPDATE schema_version SET version = 30", [])?;
        }

        // v31: in_progress_watchdog_sec
        if current_version < 31 {
            let _ = self.conn.execute_batch("ALTER TABLE app_ui_state ADD COLUMN in_progress_watchdog_sec INTEGER NOT NULL DEFAULT 120");
            self.conn.execute("UPDATE schema_version SET version = 31", [])?;
        }

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Returns the on-disk path for the Orpheus SQLite database, honoring platform
/// conventions via the `directories` crate. Returns None only if the OS cannot
/// provide an app data directory.
pub fn db_path() -> Option<PathBuf> {
    let dirs = ProjectDirs::from("com", "Orpheus", "Orpheus")?;
    Some(dirs.data_dir().join("orpheus.sqlite"))
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Base schema SQL constants — mirror db.ts exactly
// ---------------------------------------------------------------------------

const CURRENT_VERSION: i64 = 31;

const SCHEMA_SQL: &str = "
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
";

const WORKSPACES_SCHEMA_SQL: &str = "
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    cwd TEXT NOT NULL,
    pinned_at INTEGER,
    created_at INTEGER NOT NULL,
    last_opened_at INTEGER,
    archived_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS workspaces_project_id_idx ON workspaces(project_id);
  CREATE INDEX IF NOT EXISTS workspaces_pinned_idx ON workspaces(pinned_at);
";

const CLAUDE_SETTINGS_SCHEMA_SQL: &str = "
  CREATE TABLE IF NOT EXISTS claude_global_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    model TEXT NOT NULL DEFAULT 'sonnet',
    permission_mode TEXT NOT NULL DEFAULT 'default'
      CHECK (permission_mode IN ('default', 'acceptEdits', 'plan', 'bypassPermissions')),
    effort TEXT NOT NULL DEFAULT 'auto'
      CHECK (effort IN ('auto', 'low', 'medium', 'high', 'xhigh', 'max')),
    auto_memory INTEGER NOT NULL DEFAULT 1 CHECK (auto_memory IN (0, 1)),
    always_thinking INTEGER NOT NULL DEFAULT 0 CHECK (always_thinking IN (0, 1)),
    updated_at INTEGER NOT NULL
  );
";

const CLAUDE_PROJECT_SETTINGS_SCHEMA_SQL: &str = "
  CREATE TABLE IF NOT EXISTS claude_project_settings (
    project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    overrides_json TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  );
";

const CLAUDE_WORKSPACE_SETTINGS_SCHEMA_SQL: &str = "
  CREATE TABLE IF NOT EXISTS claude_workspace_settings (
    workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    overrides_json TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  );
";

const UI_STATE_SCHEMA_SQL: &str = "
  CREATE TABLE IF NOT EXISTS app_ui_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    sidebar_collapsed INTEGER NOT NULL DEFAULT 0 CHECK (sidebar_collapsed IN (0, 1)),
    last_view_kind TEXT NOT NULL DEFAULT 'dashboard'
      CHECK (last_view_kind IN ('dashboard', 'sessions', 'project', 'workspace')),
    last_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    last_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
    updated_at INTEGER NOT NULL
  );
";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_db() -> (Db, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("test.sqlite");
        let db = Db::open_at(&path).expect("open_at");
        (db, dir)
    }

    #[test]
    fn fresh_db_reaches_version_31() {
        let (db, _dir) = temp_db();
        assert_eq!(db.current_version(), 31);
    }

    #[test]
    fn init_twice_is_idempotent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("test.sqlite");
        {
            Db::open_at(&path).expect("first open");
        }
        let db = Db::open_at(&path).expect("second open");
        assert_eq!(db.current_version(), 31);
    }

    #[test]
    fn all_tables_are_selectable() {
        let (db, _dir) = temp_db();
        let tables = [
            "schema_version",
            "projects",
            "sessions",
            "workspaces",
            "claude_global_settings",
            "claude_project_settings",
            "claude_workspace_settings",
            "app_ui_state",
        ];
        for table in &tables {
            let sql = format!("SELECT 1 FROM {} LIMIT 0", table);
            db.conn()
                .execute_batch(&sql)
                .unwrap_or_else(|e| panic!("SELECT from {} failed: {}", table, e));
        }
    }

    #[test]
    fn projects_columns_match() {
        let (db, _dir) = temp_db();
        let mut stmt = db
            .conn()
            .prepare("PRAGMA table_info(projects)")
            .expect("prepare");
        let cols: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .expect("query")
            .map(|r| r.expect("row"))
            .collect();
        let expected = [
            "id", "path", "name", "claude_encoded_name", "added_at",
            "last_opened_at", "expanded_in_sidebar", "sort_order",
        ];
        assert_eq!(cols, expected, "projects columns mismatch");
    }

    #[test]
    fn workspaces_columns_match() {
        let (db, _dir) = temp_db();
        let mut stmt = db
            .conn()
            .prepare("PRAGMA table_info(workspaces)")
            .expect("prepare");
        let cols: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .expect("query")
            .map(|r| r.expect("row"))
            .collect();
        let expected = [
            "id", "project_id", "name", "cwd", "pinned_at", "created_at",
            "last_opened_at", "archived_at", "name_is_auto", "sort_order",
            "status", "claude_session_id", "last_title",
        ];
        assert_eq!(cols, expected, "workspaces columns mismatch");
    }

    #[test]
    fn sessions_columns_match() {
        let (db, _dir) = temp_db();
        let mut stmt = db
            .conn()
            .prepare("PRAGMA table_info(sessions)")
            .expect("prepare");
        let cols: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .expect("query")
            .map(|r| r.expect("row"))
            .collect();
        let expected = [
            "id", "project_id", "jsonl_path", "title", "status",
            "created_at", "updated_at", "archived_at", "model", "last_message_role",
        ];
        assert_eq!(cols, expected, "sessions columns mismatch");
    }

    #[test]
    fn claude_global_settings_has_singleton_row() {
        let (db, _dir) = temp_db();
        let count: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM claude_global_settings", [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 1, "claude_global_settings should have exactly 1 row");
    }

    #[test]
    fn app_ui_state_has_singleton_row() {
        let (db, _dir) = temp_db();
        let count: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM app_ui_state", [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 1, "app_ui_state should have exactly 1 row");
    }

    #[test]
    fn app_ui_state_columns_match() {
        let (db, _dir) = temp_db();
        let mut stmt = db
            .conn()
            .prepare("PRAGMA table_info(app_ui_state)")
            .expect("prepare");
        let cols: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .expect("query")
            .map(|r| r.expect("row"))
            .collect();
        let expected = [
            "id", "sidebar_collapsed", "last_view_kind", "last_project_id",
            "last_workspace_id", "updated_at", "window_x", "window_y",
            "window_width", "window_height", "window_fullscreen",
            "restore_geometry", "close_hides", "open_at_last_view",
            "pinned_section_visible", "workspace_count_inline", "sidebar_width",
            "default_project_expanded", "launch_at_login", "global_hotkey",
            "archived_workspace_limit", "notify_attention", "notify_stop",
            "notify_always", "notify_max_attention_repeats", "in_progress_watchdog_sec",
        ];
        assert_eq!(cols, expected, "app_ui_state columns mismatch");
    }

    /// Cross-version test: open the real Electron DB (if it exists), verify it's
    /// already at v31 and that no migrations ran (version should still be 31).
    /// Run with: cargo test -- --include-ignored
    #[test]
    #[ignore]
    fn real_electron_db_already_at_v31() {
        let real_path = dirs_next_path();
        if !real_path.exists() {
            eprintln!("Real DB not found at {:?}, skipping.", real_path);
            return;
        }

        // Copy to a temp file so we don't mutate the real DB.
        let dir = tempfile::tempdir().expect("tempdir");
        let copy_path = dir.path().join("orpheus_copy.sqlite");
        std::fs::copy(&real_path, &copy_path).expect("copy");

        // Also copy WAL/SHM if present.
        let wal = real_path.with_extension("sqlite-wal");
        if wal.exists() {
            std::fs::copy(&wal, copy_path.with_extension("sqlite-wal")).ok();
        }

        let db = Db::open_at(&copy_path).expect("open copy");
        assert_eq!(
            db.current_version(),
            31,
            "expected v31, got v{}",
            db.current_version()
        );
    }

    fn dirs_next_path() -> PathBuf {
        ProjectDirs::from("com", "Orpheus", "Orpheus")
            .map(|d| d.data_dir().join("orpheus.sqlite"))
            .unwrap_or_default()
    }
}
