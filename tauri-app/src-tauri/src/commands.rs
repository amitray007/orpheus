use serde::Deserialize;
use tauri::Window;
use tokio::sync::oneshot;

use ghostty_native::{MountResult, Rect};

#[derive(Debug, Deserialize)]
pub struct MountArgs {
    pub workspace_id: String,
    pub rect: Rect,
    pub scale: f64,
    pub cwd: Option<String>,
    pub command: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ResizeArgs {
    pub workspace_id: String,
    pub rect: Rect,
    pub scale: f64,
}

#[tauri::command]
pub async fn mount_terminal(window: Window, args: MountArgs) -> Result<MountResult, String> {
    let (tx, rx) = oneshot::channel();
    let win = window.clone();
    window
        .run_on_main_thread(move || {
            let res = ghostty_native::mount(
                &win,
                &args.workspace_id,
                &args.rect,
                args.scale,
                args.cwd.as_deref(),
                args.command.as_deref(),
            )
            .map_err(|e| e.to_string());
            let _ = tx.send(res);
        })
        .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn hide_terminal(window: Window, workspace_id: String) -> Result<(), String> {
    let (tx, rx) = oneshot::channel();
    window
        .run_on_main_thread(move || {
            let res = ghostty_native::hide(&workspace_id).map_err(|e| e.to_string());
            let _ = tx.send(res);
        })
        .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn resize_terminal(window: Window, args: ResizeArgs) -> Result<(), String> {
    let (tx, rx) = oneshot::channel();
    window
        .run_on_main_thread(move || {
            let res = ghostty_native::resize(&args.workspace_id, &args.rect, args.scale)
                .map_err(|e| e.to_string());
            let _ = tx.send(res);
        })
        .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn destroy_terminal(window: Window, workspace_id: String) -> Result<(), String> {
    let (tx, rx) = oneshot::channel();
    window
        .run_on_main_thread(move || {
            let res = ghostty_native::destroy(&workspace_id).map_err(|e| e.to_string());
            let _ = tx.send(res);
        })
        .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn set_terminal_focus(
    window: Window,
    workspace_id: String,
    focused: bool,
) -> Result<(), String> {
    let (tx, rx) = oneshot::channel();
    window
        .run_on_main_thread(move || {
            let res =
                ghostty_native::set_focus(&workspace_id, focused).map_err(|e| e.to_string());
            let _ = tx.send(res);
        })
        .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?
}
