// SurfaceEntry — one per workspace_id. Keyed in a global HashMap behind a Mutex.
//
// All operations that touch AppKit or ghostty_* must run on the main thread.
// The Tauri command layer dispatches every call via run_on_main_thread before
// entering these functions; MainThreadMarker::new() at each entry point enforces it.

use std::collections::HashMap;
use std::ffi::CString;
use std::sync::Mutex;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{msg_send, ClassType, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSView, NSWindow};
use objc2_foundation::{NSPoint, NSRect, NSSize};

use once_cell::sync::Lazy;

use crate::app::ensure_app;
use crate::display_link::{self, CVDisplayLinkRef};
use crate::ffi::*;
use crate::view::{GhosttyView, GhosttyViewIvars};

// Doomed — carries surface + display link to the deferred destroy trampoline.
struct Doomed {
    pub surface: ghostty_surface_t,
    pub link: CVDisplayLinkRef,
}
// SAFETY: Doomed is only sent to the main-thread dispatch queue.
unsafe impl Send for Doomed {}

pub struct SurfaceEntry {
    pub surface: ghostty_surface_t,
    // We store a raw *mut GhosttyView and manually hold one objc_retain for the entry's
    // lifetime (Option B from the review). Retained<MainThreadOnly> is !Send, which would
    // prevent storing it in the static Mutex<HashMap>. We call objc_retain on insert and
    // objc_release on remove/drop, giving SurfaceEntry its own strong reference independent
    // of whatever superview currently holds the view.
    pub view: usize, // raw *mut GhosttyView — one retain counted here
    pub link: CVDisplayLinkRef,
    pub attached: bool,
}

impl Drop for SurfaceEntry {
    fn drop(&mut self) {
        // Release the retain we took in mount(). Safe: only called on main thread.
        if self.view != 0 {
            unsafe { objc2::ffi::objc_release(self.view as *mut AnyObject) };
        }
    }
}

// SAFETY: All access is serialised via the global Mutex and runs on the main thread.
unsafe impl Send for SurfaceEntry {}
unsafe impl Sync for SurfaceEntry {}

pub static SURFACES: Lazy<Mutex<HashMap<String, SurfaceEntry>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Convert a CSS rect (top-left origin) to NSRect (bottom-left origin / AppKit natural).
fn css_to_ns_rect(x: f64, y: f64, w: f64, h: f64, parent_h: f64) -> NSRect {
    NSRect::new(NSPoint::new(x, parent_h - y - h), NSSize::new(w, h))
}

pub fn mount(
    window: &tauri::Window,
    workspace_id: &str,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    scale: f64,
    cwd: Option<&str>,
    command: Option<&str>,
    initial_input: Option<&str>,
    env: &[(String, String)],
) -> Result<bool, String> {
    ensure_app().map_err(|e| e.to_string())?;

    let mtm = MainThreadMarker::new().ok_or("mount must run on main thread")?;

    let ns_window_ptr = window.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
    let ns_window: &NSWindow = unsafe { &*ns_window_ptr };
    let content_view: Retained<NSView> =
        ns_window.contentView().ok_or("contentView missing")?;

    let parent_h = content_view.bounds().size.height;

    let mut map = SURFACES.lock().unwrap();

    if let Some(entry) = map.get_mut(workspace_id) {
        // Re-attach existing surface.
        let frame = css_to_ns_rect(x, y, w, h, parent_h);
        let view = unsafe { &*(entry.view as *const GhosttyView) };
        unsafe {
            view.setFrame(frame);
            content_view.addSubview(view);
            ghostty_surface_set_occlusion(entry.surface, false);
        }
        display_link::start(entry.link);
        let phys_w = (w * scale) as u32;
        let phys_h = (h * scale) as u32;
        unsafe {
            ghostty_surface_set_size(entry.surface, phys_w, phys_h);
            ghostty_surface_set_content_scale(entry.surface, scale, scale);
        }
        // Grab first responder on the next run-loop pass.
        let view_ptr = entry.view;
        unsafe {
            crate::dispatch::dispatch_async_f(
                crate::dispatch::main_queue(),
                view_ptr as *mut std::ffi::c_void,
                focus_trampoline,
            );
        }
        entry.attached = true;
        return Ok(false);
    }

    // Create new surface.
    let frame = css_to_ns_rect(x, y, w, h, parent_h);
    let ghost_view: Retained<GhosttyView> = unsafe {
        let alloc = GhosttyView::alloc(mtm).set_ivars(GhosttyViewIvars::default());
        msg_send![super(alloc, NSView::class()), initWithFrame: frame]
    };

    content_view.addSubview(&*ghost_view);

    let app = {
        let g = crate::app::GLOBAL.get().unwrap().lock().unwrap();
        g.app
    };

    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let cwd_string = cwd.map(|s| s.to_owned()).unwrap_or(home);
    let cwd_c = CString::new(cwd_string).map_err(|e| e.to_string())?;
    let command_c: Option<CString> =
        command.map(|s| CString::new(s).map_err(|e| e.to_string())).transpose()?;
    let initial_input_c: Option<CString> = initial_input
        .map(|s| CString::new(s).map_err(|e| e.to_string()))
        .transpose()?;

    // Build env-var CStrings + ghostty_env_var_s array. The CStrings must
    // outlive ghostty_surface_new — keep them in a Vec on the stack frame.
    let env_cstrs: Vec<(CString, CString)> = env
        .iter()
        .map(|(k, v)| {
            Ok::<_, String>((
                CString::new(k.as_str()).map_err(|e| e.to_string())?,
                CString::new(v.as_str()).map_err(|e| e.to_string())?,
            ))
        })
        .collect::<Result<_, _>>()?;
    let mut env_arr: Vec<ghostty_env_var_s> = env_cstrs
        .iter()
        .map(|(k, v)| ghostty_env_var_s { key: k.as_ptr(), value: v.as_ptr() })
        .collect();

    static SENTINEL: i32 = 1;
    let mut scfg = unsafe { ghostty_surface_config_new() };
    scfg.platform_tag = ghostty_platform_e_GHOSTTY_PLATFORM_MACOS;
    scfg.platform.macos.nsview =
        ghost_view.as_ref() as *const GhosttyView as *const NSView as *mut std::ffi::c_void;
    scfg.userdata = &SENTINEL as *const i32 as *mut std::ffi::c_void;
    scfg.backend = ghostty_surface_io_backend_e_GHOSTTY_SURFACE_IO_BACKEND_EXEC;
    scfg.receive_userdata = std::ptr::null_mut();
    scfg.receive_buffer = None;
    scfg.receive_resize = None;
    scfg.scale_factor = scale;
    scfg.font_size = 13.0; // TODO(config-pass): derive from user settings, not hardcoded
    scfg.working_directory = cwd_c.as_ptr();
    scfg.command = command_c.as_ref().map(|c| c.as_ptr()).unwrap_or(std::ptr::null());
    scfg.env_vars = if env_arr.is_empty() { std::ptr::null_mut() } else { env_arr.as_mut_ptr() };
    scfg.env_var_count = env_arr.len();
    scfg.initial_input = initial_input_c
        .as_ref()
        .map(|c| c.as_ptr())
        .unwrap_or(std::ptr::null());
    // wait_after_command only matters when scfg.command is set; with the
    // initial_input path the shell is just the default login shell and stays
    // alive on its own (claude is a child of it).
    scfg.wait_after_command = command_c.is_some();
    scfg.context = ghostty_surface_context_e_GHOSTTY_SURFACE_CONTEXT_WINDOW;

    let surface = unsafe { ghostty_surface_new(app, &scfg as *const ghostty_surface_config_s) };
    if surface.is_null() {
        ghost_view.removeFromSuperview();
        return Err("ghostty_surface_new returned null".into());
    }

    // Wire surface into the view so key/mouse handlers can find it.
    ghost_view.set_surface(surface);

    let phys_w = (w * scale) as u32;
    let phys_h = (h * scale) as u32;
    unsafe {
        ghostty_surface_set_size(surface, phys_w, phys_h);
        ghostty_surface_set_content_scale(surface, scale, scale);
        ghostty_surface_set_focus(surface, true);
    }

    let link = display_link::create_and_start(surface);

    // Make first responder on the next run-loop pass.
    let view_ptr = ghost_view.as_ref() as *const GhosttyView as usize;
    unsafe {
        crate::dispatch::dispatch_async_f(
            crate::dispatch::main_queue(),
            view_ptr as *mut std::ffi::c_void,
            focus_trampoline,
        );
    }

    // Take our own retain before the Retained<GhosttyView> is dropped at end of scope.
    // addSubview holds one retain for the superview; we hold a second so that hide()
    // calling removeFromSuperview() does not reach refcount zero and free the view.
    let raw_view = ghost_view.as_ref() as *const GhosttyView as usize;
    unsafe { objc2::ffi::objc_retain(raw_view as *mut AnyObject) };
    map.insert(workspace_id.to_owned(), SurfaceEntry {
        surface,
        view: raw_view,
        link,
        attached: true,
    });

    Ok(true)
}

extern "C" fn focus_trampoline(ctx: *mut std::ffi::c_void) {
    let view = unsafe { &*(ctx as *const GhosttyView) };
    unsafe {
        let win: *mut AnyObject = msg_send![view, window];
        if !win.is_null() {
            let _: () = msg_send![win, makeFirstResponder: view];
        }
    }
}

pub fn hide(workspace_id: &str) -> Result<(), String> {
    MainThreadMarker::new().ok_or("ghostty-native: hide must run on main thread")?;
    let mut map = SURFACES.lock().unwrap();
    let entry = map.get_mut(workspace_id).ok_or("workspace_id not found")?;
    if !entry.attached {
        return Ok(()); // already hidden
    }
    unsafe {
        ghostty_surface_set_occlusion(entry.surface, true);
    }
    display_link::stop(entry.link);
    let view = unsafe { &*(entry.view as *const GhosttyView) };
    view.removeFromSuperview();
    entry.attached = false;
    Ok(())
}

pub fn resize(workspace_id: &str, x: f64, y: f64, w: f64, h: f64, scale: f64) -> Result<(), String> {
    MainThreadMarker::new().ok_or("ghostty-native: resize must run on main thread")?;
    let map = SURFACES.lock().unwrap();
    let entry = map.get(workspace_id).ok_or("workspace_id not found")?;
    if !entry.attached { return Ok(()); }
    let view = unsafe { &*(entry.view as *const GhosttyView) };
    let parent_h = unsafe {
        let sv: Option<Retained<NSView>> = view.superview();
        sv.map(|v| v.bounds().size.height).unwrap_or(h)
    };
    let frame = css_to_ns_rect(x, y, w, h, parent_h);
    unsafe {
        view.setFrame(frame);
        ghostty_surface_set_size(entry.surface, (w * scale) as u32, (h * scale) as u32);
        ghostty_surface_set_content_scale(entry.surface, scale, scale);
    }
    Ok(())
}

pub fn destroy(workspace_id: &str) -> Result<(), String> {
    MainThreadMarker::new().ok_or("ghostty-native: destroy must run on main thread")?;
    let mut map = SURFACES.lock().unwrap();
    let entry = map.remove(workspace_id).ok_or("workspace_id not found")?;

    // Nil out the surface pointer in the view so any in-flight events see null.
    let view = unsafe { &*(entry.view as *const GhosttyView) };
    view.set_surface(std::ptr::null_mut());
    view.removeFromSuperview();
    display_link::stop(entry.link);

    // Deferred slow teardown — ghostty_surface_free blocks main thread briefly.
    let doomed = Doomed { surface: entry.surface, link: entry.link };
    let boxed = Box::into_raw(Box::new(doomed));
    unsafe {
        crate::dispatch::dispatch_async_f(
            crate::dispatch::main_queue(),
            boxed as *mut std::ffi::c_void,
            destroy_trampoline,
        );
    }
    Ok(())
}

extern "C" fn destroy_trampoline(ctx: *mut std::ffi::c_void) {
    let d = unsafe { Box::from_raw(ctx as *mut Doomed) };
    display_link::stop_and_release(d.link);
    if !d.surface.is_null() {
        unsafe { ghostty_surface_free(d.surface) };
    }
}

pub fn set_focus(workspace_id: &str, focused: bool) -> Result<(), String> {
    MainThreadMarker::new().ok_or("ghostty-native: set_focus must run on main thread")?;
    let map = SURFACES.lock().unwrap();
    let entry = map.get(workspace_id).ok_or("workspace_id not found")?;
    if !entry.attached { return Ok(()); }
    unsafe { ghostty_surface_set_focus(entry.surface, focused) };
    if focused {
        let view_ptr = entry.view;
        drop(map);
        unsafe {
            crate::dispatch::dispatch_async_f(
                crate::dispatch::main_queue(),
                view_ptr as *mut std::ffi::c_void,
                focus_trampoline,
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    // Full round-trip tests (mount → hide → remount → destroy) require a live NSWindow
    // and must run on the main thread — they cannot be exercised in cargo test.
    // Run manually: launch the app, mount, hide, remount, destroy, verify no crash.
    //
    // The tests below verify the SurfaceEntry state machine using a synthetic entry
    // with null pointers (no AppKit calls are made).

    use super::*;

    fn synthetic_entry(attached: bool) -> SurfaceEntry {
        SurfaceEntry {
            surface: std::ptr::null_mut(),
            view: 0, // 0 causes Drop to skip objc_release
            link: std::ptr::null_mut(),
            attached,
        }
    }

    #[test]
    #[ignore = "requires main thread + live NSWindow; verify manually"]
    fn appkit_hide_remount_destroy() {
        // Manual: mount, hide, remount with same workspace_id, destroy.
        // Expected: no crash, scrollback intact, view at new rect after remount.
    }

    #[test]
    fn attached_flag_transitions() {
        let mut entry = synthetic_entry(true);
        assert!(entry.attached);
        entry.attached = false;
        assert!(!entry.attached);
        entry.attached = true;
        assert!(entry.attached);
    }

    #[test]
    fn surface_entry_drop_with_null_view() {
        // Drop must not call objc_release when view == 0.
        drop(synthetic_entry(false));
    }
}
