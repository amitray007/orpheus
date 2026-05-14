pub mod commands;
pub mod claude_agents;
pub mod claude_auth;
pub mod context_menu;
pub mod git;
pub mod os_notifications;
pub mod ui_state;
pub mod mcp;
pub mod orpheus_notify;
pub mod claude_hooks;
pub mod claude_project_settings;
pub mod claude_settings;
pub mod claude_workspace_settings;
pub mod db;
pub mod projects;
pub mod sessions;
pub mod util;
pub mod workspaces;

use std::sync::{Arc, Mutex};

use tauri::{Listener, Manager};

use crate::db::Db;
use crate::os_notifications::{AttentionRetryState, CurrentlyViewed, SharedCurrentlyViewed, SharedRetryState};

pub type SharedDb = Arc<Mutex<Db>>;

const SOCKET_WATCHDOG_FALLBACK_SEC: u64 = 120;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let db = Db::open()?;

            let watchdog_sec = ui_state::get_ui_state(&db)
                .map(|s| s.in_progress_watchdog_sec as u64)
                .unwrap_or(SOCKET_WATCHDOG_FALLBACK_SEC);

            let shared: SharedDb = Arc::new(Mutex::new(db));
            app.manage(shared.clone());

            // Managed state for in-memory title and dirty tracking.
            app.manage(commands::events::new_title_map());
            app.manage(commands::events::new_dirty_set());

            // Managed state for notification retry cancellation and focus suppression.
            let retry_state: SharedRetryState = Arc::new(Mutex::new(AttentionRetryState::new()));
            app.manage(retry_state);
            let currently_viewed: SharedCurrentlyViewed = Arc::new(Mutex::new(CurrentlyViewed::default()));
            app.manage(currently_viewed);

            if let Err(e) = orpheus_notify::ensure_managed_hooks() {
                log::warn!("ensure_managed_hooks failed: {e}");
            }

            // Wire the AppHandle into ghostty-native so the C action_cb can
            // emit workspace:titleChanged events when the terminal sets an OSC title.
            ghostty_native::set_app_handle(app.handle().clone());

            // Keep the TitleMap in sync when workspace:titleChanged events fire.
            {
                let title_map = app.state::<commands::events::TitleMap>().inner().clone();
                app.listen("workspace:titleChanged", move |ev| {
                    if let Ok(payload) = serde_json::from_str::<serde_json::Value>(ev.payload()) {
                        let workspace_id = payload.get("workspaceId").and_then(|v| v.as_str()).map(str::to_owned);
                        let title = payload.get("title").and_then(|v| v.as_str()).map(str::to_owned);
                        if let Some(wid) = workspace_id {
                            if let Ok(mut m) = title_map.lock() {
                                match title {
                                    Some(t) => { m.insert(wid, t); }
                                    None => { m.remove(&wid); }
                                }
                            }
                        }
                    }
                });
            }

            let socket_handle =
                orpheus_notify::start_socket_server(shared, watchdog_sec, app.handle().clone());
            app.manage(SocketGuard(Mutex::new(Some(socket_handle))));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // app
            commands::app::app_get_version,
            // window
            commands::window::window_open_dev_tools,
            commands::window::window_reload,
            // terminal (Phase 2 commands — renamed for preload alignment)
            commands::terminal::terminal_mount,
            commands::terminal::terminal_hide,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_destroy,
            commands::terminal::terminal_set_focus,
            // config
            commands::config::config_open_folder,
            // doctor
            commands::doctor::doctor_check,
            // projects
            commands::projects::projects_list,
            commands::projects::projects_add,
            commands::projects::projects_pick_and_add,
            commands::projects::projects_open,
            commands::projects::projects_remove,
            commands::projects::projects_rename,
            commands::projects::projects_set_expanded_in_sidebar,
            commands::projects::projects_reorder,
            // workspaces
            commands::workspaces::workspaces_list_for_project,
            commands::workspaces::workspaces_create,
            commands::workspaces::workspaces_open,
            commands::workspaces::workspaces_set_pinned,
            commands::workspaces::workspaces_archive,
            commands::workspaces::workspaces_unarchive,
            commands::workspaces::workspaces_rename,
            commands::workspaces::workspaces_reorder,
            commands::workspaces::workspace_is_dirty,
            commands::workspaces::workspace_get_title,
            commands::workspaces::workspace_reset_activity,
            commands::workspaces::workspace_set_currently_viewed,
            commands::workspaces::pins_list_all,
            // sessions
            commands::sessions::sessions_list_for_project,
            commands::sessions::sessions_list_all,
            commands::sessions::sessions_set_status,
            // claude settings
            commands::claude_settings::claude_settings_get,
            commands::claude_settings::claude_settings_update,
            // claude auth
            commands::claude_auth::claude_auth_get,
            commands::claude_auth::claude_auth_update,
            commands::claude_auth::claude_auth_test_connection,
            // claude project settings
            commands::claude_project_settings::claude_project_settings_get,
            commands::claude_project_settings::claude_project_settings_update,
            // claude workspace settings
            commands::claude_workspace_settings::claude_workspace_settings_get,
            commands::claude_workspace_settings::claude_workspace_settings_update,
            // claude hooks
            commands::claude_hooks::claude_hooks_list,
            commands::claude_hooks::claude_hooks_open_file,
            commands::claude_hooks::claude_hooks_add,
            commands::claude_hooks::claude_hooks_update,
            commands::claude_hooks::claude_hooks_delete,
            // claude agents
            commands::claude_agents::claude_agents_list_slash_commands,
            commands::claude_agents::claude_agents_list_subagents,
            commands::claude_agents::claude_agents_add_slash_command,
            commands::claude_agents::claude_agents_update_slash_command,
            commands::claude_agents::claude_agents_delete_slash_command,
            commands::claude_agents::claude_agents_add_subagent,
            commands::claude_agents::claude_agents_update_subagent,
            commands::claude_agents::claude_agents_delete_subagent,
            // git
            commands::git::git_status,
            // mcp
            commands::mcp::mcp_list_servers,
            commands::mcp::mcp_add,
            commands::mcp::mcp_update,
            commands::mcp::mcp_delete,
            // context menu
            commands::context_menu::context_menu_show,
            // os notifications
            commands::os_notifications::notifications_test,
            // ui state
            commands::ui_state::ui_state_get,
            commands::ui_state::ui_state_update,
        ])
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}

struct SocketGuard(Mutex<Option<tokio::task::JoinHandle<()>>>);

impl Drop for SocketGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(h) = guard.take() {
                h.abort();
            }
        }
    }
}
