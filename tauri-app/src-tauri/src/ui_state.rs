// App UI state — mirrors src/main/uiState.ts.
// Manages the app_ui_state singleton row (id = 1) in the SQLite DB.

use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::db::{Db, DbError};

// ---------------------------------------------------------------------------
// AppViewKind
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AppViewKind {
    Dashboard,
    Sessions,
    Project,
    Workspace,
}

impl AppViewKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            AppViewKind::Dashboard => "dashboard",
            AppViewKind::Sessions => "sessions",
            AppViewKind::Project => "project",
            AppViewKind::Workspace => "workspace",
        }
    }
}

impl TryFrom<&str> for AppViewKind {
    type Error = String;
    fn try_from(s: &str) -> Result<Self, Self::Error> {
        match s {
            "dashboard" => Ok(AppViewKind::Dashboard),
            "sessions" => Ok(AppViewKind::Sessions),
            "project" => Ok(AppViewKind::Project),
            "workspace" => Ok(AppViewKind::Workspace),
            other => Err(format!(
                "uiState: lastViewKind must be one of dashboard, sessions, project, workspace; got {other}"
            )),
        }
    }
}

// ---------------------------------------------------------------------------
// Full state struct (mirrors AppUiState in TS)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUiState {
    pub sidebar_collapsed: bool,
    pub last_view_kind: AppViewKind,
    pub last_project_id: Option<String>,
    pub last_workspace_id: Option<String>,
    pub window_x: Option<i64>,
    pub window_y: Option<i64>,
    pub window_width: Option<i64>,
    pub window_height: Option<i64>,
    pub window_fullscreen: bool,
    // v11
    pub restore_geometry: bool,
    pub close_hides: bool,
    pub open_at_last_view: bool,
    // v12
    pub pinned_section_visible: bool,
    pub workspace_count_inline: bool,
    /// Clamped to [200, 480] at read time.
    pub sidebar_width: i64,
    pub default_project_expanded: bool,
    // v18
    pub launch_at_login: bool,
    pub global_hotkey: String,
    // v25
    pub archived_workspace_limit: i64,
    // v29
    pub notify_attention: bool,
    pub notify_stop: bool,
    pub notify_always: bool,
    // v30
    pub notify_max_attention_repeats: i64,
    // v31
    pub in_progress_watchdog_sec: i64,
    pub updated_at: i64,
}

// ---------------------------------------------------------------------------
// Patch struct — every field optional; None means "don't change"
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUiStatePatch {
    pub sidebar_collapsed: Option<bool>,
    pub last_view_kind: Option<String>,
    pub last_project_id: Option<Option<String>>,
    pub last_workspace_id: Option<Option<String>>,
    pub window_x: Option<Option<i64>>,
    pub window_y: Option<Option<i64>>,
    pub window_width: Option<Option<i64>>,
    pub window_height: Option<Option<i64>>,
    pub window_fullscreen: Option<bool>,
    pub restore_geometry: Option<bool>,
    pub close_hides: Option<bool>,
    pub open_at_last_view: Option<bool>,
    pub pinned_section_visible: Option<bool>,
    pub workspace_count_inline: Option<bool>,
    pub sidebar_width: Option<i64>,
    pub default_project_expanded: Option<bool>,
    pub launch_at_login: Option<bool>,
    pub global_hotkey: Option<String>,
    pub archived_workspace_limit: Option<i64>,
    pub notify_attention: Option<bool>,
    pub notify_stop: Option<bool>,
    pub notify_always: Option<bool>,
    pub notify_max_attention_repeats: Option<i64>,
    pub in_progress_watchdog_sec: Option<i64>,
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum UiStateError {
    #[error(transparent)]
    Db(#[from] DbError),

    #[error("{0}")]
    Validation(String),
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Read the singleton ui_state row.
pub fn get_ui_state(db: &Db) -> Result<AppUiState, DbError> {
    let row: (
        i64,  // sidebar_collapsed
        String, // last_view_kind
        Option<String>, // last_project_id
        Option<String>, // last_workspace_id
        Option<i64>, // window_x
        Option<i64>, // window_y
        Option<i64>, // window_width
        Option<i64>, // window_height
        i64,  // window_fullscreen
        i64,  // restore_geometry
        i64,  // close_hides
        i64,  // open_at_last_view
        i64,  // pinned_section_visible
        i64,  // workspace_count_inline
        i64,  // sidebar_width
        i64,  // default_project_expanded
        i64,  // launch_at_login
        String, // global_hotkey
        i64,  // archived_workspace_limit
        i64,  // notify_attention
        i64,  // notify_stop
        i64,  // notify_always
        i64,  // notify_max_attention_repeats
        i64,  // in_progress_watchdog_sec
        i64,  // updated_at
    ) = db.conn().query_row(
        "SELECT sidebar_collapsed, last_view_kind, last_project_id, last_workspace_id,
                window_x, window_y, window_width, window_height, window_fullscreen,
                restore_geometry, close_hides, open_at_last_view,
                pinned_section_visible, workspace_count_inline, sidebar_width,
                default_project_expanded, launch_at_login, global_hotkey,
                archived_workspace_limit, notify_attention, notify_stop, notify_always,
                notify_max_attention_repeats, in_progress_watchdog_sec, updated_at
         FROM app_ui_state WHERE id = 1",
        [],
        |r| {
            Ok((
                r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?,
                r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?,
                r.get(9)?, r.get(10)?, r.get(11)?,
                r.get(12)?, r.get(13)?, r.get(14)?,
                r.get(15)?, r.get(16)?, r.get(17)?,
                r.get(18)?, r.get(19)?, r.get(20)?, r.get(21)?,
                r.get(22)?, r.get(23)?, r.get(24)?,
            ))
        },
    )?;

    let (
        sidebar_collapsed, last_view_kind_str, last_project_id, last_workspace_id,
        window_x, window_y, window_width, window_height, window_fullscreen,
        restore_geometry, close_hides, open_at_last_view,
        pinned_section_visible, workspace_count_inline, raw_sidebar_width,
        default_project_expanded, launch_at_login, global_hotkey,
        archived_workspace_limit, notify_attention, notify_stop, notify_always,
        notify_max_attention_repeats, in_progress_watchdog_sec, updated_at,
    ) = row;

    let last_view_kind = AppViewKind::try_from(last_view_kind_str.as_str())
        .unwrap_or(AppViewKind::Dashboard);

    // Clamp sidebar_width to [200, 480] at read time (mirrors TS)
    let sidebar_width = raw_sidebar_width.clamp(200, 480);

    Ok(AppUiState {
        sidebar_collapsed: sidebar_collapsed != 0,
        last_view_kind,
        last_project_id,
        last_workspace_id,
        window_x,
        window_y,
        window_width,
        window_height,
        window_fullscreen: window_fullscreen != 0,
        restore_geometry: restore_geometry != 0,
        close_hides: close_hides != 0,
        open_at_last_view: open_at_last_view != 0,
        pinned_section_visible: pinned_section_visible != 0,
        workspace_count_inline: workspace_count_inline != 0,
        sidebar_width,
        default_project_expanded: default_project_expanded != 0,
        launch_at_login: launch_at_login != 0,
        global_hotkey,
        archived_workspace_limit,
        notify_attention: notify_attention != 0,
        notify_stop: notify_stop != 0,
        notify_always: notify_always != 0,
        notify_max_attention_repeats,
        in_progress_watchdog_sec,
        updated_at,
    })
}

/// Apply a partial patch to the singleton row and return the updated state.
pub fn update_ui_state(db: &Db, patch: AppUiStatePatch) -> Result<AppUiState, UiStateError> {
    // Validate last_view_kind if provided
    if let Some(ref kind_str) = patch.last_view_kind {
        AppViewKind::try_from(kind_str.as_str()).map_err(UiStateError::Validation)?;
    }

    let now = now_ms();
    let mut set_clauses: Vec<String> = Vec::new();
    // We build the SQL dynamically and bind with rusqlite params_from_iter.
    // rusqlite doesn't have a clean variadic bind API, so we collect boxed values.

    // Helper: push a boolean column
    macro_rules! push_bool {
        ($field:expr, $col:literal) => {
            if let Some(v) = $field {
                set_clauses.push(format!("{} = {}", $col, if v { 1 } else { 0 }));
            }
        };
    }
    macro_rules! push_int {
        ($field:expr, $col:literal) => {
            if let Some(v) = $field {
                set_clauses.push(format!("{} = {}", $col, v));
            }
        };
    }
    macro_rules! push_opt_int {
        ($field:expr, $col:literal) => {
            if let Some(v) = $field {
                match v {
                    Some(n) => set_clauses.push(format!("{} = {}", $col, n)),
                    None => set_clauses.push(format!("{} = NULL", $col)),
                }
            }
        };
    }
    macro_rules! push_str {
        ($field:expr, $col:literal) => {
            if let Some(ref v) = $field {
                set_clauses.push(format!("{} = '{}'", $col, v.replace('\'', "''")));
            }
        };
    }
    macro_rules! push_opt_str {
        ($field:expr, $col:literal) => {
            if let Some(ref v) = $field {
                match v {
                    Some(s) => set_clauses.push(format!("{} = '{}'", $col, s.replace('\'', "''"))),
                    None => set_clauses.push(format!("{} = NULL", $col)),
                }
            }
        };
    }

    push_bool!(patch.sidebar_collapsed, "sidebar_collapsed");
    if let Some(ref kind_str) = patch.last_view_kind {
        push_str!(Some(kind_str.clone()), "last_view_kind");
    }
    push_opt_str!(patch.last_project_id, "last_project_id");
    push_opt_str!(patch.last_workspace_id, "last_workspace_id");
    push_opt_int!(patch.window_x, "window_x");
    push_opt_int!(patch.window_y, "window_y");
    push_opt_int!(patch.window_width, "window_width");
    push_opt_int!(patch.window_height, "window_height");
    push_bool!(patch.window_fullscreen, "window_fullscreen");
    push_bool!(patch.restore_geometry, "restore_geometry");
    push_bool!(patch.close_hides, "close_hides");
    push_bool!(patch.open_at_last_view, "open_at_last_view");
    push_bool!(patch.pinned_section_visible, "pinned_section_visible");
    push_bool!(patch.workspace_count_inline, "workspace_count_inline");
    push_int!(patch.sidebar_width, "sidebar_width");
    push_bool!(patch.default_project_expanded, "default_project_expanded");
    push_bool!(patch.launch_at_login, "launch_at_login");
    push_str!(patch.global_hotkey, "global_hotkey");
    push_int!(patch.archived_workspace_limit, "archived_workspace_limit");
    push_bool!(patch.notify_attention, "notify_attention");
    push_bool!(patch.notify_stop, "notify_stop");
    push_bool!(patch.notify_always, "notify_always");
    push_int!(patch.notify_max_attention_repeats, "notify_max_attention_repeats");
    push_int!(patch.in_progress_watchdog_sec, "in_progress_watchdog_sec");

    if set_clauses.is_empty() {
        return Ok(get_ui_state(db)?);
    }

    set_clauses.push(format!("updated_at = {}", now));
    let sql = format!(
        "UPDATE app_ui_state SET {} WHERE id = 1",
        set_clauses.join(", ")
    );
    db.conn().execute(&sql, params![]).map_err(DbError::from).map_err(UiStateError::from)?;

    Ok(get_ui_state(db)?)
}

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
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.sqlite");
        let db = Db::open_at(&path).unwrap();
        (db, dir)
    }

    #[test]
    fn get_returns_defaults() {
        let (db, _dir) = temp_db();
        let state = get_ui_state(&db).unwrap();
        assert!(!state.sidebar_collapsed);
        assert_eq!(state.last_view_kind, AppViewKind::Dashboard);
        assert!(state.notify_attention);
        assert!(state.notify_stop);
        assert!(!state.notify_always);
        assert_eq!(state.notify_max_attention_repeats, 5);
        assert_eq!(state.in_progress_watchdog_sec, 120);
        assert!(state.close_hides);
        assert!(state.restore_geometry);
        assert_eq!(state.archived_workspace_limit, 20);
    }

    #[test]
    fn update_sidebar_collapsed() {
        let (db, _dir) = temp_db();
        let updated = update_ui_state(&db, AppUiStatePatch {
            sidebar_collapsed: Some(true),
            ..Default::default()
        }).unwrap();
        assert!(updated.sidebar_collapsed);
    }

    #[test]
    fn update_last_view_kind() {
        let (db, _dir) = temp_db();
        let updated = update_ui_state(&db, AppUiStatePatch {
            last_view_kind: Some("workspace".into()),
            ..Default::default()
        }).unwrap();
        assert_eq!(updated.last_view_kind, AppViewKind::Workspace);
    }

    #[test]
    fn update_invalid_view_kind_errors() {
        let (db, _dir) = temp_db();
        let result = update_ui_state(&db, AppUiStatePatch {
            last_view_kind: Some("bogus".into()),
            ..Default::default()
        });
        assert!(matches!(result, Err(UiStateError::Validation(_))));
    }

    #[test]
    fn update_null_project_id() {
        let (db, _dir) = temp_db();
        let updated = update_ui_state(&db, AppUiStatePatch {
            last_project_id: Some(None),
            ..Default::default()
        }).unwrap();
        assert!(updated.last_project_id.is_none());
    }

    #[test]
    fn update_notify_preferences() {
        let (db, _dir) = temp_db();
        let updated = update_ui_state(&db, AppUiStatePatch {
            notify_attention: Some(false),
            notify_stop: Some(false),
            notify_always: Some(true),
            notify_max_attention_repeats: Some(3),
            ..Default::default()
        }).unwrap();
        assert!(!updated.notify_attention);
        assert!(!updated.notify_stop);
        assert!(updated.notify_always);
        assert_eq!(updated.notify_max_attention_repeats, 3);
    }

    #[test]
    fn update_window_geometry() {
        let (db, _dir) = temp_db();
        let updated = update_ui_state(&db, AppUiStatePatch {
            window_x: Some(Some(100)),
            window_y: Some(Some(200)),
            window_width: Some(Some(1280)),
            window_height: Some(Some(800)),
            window_fullscreen: Some(true),
            ..Default::default()
        }).unwrap();
        assert_eq!(updated.window_x, Some(100));
        assert_eq!(updated.window_y, Some(200));
        assert_eq!(updated.window_width, Some(1280));
        assert_eq!(updated.window_height, Some(800));
        assert!(updated.window_fullscreen);
    }

    #[test]
    fn sidebar_width_default_is_256() {
        let (db, _dir) = temp_db();
        let state = get_ui_state(&db).unwrap();
        assert_eq!(state.sidebar_width, 256);
    }

    #[test]
    fn sidebar_width_update_boundary_values() {
        let (db, _dir) = temp_db();
        let updated = update_ui_state(&db, AppUiStatePatch {
            sidebar_width: Some(480),
            ..Default::default()
        }).unwrap();
        assert_eq!(updated.sidebar_width, 480);

        let updated = update_ui_state(&db, AppUiStatePatch {
            sidebar_width: Some(200),
            ..Default::default()
        }).unwrap();
        assert_eq!(updated.sidebar_width, 200);
    }

    #[test]
    fn empty_patch_returns_current_state() {
        let (db, _dir) = temp_db();
        let before = get_ui_state(&db).unwrap();
        let after = update_ui_state(&db, AppUiStatePatch::default()).unwrap();
        assert_eq!(before.sidebar_collapsed, after.sidebar_collapsed);
        assert_eq!(before.last_view_kind, after.last_view_kind);
    }
}
