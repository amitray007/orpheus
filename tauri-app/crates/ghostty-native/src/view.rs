// GhosttyView — NSView subclass with isFlipped=YES, keyboard and mouse forwarding.
//
// isFlipped=YES means Y=0 is at the top of the view, matching CSS coordinates.
// ghostty_surface_mouse_pos expects top-left origin so no extra flip is needed.
//
// TODO: Full NSTextInputClient (IME, dead keys, CJK preedit) is deferred.
// Basic ASCII + arrows + Cmd-combos work via ghostty_surface_key .text field.

use std::cell::Cell;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{define_class, msg_send, ClassType, DefinedClass, MainThreadOnly};
use objc2_app_kit::{
    NSEvent, NSEventModifierFlags, NSTrackingArea, NSTrackingAreaOptions, NSView,
};
use objc2_foundation::{NSArray, NSPoint, NSRect};

use crate::ffi::{
    ghostty_input_action_e_GHOSTTY_ACTION_PRESS as GHOSTTY_ACTION_PRESS,
    ghostty_input_action_e_GHOSTTY_ACTION_RELEASE as GHOSTTY_ACTION_RELEASE,
    ghostty_input_action_e_GHOSTTY_ACTION_REPEAT as GHOSTTY_ACTION_REPEAT,
    ghostty_input_mods_e_GHOSTTY_MODS_NONE as GHOSTTY_MODS_NONE,
    ghostty_input_mods_e_GHOSTTY_MODS_SHIFT as GHOSTTY_MODS_SHIFT,
    ghostty_input_mods_e_GHOSTTY_MODS_CTRL as GHOSTTY_MODS_CTRL,
    ghostty_input_mods_e_GHOSTTY_MODS_ALT as GHOSTTY_MODS_ALT,
    ghostty_input_mods_e_GHOSTTY_MODS_SUPER as GHOSTTY_MODS_SUPER,
    ghostty_input_mods_e_GHOSTTY_MODS_CAPS as GHOSTTY_MODS_CAPS,
    ghostty_input_mods_e_GHOSTTY_MODS_SHIFT_RIGHT as GHOSTTY_MODS_SHIFT_RIGHT,
    ghostty_input_mods_e_GHOSTTY_MODS_CTRL_RIGHT as GHOSTTY_MODS_CTRL_RIGHT,
    ghostty_input_mods_e_GHOSTTY_MODS_ALT_RIGHT as GHOSTTY_MODS_ALT_RIGHT,
    ghostty_input_mods_e_GHOSTTY_MODS_SUPER_RIGHT as GHOSTTY_MODS_SUPER_RIGHT,
    ghostty_input_mouse_state_e_GHOSTTY_MOUSE_PRESS as GHOSTTY_MOUSE_PRESS,
    ghostty_input_mouse_state_e_GHOSTTY_MOUSE_RELEASE as GHOSTTY_MOUSE_RELEASE,
    ghostty_input_mouse_button_e_GHOSTTY_MOUSE_UNKNOWN as GHOSTTY_MOUSE_UNKNOWN,
    ghostty_input_mouse_button_e_GHOSTTY_MOUSE_LEFT as GHOSTTY_MOUSE_LEFT,
    ghostty_input_mouse_button_e_GHOSTTY_MOUSE_RIGHT as GHOSTTY_MOUSE_RIGHT,
    ghostty_input_mouse_button_e_GHOSTTY_MOUSE_MIDDLE as GHOSTTY_MOUSE_MIDDLE,
    ghostty_input_mouse_button_e_GHOSTTY_MOUSE_FOUR as GHOSTTY_MOUSE_FOUR,
    ghostty_input_mouse_button_e_GHOSTTY_MOUSE_FIVE as GHOSTTY_MOUSE_FIVE,
    ghostty_input_mouse_button_e_GHOSTTY_MOUSE_SIX as GHOSTTY_MOUSE_SIX,
    ghostty_input_mouse_button_e_GHOSTTY_MOUSE_SEVEN as GHOSTTY_MOUSE_SEVEN,
    ghostty_input_mouse_button_e_GHOSTTY_MOUSE_EIGHT as GHOSTTY_MOUSE_EIGHT,
    ghostty_input_mouse_button_e_GHOSTTY_MOUSE_NINE as GHOSTTY_MOUSE_NINE,
    ghostty_input_mouse_button_e_GHOSTTY_MOUSE_TEN as GHOSTTY_MOUSE_TEN,
    ghostty_input_mouse_button_e_GHOSTTY_MOUSE_ELEVEN as GHOSTTY_MOUSE_ELEVEN,
    ghostty_input_mouse_momentum_e_GHOSTTY_MOUSE_MOMENTUM_NONE as GHOSTTY_MOUSE_MOMENTUM_NONE,
    ghostty_input_mouse_momentum_e_GHOSTTY_MOUSE_MOMENTUM_BEGAN as GHOSTTY_MOUSE_MOMENTUM_BEGAN,
    ghostty_input_mouse_momentum_e_GHOSTTY_MOUSE_MOMENTUM_STATIONARY as GHOSTTY_MOUSE_MOMENTUM_STATIONARY,
    ghostty_input_mouse_momentum_e_GHOSTTY_MOUSE_MOMENTUM_CHANGED as GHOSTTY_MOUSE_MOMENTUM_CHANGED,
    ghostty_input_mouse_momentum_e_GHOSTTY_MOUSE_MOMENTUM_ENDED as GHOSTTY_MOUSE_MOMENTUM_ENDED,
    ghostty_input_mouse_momentum_e_GHOSTTY_MOUSE_MOMENTUM_CANCELLED as GHOSTTY_MOUSE_MOMENTUM_CANCELLED,
    ghostty_input_mouse_momentum_e_GHOSTTY_MOUSE_MOMENTUM_MAY_BEGIN as GHOSTTY_MOUSE_MOMENTUM_MAY_BEGIN,
    ghostty_input_key_s,
    ghostty_input_mods_e,
    ghostty_input_mouse_button_e,
    ghostty_input_scroll_mods_t,
    ghostty_surface_t,
    ghostty_surface_key,
    ghostty_surface_mouse_pos,
    ghostty_surface_mouse_button,
    ghostty_surface_mouse_scroll,
};

// Raw IOKit modifier masks for sided keys (same values as addon.mm).
const NX_DEVICERSHIFTKEYMASK: usize = 0x0002;
const NX_DEVICERCTLKEYMASK: usize = 0x2000;
const NX_DEVICERALTKEYMASK: usize = 0x0040;
const NX_DEVICERCMDKEYMASK: usize = 0x0010;

fn mods_from_flags(flags: NSEventModifierFlags) -> ghostty_input_mods_e {
    let raw = flags.0; // NSUInteger = usize
    let mut mods: u32 = GHOSTTY_MODS_NONE;

    if flags.contains(NSEventModifierFlags::Shift)   { mods |= GHOSTTY_MODS_SHIFT; }
    if flags.contains(NSEventModifierFlags::Control) { mods |= GHOSTTY_MODS_CTRL; }
    if flags.contains(NSEventModifierFlags::Option)  { mods |= GHOSTTY_MODS_ALT; }
    if flags.contains(NSEventModifierFlags::Command) { mods |= GHOSTTY_MODS_SUPER; }
    if flags.contains(NSEventModifierFlags::CapsLock) { mods |= GHOSTTY_MODS_CAPS; }

    if raw & NX_DEVICERSHIFTKEYMASK != 0 { mods |= GHOSTTY_MODS_SHIFT_RIGHT; }
    if raw & NX_DEVICERCTLKEYMASK   != 0 { mods |= GHOSTTY_MODS_CTRL_RIGHT; }
    if raw & NX_DEVICERALTKEYMASK   != 0 { mods |= GHOSTTY_MODS_ALT_RIGHT; }
    if raw & NX_DEVICERCMDKEYMASK   != 0 { mods |= GHOSTTY_MODS_SUPER_RIGHT; }

    mods as ghostty_input_mods_e
}

/// Return the UTF-8 text to embed in a key event, filtering control chars and PUA codepoints.
fn filter_key_text(chars: &str) -> Option<&str> {
    if chars.is_empty() { return None; }
    let mut it = chars.chars();
    if let (Some(c), None) = (it.next(), it.next()) {
        if (c as u32) < 0x20 { return None; }       // control char — libghostty encodes
        if (0xF700..=0xF8FF).contains(&(c as u32)) { return None; } // PUA function keys
    }
    Some(chars)
}

/// Build scroll mods bitmask from an NSEvent (bit 0 = precise, bits 1-3 = momentum).
unsafe fn scroll_mods_for_event(event: &NSEvent) -> ghostty_input_scroll_mods_t {
    let precise: bool = unsafe { msg_send![event, hasPreciseScrollingDeltas] };
    let mut mods: i32 = if precise { 1 } else { 0 };
    let phase: usize = unsafe { msg_send![event, momentumPhase] };
    let momentum: u8 = match phase {
        0x01 => GHOSTTY_MOUSE_MOMENTUM_BEGAN as u8,
        0x02 => GHOSTTY_MOUSE_MOMENTUM_STATIONARY as u8,
        0x04 => GHOSTTY_MOUSE_MOMENTUM_CHANGED as u8,
        0x08 => GHOSTTY_MOUSE_MOMENTUM_ENDED as u8,
        0x10 => GHOSTTY_MOUSE_MOMENTUM_CANCELLED as u8,
        0x20 => GHOSTTY_MOUSE_MOMENTUM_MAY_BEGIN as u8,
        _    => GHOSTTY_MOUSE_MOMENTUM_NONE as u8,
    };
    mods |= (momentum as i32) << 1;
    mods as ghostty_input_scroll_mods_t
}

fn button_for_ns_number(btn: isize) -> ghostty_input_mouse_button_e {
    match btn {
        0 => GHOSTTY_MOUSE_LEFT,
        1 => GHOSTTY_MOUSE_RIGHT,
        2 => GHOSTTY_MOUSE_MIDDLE,
        3 => GHOSTTY_MOUSE_EIGHT,
        4 => GHOSTTY_MOUSE_NINE,
        5 => GHOSTTY_MOUSE_SIX,
        6 => GHOSTTY_MOUSE_SEVEN,
        7 => GHOSTTY_MOUSE_FOUR,
        8 => GHOSTTY_MOUSE_FIVE,
        9 => GHOSTTY_MOUSE_TEN,
        10 => GHOSTTY_MOUSE_ELEVEN,
        _ => GHOSTTY_MOUSE_UNKNOWN,
    }
}

/// Convert event location to view-local coords. With isFlipped=YES result is top-left origin.
unsafe fn mouse_pos(event: &NSEvent, view: &NSView) -> (f64, f64) {
    let loc: NSPoint = unsafe { msg_send![event, locationInWindow] };
    let local: NSPoint = unsafe {
        msg_send![view, convertPoint: loc, fromView: std::ptr::null::<NSView>()]
    };
    (local.x, local.y)
}

// Ivars struct for GhosttyView.
// surface_ptr stored as usize; all access is on the main thread, Cell<usize> is safe.
#[derive(Default)]
pub struct GhosttyViewIvars {
    pub surface_ptr: Cell<usize>,
}

// SAFETY: GhosttyView is MainThreadOnly — ivar access is single-threaded.
unsafe impl Send for GhosttyViewIvars {}
unsafe impl Sync for GhosttyViewIvars {}

define_class!(
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = GhosttyViewIvars]
    #[name = "GhosttyView"]
    pub struct GhosttyView;

    impl GhosttyView {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool { true }

        #[unsafe(method(wantsLayer))]
        fn wants_layer(&self) -> bool { true }

        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_first_responder(&self) -> bool { true }

        #[unsafe(method(updateTrackingAreas))]
        fn update_tracking_areas(&self) {
            unsafe {
                let areas: Retained<NSArray<NSTrackingArea>> =
                    msg_send![self, trackingAreas];
                for ta in areas.iter() {
                    let _: () = msg_send![self, removeTrackingArea: &*ta];
                }
                let opts = NSTrackingAreaOptions::MouseEnteredAndExited
                    | NSTrackingAreaOptions::MouseMoved
                    | NSTrackingAreaOptions::InVisibleRect
                    | NSTrackingAreaOptions::ActiveAlways;
                let frame: NSRect = msg_send![self, frame];
                // Build NSTrackingArea via raw msg_send to avoid AnyThread constraint on alloc().
                let ta_alloc: *mut NSTrackingArea = msg_send![NSTrackingArea::class(), alloc];
                let ta: *mut NSTrackingArea = msg_send![
                    ta_alloc,
                    initWithRect: frame,
                    options: opts,
                    owner: self as *const Self,
                    userInfo: std::ptr::null::<AnyObject>()
                ];
                let _: () = msg_send![self, addTrackingArea: ta];
            }
        }

        #[unsafe(method(keyDown:))]
        fn key_down(&self, event: &NSEvent) {
            let surface = self.surface();
            if surface.is_null() { return; }

            let is_repeat: bool = unsafe { msg_send![event, isARepeat] };
            let action = if is_repeat { GHOSTTY_ACTION_REPEAT } else { GHOSTTY_ACTION_PRESS };
            let keycode: u16 = unsafe { msg_send![event, keyCode] };
            let flags: NSEventModifierFlags = unsafe { msg_send![event, modifierFlags] };
            let mods = mods_from_flags(flags);

            // Unshifted codepoint: charactersByApplyingModifiers:0.
            let unshifted: u32 = unsafe {
                let bare: *mut objc2_foundation::NSString =
                    msg_send![event, charactersByApplyingModifiers: 0usize];
                if bare.is_null() { 0 } else {
                    let len: usize = msg_send![bare, length];
                    if len > 0 {
                        let cp: u16 = msg_send![bare, characterAtIndex: 0usize];
                        if cp < 0xD800 || cp > 0xDFFF { cp as u32 } else { 0 }
                    } else { 0 }
                }
            };

            // Retrieve event.characters as a Rust &str.
            let chars_ns: *mut objc2_foundation::NSString =
                unsafe { msg_send![event, characters] };
            let chars_utf8: Option<&std::ffi::CStr> = unsafe {
                if chars_ns.is_null() { None } else {
                    let ptr: *const i8 = msg_send![chars_ns, UTF8String];
                    if ptr.is_null() { None } else { Some(std::ffi::CStr::from_ptr(ptr)) }
                }
            };
            let chars_str = chars_utf8.and_then(|cs| cs.to_str().ok());
            let text_filtered = chars_str.and_then(filter_key_text);
            let text_cstr: Option<std::ffi::CString> =
                text_filtered.and_then(|s| std::ffi::CString::new(s).ok());

            let mut key_ev = ghostty_input_key_s {
                action,
                mods,
                consumed_mods: (mods & !(GHOSTTY_MODS_CTRL | GHOSTTY_MODS_SUPER)) as ghostty_input_mods_e,
                keycode: keycode as u32,
                composing: false,
                unshifted_codepoint: unshifted,
                text: std::ptr::null(),
            };
            if let Some(ref cs) = text_cstr {
                key_ev.text = cs.as_ptr();
            }
            unsafe { ghostty_surface_key(surface, key_ev) };
        }

        #[unsafe(method(keyUp:))]
        fn key_up(&self, event: &NSEvent) {
            let surface = self.surface();
            if surface.is_null() { return; }
            let keycode: u16 = unsafe { msg_send![event, keyCode] };
            let flags: NSEventModifierFlags = unsafe { msg_send![event, modifierFlags] };
            let mods = mods_from_flags(flags);
            let key_ev = ghostty_input_key_s {
                action: GHOSTTY_ACTION_RELEASE,
                mods,
                consumed_mods: 0 as ghostty_input_mods_e,
                keycode: keycode as u32,
                composing: false,
                unshifted_codepoint: 0,
                text: std::ptr::null(),
            };
            unsafe { ghostty_surface_key(surface, key_ev) };
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) {
            unsafe {
                let win: *mut AnyObject = msg_send![self, window];
                if !win.is_null() {
                    let _: () = msg_send![win, makeFirstResponder: self];
                }
            }
            let surface = self.surface();
            if surface.is_null() { return; }
            let (x, y) = unsafe { mouse_pos(event, self) };
            let flags: NSEventModifierFlags = unsafe { msg_send![event, modifierFlags] };
            let mods = mods_from_flags(flags);
            unsafe {
                ghostty_surface_mouse_pos(surface, x, y, mods);
                ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_LEFT, mods);
            }
        }

        #[unsafe(method(mouseUp:))]
        fn mouse_up(&self, event: &NSEvent) {
            let surface = self.surface();
            if surface.is_null() { return; }
            let (x, y) = unsafe { mouse_pos(event, self) };
            let flags: NSEventModifierFlags = unsafe { msg_send![event, modifierFlags] };
            let mods = mods_from_flags(flags);
            unsafe {
                ghostty_surface_mouse_pos(surface, x, y, mods);
                ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_LEFT, mods);
            }
        }

        #[unsafe(method(mouseMoved:))]
        fn mouse_moved(&self, event: &NSEvent) { self.send_pos(event); }

        #[unsafe(method(mouseDragged:))]
        fn mouse_dragged(&self, event: &NSEvent) { self.send_pos(event); }

        #[unsafe(method(rightMouseDragged:))]
        fn right_mouse_dragged(&self, event: &NSEvent) { self.send_pos(event); }

        #[unsafe(method(otherMouseDragged:))]
        fn other_mouse_dragged(&self, event: &NSEvent) { self.send_pos(event); }

        #[unsafe(method(mouseEntered:))]
        fn mouse_entered(&self, event: &NSEvent) {
            let surface = self.surface();
            if surface.is_null() { return; }
            let (x, y) = unsafe { mouse_pos(event, self) };
            let flags: NSEventModifierFlags = unsafe { msg_send![event, modifierFlags] };
            unsafe { ghostty_surface_mouse_pos(surface, x, y, mods_from_flags(flags)) };
        }

        #[unsafe(method(mouseExited:))]
        fn mouse_exited(&self, event: &NSEvent) {
            let surface = self.surface();
            if surface.is_null() { return; }
            // Skip reset while a button is held (drag case).
            let pressed: usize = unsafe { NSEvent::pressedMouseButtons() };
            if pressed != 0 { return; }
            let flags: NSEventModifierFlags = unsafe { msg_send![event, modifierFlags] };
            unsafe { ghostty_surface_mouse_pos(surface, -1.0, -1.0, mods_from_flags(flags)) };
        }

        #[unsafe(method(rightMouseDown:))]
        fn right_mouse_down(&self, event: &NSEvent) {
            let surface = self.surface();
            if surface.is_null() { return; }
            let (x, y) = unsafe { mouse_pos(event, self) };
            let flags: NSEventModifierFlags = unsafe { msg_send![event, modifierFlags] };
            let mods = mods_from_flags(flags);
            unsafe {
                ghostty_surface_mouse_pos(surface, x, y, mods);
                ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_RIGHT, mods);
            }
        }

        #[unsafe(method(rightMouseUp:))]
        fn right_mouse_up(&self, event: &NSEvent) {
            let surface = self.surface();
            if surface.is_null() { return; }
            let (x, y) = unsafe { mouse_pos(event, self) };
            let flags: NSEventModifierFlags = unsafe { msg_send![event, modifierFlags] };
            let mods = mods_from_flags(flags);
            unsafe {
                ghostty_surface_mouse_pos(surface, x, y, mods);
                ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_RIGHT, mods);
            }
        }

        #[unsafe(method(otherMouseDown:))]
        fn other_mouse_down(&self, event: &NSEvent) {
            let surface = self.surface();
            if surface.is_null() { return; }
            let (x, y) = unsafe { mouse_pos(event, self) };
            let flags: NSEventModifierFlags = unsafe { msg_send![event, modifierFlags] };
            let mods = mods_from_flags(flags);
            let btn: isize = unsafe { msg_send![event, buttonNumber] };
            unsafe {
                ghostty_surface_mouse_pos(surface, x, y, mods);
                ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_PRESS, button_for_ns_number(btn), mods);
            }
        }

        #[unsafe(method(otherMouseUp:))]
        fn other_mouse_up(&self, event: &NSEvent) {
            let surface = self.surface();
            if surface.is_null() { return; }
            let (x, y) = unsafe { mouse_pos(event, self) };
            let flags: NSEventModifierFlags = unsafe { msg_send![event, modifierFlags] };
            let mods = mods_from_flags(flags);
            let btn: isize = unsafe { msg_send![event, buttonNumber] };
            unsafe {
                ghostty_surface_mouse_pos(surface, x, y, mods);
                ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_RELEASE, button_for_ns_number(btn), mods);
            }
        }

        #[unsafe(method(scrollWheel:))]
        fn scroll_wheel(&self, event: &NSEvent) {
            let surface = self.surface();
            if surface.is_null() { return; }
            let precise: bool = unsafe { msg_send![event, hasPreciseScrollingDeltas] };
            let mut dx: f64 = unsafe { msg_send![event, scrollingDeltaX] };
            let mut dy: f64 = unsafe { msg_send![event, scrollingDeltaY] };
            if precise { dx *= 2.0; dy *= 2.0; }
            let scroll_mods = unsafe { scroll_mods_for_event(event) };
            unsafe { ghostty_surface_mouse_scroll(surface, dx, dy, scroll_mods) };
        }
    }
);

impl GhosttyView {
    pub fn surface(&self) -> ghostty_surface_t {
        self.ivars().surface_ptr.get() as ghostty_surface_t
    }

    pub fn set_surface(&self, surface: ghostty_surface_t) {
        self.ivars().surface_ptr.set(surface as usize);
    }

    fn send_pos(&self, event: &NSEvent) {
        let surface = self.surface();
        if surface.is_null() { return; }
        let (x, y) = unsafe { mouse_pos(event, self) };
        let flags: NSEventModifierFlags = unsafe { msg_send![event, modifierFlags] };
        unsafe { ghostty_surface_mouse_pos(surface, x, y, mods_from_flags(flags)) };
    }
}
