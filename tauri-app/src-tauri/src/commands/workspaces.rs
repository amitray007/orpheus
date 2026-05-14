// workspaces:* commands.

use serde::Deserialize;
use tauri::State;

use crate::workspaces::{self, PinnedItem, Workspace, WorkspaceScope};
use crate::SharedDb;

// Re-export for the title-state command (workspace:getTitle).
// The in-memory title map lives in the events module; the command reads from it.
use crate::commands::events::TitleMap;

#[derive(Debug, Deserialize)]
pub struct CreateArgs {
    pub project_id: String,
    pub name: String,
    pub cwd: String,
}

#[tauri::command]
pub fn workspaces_list_for_project(
    db: State<SharedDb>,
    project_id: String,
    scope: Option<String>,
) -> Result<Vec<Workspace>, String> {
    let ws_scope = match scope.as_deref() {
        Some("archived") => WorkspaceScope::Archived,
        Some("all") => WorkspaceScope::All,
        _ => WorkspaceScope::Active,
    };
    let lock = db.lock().map_err(|e| e.to_string())?;
    workspaces::list_workspaces_for_project(&lock, &project_id, ws_scope)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workspaces_create(db: State<SharedDb>, args: CreateArgs) -> Result<Workspace, String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    workspaces::create_workspace(&lock, &args.project_id, &args.name, &args.cwd)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workspaces_open(db: State<SharedDb>, id: String) -> Result<Workspace, String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    workspaces::open_workspace(&lock, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workspaces_set_pinned(
    db: State<SharedDb>,
    id: String,
    pinned: bool,
) -> Result<Workspace, String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    workspaces::set_workspace_pinned(&lock, &id, pinned).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workspaces_archive(db: State<SharedDb>, id: String) -> Result<Workspace, String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    workspaces::archive_workspace(&lock, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workspaces_unarchive(db: State<SharedDb>, id: String) -> Result<Workspace, String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    workspaces::unarchive_workspace(&lock, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workspaces_rename(
    db: State<SharedDb>,
    id: String,
    name: String,
) -> Result<Workspace, String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    workspaces::rename_workspace(&lock, &id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workspaces_reorder(
    db: State<SharedDb>,
    project_id: String,
    ordered_ids: Vec<String>,
) -> Result<(), String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    let refs: Vec<&str> = ordered_ids.iter().map(|s| s.as_str()).collect();
    workspaces::reorder_workspaces(&lock, &project_id, &refs).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workspace_is_dirty(
    dirty_set: State<crate::commands::events::DirtySet>,
    workspace_id: String,
) -> bool {
    dirty_set
        .lock()
        .map(|s| s.contains(&workspace_id))
        .unwrap_or(false)
}

#[tauri::command]
pub fn workspace_get_title(
    title_map: State<TitleMap>,
    workspace_id: String,
) -> Option<String> {
    title_map
        .lock()
        .ok()
        .and_then(|m| m.get(&workspace_id).cloned())
}

#[tauri::command]
pub fn workspace_reset_activity(
    dirty_set: State<crate::commands::events::DirtySet>,
    workspace_id: String,
) {
    // Reset dirty tracking for the workspace — equivalent to TS resetWorkspaceActivity.
    if let Ok(mut s) = dirty_set.lock() {
        s.remove(&workspace_id);
    }
}

#[tauri::command]
pub fn workspace_set_currently_viewed(_workspace_id: Option<String>) {
    // Phase 3 stub: suppresses attention retries for the viewed workspace.
    // The full implementation wires into AttentionRetryState in Phase 4.
}

#[tauri::command]
pub fn pins_list_all(db: State<SharedDb>) -> Result<Vec<PinnedItem>, String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    workspaces::list_all_pinned(&lock).map_err(|e| e.to_string())
}
