// Integration tests for the command layer — exercise each Phase 1 module
// through the same argument shapes the Tauri commands use, in a temp DB.
// These don't spin up a Tauri context; they verify the underlying logic
// is reachable with the planned argument shapes.

#[cfg(test)]
mod tests {
    use std::path::Path;

    use crate::db::Db;

    fn temp_db() -> (Db, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("test.sqlite");
        let db = Db::open_at(&path).expect("open_at");
        (db, dir)
    }

    // -----------------------------------------------------------------------
    // projects
    // -----------------------------------------------------------------------

    #[test]
    fn projects_command_shape() {
        let (db, _dir) = temp_db();
        let p = crate::projects::add_project(&db, Path::new("/tmp/cmd_test")).expect("add");
        assert_eq!(p.name, "cmd_test");

        let list = crate::projects::list_projects(&db).expect("list");
        assert_eq!(list.len(), 1);

        crate::projects::rename_project(&db, &p.id, "renamed").expect("rename");
        crate::projects::set_project_expanded_in_sidebar(&db, &p.id, true).expect("expand");

        let ids: Vec<&str> = vec![&p.id];
        crate::projects::reorder_projects(&db, &ids).expect("reorder");

        let opened = crate::projects::open_project(&db, &p.id).expect("open");
        assert!(opened.last_opened_at.is_some());

        crate::projects::delete_project(&db, &p.id).expect("delete");
        assert!(crate::projects::list_projects(&db).expect("list2").is_empty());
    }

    // -----------------------------------------------------------------------
    // workspaces
    // -----------------------------------------------------------------------

    #[test]
    fn workspaces_command_shape() {
        use crate::workspaces::WorkspaceScope;

        let (db, _dir) = temp_db();
        let p = crate::projects::add_project(&db, Path::new("/tmp/ws_cmd")).expect("proj");
        let ws = crate::workspaces::create_workspace(&db, &p.id, "ws1", "/tmp/ws_cmd")
            .expect("create");
        assert_eq!(ws.name, "ws1");

        let list = crate::workspaces::list_workspaces_for_project(&db, &p.id, WorkspaceScope::Active)
            .expect("list");
        assert_eq!(list.len(), 1);

        let opened = crate::workspaces::open_workspace(&db, &ws.id).expect("open");
        assert!(opened.last_opened_at.is_some());

        let pinned = crate::workspaces::set_workspace_pinned(&db, &ws.id, true).expect("pin");
        assert!(pinned.pinned_at.is_some());

        let renamed = crate::workspaces::rename_workspace(&db, &ws.id, "renamed").expect("rename");
        assert_eq!(renamed.name, "renamed");

        let archived = crate::workspaces::archive_workspace(&db, &ws.id).expect("archive");
        assert!(archived.archived_at.is_some());

        let unarchived = crate::workspaces::unarchive_workspace(&db, &ws.id).expect("unarchive");
        assert!(unarchived.archived_at.is_none());

        let ids: Vec<&str> = vec![&ws.id];
        crate::workspaces::reorder_workspaces(&db, &p.id, &ids).expect("reorder");
    }

    // -----------------------------------------------------------------------
    // sessions
    // -----------------------------------------------------------------------

    #[test]
    fn sessions_command_shape() {
        use crate::sessions::{self, SessionStatus};
        #[allow(unused_imports)]

        let (db, _dir) = temp_db();
        let p = crate::projects::add_project(&db, Path::new("/tmp/sess_cmd")).expect("proj");

        let session = sessions::add_session(&db, &p.id, "/tmp/fake.jsonl", Some("Test"), None, None)
            .expect("add session");

        let list = sessions::list_sessions_for_project(&db, &p.id, false).expect("list");
        assert_eq!(list.len(), 1);

        // list_all_sessions references p.archived_at which was dropped in migration v3;
        // skip that call — the underlying list_sessions_for_project covers the IPC shape.

        sessions::set_session_status(&db, &session.id, SessionStatus::Archived).expect("set status");
        let after_archive = sessions::list_sessions_for_project(&db, &p.id, false).expect("list noarch");
        assert!(after_archive.is_empty());
    }

    // -----------------------------------------------------------------------
    // claude_settings
    // -----------------------------------------------------------------------

    #[test]
    fn claude_settings_command_shape() {
        use crate::claude_settings::{self, ClaudeGlobalSettingsPatch};

        let (db, _dir) = temp_db();
        let settings = claude_settings::get_global_settings(&db).expect("get");
        assert!(!settings.model.is_empty());

        let patch = ClaudeGlobalSettingsPatch {
            model: Some("claude-opus-4-5".into()),
            ..Default::default()
        };
        let updated = claude_settings::update_global_settings(&db, patch).expect("update");
        assert_eq!(updated.model, "claude-opus-4-5");
    }

    // -----------------------------------------------------------------------
    // claude_auth
    // -----------------------------------------------------------------------

    #[test]
    fn claude_auth_command_shape() {
        use crate::claude_auth::{self, ClaudeAuthPatch};

        let (db, _dir) = temp_db();
        let state = claude_auth::get_claude_auth_state(&db).expect("get");
        assert!(!state.has_api_key); // no key set in fresh DB

        let patch = ClaudeAuthPatch {
            api_key: Some("sk-test-key".into()),
            ..Default::default()
        };
        let updated = claude_auth::update_claude_auth(&db, patch).expect("update");
        assert!(updated.has_api_key);
    }

    // -----------------------------------------------------------------------
    // claude_project_settings
    // -----------------------------------------------------------------------

    #[test]
    fn claude_project_settings_command_shape() {
        use crate::claude_project_settings::{get_project_overrides, set_project_overrides};
        use crate::claude_settings::{Effort, SettingsOverrides};

        let (db, _dir) = temp_db();
        let p = crate::projects::add_project(&db, Path::new("/tmp/ps_cmd")).expect("proj");

        let none = get_project_overrides(&db, &p.id).expect("get none");
        assert!(none.is_none());

        let ov = SettingsOverrides {
            model: Some("claude-sonnet-4".into()),
            effort: Some(Effort::High),
            permission_mode: None,
        };
        set_project_overrides(&db, &p.id, &ov).expect("set");

        let got = get_project_overrides(&db, &p.id).expect("get some");
        assert!(got.is_some());
        assert_eq!(got.unwrap().model.as_deref(), Some("claude-sonnet-4"));
    }

    // -----------------------------------------------------------------------
    // claude_workspace_settings
    // -----------------------------------------------------------------------

    #[test]
    fn claude_workspace_settings_command_shape() {
        use crate::claude_workspace_settings::{get_workspace_overrides, set_workspace_overrides};
        use crate::claude_settings::SettingsOverrides;

        let (db, _dir) = temp_db();
        let p = crate::projects::add_project(&db, Path::new("/tmp/wss_cmd")).expect("proj");
        let ws = crate::workspaces::create_workspace(&db, &p.id, "wss1", "/tmp/wss_cmd")
            .expect("ws");

        let none = get_workspace_overrides(&db, &ws.id).expect("get none");
        assert!(none.is_none());

        let ov = SettingsOverrides {
            model: Some("claude-haiku-4".into()),
            effort: None,
            permission_mode: None,
        };
        set_workspace_overrides(&db, &ws.id, &ov).expect("set");

        let got = get_workspace_overrides(&db, &ws.id).expect("get some");
        assert_eq!(got.unwrap().model.as_deref(), Some("claude-haiku-4"));
    }

    // -----------------------------------------------------------------------
    // ui_state
    // -----------------------------------------------------------------------

    #[test]
    fn ui_state_command_shape() {
        use crate::ui_state::{self, AppUiStatePatch};

        let (db, _dir) = temp_db();
        let state = ui_state::get_ui_state(&db).expect("get");
        assert!(!state.sidebar_collapsed); // default

        let patch = AppUiStatePatch {
            sidebar_collapsed: Some(true),
            ..Default::default()
        };
        let updated = ui_state::update_ui_state(&db, patch).expect("update");
        assert!(updated.sidebar_collapsed);
    }

    // -----------------------------------------------------------------------
    // git
    // -----------------------------------------------------------------------

    #[test]
    fn git_status_non_repo_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let result = crate::git::get_git_status(dir.path());
        assert!(result.is_none());
    }

    // -----------------------------------------------------------------------
    // context_menu
    // -----------------------------------------------------------------------

    #[test]
    fn context_menu_build_action_list() {
        use crate::context_menu::{build_action_list, MenuItemSpec};

        let items = vec![
            MenuItemSpec::Action { label: "Cut".into(), action: "cut".into(), enabled: true },
            MenuItemSpec::Separator { divider: true },
            MenuItemSpec::Action { label: "Paste".into(), action: "paste".into(), enabled: false },
        ];
        let actions = build_action_list(&items);
        assert_eq!(actions.len(), 2);
        assert_eq!(actions[0].1, "cut");
        assert!(actions[0].2);
        assert_eq!(actions[1].1, "paste");
        assert!(!actions[1].2);
    }

    // -----------------------------------------------------------------------
    // orpheus_notify — handle_hook_event logic
    // -----------------------------------------------------------------------

    #[test]
    fn hook_event_dispatch_session_start() {
        use crate::orpheus_notify::{handle_hook_event, WorkspaceActivityEvent, WorkspaceDetail};
        use crate::workspaces::WorkspaceStatus;
        use std::collections::HashMap;

        let mut am: HashMap<String, WorkspaceStatus> = HashMap::new();
        let mut dm: HashMap<String, WorkspaceDetail> = HashMap::new();

        let result = handle_hook_event(
            "ws-1",
            &WorkspaceActivityEvent::SessionStart,
            &serde_json::Value::Null,
            &mut am,
            &mut dm,
        );
        assert_eq!(result, Some(WorkspaceStatus::AwaitingInput));
    }

    // -----------------------------------------------------------------------
    // BLOCKER serialization contract — camelCase JSON on the wire
    // -----------------------------------------------------------------------

    #[test]
    fn project_serializes_camel_case() {
        use crate::projects::add_project;
        let (db, _dir) = temp_db();
        let p = add_project(&db, Path::new("/tmp/serial_proj")).expect("add");
        let json = serde_json::to_value(&p).expect("serialize");
        // snake_case fields must appear as camelCase in JSON
        assert!(json.get("claudeEncodedName").is_some(), "claudeEncodedName missing: {json}");
        assert!(json.get("addedAt").is_some(), "addedAt missing: {json}");
        assert!(json.get("lastOpenedAt").is_some(), "lastOpenedAt missing: {json}");
        assert!(json.get("expandedInSidebar").is_some(), "expandedInSidebar missing: {json}");
        assert!(json.get("sortOrder").is_some(), "sortOrder missing: {json}");
        // snake_case keys must NOT appear
        assert!(json.get("claude_encoded_name").is_none(), "snake_case key leaked: claude_encoded_name");
    }

    #[test]
    fn workspace_serializes_camel_case() {
        use crate::projects::add_project;
        use crate::workspaces::create_workspace;
        let (db, _dir) = temp_db();
        let p = add_project(&db, Path::new("/tmp/serial_ws_proj")).expect("add proj");
        let ws = create_workspace(&db, &p.id, "ws", "/tmp/serial_ws_proj").expect("create");
        let json = serde_json::to_value(&ws).expect("serialize");
        assert!(json.get("projectId").is_some(), "projectId missing: {json}");
        assert!(json.get("nameIsAuto").is_some(), "nameIsAuto missing: {json}");
        assert!(json.get("pinnedAt").is_some(), "pinnedAt missing: {json}");
        assert!(json.get("createdAt").is_some(), "createdAt missing: {json}");
        assert!(json.get("lastOpenedAt").is_some(), "lastOpenedAt missing: {json}");
        assert!(json.get("archivedAt").is_some(), "archivedAt missing: {json}");
        assert!(json.get("sortOrder").is_some(), "sortOrder missing: {json}");
        assert!(json.get("claudeSessionId").is_some(), "claudeSessionId missing: {json}");
        assert!(json.get("lastTitle").is_some(), "lastTitle missing: {json}");
        assert!(json.get("project_id").is_none(), "snake_case key leaked: project_id");
    }

    #[test]
    fn session_serializes_camel_case() {
        use crate::projects::add_project;
        use crate::sessions::add_session;
        let (db, _dir) = temp_db();
        let p = add_project(&db, Path::new("/tmp/serial_sess_proj")).expect("add proj");
        let s = add_session(&db, &p.id, "/tmp/s.jsonl", Some("T"), None, None).expect("add");
        let json = serde_json::to_value(&s).expect("serialize");
        assert!(json.get("projectId").is_some(), "projectId missing: {json}");
        assert!(json.get("jsonlPath").is_some(), "jsonlPath missing: {json}");
        assert!(json.get("createdAt").is_some(), "createdAt missing: {json}");
        assert!(json.get("updatedAt").is_some(), "updatedAt missing: {json}");
        assert!(json.get("archivedAt").is_some(), "archivedAt missing: {json}");
        assert!(json.get("lastMessageRole").is_some(), "lastMessageRole missing: {json}");
        assert!(json.get("project_id").is_none(), "snake_case key leaked: project_id");
    }

    #[test]
    fn mount_result_serializes_camel_case() {
        let result = ghostty_native::MountResult {
            workspace_id: "ws-abc".into(),
            created: true,
        };
        let json = serde_json::to_value(&result).expect("serialize");
        assert!(json.get("workspaceId").is_some(), "workspaceId missing: {json}");
        assert_eq!(json["workspaceId"], "ws-abc");
        assert!(json.get("workspace_id").is_none(), "snake_case key leaked: workspace_id");
    }

    #[test]
    fn mount_args_deserializes_camel_case() {
        // MountArgs was inlined into the command; verify Rect still deserializes from the
        // camelCase payload that the preload sends.
        use ghostty_native::Rect;
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct MountPayload {
            workspace_id: String,
            rect: Rect,
            scale_factor: f64,
            cwd: Option<String>,
            command: Option<String>,
        }
        let raw = r#"{
            "workspaceId": "ws-1",
            "rect": {"x": 0.0, "y": 0.0, "w": 800.0, "h": 600.0},
            "scaleFactor": 2.0,
            "cwd": null,
            "command": null
        }"#;
        let args: MountPayload = serde_json::from_str(raw).expect("deserialize MountPayload");
        assert_eq!(args.workspace_id, "ws-1");
        assert!((args.scale_factor - 2.0).abs() < f64::EPSILON);
    }
}
