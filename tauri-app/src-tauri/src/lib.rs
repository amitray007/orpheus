mod commands;
pub mod claude_agents;
pub mod claude_auth;
pub mod context_menu;
pub mod git;
pub mod os_notifications;
pub mod claude_hooks;
pub mod claude_project_settings;
pub mod claude_settings;
pub mod claude_workspace_settings;
pub mod db;
pub mod projects;
pub mod sessions;
pub mod workspaces;

#[cfg(target_os = "macos")]
mod ghostty;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            commands::spawn_terminal,
            commands::resize_terminal,
        ])
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}
