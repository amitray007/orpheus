use serde::Deserialize;
use tauri::Window;

#[derive(Debug, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub scale: f64,
}

#[tauri::command]
pub fn spawn_terminal(window: Window, rect: Rect) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        crate::ghostty::spawn(&window, rect.x, rect.y, rect.w, rect.h, rect.scale)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, rect);
        Err("macOS only".into())
    }
}

#[tauri::command]
pub fn resize_terminal(rect: Rect) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        crate::ghostty::resize(rect.x, rect.y, rect.w, rect.h, rect.scale)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = rect;
        Err("macOS only".into())
    }
}
