mod commands;
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

#[cfg(target_os = "macos")]
mod ghostty;

use std::sync::{Arc, Mutex};

use tauri::Manager;

use crate::db::Db;

pub type SharedDb = Arc<Mutex<Db>>;

// Fallback if the DB row is missing or the column is 0.
const SOCKET_WATCHDOG_FALLBACK_SEC: u64 = 120;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let db = Db::open()?;

            let watchdog_sec = ui_state::get_ui_state(&db)
                .map(|s| s.in_progress_watchdog_sec as u64)
                .unwrap_or(SOCKET_WATCHDOG_FALLBACK_SEC);

            let shared: SharedDb = Arc::new(Mutex::new(db));
            app.manage(shared.clone());

            if let Err(e) = orpheus_notify::ensure_managed_hooks() {
                log::warn!("ensure_managed_hooks failed: {e}");
            }

            let socket_handle =
                orpheus_notify::start_socket_server(shared, watchdog_sec);
            app.manage(SocketGuard(Mutex::new(Some(socket_handle))));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::spawn_terminal,
            commands::resize_terminal,
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
