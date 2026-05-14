// Global ghostty_app_t — initialised exactly once on first mount.

use once_cell::sync::OnceCell;
use std::ffi::CStr;
use std::sync::Mutex;

use tauri::Emitter;

use crate::dispatch::{dispatch_async_f, main_queue};
use crate::ffi::*;

pub struct GlobalApp {
    pub app: ghostty_app_t,
}

// ghostty_app_t is an opaque pointer; serialised by the Mutex.
unsafe impl Send for GlobalApp {}
unsafe impl Sync for GlobalApp {}

pub static GLOBAL: OnceCell<Mutex<GlobalApp>> = OnceCell::new();

/// AppHandle stored so the C callbacks can emit Tauri events.
pub static APP_HANDLE: OnceCell<tauri::AppHandle> = OnceCell::new();

/// Store the AppHandle for use in C callbacks. Call once from lib.rs setup.
pub fn set_app_handle(handle: tauri::AppHandle) {
    let _ = APP_HANDLE.set(handle);
}

unsafe extern "C" fn wakeup_cb(_userdata: *mut std::ffi::c_void) {
    unsafe { dispatch_async_f(main_queue(), std::ptr::null_mut(), tick_trampoline) };
}

extern "C" fn tick_trampoline(_ctx: *mut std::ffi::c_void) {
    if let Some(lock) = GLOBAL.get() {
        if let Ok(g) = lock.lock() {
            unsafe { ghostty_app_tick(g.app) };
        }
    }
}

unsafe extern "C" fn action_cb(
    _app: ghostty_app_t,
    target: ghostty_target_s,
    action: ghostty_action_s,
) -> bool {
    use crate::ffi::{
        ghostty_action_tag_e_GHOSTTY_ACTION_SET_TITLE as ACTION_SET_TITLE,
        ghostty_target_tag_e_GHOSTTY_TARGET_SURFACE as TARGET_SURFACE,
    };

    if action.tag == ACTION_SET_TITLE
        && target.tag == TARGET_SURFACE
    {
        let surface_ptr = unsafe { target.target.surface };
        // Map surface pointer back to workspace_id via SURFACES.
        let workspace_id = {
            let map = crate::surface::SURFACES.lock().unwrap();
            map.iter()
                .find(|(_, e)| e.surface == surface_ptr)
                .map(|(k, _)| k.clone())
        };

        if let Some(workspace_id) = workspace_id {
            let raw_title = unsafe {
                let ptr = action.action.set_title.title;
                if ptr.is_null() { None }
                else { CStr::from_ptr(ptr).to_str().ok().map(|s| s.to_owned()) }
            };

            // Strip leading spinner glyphs (same logic as Electron index.ts).
            let cleaned = raw_title.as_deref().map(|t| {
                let stripped = t.trim_start_matches(|c: char| !c.is_alphanumeric() && !c.is_whitespace());
                stripped.trim().to_owned()
            }).filter(|s| !s.is_empty());

            // Emit the event; the app-level TitleMap is updated by listening in lib.rs.
            if let Some(handle) = APP_HANDLE.get() {
                let _ = handle.emit(
                    "workspace:titleChanged",
                    serde_json::json!({
                        "workspaceId": workspace_id,
                        "title": cleaned,
                    }),
                );
            }
        }
    }

    true
}

unsafe extern "C" fn read_clipboard_cb(
    _userdata: *mut std::ffi::c_void,
    _clipboard: ghostty_clipboard_e,
    _state: *mut std::ffi::c_void,
) -> bool {
    false
}

unsafe extern "C" fn confirm_read_clipboard_cb(
    _userdata: *mut std::ffi::c_void,
    _str: *const std::ffi::c_char,
    _state: *mut std::ffi::c_void,
    _request: ghostty_clipboard_request_e,
) {
}

unsafe extern "C" fn write_clipboard_cb(
    _userdata: *mut std::ffi::c_void,
    _clipboard: ghostty_clipboard_e,
    _content: *const ghostty_clipboard_content_s,
    _len: usize,
    _confirm: bool,
) {
}

unsafe extern "C" fn close_surface_cb(_userdata: *mut std::ffi::c_void, _exited: bool) {}

pub fn ensure_app() -> Result<(), String> {
    if GLOBAL.get().is_some() {
        return Ok(());
    }
    unsafe {
        let rc = ghostty_init(0, std::ptr::null_mut());
        if rc != GHOSTTY_SUCCESS as i32 {
            return Err(format!("ghostty_init failed: {rc}"));
        }
        let cfg = ghostty_config_new();
        if cfg.is_null() {
            return Err("ghostty_config_new returned null".into());
        }
        ghostty_config_load_default_files(cfg);
        ghostty_config_load_recursive_files(cfg); // correct — see addon.mm:1104 for context
        ghostty_config_finalize(cfg);

        let rt = ghostty_runtime_config_s {
            userdata: std::ptr::null_mut(),
            supports_selection_clipboard: false,
            wakeup_cb: Some(wakeup_cb),
            action_cb: Some(action_cb),
            read_clipboard_cb: Some(read_clipboard_cb),
            confirm_read_clipboard_cb: Some(confirm_read_clipboard_cb),
            write_clipboard_cb: Some(write_clipboard_cb),
            close_surface_cb: Some(close_surface_cb),
        };
        let app = ghostty_app_new(&rt as *const ghostty_runtime_config_s, cfg);
        if app.is_null() {
            return Err("ghostty_app_new returned null".into());
        }
        GLOBAL.set(Mutex::new(GlobalApp { app })).map_err(|_| "GLOBAL already set")?;
    }
    Ok(())
}
