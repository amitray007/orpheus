// ghostty-native — standalone crate wrapping libghostty for Tauri.
//
// Provides one persistent ghostty_surface_t per workspace_id with
// mount/hide/resize/destroy/set_focus lifecycle.

#[cfg(target_os = "macos")]
mod app;
#[cfg(target_os = "macos")]
mod dispatch;
#[cfg(target_os = "macos")]
mod display_link;
#[cfg(target_os = "macos")]
mod ffi;
#[cfg(target_os = "macos")]
pub mod surface;
#[cfg(target_os = "macos")]
mod view;

/// Store the AppHandle for title/event callbacks from the native layer.
/// Must be called once from lib.rs during app setup (macOS only).
#[cfg(target_os = "macos")]
pub fn set_app_handle(handle: tauri::AppHandle) {
    app::set_app_handle(handle);
}

#[cfg(not(target_os = "macos"))]
pub fn set_app_handle(_handle: tauri::AppHandle) {}

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum GhosttyError {
    #[error("{0}")]
    Msg(String),
}

impl From<String> for GhosttyError {
    fn from(s: String) -> Self { GhosttyError::Msg(s) }
}

impl serde::Serialize for GhosttyError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountResult {
    pub workspace_id: String,
    pub created: bool,
}

/// Mount (or re-attach) a terminal surface for the given workspace_id.
///
/// `command` exec-spawns a process directly. `initial_input` instead boots
/// the default login shell and types the string into it (effectively
/// simulating the user). Use at most one — passing both is a contract
/// violation. `initial_input` is the path Claude wants: it gives claude an
/// interactive zsh as its parent, which keeps libghostty's rendering
/// pipeline awake during spinner animations.
///
/// Returns `created: true` on first mount, `false` on re-attach.
pub fn mount(
    window: &tauri::Window,
    workspace_id: &str,
    rect: &Rect,
    scale: f64,
    cwd: Option<&str>,
    command: Option<&str>,
    initial_input: Option<&str>,
    env: &[(String, String)],
) -> Result<MountResult, GhosttyError> {
    #[cfg(target_os = "macos")]
    {
        let created = surface::mount(
            window,
            workspace_id,
            rect.x, rect.y, rect.w, rect.h,
            scale,
            cwd,
            command,
            initial_input,
            env,
        )
        .map_err(GhosttyError::from)?;
        Ok(MountResult { workspace_id: workspace_id.to_owned(), created })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, workspace_id, rect, scale, cwd, command, initial_input, env);
        Err(GhosttyError::Msg("macOS only".into()))
    }
}

/// Hide the surface for workspace_id (keeps surface + shell alive).
pub fn hide(workspace_id: &str) -> Result<(), GhosttyError> {
    #[cfg(target_os = "macos")]
    { surface::hide(workspace_id).map_err(GhosttyError::from) }
    #[cfg(not(target_os = "macos"))]
    { let _ = workspace_id; Err(GhosttyError::Msg("macOS only".into())) }
}

/// Resize the terminal surface.
pub fn resize(workspace_id: &str, rect: &Rect, scale: f64) -> Result<(), GhosttyError> {
    #[cfg(target_os = "macos")]
    { surface::resize(workspace_id, rect.x, rect.y, rect.w, rect.h, scale).map_err(GhosttyError::from) }
    #[cfg(not(target_os = "macos"))]
    { let _ = (workspace_id, rect, scale); Err(GhosttyError::Msg("macOS only".into())) }
}

/// Destroy the surface for workspace_id (full teardown; workspace is archived).
pub fn destroy(workspace_id: &str) -> Result<(), GhosttyError> {
    #[cfg(target_os = "macos")]
    { surface::destroy(workspace_id).map_err(GhosttyError::from) }
    #[cfg(not(target_os = "macos"))]
    { let _ = workspace_id; Err(GhosttyError::Msg("macOS only".into())) }
}

/// Set keyboard focus for the surface.
pub fn set_focus(workspace_id: &str, focused: bool) -> Result<(), GhosttyError> {
    #[cfg(target_os = "macos")]
    { surface::set_focus(workspace_id, focused).map_err(GhosttyError::from) }
    #[cfg(not(target_os = "macos"))]
    { let _ = (workspace_id, focused); Err(GhosttyError::Msg("macOS only".into())) }
}
