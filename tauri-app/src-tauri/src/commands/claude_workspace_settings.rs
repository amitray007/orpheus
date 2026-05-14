// claudeWorkspaceSettings:* commands — per-workspace overrides.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::claude_workspace_settings;
use crate::claude_settings::SettingsOverrides;
use crate::commands::events::{DirtySet, MountSnapshots};
use crate::SharedDb;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSettingsResponse {
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub effort: Option<String>,
}

fn overrides_to_response(ov: Option<SettingsOverrides>) -> WorkspaceSettingsResponse {
    match ov {
        Some(o) => WorkspaceSettingsResponse {
            model: o.model,
            permission_mode: o.permission_mode.map(|m| m.as_str().to_owned()),
            effort: o.effort.map(|e| e.as_str().to_owned()),
        },
        None => WorkspaceSettingsResponse {
            model: None,
            permission_mode: None,
            effort: None,
        },
    }
}

#[derive(Debug, Deserialize)]
pub struct WorkspaceSettingsPatch {
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub effort: Option<String>,
}

impl From<WorkspaceSettingsPatch> for SettingsOverrides {
    fn from(p: WorkspaceSettingsPatch) -> Self {
        use crate::claude_settings::{Effort, PermissionMode};
        SettingsOverrides {
            model: p.model,
            permission_mode: p.permission_mode.as_deref().and_then(|s| PermissionMode::try_from(s).ok()),
            effort: p.effort.as_deref().and_then(|s| Effort::try_from(s).ok()),
        }
    }
}

#[tauri::command]
pub fn claude_workspace_settings_get(
    db: State<SharedDb>,
    workspace_id: String,
) -> Result<WorkspaceSettingsResponse, String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    let ov = claude_workspace_settings::get_workspace_overrides(&lock, &workspace_id)
        .map_err(|e| e.to_string())?;
    Ok(overrides_to_response(ov))
}

#[tauri::command]
pub fn claude_workspace_settings_update(
    app: AppHandle,
    db: State<SharedDb>,
    snapshots: State<MountSnapshots>,
    dirty_set: State<DirtySet>,
    workspace_id: String,
    patch: WorkspaceSettingsPatch,
) -> Result<WorkspaceSettingsResponse, String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    let ov: SettingsOverrides = patch.into();
    claude_workspace_settings::set_workspace_overrides(&lock, &workspace_id, &ov)
        .map_err(|e| e.to_string())?;
    let updated = claude_workspace_settings::get_workspace_overrides(&lock, &workspace_id)
        .map_err(|e| e.to_string())?;
    crate::commands::events::recompute_dirty_for_all_mounted(&lock, &app, &snapshots, &dirty_set);
    Ok(overrides_to_response(updated))
}
