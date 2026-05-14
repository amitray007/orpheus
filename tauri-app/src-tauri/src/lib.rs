mod commands;

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
