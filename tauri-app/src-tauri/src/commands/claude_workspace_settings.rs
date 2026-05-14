// claudeWorkspaceSettings:* commands — per-workspace overrides.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::claude_workspace_settings;
use crate::claude_settings::SettingsOverrides;
use crate::commands::events::{DirtySet, MountSnapshots};
use crate::SharedDb;

// The renderer expects { workspaceId, overrides: { model?, permissionMode?, effort? }, updatedAt }
// matching ClaudeWorkspaceSettings in TS.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOverridesInner {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSettingsResponse {
    pub workspace_id: String,
    pub overrides: WorkspaceOverridesInner,
    pub updated_at: i64,
}

fn overrides_to_response(workspace_id: String, ov: Option<SettingsOverrides>) -> WorkspaceSettingsResponse {
    let overrides = match ov {
        Some(o) => WorkspaceOverridesInner {
            model: o.model,
            permission_mode: o.permission_mode.map(|m| m.as_str().to_owned()),
            effort: o.effort.map(|e| e.as_str().to_owned()),
        },
        None => WorkspaceOverridesInner {
            model: None,
            permission_mode: None,
            effort: None,
        },
    };
    WorkspaceSettingsResponse {
        workspace_id,
        overrides,
        updated_at: crate::util::now_ms(),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
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

#[tauri::command(rename_all = "camelCase")]
pub fn claude_workspace_settings_get(
    db: State<SharedDb>,
    workspace_id: String,
) -> Result<WorkspaceSettingsResponse, String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    let ov = claude_workspace_settings::get_workspace_overrides(&lock, &workspace_id)
        .map_err(|e| e.to_string())?;
    Ok(overrides_to_response(workspace_id, ov))
}

#[tauri::command(rename_all = "camelCase")]
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
    Ok(overrides_to_response(workspace_id, updated))
}
