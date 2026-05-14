// projects:* commands.

use std::path::Path;

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::projects::{self, Project};
use crate::SharedDb;
use tauri::State;

#[tauri::command]
pub fn projects_list(db: State<SharedDb>) -> Result<Vec<Project>, String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    projects::list_projects(&lock).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn projects_add(db: State<SharedDb>, path: String) -> Result<Project, String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    projects::add_project(&lock, Path::new(&path)).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn projects_pick_and_add(
    app: AppHandle,
    db: State<'_, SharedDb>,
) -> Result<Option<Project>, String> {
    let path = app
        .dialog()
        .file()
        .blocking_pick_folder();

    let chosen = match path.and_then(|p| p.into_path().ok()) {
        Some(p) => p,
        None => return Ok(None),
    };

    let lock = db.lock().map_err(|e| e.to_string())?;
    let project = projects::add_project(&lock, &chosen).map_err(|e| e.to_string())?;
    Ok(Some(project))
}

#[tauri::command(rename_all = "camelCase")]
pub fn projects_open(db: State<SharedDb>, id: String) -> Result<Project, String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    projects::open_project(&lock, &id).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub fn projects_remove(db: State<SharedDb>, id: String) -> Result<(), String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    projects::delete_project(&lock, &id).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub fn projects_rename(db: State<SharedDb>, id: String, name: String) -> Result<(), String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    projects::rename_project(&lock, &id, &name).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub fn projects_set_expanded_in_sidebar(
    db: State<SharedDb>,
    id: String,
    expanded: bool,
) -> Result<(), String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    projects::set_project_expanded_in_sidebar(&lock, &id, expanded).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub fn projects_reorder(db: State<SharedDb>, ordered_ids: Vec<String>) -> Result<(), String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    let refs: Vec<&str> = ordered_ids.iter().map(|s| s.as_str()).collect();
    projects::reorder_projects(&lock, &refs).map_err(|e| e.to_string())
}
