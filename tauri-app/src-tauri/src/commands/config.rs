// config:* commands — file/folder pickers.

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// Open a native folder picker. Returns the chosen path or null if cancelled.
#[tauri::command]
pub async fn config_open_folder(app: AppHandle) -> Option<String> {
    let path = app
        .dialog()
        .file()
        .blocking_pick_folder();

    path.and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}
