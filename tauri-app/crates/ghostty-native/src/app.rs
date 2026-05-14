// Global ghostty_app_t — initialised exactly once on first mount.

use once_cell::sync::OnceCell;
use std::sync::Mutex;

use crate::dispatch::{dispatch_async_f, main_queue};
use crate::ffi::*;

pub struct GlobalApp {
    pub app: ghostty_app_t,
}

// ghostty_app_t is an opaque pointer; serialised by the Mutex.
unsafe impl Send for GlobalApp {}
unsafe impl Sync for GlobalApp {}

pub static GLOBAL: OnceCell<Mutex<GlobalApp>> = OnceCell::new();

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
    _target: ghostty_target_s,
    _action: ghostty_action_s,
) -> bool {
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
        ghostty_config_load_recursive_files(cfg);
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
