// sessions:* commands.

use tauri::State;

use crate::sessions::{self, Session, SessionStatus};
use crate::SharedDb;

#[tauri::command]
pub fn sessions_list_for_project(
    db: State<SharedDb>,
    project_id: String,
    include_archived: Option<bool>,
) -> Result<Vec<Session>, String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    sessions::list_sessions_for_project(&lock, &project_id, include_archived.unwrap_or(false))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sessions_list_all(
    db: State<SharedDb>,
    status: Option<SessionStatus>,
) -> Result<Vec<Session>, String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    sessions::list_all_sessions(&lock, status).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sessions_set_status(
    db: State<SharedDb>,
    id: String,
    status: SessionStatus,
) -> Result<(), String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    sessions::set_session_status(&lock, &id, status).map_err(|e| e.to_string())
}
