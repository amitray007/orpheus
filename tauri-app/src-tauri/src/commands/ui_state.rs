// uiState:* commands.

use tauri::State;

use crate::ui_state::{self, AppUiState, AppUiStatePatch};
use crate::SharedDb;

#[tauri::command]
pub fn ui_state_get(db: State<SharedDb>) -> Result<AppUiState, String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    ui_state::get_ui_state(&lock).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ui_state_update(db: State<SharedDb>, patch: AppUiStatePatch) -> Result<AppUiState, String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    ui_state::update_ui_state(&lock, patch).map_err(|e| e.to_string())
}
