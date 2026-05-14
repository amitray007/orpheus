// claudeProjectSettings:* commands — per-project overrides.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::claude_project_settings;
use crate::claude_settings::SettingsOverrides;
use crate::commands::events::{DirtySet, MountSnapshots};
use crate::SharedDb;

// The renderer expects a flat object matching ClaudeProjectSettings in TS.
// SettingsOverrides is the Rust equivalent — serialize directly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettingsResponse {
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub effort: Option<String>,
}

fn overrides_to_response(ov: Option<SettingsOverrides>) -> ProjectSettingsResponse {
    match ov {
        Some(o) => ProjectSettingsResponse {
            model: o.model,
            permission_mode: o.permission_mode.map(|m| m.as_str().to_owned()),
            effort: o.effort.map(|e| e.as_str().to_owned()),
        },
        None => ProjectSettingsResponse {
            model: None,
            permission_mode: None,
            effort: None,
        },
    }
}

#[derive(Debug, Deserialize)]
pub struct ProjectSettingsPatch {
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub effort: Option<String>,
}

impl From<ProjectSettingsPatch> for SettingsOverrides {
    fn from(p: ProjectSettingsPatch) -> Self {
        use crate::claude_settings::{Effort, PermissionMode};
        SettingsOverrides {
            model: p.model,
            permission_mode: p.permission_mode.as_deref().and_then(|s| PermissionMode::try_from(s).ok()),
            effort: p.effort.as_deref().and_then(|s| Effort::try_from(s).ok()),
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn claude_project_settings_get(
    db: State<SharedDb>,
    project_id: String,
) -> Result<ProjectSettingsResponse, String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    let ov = claude_project_settings::get_project_overrides(&lock, &project_id)
        .map_err(|e| e.to_string())?;
    Ok(overrides_to_response(ov))
}

#[tauri::command(rename_all = "camelCase")]
pub fn claude_project_settings_update(
    app: AppHandle,
    db: State<SharedDb>,
    snapshots: State<MountSnapshots>,
    dirty_set: State<DirtySet>,
    project_id: String,
    patch: ProjectSettingsPatch,
) -> Result<ProjectSettingsResponse, String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    let ov: SettingsOverrides = patch.into();
    claude_project_settings::set_project_overrides(&lock, &project_id, &ov)
        .map_err(|e| e.to_string())?;
    let updated = claude_project_settings::get_project_overrides(&lock, &project_id)
        .map_err(|e| e.to_string())?;
    crate::commands::events::recompute_dirty_for_all_mounted(&lock, &app, &snapshots, &dirty_set);
    Ok(overrides_to_response(updated))
}
