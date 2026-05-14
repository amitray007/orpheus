// Projects data layer — mirrors src/main/projects.ts.
// IDs are TEXT UUIDs (same as TS). All timestamps are epoch-milliseconds i64.

use std::path::Path;

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::db::{Db, DbError};
use crate::util::{now_ms, uuid_v4};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub path: String,
    pub name: String,
    pub claude_encoded_name: Option<String>,
    pub added_at: i64,
    pub last_opened_at: Option<i64>,
    pub expanded_in_sidebar: bool,
    pub sort_order: Option<i64>,
}

// ---------------------------------------------------------------------------
// Row → struct
// ---------------------------------------------------------------------------

fn row_to_project(
    id: String,
    path: String,
    name: String,
    claude_encoded_name: Option<String>,
    added_at: i64,
    last_opened_at: Option<i64>,
    expanded_in_sidebar: i64,
    sort_order: Option<i64>,
) -> Project {
    Project {
        id,
        path,
        name,
        claude_encoded_name,
        added_at,
        last_opened_at,
        expanded_in_sidebar: expanded_in_sidebar != 0,
        sort_order,
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn encode_path(path: &str) -> String {
    // Mirrors TS: path.replace(/\//g, '-')
    path.replace('/', "-")
}

fn fetch_project(db: &Db, id: &str) -> Result<Project, DbError> {
    db.conn().query_row(
        "SELECT id, path, name, claude_encoded_name, added_at, last_opened_at,
                expanded_in_sidebar, sort_order
         FROM projects WHERE id = ?1",
        params![id],
        |r| {
            Ok(row_to_project(
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
            ))
        },
    )
    .map_err(DbError::from)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Return all projects ordered by sort_order ASC NULLS LAST, then last_opened_at DESC NULLS LAST,
/// then added_at DESC — mirrors TS listProjects ordering exactly.
pub fn list_projects(db: &Db) -> Result<Vec<Project>, DbError> {
    let mut stmt = db.conn().prepare(
        "SELECT id, path, name, claude_encoded_name, added_at, last_opened_at,
                expanded_in_sidebar, sort_order
         FROM projects
         ORDER BY sort_order ASC NULLS LAST, last_opened_at DESC NULLS LAST, added_at DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(row_to_project(
            r.get(0)?,
            r.get(1)?,
            r.get(2)?,
            r.get(3)?,
            r.get(4)?,
            r.get(5)?,
            r.get(6)?,
            r.get(7)?,
        ))
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
}

/// Insert a new project for the given filesystem path, or bump last_opened_at if it already exists.
/// Mirrors TS addProject dedup logic. Does NOT auto-create a workspace or import sessions — the
/// TS code called those inside a transaction, but those modules are in a separate Rust phase.
/// Callers that need the full TS atomicity must wrap this + workspace create + session import.
pub fn add_project(db: &Db, path: &Path) -> Result<Project, DbError> {
    let path_str = path.to_string_lossy();

    // Dedup: if path already exists, bump last_opened_at and return.
    let existing_id: Option<String> = db
        .conn()
        .query_row(
            "SELECT id FROM projects WHERE path = ?1",
            params![path_str],
            |r| r.get(0),
        )
        .ok();

    if let Some(id) = existing_id {
        db.conn().execute(
            "UPDATE projects SET last_opened_at = ?1 WHERE id = ?2",
            params![now_ms(), id],
        )?;
        return fetch_project(db, &id);
    }

    let id = uuid_v4();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path_str.to_string());
    let claude_encoded_name = encode_path(&path_str);
    let added_at = now_ms();

    db.conn().execute(
        "INSERT INTO projects (id, path, name, claude_encoded_name, added_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, path_str, name, claude_encoded_name, added_at],
    )?;

    fetch_project(db, &id)
}

/// Bump last_opened_at and return the updated project — mirrors TS openProject.
pub fn open_project(db: &Db, id: &str) -> Result<Project, DbError> {
    db.conn().execute(
        "UPDATE projects SET last_opened_at = ?1 WHERE id = ?2",
        params![now_ms(), id],
    )?;
    fetch_project(db, id)
}

/// Delete a project and cascade to workspaces + sessions via FK.
pub fn delete_project(db: &Db, id: &str) -> Result<(), DbError> {
    db.conn()
        .execute("DELETE FROM projects WHERE id = ?1", params![id])?;
    Ok(())
}

/// Update the display name of a project.
pub fn rename_project(db: &Db, id: &str, name: &str) -> Result<(), DbError> {
    db.conn().execute(
        "UPDATE projects SET name = ?1 WHERE id = ?2",
        params![name, id],
    )?;
    Ok(())
}

/// Set whether the project is expanded in the sidebar.
pub fn set_project_expanded_in_sidebar(db: &Db, id: &str, expanded: bool) -> Result<(), DbError> {
    db.conn().execute(
        "UPDATE projects SET expanded_in_sidebar = ?1 WHERE id = ?2",
        params![if expanded { 1i64 } else { 0i64 }, id],
    )?;
    Ok(())
}

/// Assign sort_order to each project in the given order — mirrors TS reorderProjects transaction.
pub fn reorder_projects(db: &Db, ordered_ids: &[&str]) -> Result<(), DbError> {
    let conn = db.conn();
    let tx = rusqlite::Connection::unchecked_transaction(conn).map_err(DbError::from)?;
    for (idx, id) in ordered_ids.iter().enumerate() {
        tx.execute(
            "UPDATE projects SET sort_order = ?1 WHERE id = ?2",
            rusqlite::params![idx as i64, id],
        )
        .map_err(DbError::from)?;
    }
    tx.commit().map_err(DbError::from)
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
    fn add_and_list() {
        let (db, _dir) = temp_db();

        let p = add_project(&db, Path::new("/tmp/myproject")).expect("add");
        assert_eq!(p.name, "myproject");
        assert_eq!(p.path, "/tmp/myproject");
        assert!(p.claude_encoded_name.as_deref().unwrap().contains("tmp"));

        let projects = list_projects(&db).expect("list");
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].id, p.id);
    }

    #[test]
    fn add_dedup_bumps_last_opened_at() {
        let (db, _dir) = temp_db();

        let p1 = add_project(&db, Path::new("/tmp/proj")).expect("add first");
        // brief wait to ensure timestamps differ
        std::thread::sleep(std::time::Duration::from_millis(2));
        let p2 = add_project(&db, Path::new("/tmp/proj")).expect("add duplicate");

        assert_eq!(p1.id, p2.id, "dedup must return same id");
        // last_opened_at should have been bumped on re-add
        assert!(
            p2.last_opened_at.is_some(),
            "last_opened_at should be set after re-add"
        );
    }

    #[test]
    fn rename_project_test() {
        let (db, _dir) = temp_db();

        let p = add_project(&db, Path::new("/tmp/foo")).expect("add");
        rename_project(&db, &p.id, "NewName").expect("rename");

        let projects = list_projects(&db).expect("list");
        assert_eq!(projects[0].name, "NewName");
    }

    #[test]
    fn reorder_projects_test() {
        let (db, _dir) = temp_db();

        let p1 = add_project(&db, Path::new("/tmp/a")).expect("a");
        let p2 = add_project(&db, Path::new("/tmp/b")).expect("b");
        let p3 = add_project(&db, Path::new("/tmp/c")).expect("c");

        // Reverse order: c, a, b
        reorder_projects(&db, &[&p3.id, &p1.id, &p2.id]).expect("reorder");

        let projects = list_projects(&db).expect("list");
        // sort_order 0=p3, 1=p1, 2=p2 → ordering should be p3 first
        assert_eq!(projects[0].id, p3.id);
        assert_eq!(projects[1].id, p1.id);
        assert_eq!(projects[2].id, p2.id);
    }

    #[test]
    fn delete_project_test() {
        let (db, _dir) = temp_db();

        let p = add_project(&db, Path::new("/tmp/todelete")).expect("add");
        delete_project(&db, &p.id).expect("delete");

        let projects = list_projects(&db).expect("list");
        assert!(projects.is_empty());
    }

    #[test]
    fn expanded_in_sidebar_roundtrip() {
        let (db, _dir) = temp_db();

        let p = add_project(&db, Path::new("/tmp/exp")).expect("add");
        assert!(!p.expanded_in_sidebar);

        set_project_expanded_in_sidebar(&db, &p.id, true).expect("expand");
        let projects = list_projects(&db).expect("list");
        assert!(projects[0].expanded_in_sidebar);

        set_project_expanded_in_sidebar(&db, &p.id, false).expect("collapse");
        let projects = list_projects(&db).expect("list");
        assert!(!projects[0].expanded_in_sidebar);
    }

    #[test]
    fn reorder_projects_apostrophe_in_id() {
        let (db, _dir) = temp_db();

        let p = add_project(&db, Path::new("/tmp/reorder_apos")).expect("add");

        // An ID with a single quote must not cause a SQL error with bound params.
        let fake_id = "foo'bar";
        reorder_projects(&db, &[&p.id, fake_id]).expect("reorder should not error");

        let projects = list_projects(&db).expect("list");
        assert_eq!(projects[0].sort_order, Some(0), "real project gets sort_order 0");
    }
}
