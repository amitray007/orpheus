use serde::Deserialize;
use tauri::Window;

use ghostty_native::{MountResult, Rect};

#[derive(Debug, Deserialize)]
pub struct MountArgs {
    pub workspace_id: String,
    pub rect: Rect,
    pub scale: f64,
    pub cwd: Option<String>,
    pub command: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ResizeArgs {
    pub workspace_id: String,
    pub rect: Rect,
    pub scale: f64,
}

#[tauri::command]
pub fn mount_terminal(window: Window, args: MountArgs) -> Result<MountResult, String> {
    ghostty_native::mount(
        &window,
        &args.workspace_id,
        &args.rect,
        args.scale,
        args.cwd.as_deref(),
        args.command.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn hide_terminal(workspace_id: String) -> Result<(), String> {
    ghostty_native::hide(&workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn resize_terminal(args: ResizeArgs) -> Result<(), String> {
    ghostty_native::resize(&args.workspace_id, &args.rect, args.scale)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn destroy_terminal(workspace_id: String) -> Result<(), String> {
    ghostty_native::destroy(&workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_terminal_focus(workspace_id: String, focused: bool) -> Result<(), String> {
    ghostty_native::set_focus(&workspace_id, focused).map_err(|e| e.to_string())
}
