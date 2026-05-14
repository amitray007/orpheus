// window:* commands — dev tools and reload.

use tauri::WebviewWindow;

#[tauri::command]
pub fn window_open_dev_tools(window: WebviewWindow) {
    #[cfg(debug_assertions)]
    window.open_devtools();
    #[cfg(not(debug_assertions))]
    let _ = window; // no-op in release
}

#[tauri::command]
pub fn window_reload(window: WebviewWindow) -> Result<(), String> {
    // Reload by evaluating location.reload() in the webview.
    window
        .eval("location.reload()")
        .map_err(|e| e.to_string())
}
