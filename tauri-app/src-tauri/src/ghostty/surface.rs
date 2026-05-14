// Spawn and manage a libghostty terminal surface embedded as a sibling NSView
// under Tauri's window contentView, outside the WKWebView compositor.

use std::ffi::CString;
use std::sync::Mutex;

use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSView, NSWindow};
use objc2_foundation::{NSPoint, NSRect, NSSize};

use super::ffi::*;
use super::state::{GlobalState, SurfaceState, GLOBAL, SURFACE};

// -- callbacks required by ghostty_runtime_config_s --

unsafe extern "C" fn wakeup_cb(_userdata: *mut std::ffi::c_void) {
    unsafe { dispatch_async_f(dispatch_get_main_queue(), std::ptr::null_mut(), tick_trampoline) };
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

// -- libdispatch raw bindings (system libSystem) --

#[link(name = "System")]
extern "C" {
    fn dispatch_get_main_queue() -> *mut std::ffi::c_void;
    fn dispatch_async_f(
        queue: *mut std::ffi::c_void,
        context: *mut std::ffi::c_void,
        work: extern "C" fn(*mut std::ffi::c_void),
    );
}

// -- CVDisplayLink raw bindings --

#[allow(non_camel_case_types)]
type CVDisplayLinkRef = *mut std::ffi::c_void;
type CVReturn = i32;

#[repr(C)]
struct CVTimeStamp {
    _pad: [u8; 80],
}

#[allow(non_camel_case_types)]
type CVOptionFlags = u64;

#[link(name = "CoreVideo", kind = "framework")]
extern "C" {
    fn CVDisplayLinkCreateWithActiveCGDisplays(out: *mut CVDisplayLinkRef) -> CVReturn;
    fn CVDisplayLinkSetOutputCallback(
        link: CVDisplayLinkRef,
        cb: unsafe extern "C" fn(
            CVDisplayLinkRef,
            *const CVTimeStamp,
            *const CVTimeStamp,
            CVOptionFlags,
            *mut CVOptionFlags,
            *mut std::ffi::c_void,
        ) -> CVReturn,
        userdata: *mut std::ffi::c_void,
    ) -> CVReturn;
    fn CVDisplayLinkStart(link: CVDisplayLinkRef) -> CVReturn;
}

unsafe extern "C" fn display_link_cb(
    _link: CVDisplayLinkRef,
    _in_now: *const CVTimeStamp,
    _in_output: *const CVTimeStamp,
    _flags_in: CVOptionFlags,
    _flags_out: *mut CVOptionFlags,
    userdata: *mut std::ffi::c_void,
) -> CVReturn {
    let surface = userdata as ghostty_surface_t;
    unsafe {
        dispatch_async_f(
            dispatch_get_main_queue(),
            surface as *mut std::ffi::c_void,
            draw_trampoline,
        )
    };
    0
}

extern "C" fn draw_trampoline(ctx: *mut std::ffi::c_void) {
    unsafe { ghostty_surface_draw(ctx as ghostty_surface_t) };
}

// -- ghostty init --

fn ensure_global_app() -> Result<(), String> {
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
        GLOBAL.set(Mutex::new(GlobalState { app })).map_err(|_| "GLOBAL already set")?;
    }
    Ok(())
}

// -- coordinate conversion --
// CSS rect origin is top-left; NSView frame is bottom-left (contentView not flipped).
fn dom_to_ns_rect(x: f64, y: f64, w: f64, h: f64, parent_h: f64) -> NSRect {
    NSRect::new(NSPoint::new(x, parent_h - (y + h)), NSSize::new(w, h))
}

// -- public API --

pub fn spawn(
    window: &tauri::Window,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    scale: f64,
) -> Result<(), Box<dyn std::error::Error>> {
    if SURFACE.get().is_some() {
        return resize(x, y, w, h, scale);
    }
    ensure_global_app().map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;

    // Tauri invokes commands on the main thread on macOS.
    let mtm = MainThreadMarker::new().ok_or("spawn must run on main thread")?;

    let ns_window_ptr = window.ns_window()? as *mut NSWindow;

    unsafe {
        let ns_window: &NSWindow = &*ns_window_ptr;
        let content_view: Retained<NSView> =
            ns_window.contentView().ok_or("contentView missing")?;

        let parent_h = content_view.bounds().size.height;
        let frame = dom_to_ns_rect(x, y, w, h, parent_h);

        // Allocate and init the ghost view.
        let ghost_view: Retained<NSView> = NSView::initWithFrame(mtm.alloc::<NSView>(), frame);
        ghost_view.setWantsLayer(true);

        // Place ABOVE the WKWebView so it receives events without pointer-events tricks.
        content_view.addSubview(&ghost_view);

        // Build surface config.
        let mut scfg = ghostty_surface_config_new();
        scfg.platform_tag = ghostty_platform_e_GHOSTTY_PLATFORM_MACOS;
        scfg.platform.macos.nsview =
            ghost_view.as_ref() as *const NSView as *mut std::ffi::c_void;

        static SENTINEL: i32 = 1;
        scfg.userdata = &SENTINEL as *const i32 as *mut std::ffi::c_void;
        scfg.backend = ghostty_surface_io_backend_e_GHOSTTY_SURFACE_IO_BACKEND_EXEC;
        scfg.receive_userdata = std::ptr::null_mut();
        scfg.receive_buffer = None;
        scfg.receive_resize = None;
        scfg.scale_factor = scale;
        scfg.font_size = 13.0;

        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        let cwd = CString::new(home).unwrap();
        scfg.working_directory = cwd.as_ptr();
        scfg.command = std::ptr::null();
        scfg.env_vars = std::ptr::null_mut();
        scfg.env_var_count = 0;
        scfg.initial_input = std::ptr::null();
        scfg.wait_after_command = true;
        scfg.context = ghostty_surface_context_e_GHOSTTY_SURFACE_CONTEXT_WINDOW;

        let app = GLOBAL.get().unwrap().lock().unwrap().app;
        let surface = ghostty_surface_new(app, &scfg as *const ghostty_surface_config_s);
        if surface.is_null() {
            return Err("ghostty_surface_new returned null".into());
        }

        let phys_w = (w * scale) as u32;
        let phys_h = (h * scale) as u32;
        ghostty_surface_set_size(surface, phys_w, phys_h);
        ghostty_surface_set_content_scale(surface, scale, scale);
        ghostty_surface_set_focus(surface, true);

        let nsview_usize = ghost_view.as_ref() as *const NSView as usize;
        SURFACE
            .set(Mutex::new(SurfaceState { surface, nsview: nsview_usize }))
            .map_err(|_| "SURFACE already set")?;

        // CVDisplayLink drives continuous frame delivery from a private thread.
        let mut link: CVDisplayLinkRef = std::ptr::null_mut();
        CVDisplayLinkCreateWithActiveCGDisplays(&mut link);
        CVDisplayLinkSetOutputCallback(link, display_link_cb, surface as *mut std::ffi::c_void);
        CVDisplayLinkStart(link);
        // link leaked intentionally — process lifetime is sufficient for the spike.

        // Make ghost_view first responder so the user can type immediately.
        ns_window.makeFirstResponder(Some(ghost_view.as_ref() as &NSView as &objc2_app_kit::NSResponder));
    }
    Ok(())
}

pub fn resize(
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    scale: f64,
) -> Result<(), Box<dyn std::error::Error>> {
    let state_lock = SURFACE.get().ok_or("surface not spawned yet")?;
    let state = state_lock.lock().unwrap();
    unsafe {
        let ns_view = &*(state.nsview as *const NSView);
        let parent_h = ns_view
            .superview()
            .map(|sv| sv.bounds().size.height)
            .unwrap_or(800.0);
        let frame = dom_to_ns_rect(x, y, w, h, parent_h);
        ns_view.setFrame(frame);
        ghostty_surface_set_size(state.surface, (w * scale) as u32, (h * scale) as u32);
        ghostty_surface_set_content_scale(state.surface, scale, scale);
    }
    Ok(())
}
