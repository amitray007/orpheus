// claudeSettings:* commands — global Claude settings.

use tauri::State;

use crate::claude_settings::{self, ClaudeGlobalSettings, ClaudeGlobalSettingsPatch};
use crate::SharedDb;

#[tauri::command]
pub fn claude_settings_get(db: State<SharedDb>) -> Result<ClaudeGlobalSettings, String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    claude_settings::get_global_settings(&lock).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn claude_settings_update(
    db: State<SharedDb>,
    patch: ClaudeGlobalSettingsPatch,
) -> Result<ClaudeGlobalSettings, String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    claude_settings::update_global_settings(&lock, patch).map_err(|e| e.to_string())
}
