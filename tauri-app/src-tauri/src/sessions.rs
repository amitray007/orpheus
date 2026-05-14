// Sessions data layer — mirrors src/main/sessions.ts.
// IDs are TEXT (UUID or Claude-generated session IDs from .jsonl filenames).
// Timestamps are epoch-ms i64.
//
// The TS sessions.ts contains extractTitle/extractModel/extractLastMessageRole helpers
// and importSessionsForProject (scans ~/.claude/projects/<encoded>/). Those are ported
// here as pub fns so callers (e.g. add_project) can import sessions at project-add time.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::db::{Db, DbError};
use crate::util::{now_ms, uuid_v4};

// ---------------------------------------------------------------------------
// Status enum
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    InProgress,
    InReview,
    Archived,
}

impl SessionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            SessionStatus::InProgress => "in_progress",
            SessionStatus::InReview => "in_review",
            SessionStatus::Archived => "archived",
        }
    }
}

impl TryFrom<&str> for SessionStatus {
    type Error = String;
    fn try_from(s: &str) -> Result<Self, Self::Error> {
        match s {
            "in_progress" => Ok(SessionStatus::InProgress),
            "in_review" => Ok(SessionStatus::InReview),
            "archived" => Ok(SessionStatus::Archived),
            other => Err(format!("unknown session status: {other}")),
        }
    }
}

impl rusqlite::types::FromSql for SessionStatus {
    fn column_result(value: rusqlite::types::ValueRef<'_>) -> rusqlite::types::FromSqlResult<Self> {
        let s = value.as_str()?;
        SessionStatus::try_from(s).map_err(|e| rusqlite::types::FromSqlError::Other(e.into()))
    }
}

impl rusqlite::types::ToSql for SessionStatus {
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
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub project_id: String,
    pub jsonl_path: String,
    pub title: Option<String>,
    pub status: SessionStatus,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived_at: Option<i64>,
    pub model: Option<String>,
    pub last_message_role: Option<String>,
}

// ---------------------------------------------------------------------------
// Row → struct
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn row_to_session(
    id: String,
    project_id: String,
    jsonl_path: String,
    title: Option<String>,
    status: SessionStatus,
    created_at: i64,
    updated_at: i64,
    archived_at: Option<i64>,
    model: Option<String>,
    last_message_role: Option<String>,
) -> Session {
    Session {
        id,
        project_id,
        jsonl_path,
        title,
        status,
        created_at,
        updated_at,
        archived_at,
        model,
        last_message_role,
    }
}

fn map_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Session> {
    Ok(row_to_session(
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
    ))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn fetch_session(db: &Db, id: &str) -> Result<Session, DbError> {
    db.conn()
        .query_row(
            "SELECT id, project_id, jsonl_path, title, status,
                    created_at, updated_at, archived_at, model, last_message_role
             FROM sessions WHERE id = ?1",
            params![id],
            map_row,
        )
        .map_err(DbError::from)
}

// ---------------------------------------------------------------------------
// JSONL parsing helpers — mirrors TS extractTitle / extractModel / extractLastMessageRole
// ---------------------------------------------------------------------------

const MAX_BYTES: usize = 200 * 1024;
const MAX_TITLE_LEN: usize = 60;

/// Read up to MAX_BYTES from a file starting at `offset` from the end.
fn read_tail_bytes(path: &Path, from_end: bool) -> Option<String> {
    use std::fs::File;
    use std::io::{Read, Seek, SeekFrom};

    let mut file = File::open(path).ok()?;
    let file_size = file.metadata().ok()?.len() as usize;
    let read_size = file_size.min(MAX_BYTES);
    let offset = if from_end { (file_size - read_size) as u64 } else { 0 };

    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut buf = vec![0u8; read_size];
    let n = file.read(&mut buf).ok()?;
    String::from_utf8_lossy(&buf[..n]).into_owned().into()
}

/// Extract the title from the first user message in the JSONL file.
pub fn extract_title(path: &Path) -> Option<String> {
    let text = read_tail_bytes(path, false)?;

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }

        let parsed: serde_json::Value = serde_json::from_str(trimmed).ok()?;
        if parsed.get("role").and_then(|v| v.as_str()) != Some("user") {
            continue;
        }

        let raw: Option<String> = match parsed.get("content") {
            Some(serde_json::Value::String(s)) => Some(s.clone()),
            Some(serde_json::Value::Array(parts)) => {
                parts.iter().find_map(|p| {
                    if p.get("type").and_then(|v| v.as_str()) == Some("text") {
                        p.get("text").and_then(|v| v.as_str()).map(String::from)
                    } else {
                        None
                    }
                })
            }
            _ => None,
        };

        if let Some(r) = raw {
            let t = r.trim().to_string();
            return if t.chars().count() > MAX_TITLE_LEN {
                let truncated: String = t.chars().take(MAX_TITLE_LEN).collect();
                Some(format!("{truncated}\u{2026}")) // … ellipsis
            } else {
                Some(t)
            };
        }
    }

    None
}

/// Extract the first model string from the JSONL file.
pub fn extract_model(path: &Path) -> Option<String> {
    let text = read_tail_bytes(path, false)?;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(trimmed) {
            if let Some(m) = parsed.get("model").and_then(|v| v.as_str()) {
                return Some(m.to_string());
            }
        }
    }
    None
}

/// Extract the last role string from the JSONL file (reads from the tail for efficiency).
pub fn extract_last_message_role(path: &Path) -> Option<String> {
    let text = read_tail_bytes(path, true)?;
    for line in text.lines().rev() {
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(trimmed) {
            if let Some(r) = parsed.get("role").and_then(|v| v.as_str()) {
                return Some(r.to_string());
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/// Scan ~/.claude/projects/<claude_encoded_name>/ for .jsonl files and insert them
/// via INSERT OR IGNORE (idempotent). Mirrors TS importSessionsForProject.
/// The caller is responsible for wrapping in a transaction if atomicity is needed.
pub fn import_sessions_for_project(
    db: &Db,
    project_id: &str,
    claude_encoded_name: &str,
) -> Result<Vec<Session>, DbError> {
    let home = match dirs_home() {
        Some(h) => h,
        None => return Ok(vec![]),
    };

    let dir = home
        .join(".claude")
        .join("projects")
        .join(claude_encoded_name);

    if !dir.exists() {
        return Ok(vec![]);
    }

    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(vec![]),
    };

    for entry in entries.flatten() {
        let fname = entry.file_name();
        let name = fname.to_string_lossy();
        if !name.ends_with(".jsonl") {
            continue;
        }

        let session_id = name.trim_end_matches(".jsonl");
        let jsonl_path = entry.path();

        let mtime = std::fs::metadata(&jsonl_path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or_else(now_ms);

        let title = extract_title(&jsonl_path);
        let model = extract_model(&jsonl_path);
        let last_role = extract_last_message_role(&jsonl_path);

        let _ = db.conn().execute(
            "INSERT OR IGNORE INTO sessions
               (id, project_id, jsonl_path, title, status, created_at, updated_at, model, last_message_role)
             VALUES (?1, ?2, ?3, ?4, 'in_review', ?5, ?6, ?7, ?8)",
            params![
                session_id,
                project_id,
                jsonl_path.to_string_lossy().as_ref(),
                title,
                mtime,
                mtime,
                model,
                last_role
            ],
        );
    }

    list_sessions_for_project(db, project_id, false)
}

fn dirs_home() -> Option<PathBuf> {
    // Use HOME env var on Unix (avoids adding the `dirs` crate just for this).
    #[cfg(unix)]
    {
        std::env::var("HOME").ok().map(PathBuf::from)
    }
    #[cfg(not(unix))]
    {
        None
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// List sessions for a project. Status ordering: in_progress → in_review → archived.
pub fn list_sessions_for_project(
    db: &Db,
    project_id: &str,
    include_archived: bool,
) -> Result<Vec<Session>, DbError> {
    let archived_filter = if include_archived { "" } else { "AND status != 'archived'" };
    let sql = format!(
        "SELECT id, project_id, jsonl_path, title, status,
                created_at, updated_at, archived_at, model, last_message_role
         FROM sessions
         WHERE project_id = ?1 {archived_filter}
         ORDER BY
           CASE status
             WHEN 'in_progress' THEN 0
             WHEN 'in_review' THEN 1
             WHEN 'archived' THEN 2
             ELSE 3
           END,
           updated_at DESC"
    );
    let mut stmt = db.conn().prepare(&sql)?;
    let rows = stmt.query_map(params![project_id], map_row)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
}

/// List all sessions across non-archived projects, optionally filtered by status.
pub fn list_all_sessions(
    db: &Db,
    status_filter: Option<SessionStatus>,
) -> Result<Vec<Session>, DbError> {
    let status_clause = if status_filter.is_some() {
        "AND s.status = ?2"
    } else {
        ""
    };

    let sql = format!(
        "SELECT s.id, s.project_id, s.jsonl_path, s.title, s.status,
                s.created_at, s.updated_at, s.archived_at, s.model, s.last_message_role
         FROM sessions s
         JOIN projects p ON p.id = s.project_id
         WHERE p.archived_at IS NULL {status_clause}
         ORDER BY
           CASE s.status
             WHEN 'in_progress' THEN 0
             WHEN 'in_review' THEN 1
             WHEN 'archived' THEN 2
             ELSE 3
           END,
           s.updated_at DESC"
    );

    let mut stmt = db.conn().prepare(&sql)?;

    let rows = match status_filter {
        Some(ref sf) => stmt.query_map(params![sf], map_row)?,
        None => stmt.query_map([], map_row)?,
    };

    rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
}

/// Insert a new session record explicitly.
pub fn add_session(
    db: &Db,
    project_id: &str,
    jsonl_path: &str,
    title: Option<&str>,
    model: Option<&str>,
    last_message_role: Option<&str>,
) -> Result<Session, DbError> {
    let id = uuid_v4();
    let now = now_ms();
    db.conn().execute(
        "INSERT INTO sessions
           (id, project_id, jsonl_path, title, status, created_at, updated_at, model, last_message_role)
         VALUES (?1, ?2, ?3, ?4, 'in_review', ?5, ?6, ?7, ?8)",
        params![id, project_id, jsonl_path, title, now, now, model, last_message_role],
    )?;
    fetch_session(db, &id)
}

/// Update the title of a session.
pub fn rename_session(db: &Db, id: &str, title: &str) -> Result<(), DbError> {
    db.conn().execute(
        "UPDATE sessions SET title = ?1, updated_at = ?2 WHERE id = ?3",
        params![title, now_ms(), id],
    )?;
    Ok(())
}

/// Set status, keeping archived_at and updated_at consistent.
pub fn set_session_status(db: &Db, id: &str, status: SessionStatus) -> Result<(), DbError> {
    let now = now_ms();
    if status == SessionStatus::Archived {
        db.conn().execute(
            "UPDATE sessions SET status = ?1, archived_at = ?2, updated_at = ?3 WHERE id = ?4",
            params![status, now, now, id],
        )?;
    } else {
        db.conn().execute(
            "UPDATE sessions SET status = ?1, archived_at = NULL, updated_at = ?2 WHERE id = ?3",
            params![status, now, id],
        )?;
    }
    Ok(())
}

/// Delete a session permanently.
pub fn delete_session(db: &Db, id: &str) -> Result<(), DbError> {
    db.conn()
        .execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
    Ok(())
}

/// Update preview data after a session runs — mirrors TS setPreview / setTokenCount semantics.
/// (TS sessions.ts doesn't have a setPreview, but preview-like data is carried in title/model;
/// this function updates both to allow callers to refresh after analysis.)
pub fn update_session_metadata(
    db: &Db,
    id: &str,
    title: Option<&str>,
    model: Option<&str>,
    last_message_role: Option<&str>,
) -> Result<(), DbError> {
    db.conn().execute(
        "UPDATE sessions SET title = ?1, model = ?2, last_message_role = ?3, updated_at = ?4 WHERE id = ?5",
        params![title, model, last_message_role, now_ms(), id],
    )?;
    Ok(())
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

    fn add_test_project(db: &Db) -> crate::projects::Project {
        add_project(db, Path::new("/tmp/session_test_proj")).expect("add_project")
    }

    #[test]
    fn add_and_list() {
        let (db, _dir) = temp_db();
        let p = add_test_project(&db);

        let s = add_session(&db, &p.id, "/tmp/session.jsonl", Some("Hello"), None, None).expect("add");
        assert_eq!(s.title.as_deref(), Some("Hello"));
        assert_eq!(s.status, SessionStatus::InReview);

        let sessions = list_sessions_for_project(&db, &p.id, false).expect("list");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, s.id);
    }

    #[test]
    fn rename_session_test() {
        let (db, _dir) = temp_db();
        let p = add_test_project(&db);
        let s = add_session(&db, &p.id, "/tmp/s.jsonl", Some("Old"), None, None).expect("add");

        rename_session(&db, &s.id, "New Title").expect("rename");

        let sessions = list_sessions_for_project(&db, &p.id, false).expect("list");
        assert_eq!(sessions[0].title.as_deref(), Some("New Title"));
    }

    #[test]
    fn set_preview_metadata() {
        let (db, _dir) = temp_db();
        let p = add_test_project(&db);
        let s = add_session(&db, &p.id, "/tmp/s.jsonl", None, None, None).expect("add");

        update_session_metadata(&db, &s.id, Some("A title"), Some("claude-sonnet"), Some("assistant"))
            .expect("update metadata");

        let sessions = list_sessions_for_project(&db, &p.id, false).expect("list");
        assert_eq!(sessions[0].model.as_deref(), Some("claude-sonnet"));
        assert_eq!(sessions[0].last_message_role.as_deref(), Some("assistant"));
    }

    #[test]
    fn delete_session_test() {
        let (db, _dir) = temp_db();
        let p = add_test_project(&db);
        let s = add_session(&db, &p.id, "/tmp/s.jsonl", None, None, None).expect("add");

        delete_session(&db, &s.id).expect("delete");

        let sessions = list_sessions_for_project(&db, &p.id, false).expect("list");
        assert!(sessions.is_empty());
    }

    #[test]
    fn archive_status_sets_archived_at() {
        let (db, _dir) = temp_db();
        let p = add_test_project(&db);
        let s = add_session(&db, &p.id, "/tmp/s.jsonl", None, None, None).expect("add");

        set_session_status(&db, &s.id, SessionStatus::Archived).expect("archive");

        let sessions = list_sessions_for_project(&db, &p.id, true).expect("list all");
        let archived = sessions.iter().find(|x| x.id == s.id).expect("find");
        assert!(archived.archived_at.is_some());

        // Unarchiving should clear archived_at.
        set_session_status(&db, &s.id, SessionStatus::InReview).expect("unarchive");
        let sessions2 = list_sessions_for_project(&db, &p.id, true).expect("list all2");
        let unarchived = sessions2.iter().find(|x| x.id == s.id).expect("find2");
        assert!(unarchived.archived_at.is_none());
    }

    #[test]
    fn status_ordering() {
        let (db, _dir) = temp_db();
        let p = add_test_project(&db);

        let s1 = add_session(&db, &p.id, "/tmp/s1.jsonl", Some("in_review"), None, None).expect("s1");
        let s2 = add_session(&db, &p.id, "/tmp/s2.jsonl", Some("in_progress"), None, None).expect("s2");

        set_session_status(&db, &s2.id, SessionStatus::InProgress).expect("promote s2");

        let sessions = list_sessions_for_project(&db, &p.id, false).expect("list");
        // in_progress should sort first.
        assert_eq!(sessions[0].id, s2.id);
        assert_eq!(sessions[1].id, s1.id);
    }

    #[test]
    fn extract_title_from_jsonl() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("session.jsonl");

        let content = r#"{"role":"system","content":"You are an assistant"}
{"role":"user","content":"Hello from test"}
{"role":"assistant","content":"Hi!"}
"#;
        std::fs::write(&path, content).expect("write");

        let title = extract_title(&path);
        assert_eq!(title.as_deref(), Some("Hello from test"));
    }
}
