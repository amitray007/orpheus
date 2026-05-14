// Terminal lifecycle commands — wraps ghostty-native mount/hide/resize/destroy/focus.
// Migrated from commands.rs (Phase 2) with names aligned to the preload surface.

use std::collections::HashMap;

use tauri::{Emitter, Manager, Window};
use tokio::sync::oneshot;

use ghostty_native::{MountResult, Rect};

use crate::claude_settings::ClaudeLaunch;

/// Compose the env-var pairs to hand to the spawned `orpheus-claude.sh`.
///
/// Bundles:
/// - Terminal capability env (`TERM`, `TERMINFO`, `COLORTERM`, `TERM_PROGRAM`,
///   `GHOSTTY_RESOURCES_DIR`) so claude's `setupterm("xterm-ghostty")` finds
///   the bundled terminfo entry. Without it claude can't look up cursor /
///   clear / scroll capability sequences and falls back to a dumb mode where
///   animations don't render.
/// - `ORPHEUS_CLAUDE_FLAGS` / `ORPHEUS_CLAUDE_SETTINGS_JSON` (the wrapper reads these)
/// - `ORPHEUS_WORKSPACE_ID` so hooks and the notify shim can correlate events
/// - `ORPHEUS_SOCK` / `ORPHEUS_NOTIFY` so the managed Claude hooks can reach
///   the in-process notify server (drives activity status indicators)
/// - `launch.env` (model gateway flags, perf knobs, etc.)
/// - Claude auth provider env (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_*`, ...)
fn build_launch_env(
    workspace_id: &str,
    launch: &ClaudeLaunch,
    auth_env: HashMap<String, String>,
    sock_path: Option<String>,
    notify_bin: Option<String>,
    terminfo_dir: Option<String>,
    ghostty_resources_dir: Option<String>,
) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = Vec::new();

    // Terminal capabilities — match what Ghostty.app sets so TUI apps treat
    // our surface identically.
    env.push(("TERM".into(), "xterm-ghostty".into()));
    env.push(("COLORTERM".into(), "truecolor".into()));
    env.push(("TERM_PROGRAM".into(), "orpheus".into()));
    env.push((
        "TERM_PROGRAM_VERSION".into(),
        env!("CARGO_PKG_VERSION").to_string(),
    ));
    if let Some(p) = terminfo_dir {
        env.push(("TERMINFO".into(), p));
    }
    if let Some(p) = ghostty_resources_dir {
        env.push(("GHOSTTY_RESOURCES_DIR".into(), p));
    }

    env.push(("ORPHEUS_CLAUDE_FLAGS".into(), launch.flags.clone()));
    env.push((
        "ORPHEUS_CLAUDE_SETTINGS_JSON".into(),
        launch.settings_json.clone(),
    ));
    env.push(("ORPHEUS_WORKSPACE_ID".into(), workspace_id.to_owned()));
    if let Some(p) = sock_path {
        env.push(("ORPHEUS_SOCK".into(), p));
    }
    if let Some(p) = notify_bin {
        env.push(("ORPHEUS_NOTIFY".into(), p));
    }
    for (k, v) in &launch.env {
        env.push((k.clone(), v.clone()));
    }
    for (k, v) in auth_env {
        env.push((k, v));
    }
    env
}

/// Resolve the bundled `orpheus-notify` shim path so Claude hooks can POST
/// activity events back to us via the Unix socket.
fn resolve_notify_bin(window: &Window) -> Option<String> {
    let resource_dir = window.app_handle().path().resource_dir().ok()?;
    let p = resource_dir.join("bin").join("orpheus-notify");
    if !p.exists() {
        eprintln!("[terminal_mount] orpheus-notify missing at {}", p.display());
        return None;
    }
    p.to_str().map(|s| s.to_owned())
}

/// Resolve the bundled terminfo directory (contains the `xterm-ghostty`
/// entry). Setting `TERMINFO` to this path lets `setupterm` / `tparm` find
/// the right capability strings inside the spawned PTY.
fn resolve_terminfo_dir(window: &Window) -> Option<String> {
    let resource_dir = window.app_handle().path().resource_dir().ok()?;
    let p = resource_dir.join("terminfo");
    if !p.is_dir() {
        eprintln!("[terminal_mount] terminfo dir missing at {}", p.display());
        return None;
    }
    p.to_str().map(|s| s.to_owned())
}

/// Resolve the bundled ghostty resources directory (used by some tools that
/// expect `GHOSTTY_RESOURCES_DIR` to find shell-integration scripts, etc.).
fn resolve_ghostty_resources_dir(window: &Window) -> Option<String> {
    let resource_dir = window.app_handle().path().resource_dir().ok()?;
    let p = resource_dir.join("ghostty");
    if !p.is_dir() {
        return None;
    }
    p.to_str().map(|s| s.to_owned())
}

/// Resolve the bundled `orpheus-claude.sh` wrapper script path. In a packaged
/// .app the script lives under `Contents/Resources/`; the Tauri `path()` API
/// returns the right directory in dev and bundled builds.
fn resolve_wrapper_script(window: &Window) -> Option<String> {
    let resource_dir = window.app_handle().path().resource_dir().ok()?;
    let p = resource_dir.join("orpheus-claude.sh");
    if !p.exists() {
        eprintln!("[terminal_mount] orpheus-claude.sh missing at {}", p.display());
        return None;
    }
    p.to_str().map(|s| s.to_owned())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn terminal_mount(
    window: Window,
    workspace_id: String,
    rect: Rect,
    scale_factor: f64,
    cwd: Option<String>,
    command: Option<String>,
) -> Result<MountResult, String> {
    // Compose the Claude launch (flags + settings JSON + env) from layered
    // settings (global → project → workspace) and the persisted session id.
    let (launch_for_env, env_pairs, resolved_command): (
        Option<ClaudeLaunch>,
        Vec<(String, String)>,
        Option<String>,
    ) = {
        let db_state = window.state::<crate::SharedDb>();
        let db_guard = db_state.lock().map_err(|e| e.to_string())?;

        let proj_ovr = crate::claude_project_settings::get_project_overrides_by_workspace(
            &db_guard, &workspace_id,
        )
        .ok()
        .flatten();
        let ws_ovr = crate::claude_workspace_settings::get_workspace_overrides(
            &db_guard, &workspace_id,
        )
        .ok()
        .flatten();
        let session_id = crate::workspaces::get_workspace(&db_guard, &workspace_id)
            .ok()
            .flatten()
            .and_then(|w| w.claude_session_id);

        let launch = crate::claude_settings::compose_claude_launch(
            &db_guard,
            proj_ovr.as_ref(),
            ws_ovr.as_ref(),
            session_id.as_deref(),
        )
        .map_err(|e| format!("compose_claude_launch failed: {e}"))?;

        let auth_env = crate::claude_auth::get_claude_auth_env(&db_guard)
            .map_err(|e| format!("get_claude_auth_env failed: {e}"))?;

        drop(db_guard); // release lock before resolving paths

        let sock_path = crate::orpheus_notify::notify_sock_path()
            .map(|p| p.to_string_lossy().into_owned());
        let notify_bin = resolve_notify_bin(&window);
        let terminfo_dir = resolve_terminfo_dir(&window);
        let ghostty_resources_dir = resolve_ghostty_resources_dir(&window);

        let env_pairs = build_launch_env(
            &workspace_id,
            &launch,
            auth_env,
            sock_path,
            notify_bin,
            terminfo_dir,
            ghostty_resources_dir,
        );
        (Some(launch), env_pairs, command)
    };

    // Default: exec the orpheus-claude.sh wrapper as the surface command.
    // Now that the GhosttyView is left parentless until AFTER ghostty_surface_new
    // and wantsLayer is NOT overridden, libghostty can put the view into
    // layer-hosting mode and IOSurfaceLayer's setSurfaceCallback presents
    // every frame from the renderer thread — animations work on first mount.
    let final_command: Option<String> =
        resolved_command.or_else(|| resolve_wrapper_script(&window));

    let (tx, rx) = oneshot::channel();
    let win = window.clone();
    let wid = workspace_id.clone();
    let env_for_mount = env_pairs;
    let cmd_clone = final_command.clone();
    window
        .run_on_main_thread(move || {
            let res = ghostty_native::mount(
                &win,
                &workspace_id,
                &rect,
                scale_factor,
                cwd.as_deref(),
                cmd_clone.as_deref(),
                None, // initial_input — unused with the command path
                &env_for_mount,
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

    // Stash the launch we just used as the baseline for future dirty checks.
    if let Some(snapshots) = window.try_state::<crate::commands::events::MountSnapshots>() {
        if let (Some(launch), Ok(mut snap)) = (launch_for_env, snapshots.lock()) {
            snap.insert(wid.clone(), launch);
        }
    }

    // Kick off session-id capture in the background — Claude writes a JSONL
    // transcript under ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
    // shortly after the wrapper execs. We persist the id so future mounts
    // can resume the same session via --resume.
    let cwd_for_capture = result.workspace_id.clone();
    let _ = cwd_for_capture; // silence — actual capture below uses wid + cwd
    spawn_session_capture(window.clone(), wid.clone());

    Ok(result)
}

/// Poll `~/.claude/projects/<encoded-cwd>/*.jsonl` for the newest session
/// file and persist its session id to the workspaces table. Bails out after
/// a couple of minutes of no activity.
fn spawn_session_capture(window: Window, workspace_id: String) {
    tauri::async_runtime::spawn(async move {
        // Fetch the cwd for this workspace
        let cwd = {
            let Some(db_state) = window.try_state::<crate::SharedDb>() else { return };
            let Ok(db) = db_state.lock() else { return };
            crate::workspaces::get_workspace(&db, &workspace_id)
                .ok()
                .flatten()
                .map(|w| w.cwd)
        };
        let Some(cwd) = cwd else { return };

        let home = match std::env::var("HOME") {
            Ok(h) => std::path::PathBuf::from(h),
            Err(_) => return,
        };
        let projects_dir = home
            .join(".claude")
            .join("projects")
            .join(encode_cwd(&cwd));

        // Poll up to ~30 seconds for the first session file to appear, then
        // stop. Claude writes the .jsonl within seconds of launch — there's
        // no value in re-checking afterwards, and the per-second filesystem
        // walk + DB lock churn was contending with IPC tokio workers.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;

            let Some(newest_id) = newest_session_id(&projects_dir) else { continue };

            if let Some(db_state) = window.try_state::<crate::SharedDb>() {
                if let Ok(db) = db_state.lock() {
                    if let Err(e) = crate::workspaces::set_workspace_claude_session_id(
                        &db,
                        &workspace_id,
                        Some(&newest_id),
                    ) {
                        eprintln!("[terminal_mount] set claude_session_id failed: {e}");
                    }
                }
            }
            return; // first hit wins — stop polling
        }
    });
}

/// Encode a cwd to Claude's project-folder convention (replace `/` with `-`).
fn encode_cwd(cwd: &str) -> String {
    let mut out = cwd.replace('/', "-");
    if out.starts_with('-') {
        // leave the leading '-' — Claude's convention
    } else {
        out.insert(0, '-');
    }
    out
}

/// Newest `.jsonl` stem (= session id) in `dir`, or None if dir has none.
fn newest_session_id(dir: &std::path::Path) -> Option<String> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut best: Option<(std::time::SystemTime, String)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_owned(),
            None => continue,
        };
        let mtime = entry.metadata().and_then(|m| m.modified()).ok()?;
        match &best {
            Some((t, _)) if *t >= mtime => {}
            _ => best = Some((mtime, stem)),
        }
    }
    best.map(|(_, id)| id)
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
