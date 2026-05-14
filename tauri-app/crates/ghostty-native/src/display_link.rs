// Per-surface CVDisplayLink — one per workspace, started on mount, stopped on hide/destroy.

use crate::dispatch::{dispatch_async_f, main_queue};
use crate::ffi::ghostty_surface_t;

pub type CVDisplayLinkRef = *mut std::ffi::c_void;
type CVReturn = i32;

// CVTimeStamp is opaque; only its address is passed through the callback ABI.
#[repr(C)]
pub(crate) struct CVTimeStamp {
    _pad: [u8; 80],
}

type CVOptionFlags = u64;

#[link(name = "CoreVideo", kind = "framework")]
extern "C" {
    pub fn CVDisplayLinkCreateWithActiveCGDisplays(out: *mut CVDisplayLinkRef) -> CVReturn;
    pub fn CVDisplayLinkSetOutputCallback(
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
    pub fn CVDisplayLinkStart(link: CVDisplayLinkRef) -> CVReturn;
    pub fn CVDisplayLinkStop(link: CVDisplayLinkRef) -> CVReturn;
    pub fn CVDisplayLinkRelease(link: CVDisplayLinkRef);
}

unsafe extern "C" fn display_link_cb(
    _link: CVDisplayLinkRef,
    _in_now: *const CVTimeStamp,
    _in_output: *const CVTimeStamp,
    _flags_in: CVOptionFlags,
    _flags_out: *mut CVOptionFlags,
    userdata: *mut std::ffi::c_void,
) -> CVReturn {
    // userdata is the ghostty_surface_t for this specific surface.
    unsafe {
        dispatch_async_f(main_queue(), userdata, draw_trampoline);
    }
    0
}

unsafe extern "C" fn draw_trampoline(ctx: *mut std::ffi::c_void) {
    use crate::ffi::{ghostty_surface_draw, ghostty_surface_refresh};
    // ghostty_surface_refresh flags the surface as needing a render. Without
    // it, ghostty_surface_draw short-circuits when PTY output rewrites cells
    // with identical glyphs (e.g. Claude's spinner cycling through braille
    // characters in the same column). Ghostty.app's standalone render thread
    // handles this internally; embedders driving draw from CVDisplayLink must
    // signal refresh explicitly per frame. Cheap flag-set.
    unsafe {
        let surface = ctx as ghostty_surface_t;
        ghostty_surface_refresh(surface);
        ghostty_surface_draw(surface);
    }
}

/// Create a started CVDisplayLink wired to the given surface.
pub fn create_and_start(surface: ghostty_surface_t) -> CVDisplayLinkRef {
    unsafe {
        let mut link: CVDisplayLinkRef = std::ptr::null_mut();
        CVDisplayLinkCreateWithActiveCGDisplays(&mut link);
        CVDisplayLinkSetOutputCallback(link, display_link_cb, surface as *mut std::ffi::c_void);
        CVDisplayLinkStart(link);
        link
    }
}

/// Start a previously stopped display link (re-attach path).
pub fn start(link: CVDisplayLinkRef) {
    unsafe { CVDisplayLinkStart(link) };
}

/// Stop the display link (surface goes dark; link stays allocated).
pub fn stop(link: CVDisplayLinkRef) {
    unsafe { CVDisplayLinkStop(link) };
}

/// Stop and release the display link entirely (call on destroy).
pub fn stop_and_release(link: CVDisplayLinkRef) {
    unsafe {
        CVDisplayLinkStop(link);
        CVDisplayLinkRelease(link);
    }
}
