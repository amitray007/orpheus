// uiState:* commands.

use tauri::{AppHandle, State};

use crate::ui_state::{self, AppUiState, AppUiStatePatch};
use crate::SharedDb;

#[tauri::command]
pub fn ui_state_get(db: State<SharedDb>) -> Result<AppUiState, String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    ui_state::get_ui_state(&lock).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ui_state_update(
    app: AppHandle,
    db: State<SharedDb>,
    patch: AppUiStatePatch,
) -> Result<AppUiState, String> {
    let launch_at_login = patch.launch_at_login;
    let global_hotkey = patch.global_hotkey.clone();
    let lock = db.lock().map_err(|e| e.to_string())?;
    let updated = ui_state::update_ui_state(&lock, patch).map_err(|e| e.to_string())?;
    // Apply side effects for launchAtLogin and globalHotkey changes.
    if let Some(enabled) = launch_at_login {
        crate::apply_launch_at_login(&app, enabled);
    }
    if let Some(ref hotkey) = global_hotkey {
        crate::apply_global_hotkey(&app, hotkey);
    }
    Ok(updated)
}
