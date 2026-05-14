// Workspace-level overrides: read/write the overrides_json blob in claude_workspace_settings.
// Mirrors src/main/claudeWorkspaceSettings.ts. Schema v15+.

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::claude_settings::{Effort, PermissionMode, SettingsOverrides};
use crate::db::{Db, DbError};
use crate::util::now_ms;

// ---------------------------------------------------------------------------
// On-disk JSON shape (camelCase to match the v17 migration contract)
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Serialize, Deserialize)]
struct OverridesBlob {
    #[serde(rename = "model", skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(rename = "permissionMode", skip_serializing_if = "Option::is_none")]
    permission_mode: Option<String>,
    #[serde(rename = "effort", skip_serializing_if = "Option::is_none")]
    effort: Option<String>,
}

impl OverridesBlob {
    fn into_settings_overrides(self) -> SettingsOverrides {
        SettingsOverrides {
            model: self.model,
            permission_mode: self
                .permission_mode
                .as_deref()
                .and_then(|s| PermissionMode::try_from(s).ok()),
            effort: self
                .effort
                .as_deref()
                .and_then(|s| Effort::try_from(s).ok()),
        }
    }
}

impl From<&SettingsOverrides> for OverridesBlob {
    fn from(ov: &SettingsOverrides) -> Self {
        OverridesBlob {
            model: ov.model.clone(),
            permission_mode: ov.permission_mode.as_ref().map(|m| m.as_str().to_owned()),
            effort: ov.effort.as_ref().map(|e| e.as_str().to_owned()),
        }
    }
}

fn parse_blob(json: &str) -> OverridesBlob {
    serde_json::from_str(json).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Return the stored overrides for a workspace, or None if no row exists.
pub fn get_workspace_overrides(
    db: &Db,
    workspace_id: &str,
) -> Result<Option<SettingsOverrides>, DbError> {
    let row: Option<String> = db
        .conn()
        .query_row(
            "SELECT overrides_json FROM claude_workspace_settings WHERE workspace_id = ?1",
            [workspace_id],
            |r| r.get(0),
        )
        .optional()?;

    Ok(row.map(|json| parse_blob(&json).into_settings_overrides()))
}

/// Upsert overrides for a workspace.
pub fn set_workspace_overrides(
    db: &Db,
    workspace_id: &str,
    overrides: &SettingsOverrides,
) -> Result<(), DbError> {
    let blob: OverridesBlob = overrides.into();
    let json = serde_json::to_string(&blob).unwrap_or_else(|_| "{}".into());
    let now = now_ms();
    db.conn().execute(
        "INSERT INTO claude_workspace_settings (workspace_id, overrides_json, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(workspace_id) DO UPDATE SET overrides_json = excluded.overrides_json, updated_at = excluded.updated_at",
        rusqlite::params![workspace_id, json, now],
    )?;
    Ok(())
}

/// Delete the overrides row for a workspace (no-op if absent).
pub fn clear_workspace_overrides(db: &Db, workspace_id: &str) -> Result<(), DbError> {
    db.conn().execute(
        "DELETE FROM claude_workspace_settings WHERE workspace_id = ?1",
        [workspace_id],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn temp_db() -> (Db, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("test.sqlite");
        let db = Db::open_at(&path).expect("open_at");
        (db, dir)
    }

    fn seed_workspace(db: &Db, ws_id: &str, proj_id: &str) {
        db.conn()
            .execute(
                "INSERT OR IGNORE INTO projects (id, path, name, added_at) VALUES (?1, ?2, ?3, 0)",
                [proj_id, &format!("/tmp/{proj_id}"), proj_id],
            )
            .expect("seed project");
        db.conn()
            .execute(
                "INSERT INTO workspaces (id, project_id, name, cwd, created_at) VALUES (?1, ?2, ?3, ?4, 0)",
                [ws_id, proj_id, ws_id, &format!("/tmp/{ws_id}")],
            )
            .expect("seed workspace");
    }

    #[test]
    fn get_returns_none_when_no_row() {
        let (db, _dir) = temp_db();
        seed_workspace(&db, "ws-1", "p-1");
        let result = get_workspace_overrides(&db, "ws-1").expect("get");
        assert!(result.is_none());
    }

    #[test]
    fn round_trip_model_only() {
        let (db, _dir) = temp_db();
        seed_workspace(&db, "ws-2", "p-2");

        let ovr = SettingsOverrides {
            model: Some("claude-opus-4".into()),
            permission_mode: None,
            effort: None,
        };
        set_workspace_overrides(&db, "ws-2", &ovr).expect("set");

        let got = get_workspace_overrides(&db, "ws-2")
            .expect("get")
            .expect("Some");
        assert_eq!(got.model.as_deref(), Some("claude-opus-4"));
        assert!(got.permission_mode.is_none());
        assert!(got.effort.is_none());
    }

    #[test]
    fn round_trip_all_fields() {
        let (db, _dir) = temp_db();
        seed_workspace(&db, "ws-3", "p-3");

        let ovr = SettingsOverrides {
            model: Some("claude-sonnet".into()),
            permission_mode: Some(PermissionMode::Plan),
            effort: Some(Effort::High),
        };
        set_workspace_overrides(&db, "ws-3", &ovr).expect("set");

        let got = get_workspace_overrides(&db, "ws-3")
            .expect("get")
            .expect("Some");
        assert_eq!(got.model.as_deref(), Some("claude-sonnet"));
        assert_eq!(got.permission_mode, Some(PermissionMode::Plan));
        assert_eq!(got.effort, Some(Effort::High));
    }

    #[test]
    fn camel_case_on_disk() {
        let (db, _dir) = temp_db();
        seed_workspace(&db, "ws-4", "p-4");

        let ovr = SettingsOverrides {
            model: None,
            permission_mode: Some(PermissionMode::AcceptEdits),
            effort: Some(Effort::Max),
        };
        set_workspace_overrides(&db, "ws-4", &ovr).expect("set");

        let raw: String = db
            .conn()
            .query_row(
                "SELECT overrides_json FROM claude_workspace_settings WHERE workspace_id = 'ws-4'",
                [],
                |r| r.get(0),
            )
            .expect("raw");

        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("parse");
        assert_eq!(parsed["permissionMode"], "acceptEdits");
        assert_eq!(parsed["effort"], "max");
        assert!(parsed.get("model").is_none());
    }

    #[test]
    fn upsert_replaces_existing() {
        let (db, _dir) = temp_db();
        seed_workspace(&db, "ws-5", "p-5");

        let first = SettingsOverrides {
            model: Some("old".into()),
            permission_mode: None,
            effort: None,
        };
        set_workspace_overrides(&db, "ws-5", &first).expect("first set");

        let second = SettingsOverrides {
            model: Some("new".into()),
            permission_mode: Some(PermissionMode::BypassPermissions),
            effort: Some(Effort::Low),
        };
        set_workspace_overrides(&db, "ws-5", &second).expect("second set");

        let got = get_workspace_overrides(&db, "ws-5")
            .expect("get")
            .expect("Some");
        assert_eq!(got.model.as_deref(), Some("new"));
        assert_eq!(got.permission_mode, Some(PermissionMode::BypassPermissions));
    }

    #[test]
    fn clear_removes_row() {
        let (db, _dir) = temp_db();
        seed_workspace(&db, "ws-6", "p-6");

        let ovr = SettingsOverrides {
            model: Some("m".into()),
            permission_mode: None,
            effort: None,
        };
        set_workspace_overrides(&db, "ws-6", &ovr).expect("set");
        assert!(get_workspace_overrides(&db, "ws-6").expect("get").is_some());

        clear_workspace_overrides(&db, "ws-6").expect("clear");
        assert!(get_workspace_overrides(&db, "ws-6").expect("get").is_none());
    }

    #[test]
    fn clear_is_noop_when_absent() {
        let (db, _dir) = temp_db();
        seed_workspace(&db, "ws-7", "p-7");
        clear_workspace_overrides(&db, "ws-7").expect("clear noop");
    }
}
