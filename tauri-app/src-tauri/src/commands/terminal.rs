// Terminal lifecycle commands — wraps ghostty-native mount/hide/resize/destroy/focus.
// Migrated from commands.rs (Phase 2) with names aligned to the preload surface.

use tauri::{Emitter, Manager, Window};
use tokio::sync::oneshot;

use ghostty_native::{MountResult, Rect};

#[tauri::command(rename_all = "camelCase")]
pub async fn terminal_mount(
    window: Window,
    workspace_id: String,
    rect: Rect,
    scale_factor: f64,
    cwd: Option<String>,
    command: Option<String>,
) -> Result<MountResult, String> {
    let (tx, rx) = oneshot::channel();
    let win = window.clone();
    let wid = workspace_id.clone();
    window
        .run_on_main_thread(move || {
            let res = ghostty_native::mount(
                &win,
                &workspace_id,
                &rect,
                scale_factor,
                cwd.as_deref(),
                command.as_deref(),
            )
            .map_err(|e| e.to_string());
            let _ = tx.send(res);
        })
        .map_err(|e| e.to_string())?;
    let result = rx.await.map_err(|e| e.to_string())??;

    // Clear dirty state on (re-)mount — workspace starts clean.
    if let Some(dirty_set) = window.try_state::<crate::commands::events::DirtySet>() {
        if let Ok(mut s) = dirty_set.lock() {
            s.remove(&wid);
        }
    }
    let _ = window.emit(
        "workspace:dirtyChanged",
        serde_json::json!({ "workspaceId": wid, "dirty": false }),
    );

    // Capture the current ClaudeLaunch as the baseline dirty snapshot for this workspace.
    if let Some(db_state) = window.try_state::<crate::SharedDb>() {
        if let Some(snapshots) = window.try_state::<crate::commands::events::MountSnapshots>() {
            if let Ok(db) = db_state.lock() {
                let proj_ovr = crate::claude_project_settings::get_project_overrides_by_workspace(
                    &db, &wid,
                ).ok().flatten();
                let ws_ovr = crate::claude_workspace_settings::get_workspace_overrides(
                    &db, &wid,
                ).ok().flatten();
                if let Ok(launch) = crate::claude_settings::compose_claude_launch(
                    &db,
                    proj_ovr.as_ref(),
                    ws_ovr.as_ref(),
                    None,
                ) {
                    if let Ok(mut snap) = snapshots.lock() {
                        snap.insert(wid.clone(), launch);
                    }
                }
            }
        }
    }

    Ok(result)
}

#[tauri::command(rename_all = "camelCase")]
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

#[tauri::command(rename_all = "camelCase")]
pub async fn terminal_resize(
    window: Window,
    workspace_id: String,
    rect: Rect,
    scale_factor: f64,
) -> Result<(), String> {
    let (tx, rx) = oneshot::channel();
    window
        .run_on_main_thread(move || {
            let res = ghostty_native::resize(&workspace_id, &rect, scale_factor)
                .map_err(|e| e.to_string());
            let _ = tx.send(res);
        })
        .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
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
    // Remove mount snapshot so stale dirty checks don't fire after destroy.
    if let Some(snapshots) = window.try_state::<crate::commands::events::MountSnapshots>() {
        if let Ok(mut snap) = snapshots.lock() {
            snap.remove(&wid);
        }
    }
    let _ = window.emit(
        "workspace:titleChanged",
        serde_json::json!({ "workspaceId": wid, "title": serde_json::Value::Null }),
    );

    result
}

#[tauri::command(rename_all = "camelCase")]
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
