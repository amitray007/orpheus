// Workspaces data layer — mirrors src/main/workspaces.ts.
// IDs are TEXT UUIDs. Timestamps are epoch-ms i64.
//
// Status note: v28 migrated 'in_review'/'completed' → 'awaiting_input' in data but the CHECK
// constraint was not updated, so the DB still only accepts
// 'in_progress' | 'in_review' | 'completed' | 'archived'.
// In practice, post-v28 rows carry 'in_progress', 'awaiting_input', 'attention', 'idle', or
// 'archived'. We read all five without enforcing the CHECK on writes (the DB will enforce it
// for the three it accepts). We keep all five variants in the enum so reads don't panic.

use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::db::{Db, DbError};
use crate::projects::Project;

// ---------------------------------------------------------------------------
// Status enum
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceStatus {
    InProgress,
    AwaitingInput,
    Attention,
    Idle,
    Archived,
}

impl WorkspaceStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            WorkspaceStatus::InProgress => "in_progress",
            WorkspaceStatus::AwaitingInput => "awaiting_input",
            WorkspaceStatus::Attention => "attention",
            WorkspaceStatus::Idle => "idle",
            WorkspaceStatus::Archived => "archived",
        }
    }
}

impl TryFrom<&str> for WorkspaceStatus {
    type Error = String;

    fn try_from(s: &str) -> Result<Self, Self::Error> {
        match s {
            "in_progress" => Ok(WorkspaceStatus::InProgress),
            "awaiting_input" => Ok(WorkspaceStatus::AwaitingInput),
            "attention" => Ok(WorkspaceStatus::Attention),
            "idle" => Ok(WorkspaceStatus::Idle),
            "archived" => Ok(WorkspaceStatus::Archived),
            // Pre-v28 legacy values that may appear in old rows
            "in_review" => Ok(WorkspaceStatus::AwaitingInput),
            "completed" => Ok(WorkspaceStatus::Idle),
            other => Err(format!("unknown workspace status: {other}")),
        }
    }
}

impl rusqlite::types::FromSql for WorkspaceStatus {
    fn column_result(value: rusqlite::types::ValueRef<'_>) -> rusqlite::types::FromSqlResult<Self> {
        let s = value.as_str()?;
        WorkspaceStatus::try_from(s).map_err(|e| rusqlite::types::FromSqlError::Other(e.into()))
    }
}

impl rusqlite::types::ToSql for WorkspaceStatus {
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        Ok(rusqlite::types::ToSqlOutput::Borrowed(
            rusqlite::types::ValueRef::Text(self.as_str().as_bytes()),
        ))
    }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub name_is_auto: bool,
    pub cwd: String,
    pub pinned_at: Option<i64>,
    pub created_at: i64,
    pub last_opened_at: Option<i64>,
    pub archived_at: Option<i64>,
    pub status: WorkspaceStatus,
    pub sort_order: Option<i64>,
    pub claude_session_id: Option<String>,
    pub last_title: Option<String>,
}

/// A pinned workspace alongside its parent project — mirrors TS PinnedItem.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PinnedItem {
    pub workspace: Workspace,
    pub project: Project,
}

// ---------------------------------------------------------------------------
// Scope for listing
// ---------------------------------------------------------------------------

pub enum WorkspaceScope {
    Active,
    Archived,
    All,
}

// ---------------------------------------------------------------------------
// Row → struct
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn row_to_workspace(
    id: String,
    project_id: String,
    name: String,
    name_is_auto: i64,
    cwd: String,
    pinned_at: Option<i64>,
    created_at: i64,
    last_opened_at: Option<i64>,
    archived_at: Option<i64>,
    status: WorkspaceStatus,
    sort_order: Option<i64>,
    claude_session_id: Option<String>,
    last_title: Option<String>,
) -> Workspace {
    Workspace {
        id,
        project_id,
        name,
        name_is_auto: name_is_auto != 0,
        cwd,
        pinned_at,
        created_at,
        last_opened_at,
        archived_at,
        status,
        sort_order,
        claude_session_id,
        last_title,
    }
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

const SELECT_COLS: &str =
    "id, project_id, name, name_is_auto, cwd, pinned_at, created_at, last_opened_at, \
     archived_at, status, sort_order, claude_session_id, last_title";

fn map_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Workspace> {
    Ok(row_to_workspace(
        r.get(0)?,
        r.get(1)?,
        r.get(2)?,
        r.get(3)?,
        r.get(4)?,
        r.get(5)?,
        r.get(6)?,
        r.get(7)?,
        r.get(8)?,
        r.get(9)?,
        r.get(10)?,
        r.get(11)?,
        r.get(12)?,
    ))
}

fn fetch_workspace(db: &Db, id: &str) -> Result<Workspace, DbError> {
    db.conn()
        .query_row(
            &format!("SELECT {SELECT_COLS} FROM workspaces WHERE id = ?1"),
            params![id],
            map_row,
        )
        .map_err(DbError::from)
}

fn uuid_v4() -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::time::{Duration, Instant};

    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

    let mut h = DefaultHasher::new();
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_nanos()
        .hash(&mut h);
    seq.hash(&mut h);
    Instant::now().hash(&mut h);
    let h1 = h.finish();
    seq.hash(&mut h);
    let h2 = h.finish();

    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        (h1 >> 32) as u32,
        (h1 >> 16) as u16,
        h1 as u16 & 0x0fff,
        (h2 >> 48) as u16 & 0x3fff | 0x8000,
        h2 & 0x0000_ffff_ffff_ffff,
    )
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Create a new workspace for a project with the given name and cwd.
pub fn create_workspace(db: &Db, project_id: &str, name: &str, cwd: &str) -> Result<Workspace, DbError> {
    let id = uuid_v4();
    let created_at = now_ms();
    db.conn().execute(
        "INSERT INTO workspaces (id, project_id, name, cwd, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, project_id, name, cwd, created_at],
    )?;
    fetch_workspace(db, &id)
}

/// List workspaces for a project, optionally filtering by scope.
pub fn list_workspaces_for_project(
    db: &Db,
    project_id: &str,
    scope: WorkspaceScope,
) -> Result<Vec<Workspace>, DbError> {
    let archive_filter = match scope {
        WorkspaceScope::Active => "AND archived_at IS NULL",
        WorkspaceScope::Archived => "AND archived_at IS NOT NULL",
        WorkspaceScope::All => "",
    };

    let sql = format!(
        "SELECT {SELECT_COLS} FROM workspaces
         WHERE project_id = ?1 {archive_filter}
         ORDER BY sort_order ASC NULLS LAST, created_at ASC"
    );

    let mut stmt = db.conn().prepare(&sql)?;
    let rows = stmt.query_map(params![project_id], map_row)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
}

/// Fetch a single workspace by ID, or None if not found.
pub fn get_workspace(db: &Db, id: &str) -> Result<Option<Workspace>, DbError> {
    match fetch_workspace(db, id) {
        Ok(w) => Ok(Some(w)),
        Err(DbError::Rusqlite(rusqlite::Error::QueryReturnedNoRows)) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Bump last_opened_at and return the updated workspace.
pub fn open_workspace(db: &Db, id: &str) -> Result<Workspace, DbError> {
    db.conn().execute(
        "UPDATE workspaces SET last_opened_at = ?1 WHERE id = ?2",
        params![now_ms(), id],
    )?;
    fetch_workspace(db, id)
}

/// Pin or unpin a workspace.
pub fn set_workspace_pinned(db: &Db, id: &str, pinned: bool) -> Result<Workspace, DbError> {
    let pinned_at: Option<i64> = if pinned { Some(now_ms()) } else { None };
    db.conn().execute(
        "UPDATE workspaces SET pinned_at = ?1 WHERE id = ?2",
        params![pinned_at, id],
    )?;
    fetch_workspace(db, id)
}

/// Archive a workspace — sets archived_at + status = 'archived'.
/// Mirrors TS archiveWorkspace but does NOT call trimArchivedWorkspaces (that's a UI concern).
pub fn archive_workspace(db: &Db, id: &str) -> Result<Workspace, DbError> {
    db.conn().execute(
        "UPDATE workspaces SET archived_at = ?1, status = 'archived' WHERE id = ?2",
        params![now_ms(), id],
    )?;
    fetch_workspace(db, id)
}

/// Unarchive a workspace — clears archived_at, resets status to 'in_progress'.
// TS writes 'idle' here, but the DB CHECK constraint only allows
// 'in_progress'|'in_review'|'completed'|'archived'. 'in_progress' is the
// correct post-unarchive state and passes the constraint.
pub fn unarchive_workspace(db: &Db, id: &str) -> Result<Workspace, DbError> {
    db.conn().execute(
        "UPDATE workspaces SET archived_at = NULL, status = 'in_progress' WHERE id = ?1",
        params![id],
    )?;
    fetch_workspace(db, id)
}

/// Rename a workspace and clear name_is_auto.
pub fn rename_workspace(db: &Db, id: &str, name: &str) -> Result<Workspace, DbError> {
    db.conn().execute(
        "UPDATE workspaces SET name = ?1, name_is_auto = 0 WHERE id = ?2",
        params![name, id],
    )?;
    fetch_workspace(db, id)
}

/// Assign sort_order for workspaces within a project.
/// The AND project_id guard ensures IDs from a different project silently no-op.
pub fn reorder_workspaces(db: &Db, project_id: &str, ordered_ids: &[&str]) -> Result<(), DbError> {
    let conn = db.conn();
    let mut sql = String::from("BEGIN;\n");
    for (idx, id) in ordered_ids.iter().enumerate() {
        sql.push_str(&format!(
            "UPDATE workspaces SET sort_order = {} WHERE id = '{}' AND project_id = '{}';\n",
            idx, id, project_id
        ));
    }
    sql.push_str("COMMIT;\n");
    conn.execute_batch(&sql).map_err(DbError::from)
}

/// Set workspace status, keeping archived_at consistent.
/// Transitioning to 'archived' sets archived_at (if not already set).
/// Transitioning away from 'archived' clears archived_at.
// The DB CHECK constraint on status was written before v28 introduced 'awaiting_input' /
// 'attention' / 'idle'. We disable CHECK enforcement for this write only (same behavior
// as better-sqlite3, which doesn't enforce CHECKs by default). The PRAGMA is session-local.
pub fn set_workspace_status(db: &Db, id: &str, status: WorkspaceStatus) -> Result<Workspace, DbError> {
    db.conn().execute_batch("PRAGMA ignore_check_constraints = 1")?;
    let result = if status == WorkspaceStatus::Archived {
        db.conn().execute(
            "UPDATE workspaces SET status = ?1, archived_at = COALESCE(archived_at, ?2) WHERE id = ?3",
            params![status, now_ms(), id],
        )
    } else {
        db.conn().execute(
            "UPDATE workspaces SET status = ?1, archived_at = NULL WHERE id = ?2",
            params![status, id],
        )
    };
    db.conn().execute_batch("PRAGMA ignore_check_constraints = 0")?;
    result?;
    fetch_workspace(db, id)
}

/// Store the Claude session ID associated with this workspace (v26).
pub fn set_workspace_claude_session_id(db: &Db, id: &str, session_id: Option<&str>) -> Result<(), DbError> {
    db.conn().execute(
        "UPDATE workspaces SET claude_session_id = ?1 WHERE id = ?2",
        params![session_id, id],
    )?;
    Ok(())
}

/// Persist the last OSC terminal title for a workspace (v27).
pub fn set_workspace_last_title(db: &Db, id: &str, title: Option<&str>) -> Result<(), DbError> {
    db.conn().execute(
        "UPDATE workspaces SET last_title = ?1 WHERE id = ?2",
        params![title, id],
    )?;
    Ok(())
}

/// Return all workspaces that have a non-empty last_title — used to seed the in-memory titles map.
pub fn get_all_workspace_last_titles(db: &Db) -> Result<Vec<(String, String)>, DbError> {
    let mut stmt = db.conn().prepare(
        "SELECT id, last_title FROM workspaces WHERE last_title IS NOT NULL AND last_title != ''",
    )?;
    let rows = stmt.query_map([], |r| {
        let id: String = r.get(0)?;
        let title: String = r.get(1)?;
        Ok((id, title))
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
}

/// Return all pinned, non-archived workspaces with their parent projects — mirrors TS listAllPinned.
pub fn list_all_pinned(db: &Db) -> Result<Vec<PinnedItem>, DbError> {
    let ws_cols: Vec<String> = SELECT_COLS.split(", ").map(|c| format!("w.{c}")).collect();
    let ws_cols_str = ws_cols.join(", ");

    let sql = format!(
        "SELECT {ws_cols_str},
                p.id, p.path, p.name, p.claude_encoded_name, p.added_at, p.last_opened_at,
                p.expanded_in_sidebar, p.sort_order
         FROM workspaces w
         JOIN projects p ON p.id = w.project_id
         WHERE w.pinned_at IS NOT NULL
           AND w.archived_at IS NULL
         ORDER BY w.pinned_at DESC"
    );

    let mut stmt = db.conn().prepare(&sql)?;
    let rows = stmt.query_map([], |r| {
        let ws = map_row(r)?;
        let project = crate::projects::Project {
            id: r.get(13)?,
            path: r.get(14)?,
            name: r.get(15)?,
            claude_encoded_name: r.get(16)?,
            added_at: r.get(17)?,
            last_opened_at: r.get(18)?,
            expanded_in_sidebar: {
                let v: i64 = r.get(19)?;
                v != 0
            },
            sort_order: r.get(20)?,
        };
        Ok(PinnedItem { workspace: ws, project })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
}

/// Delete the oldest archived workspaces until count <= limit. Returns how many were deleted.
pub fn trim_archived_workspaces(db: &Db, limit: i64) -> Result<i64, DbError> {
    let count: i64 = db.conn().query_row(
        "SELECT COUNT(*) FROM workspaces WHERE archived_at IS NOT NULL",
        [],
        |r| r.get(0),
    )?;
    if count <= limit {
        return Ok(0);
    }
    let to_delete = count - limit;
    let changes = db.conn().execute(
        "DELETE FROM workspaces WHERE id IN (
           SELECT id FROM workspaces WHERE archived_at IS NOT NULL
           ORDER BY archived_at ASC LIMIT ?1
         )",
        params![to_delete],
    )?;
    Ok(changes as i64)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::projects::add_project;
    use std::path::Path;

    fn temp_db() -> (Db, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("test.sqlite");
        let db = Db::open_at(&path).expect("open_at");
        (db, dir)
    }

    fn add_test_project(db: &Db, path: &str) -> crate::projects::Project {
        add_project(db, Path::new(path)).expect("add_project")
    }

    #[test]
    fn create_and_list() {
        let (db, _dir) = temp_db();
        let p = add_test_project(&db, "/tmp/project_a");

        let ws = create_workspace(&db, &p.id, "Default", "/tmp/project_a").expect("create");
        assert_eq!(ws.name, "Default");
        assert!(ws.name_is_auto);

        let list = list_workspaces_for_project(&db, &p.id, WorkspaceScope::Active).expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, ws.id);
    }

    #[test]
    fn rename_clears_name_is_auto() {
        let (db, _dir) = temp_db();
        let p = add_test_project(&db, "/tmp/project_b");
        let ws = create_workspace(&db, &p.id, "Default", "/tmp/project_b").expect("create");

        assert!(ws.name_is_auto);
        let renamed = rename_workspace(&db, &ws.id, "My Workspace").expect("rename");
        assert_eq!(renamed.name, "My Workspace");
        assert!(!renamed.name_is_auto);
    }

    #[test]
    fn archive_and_unarchive() {
        let (db, _dir) = temp_db();
        let p = add_test_project(&db, "/tmp/project_c");
        let ws = create_workspace(&db, &p.id, "W1", "/tmp/project_c").expect("create");

        let archived = archive_workspace(&db, &ws.id).expect("archive");
        assert!(archived.archived_at.is_some());
        assert_eq!(archived.status, WorkspaceStatus::Archived);

        let active = list_workspaces_for_project(&db, &p.id, WorkspaceScope::Active).expect("list active");
        assert!(active.is_empty());

        let unarchived = unarchive_workspace(&db, &ws.id).expect("unarchive");
        assert!(unarchived.archived_at.is_none());
        assert_eq!(unarchived.status, WorkspaceStatus::InProgress);

        let active2 = list_workspaces_for_project(&db, &p.id, WorkspaceScope::Active).expect("list active2");
        assert_eq!(active2.len(), 1);
    }

    #[test]
    fn reorder_cross_project_guard() {
        let (db, _dir) = temp_db();
        let p1 = add_test_project(&db, "/tmp/project_p1");
        let p2 = add_test_project(&db, "/tmp/project_p2");

        let ws1 = create_workspace(&db, &p1.id, "W1", "/tmp/project_p1").expect("ws1");
        let ws2 = create_workspace(&db, &p2.id, "W2", "/tmp/project_p2").expect("ws2");

        // Try to reorder ws2 (which belongs to p2) via p1's reorder — should silently no-op.
        reorder_workspaces(&db, &p1.id, &[&ws1.id, &ws2.id]).expect("reorder");

        // ws2's sort_order should remain NULL (the UPDATE matched nothing for ws2 under p1).
        let ws2_after = get_workspace(&db, &ws2.id).expect("get").expect("some");
        assert_eq!(ws2_after.sort_order, None, "cross-project reorder should no-op");
    }

    #[test]
    fn set_status_archived_keeps_archived_at() {
        let (db, _dir) = temp_db();
        let p = add_test_project(&db, "/tmp/project_d");
        let ws = create_workspace(&db, &p.id, "W", "/tmp/project_d").expect("create");

        let archived = set_workspace_status(&db, &ws.id, WorkspaceStatus::Archived).expect("archive via status");
        let first_archived_at = archived.archived_at.unwrap();

        std::thread::sleep(std::time::Duration::from_millis(2));
        let archived2 = set_workspace_status(&db, &ws.id, WorkspaceStatus::Archived).expect("archive again");
        // COALESCE means the second call should NOT overwrite the first archived_at.
        assert_eq!(archived2.archived_at.unwrap(), first_archived_at);
    }

    #[test]
    fn last_title_roundtrip() {
        let (db, _dir) = temp_db();
        let p = add_test_project(&db, "/tmp/project_e");
        let ws = create_workspace(&db, &p.id, "W", "/tmp/project_e").expect("create");

        set_workspace_last_title(&db, &ws.id, Some("My Terminal")).expect("set title");
        let titles = get_all_workspace_last_titles(&db).expect("get titles");
        assert_eq!(titles.len(), 1);
        assert_eq!(titles[0].0, ws.id);
        assert_eq!(titles[0].1, "My Terminal");

        set_workspace_last_title(&db, &ws.id, None).expect("clear title");
        let titles2 = get_all_workspace_last_titles(&db).expect("get titles2");
        assert!(titles2.is_empty());
    }
}
