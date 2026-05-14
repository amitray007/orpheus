// claudeSettings:* commands — global Claude settings.

use tauri::{AppHandle, State};

use crate::claude_settings::{self, ClaudeGlobalSettings, ClaudeGlobalSettingsPatch};
use crate::commands::events::{DirtySet, MountSnapshots};
use crate::SharedDb;

#[tauri::command]
pub fn claude_settings_get(db: State<SharedDb>) -> Result<ClaudeGlobalSettings, String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    claude_settings::get_global_settings(&lock).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn claude_settings_update(
    app: AppHandle,
    db: State<SharedDb>,
    snapshots: State<MountSnapshots>,
    dirty_set: State<DirtySet>,
    patch: ClaudeGlobalSettingsPatch,
) -> Result<ClaudeGlobalSettings, String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    let updated = claude_settings::update_global_settings(&lock, patch).map_err(|e| e.to_string())?;
    crate::commands::events::recompute_dirty_for_all_mounted(&lock, &app, &snapshots, &dirty_set);
    Ok(updated)
}
