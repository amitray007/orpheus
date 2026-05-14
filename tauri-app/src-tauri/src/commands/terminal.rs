// Terminal lifecycle commands — wraps ghostty-native mount/hide/resize/destroy/focus.
// Migrated from commands.rs (Phase 2) with names aligned to the preload surface.

use serde::Deserialize;
use tauri::{Emitter, Manager, Window};
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
pub async fn terminal_mount(window: Window, args: MountArgs) -> Result<MountResult, String> {
    let (tx, rx) = oneshot::channel();
    let win = window.clone();
    let workspace_id = args.workspace_id.clone();
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
    let result = rx.await.map_err(|e| e.to_string())??;

    // Clear dirty state on (re-)mount — workspace starts clean.
    if let Some(dirty_set) = window.try_state::<crate::commands::events::DirtySet>() {
        if let Ok(mut s) = dirty_set.lock() {
            s.remove(&workspace_id);
        }
    }
    let _ = window.emit(
        "workspace:dirtyChanged",
        serde_json::json!({ "workspaceId": workspace_id, "dirty": false }),
    );

    Ok(result)
}

#[tauri::command]
pub async fn terminal_hide(window: Window, workspace_id: String) -> Result<(), String> {
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
pub async fn terminal_resize(window: Window, args: ResizeArgs) -> Result<(), String> {
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
pub async fn terminal_destroy(window: Window, workspace_id: String) -> Result<(), String> {
    let (tx, rx) = oneshot::channel();
    let wid = workspace_id.clone();
    window
        .run_on_main_thread(move || {
            let res = ghostty_native::destroy(&workspace_id).map_err(|e| e.to_string());
            let _ = tx.send(res);
        })
        .map_err(|e| e.to_string())?;
    let result = rx.await.map_err(|e| e.to_string())?;

    // On destroy: clear dirty flag and broadcast title null (matches Electron behavior).
    if let Some(dirty_set) = window.try_state::<crate::commands::events::DirtySet>() {
        let was_dirty = dirty_set.lock().map(|mut s| s.remove(&wid)).unwrap_or(false);
        if was_dirty {
            let _ = window.emit(
                "workspace:dirtyChanged",
                serde_json::json!({ "workspaceId": wid, "dirty": false }),
            );
        }
    }
    let _ = window.emit(
        "workspace:titleChanged",
        serde_json::json!({ "workspaceId": wid, "title": serde_json::Value::Null }),
    );

    result
}

#[tauri::command]
pub async fn terminal_set_focus(
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
