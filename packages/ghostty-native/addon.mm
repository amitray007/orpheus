// ghostty-native — production lifecycle addon for Orpheus.
//
// Exports four synchronous NAPI functions (all called on the AppKit main thread
// from the Electron main process):
//
//   mount(handleBuffer, { workspaceId, rect: {x,y,w,h}, scaleFactor, cwd? })
//       → { workspaceId, created: bool }
//   hide(workspaceId)    → void   (keeps surface alive, just removes from superview)
//   resize(workspaceId, { x, y, w, h }, scaleFactor) → void
//   destroy(workspaceId) → void   (full teardown; call only on archive/project-remove)
//
// Persistence model:
//   Each workspace owns exactly one GhosttySurfaceEntry keyed by workspace.id.
//   mount()   — creates on first call; re-attaches on subsequent calls.
//   hide()    — removeFromSuperview + occlusion + stop CVDisplayLink; keeps entry alive.
//   destroy() — full teardown; removes from map.
//   Orpheus quit → process exit GCs everything naturally.
//
// Threading model:
//   • NAPI handlers run on the main thread — all ghostty_* calls here are safe.
//   • CVDisplayLink fires its callback on a private thread.  The callback
//     dispatches ghostty_surface_draw back to the main queue so Metal/AppKit
//     keep running on the same thread that created the surface.

#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <CoreVideo/CoreVideo.h>
#import <Carbon/Carbon.h>

#include <string>
#include <map>
#include <atomic>
#include <unistd.h>

// GhosttyKit C API
#include "ghostty.h"

// node-addon-api (C++ NAPI wrapper)
#include <napi.h>

// ---------------------------------------------------------------------------
// OrpheusGhosttyView — NSView subclass with keyboard + focus support.
//
// Keyboard design (from Ghostty Swift reference implementation):
//   • ghostty_input_key_s.keycode = raw macOS virtual keycode (event.keyCode).
//     Ghostty's key codec maps these natively; we do NOT pre-convert to
//     GHOSTTY_KEY_* enum values.
//   • mods = NSEvent.modifierFlags translated to ghostty_input_mods_e bitmask.
//   • action = GHOSTTY_ACTION_PRESS for keyDown:, GHOSTTY_ACTION_RELEASE for keyUp:,
//     GHOSTTY_ACTION_REPEAT for auto-repeat.
//   • text field: pass event.characters unless it's a control char (< 0x20) or PUA
//     range (0xF700–0xF8FF).  Control-char encoding is handled inside libghostty.
//
// NSTextInputClient (minimal stub):
//   • insertText:replacementRange: → ghostty_surface_text  (committed text from IME)
//   • doCommandBySelector:        → suppressed (no NSBeep); keyDown: already forwarded
//   • Marked text / preedit: stubbed out.  CJK dead-key composition is a follow-up.
//     ghostty_surface_preedit and ghostty_surface_ime_point are intentionally not
//     wired here; add them when NSTextInputClient composition is fully wired.
//
// Mouse:
//   • mouseDown: makes the view first responder AND forwards to ghostty_surface_mouse_button.
//   • Full mouse forwarding: mouseUp, mouseDragged, rightMouseDown/Up, otherMouseDown/Up,
//     scrollWheel — all call ghostty_surface_mouse_*.
//   • Tracking area added via updateTrackingAreas so mouseMoved / mouseEntered / mouseExited
//     fire for hover and cursor-shape updates.
//
// Coordinate system note:
//   • OrpheusGhosttyView has isFlipped = YES, so convertPoint:fromView:nil yields
//     top-left origin. Ghostty expects bottom-left origin (non-flipped), so we apply
//     the same manual flip that Ghostty's own SurfaceView_AppKit.swift performs:
//       ghosttyY = view.frame.size.height - localPoint.y
//   • Coordinates passed to ghostty_surface_mouse_pos are logical (point) values,
//     NOT scaled physical pixels. The Swift reference confirms this (raw pos.x / pos.y).
//   • ghostty_surface_mouse_scroll also uses logical deltas (event.scrollingDeltaX/Y).
//
// Scroll mods packing (from Ghostty.Input.swift ScrollMods struct):
//   ghostty_input_scroll_mods_t is an int32 packed bitmask:
//     bit 0   : precision (1 = hasPreciseScrollingDeltas, trackpad/Magic Mouse)
//     bits 1–3: momentum phase (NSEvent.Phase → ghostty_input_mouse_momentum_e values 0–6)
//   precise deltas are multiplied by 2.0 (matches Ghostty upstream behaviour).
// ---------------------------------------------------------------------------

@interface OrpheusGhosttyView : NSView <NSTextInputClient>
@property (nonatomic, assign) ghostty_surface_t surface;
// Set to YES while we are inside keyDown: so that insertText:replacementRange:
// can distinguish IME-committed text (outside keyDown:) from plain ASCII input
// that ghostty_surface_key already handled via the .text field.
@property (nonatomic, assign) BOOL inKeyDown;
@end

@implementation OrpheusGhosttyView

- (BOOL)isFlipped {
    // Flip so Y=0 is at the top (matches CSS/JS coordinate system).
    return YES;
}

- (BOOL)wantsLayer {
    return YES;
}

- (BOOL)acceptsFirstResponder {
    return YES;
}

// ---------------------------------------------------------------------------
// Modifier flag → Ghostty mods bitmask
// Source: Ghostty.Input.swift ghosttyMods() method.
// NX_DEVICE* masks detect right-side modifier keys (IOKit private constants).
// ---------------------------------------------------------------------------

static ghostty_input_mods_e modsFromEvent(NSEvent *event) {
    NSEventModifierFlags flags = event.modifierFlags;
    uint32_t mods = GHOSTTY_MODS_NONE;

    if (flags & NSEventModifierFlagShift)   mods |= GHOSTTY_MODS_SHIFT;
    if (flags & NSEventModifierFlagControl) mods |= GHOSTTY_MODS_CTRL;
    if (flags & NSEventModifierFlagOption)  mods |= GHOSTTY_MODS_ALT;
    if (flags & NSEventModifierFlagCommand) mods |= GHOSTTY_MODS_SUPER;
    if (flags & NSEventModifierFlagCapsLock) mods |= GHOSTTY_MODS_CAPS;

    // Sided modifiers via IOKit raw bits (same constants used in Ghostty Swift).
    NSUInteger raw = flags;
    if (raw & NX_DEVICERSHIFTKEYMASK) mods |= GHOSTTY_MODS_SHIFT_RIGHT;
    if (raw & NX_DEVICERCTLKEYMASK)   mods |= GHOSTTY_MODS_CTRL_RIGHT;
    if (raw & NX_DEVICERALTKEYMASK)   mods |= GHOSTTY_MODS_ALT_RIGHT;
    if (raw & NX_DEVICERCMDKEYMASK)   mods |= GHOSTTY_MODS_SUPER_RIGHT;

    return (ghostty_input_mods_e)mods;
}

// ---------------------------------------------------------------------------
// Convert an NSEvent location to view-local Ghostty coordinates.
//
// Steps:
//   1. event.locationInWindow   → window coords
//   2. convertPoint:fromView:nil → view-local coords (top-left origin, because
//      isFlipped = YES)
//   3. ghosttyY = frame.height - localY   → flip to bottom-left origin
//      (mirrors the `y: frame.height - pos.y` in SurfaceView_AppKit.swift;
//       Ghostty's internal mouse logic expects non-flipped coords)
//
// Returns a struct so both x and y can be passed with a single call.
// ---------------------------------------------------------------------------

struct GhosttyMousePos { double x; double y; };

static GhosttyMousePos ghosttyPosForEvent(NSEvent *event, OrpheusGhosttyView *view) {
    NSPoint local = [view convertPoint:event.locationInWindow fromView:nil];
    // local.y is top-origin (isFlipped = YES); flip it for Ghostty.
    double ghosttyY = view.frame.size.height - local.y;
    return { local.x, ghosttyY };
}

// ---------------------------------------------------------------------------
// Build ghostty_input_scroll_mods_t from an NSEvent scroll event.
//
// Packing (from Ghostty.Input.swift ScrollMods):
//   bit 0   : 1 if hasPreciseScrollingDeltas (trackpad / Magic Mouse)
//   bits 1–3: momentum phase (NSEvent.Phase → ghostty_input_mouse_momentum_e)
//
// NSEvent.Phase → momentum enum mapping (from Ghostty.Input.swift Momentum):
//   .began      → GHOSTTY_MOUSE_MOMENTUM_BEGAN      (1)
//   .stationary → GHOSTTY_MOUSE_MOMENTUM_STATIONARY (2)
//   .changed    → GHOSTTY_MOUSE_MOMENTUM_CHANGED    (3)
//   .ended      → GHOSTTY_MOUSE_MOMENTUM_ENDED      (4)
//   .cancelled  → GHOSTTY_MOUSE_MOMENTUM_CANCELLED  (5)
//   .mayBegin   → GHOSTTY_MOUSE_MOMENTUM_MAY_BEGIN  (6)
//   default     → GHOSTTY_MOUSE_MOMENTUM_NONE       (0)
// ---------------------------------------------------------------------------

static ghostty_input_scroll_mods_t scrollModsForEvent(NSEvent *event) {
    int32_t mods = 0;

    bool precise = event.hasPreciseScrollingDeltas;
    if (precise) mods |= 0x01;   // bit 0

    // Map NSEvent.Phase (momentum phase) → ghostty momentum enum value (0–6).
    uint8_t momentum = GHOSTTY_MOUSE_MOMENTUM_NONE;
    switch (event.momentumPhase) {
        case NSEventPhaseBegan:       momentum = GHOSTTY_MOUSE_MOMENTUM_BEGAN;       break;
        case NSEventPhaseStationary:  momentum = GHOSTTY_MOUSE_MOMENTUM_STATIONARY;  break;
        case NSEventPhaseChanged:     momentum = GHOSTTY_MOUSE_MOMENTUM_CHANGED;     break;
        case NSEventPhaseEnded:       momentum = GHOSTTY_MOUSE_MOMENTUM_ENDED;       break;
        case NSEventPhaseCancelled:   momentum = GHOSTTY_MOUSE_MOMENTUM_CANCELLED;   break;
        case NSEventPhaseMayBegin:    momentum = GHOSTTY_MOUSE_MOMENTUM_MAY_BEGIN;   break;
        default:                      momentum = GHOSTTY_MOUSE_MOMENTUM_NONE;        break;
    }
    mods |= (int32_t)momentum << 1;   // bits 1–3

    return (ghostty_input_scroll_mods_t)mods;
}

// ---------------------------------------------------------------------------
// Return the text to pass in ghostty_input_key_s.text:
//   • nil if no characters
//   • nil if single control character (< 0x20) — libghostty encodes these itself
//   • nil if single PUA codepoint (0xF700–0xF8FF) — these are AppKit function-key
//     private-use sentinels, not real text
//   • otherwise: the characters string (caller must use withCString lifetime)
// ---------------------------------------------------------------------------

static NSString *ghosttyTextForEvent(NSEvent *event) {
    NSString *chars = event.characters;
    if (!chars || chars.length == 0) return nil;

    if (chars.length == 1) {
        unichar c = [chars characterAtIndex:0];
        if (c < 0x20) return nil;               // control char
        if (c >= 0xF700 && c <= 0xF8FF) return nil; // PUA (function keys etc.)
    }

    return chars;
}

// ---------------------------------------------------------------------------
// keyDown: — build ghostty_input_key_s and forward to libghostty.
// After that, call interpretKeyEvents: so the NSTextInputClient chain runs,
// which fires insertText: for normal printable characters (used by IME).
// ---------------------------------------------------------------------------

- (void)keyDown:(NSEvent *)event {
    if (!self.surface) {
        [self interpretKeyEvents:@[event]];
        return;
    }

    ghostty_input_action_e action = event.isARepeat
        ? GHOSTTY_ACTION_REPEAT
        : GHOSTTY_ACTION_PRESS;

    ghostty_input_key_s key_ev = {};
    key_ev.action          = action;
    key_ev.mods            = modsFromEvent(event);
    key_ev.consumed_mods   = (ghostty_input_mods_e)(key_ev.mods &
                                ~(GHOSTTY_MODS_CTRL | GHOSTTY_MODS_SUPER));
    key_ev.keycode         = (uint32_t)event.keyCode; // raw macOS vkey
    key_ev.composing       = false;
    key_ev.unshifted_codepoint = 0;
    key_ev.text            = nullptr;

    // Compute unshifted codepoint (codepoint with no modifiers applied).
    NSString *bare = [event charactersByApplyingModifiers:0];
    if (bare && bare.length > 0) {
        NSUInteger cp = [bare characterAtIndex:0];
        if (cp < 0xD800 || cp > 0xDFFF) { // exclude surrogates
            key_ev.unshifted_codepoint = (uint32_t)cp;
        }
    }

    // Include text only for non-control, non-PUA characters.
    NSString *textStr = ghosttyTextForEvent(event);
    if (textStr) {
        const char *cstr = [textStr UTF8String];
        if (cstr) {
            key_ev.text = cstr;
            ghostty_surface_key(self.surface, key_ev);
            key_ev.text = nullptr; // pointer no longer valid after return
        } else {
            ghostty_surface_key(self.surface, key_ev);
        }
    } else {
        ghostty_surface_key(self.surface, key_ev);
    }

    // Run the AppKit input manager so IME / dead keys / NSTextInputClient fire.
    // We set inKeyDown = YES so that insertText:replacementRange: knows the text
    // is already handled via ghostty_surface_key (.text field) and should not
    // double-send via ghostty_surface_text.
    self.inKeyDown = YES;
    [self interpretKeyEvents:@[event]];
    self.inKeyDown = NO;
}

// ---------------------------------------------------------------------------
// keyUp:
// ---------------------------------------------------------------------------

- (void)keyUp:(NSEvent *)event {
    if (!self.surface) return;

    ghostty_input_key_s key_ev = {};
    key_ev.action        = GHOSTTY_ACTION_RELEASE;
    key_ev.mods          = modsFromEvent(event);
    key_ev.consumed_mods = (ghostty_input_mods_e)0;
    key_ev.keycode       = (uint32_t)event.keyCode;
    key_ev.composing     = false;
    key_ev.text          = nullptr;
    key_ev.unshifted_codepoint = 0;

    ghostty_surface_key(self.surface, key_ev);
}

// ---------------------------------------------------------------------------
// updateTrackingAreas — install a tracking area that covers the entire view.
//
// This fires mouseMoved: and mouseEntered:/mouseExited: events, which are
// needed for:
//   • cursor shape updates (GHOSTTY_ACTION_MOUSE_SHAPE via action_cb)
//   • terminal mouse-tracking mode (OSC mouse extensions used by vim, htop…)
//   • hover-aware URL detection
//
// Options mirror Ghostty's SurfaceView_AppKit.swift updateTrackingAreas().
// .activeAlways ensures mouse reports fire even when the window isn't key
// (important for focus-follows-mouse and multi-pane terminal managers).
// ---------------------------------------------------------------------------

- (void)updateTrackingAreas {
    // Remove all existing tracking areas before installing new ones.
    for (NSTrackingArea *ta in [self.trackingAreas copy]) {
        [self removeTrackingArea:ta];
    }

    NSTrackingAreaOptions opts =
        NSTrackingMouseEnteredAndExited |
        NSTrackingMouseMoved           |
        NSTrackingInVisibleRect        |  // only events in non-obscured rect
        NSTrackingActiveAlways;           // fire even when not key window

    NSTrackingArea *ta = [[NSTrackingArea alloc]
        initWithRect:self.frame
             options:opts
               owner:self
            userInfo:nil];
    [self addTrackingArea:ta];
}

// ---------------------------------------------------------------------------
// mouseDown: — make the view first responder (keeps keyboard working) AND
// forward the press to Ghostty so TUI apps that use click-to-position (vim,
// less, htop, etc.) respond to the click.
// ---------------------------------------------------------------------------

- (void)mouseDown:(NSEvent *)event {
    [self.window makeFirstResponder:self];
    if (!self.surface) return;

    GhosttyMousePos pos = ghosttyPosForEvent(event, self);
    ghostty_surface_mouse_pos(self.surface, pos.x, pos.y, modsFromEvent(event));
    ghostty_surface_mouse_button(self.surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_LEFT, modsFromEvent(event));
}

- (void)mouseUp:(NSEvent *)event {
    if (!self.surface) return;
    GhosttyMousePos pos = ghosttyPosForEvent(event, self);
    ghostty_surface_mouse_pos(self.surface, pos.x, pos.y, modsFromEvent(event));
    ghostty_surface_mouse_button(self.surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_LEFT, modsFromEvent(event));
}

// ---------------------------------------------------------------------------
// Mouse movement — report position for selection (drag) and hover tracking.
// mouseDragged: / rightMouseDragged: / otherMouseDragged: all call through
// to the shared helper so Ghostty sees continuous position updates for
// click-drag selection regardless of which button is held.
// ---------------------------------------------------------------------------

- (void)sendMousePos:(NSEvent *)event {
    if (!self.surface) return;
    GhosttyMousePos pos = ghosttyPosForEvent(event, self);
    ghostty_surface_mouse_pos(self.surface, pos.x, pos.y, modsFromEvent(event));
}

- (void)mouseMoved:(NSEvent *)event    { [self sendMousePos:event]; }
- (void)mouseDragged:(NSEvent *)event  { [self sendMousePos:event]; }
- (void)rightMouseDragged:(NSEvent *)event { [self sendMousePos:event]; }
- (void)otherMouseDragged:(NSEvent *)event { [self sendMousePos:event]; }

// mouseEntered/mouseExited: reset the cursor position in Ghostty.
// On exit we send -1/-1 to tell Ghostty the cursor has left the viewport
// (mirrors Ghostty SurfaceView_AppKit.swift mouseExited behaviour).

- (void)mouseEntered:(NSEvent *)event {
    if (!self.surface) { [super mouseEntered:event]; return; }
    GhosttyMousePos pos = ghosttyPosForEvent(event, self);
    ghostty_surface_mouse_pos(self.surface, pos.x, pos.y, modsFromEvent(event));
    [super mouseEntered:event];
}

- (void)mouseExited:(NSEvent *)event {
    if (!self.surface) { [super mouseExited:event]; return; }
    // Skip the -1/-1 reset while a button is held (drag case).
    if (NSEvent.pressedMouseButtons != 0) return;
    ghostty_surface_mouse_pos(self.surface, -1.0, -1.0, modsFromEvent(event));
    [super mouseExited:event];
}

// ---------------------------------------------------------------------------
// Right mouse button — forward to Ghostty first; fall through to super
// so macOS still shows the context menu if Ghostty doesn't consume it.
// (mirrors Ghostty SurfaceView_AppKit.swift rightMouseDown: pattern)
// ---------------------------------------------------------------------------

- (void)rightMouseDown:(NSEvent *)event {
    if (!self.surface) { [super rightMouseDown:event]; return; }
    GhosttyMousePos pos = ghosttyPosForEvent(event, self);
    ghostty_surface_mouse_pos(self.surface, pos.x, pos.y, modsFromEvent(event));
    bool consumed = ghostty_surface_mouse_button(
        self.surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_RIGHT, modsFromEvent(event));
    if (!consumed) [super rightMouseDown:event];
}

- (void)rightMouseUp:(NSEvent *)event {
    if (!self.surface) { [super rightMouseUp:event]; return; }
    GhosttyMousePos pos = ghosttyPosForEvent(event, self);
    ghostty_surface_mouse_pos(self.surface, pos.x, pos.y, modsFromEvent(event));
    bool consumed = ghostty_surface_mouse_button(
        self.surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_RIGHT, modsFromEvent(event));
    if (!consumed) [super rightMouseUp:event];
}

// ---------------------------------------------------------------------------
// Other mouse buttons (middle = buttonNumber 2, back/forward = 3/4, etc.)
// Map NSEvent.buttonNumber → ghostty_input_mouse_button_e exactly as
// Ghostty.Input.swift MouseButton.init(fromNSEventButtonNumber:) does.
// ---------------------------------------------------------------------------

static ghostty_input_mouse_button_e ghosttyButtonForNSEventNumber(NSInteger btn) {
    switch (btn) {
        case 0:  return GHOSTTY_MOUSE_LEFT;
        case 1:  return GHOSTTY_MOUSE_RIGHT;
        case 2:  return GHOSTTY_MOUSE_MIDDLE;
        case 3:  return GHOSTTY_MOUSE_EIGHT;   // back
        case 4:  return GHOSTTY_MOUSE_NINE;    // forward
        case 5:  return GHOSTTY_MOUSE_SIX;
        case 6:  return GHOSTTY_MOUSE_SEVEN;
        case 7:  return GHOSTTY_MOUSE_FOUR;
        case 8:  return GHOSTTY_MOUSE_FIVE;
        case 9:  return GHOSTTY_MOUSE_TEN;
        case 10: return GHOSTTY_MOUSE_ELEVEN;
        default: return GHOSTTY_MOUSE_UNKNOWN;
    }
}

- (void)otherMouseDown:(NSEvent *)event {
    if (!self.surface) return;
    GhosttyMousePos pos = ghosttyPosForEvent(event, self);
    ghostty_surface_mouse_pos(self.surface, pos.x, pos.y, modsFromEvent(event));
    ghostty_surface_mouse_button(self.surface, GHOSTTY_MOUSE_PRESS,
        ghosttyButtonForNSEventNumber(event.buttonNumber), modsFromEvent(event));
}

- (void)otherMouseUp:(NSEvent *)event {
    if (!self.surface) return;
    GhosttyMousePos pos = ghosttyPosForEvent(event, self);
    ghostty_surface_mouse_pos(self.surface, pos.x, pos.y, modsFromEvent(event));
    ghostty_surface_mouse_button(self.surface, GHOSTTY_MOUSE_RELEASE,
        ghosttyButtonForNSEventNumber(event.buttonNumber), modsFromEvent(event));
}

// ---------------------------------------------------------------------------
// scrollWheel: — forward to ghostty_surface_mouse_scroll.
//
// Delta values: use event.scrollingDeltaX/Y (logical points, not pixels).
// For precise (trackpad) events, multiply by 2.0 — same as Ghostty upstream.
// Scroll mods are packed per the ScrollMods bitmask (see scrollModsForEvent).
// ---------------------------------------------------------------------------

- (void)scrollWheel:(NSEvent *)event {
    if (!self.surface) return;

    double x = event.scrollingDeltaX;
    double y = event.scrollingDeltaY;

    if (event.hasPreciseScrollingDeltas) {
        // Trackpad / Magic Mouse — 2x multiplier (matches Ghostty upstream).
        x *= 2.0;
        y *= 2.0;
    }

    ghostty_input_scroll_mods_t scrollMods = scrollModsForEvent(event);
    ghostty_surface_mouse_scroll(self.surface, x, y, scrollMods);
}

// ---------------------------------------------------------------------------
// NSTextInputClient — minimal implementation
//
// insertText:replacementRange: fires when AppKit has committed text (after
// any IME composition or for direct ASCII input via interpretKeyEvents:).
// We forward to ghostty_surface_text so the terminal sees it.
//
// NOTE: For normal ASCII typing this path runs IN ADDITION to the
// ghostty_surface_key call in keyDown:.  Ghostty deduplicates internally
// (the key event carries the text in its .text field; ghostty_surface_text
// is for cases where the text comes from outside key events, e.g. paste or
// IME commit). Both paths are needed because some key combos go only through
// one path depending on the IME state.
//
// CJK / dead-key full composition (setMarkedText: / syncPreedit) is deferred.
// ghostty_surface_preedit and ghostty_surface_ime_point are not yet wired.
// ---------------------------------------------------------------------------

- (void)insertText:(id)string replacementRange:(NSRange)replacementRange {
    if (!self.surface) return;

    // If we are inside keyDown:, ghostty_surface_key already forwarded the text
    // via the .text field on the key event struct.  Sending it again via
    // ghostty_surface_text would double-encode every keystroke (e.g., "l" → "ll").
    // Only forward here when interpretKeyEvents: fires insertText: from OUTSIDE a
    // key event — which is the IME commit path (CJK, dead keys, paste via IME).
    if (self.inKeyDown) return;

    NSString *s = [string isKindOfClass:[NSAttributedString class]]
        ? [(NSAttributedString *)string string]
        : (NSString *)string;

    const char *bytes = [s UTF8String];
    if (!bytes) return;
    NSUInteger len = strlen(bytes);
    if (len == 0) return;

    ghostty_surface_text(self.surface, bytes, (uintptr_t)len);
}

- (void)doCommandBySelector:(SEL)selector {
    // Suppress NSBeep for unhandled commands.
    // keyDown: already forwarded the raw key event to ghostty_surface_key,
    // so control keys (Return, Tab, Backspace, arrows, Escape, Ctrl+C etc.)
    // are already encoded by libghostty from the key event.
    // We intentionally do nothing here rather than double-encoding.
    (void)selector;
}

// ---------------------------------------------------------------------------
// NSTextInputClient stubs — marked text / IME
// CJK composition and dead-key preedit are deferred to a follow-up commit.
// ---------------------------------------------------------------------------

- (BOOL)hasMarkedText { return NO; }
- (NSRange)markedRange { return NSMakeRange(NSNotFound, 0); }
- (NSRange)selectedRange { return NSMakeRange(NSNotFound, 0); }
- (void)setMarkedText:(id)string
        selectedRange:(NSRange)selectedRange
     replacementRange:(NSRange)replacementRange {
    (void)string; (void)selectedRange; (void)replacementRange;
}
- (void)unmarkText {}
- (NSArray<NSAttributedStringKey> *)validAttributesForMarkedText { return @[]; }
- (NSAttributedString *)attributedSubstringForProposedRange:(NSRange)range
                                                actualRange:(NSRangePointer)actualRange {
    (void)range; (void)actualRange;
    return nil;
}
- (NSUInteger)characterIndexForPoint:(NSPoint)point {
    (void)point;
    return 0;
}
- (NSRect)firstRectForCharacterRange:(NSRange)range
                         actualRange:(NSRangePointer)actualRange {
    (void)range; (void)actualRange;
    return NSZeroRect;
}

@end

// ---------------------------------------------------------------------------
// GhosttySurfaceEntry + g_surfaces
// ---------------------------------------------------------------------------

struct GhosttySurfaceEntry {
    ghostty_surface_t surface;
    OrpheusGhosttyView* __strong view;
    CVDisplayLinkRef displayLink;
    BOOL isAttached;              // YES = view is in contentView superview, displayLink running
    CGRect lastRect;              // last known CSS rect (top-left origin, pre-flip)
    CGFloat lastScale;
};

// workspaceId → entry
static std::map<std::string, GhosttySurfaceEntry> g_surfaces;

// ---------------------------------------------------------------------------
// Runtime callbacks (required by ghostty_runtime_config_s)
// ---------------------------------------------------------------------------

static void wakeup_cb(void* /*userdata*/) {
    // Called from Ghostty's IO thread — do not call ghostty_* here.
}

static bool action_cb(ghostty_app_t /*app*/,
                      ghostty_target_s /*target*/,
                      ghostty_action_s action) {
    if (action.tag == GHOSTTY_ACTION_SET_TITLE) {
        const char* title = action.action.set_title.title;
        NSLog(@"[ghostty-native] SET_TITLE: %s", title ? title : "(null)");
    }

    return false;
}

static bool read_clipboard_cb(void* /*userdata*/,
                               ghostty_clipboard_e /*type*/,
                               void* /*state*/) {
    return false;
}

static void confirm_read_clipboard_cb(void* /*userdata*/,
                                       const char* /*text*/,
                                       void* /*state*/,
                                       ghostty_clipboard_request_e /*req*/) {}

static void write_clipboard_cb(void* /*userdata*/,
                                ghostty_clipboard_e /*type*/,
                                const ghostty_clipboard_content_s* /*content*/,
                                size_t /*count*/,
                                bool /*confirm*/) {}

static void close_surface_cb(void* /*userdata*/, bool process_alive) {
    NSLog(@"[ghostty-native] close_surface_cb process_alive=%d", (int)process_alive);
}

// ---------------------------------------------------------------------------
// Global app state (lazily inited on first mount)
// GhosttySurfaceEntry and g_surfaces are declared above the runtime callbacks
// so that action_cb can iterate g_surfaces for the PWD auto-launch guard.
// ---------------------------------------------------------------------------

static ghostty_app_t    g_app    = nullptr;
static ghostty_config_t g_config = nullptr;
static std::atomic<bool> g_inited{false};

// ---------------------------------------------------------------------------
// Coordinate helpers
// ---------------------------------------------------------------------------

// Convert a CSS rect {x, y(top), w, h} measured from window top-left into
// an NSRect measured from window bottom-left (AppKit natural coordinates).
// parentHeight is the height of the parent NSView (contentView).
static NSRect cssRectToAppKit(double x, double y, double w, double h,
                               double parentHeight) {
    // AppKit Y origin is at the bottom; CSS Y is at the top.
    double appKitY = parentHeight - y - h;
    return NSMakeRect(x, appKitY, w, h);
}

// ---------------------------------------------------------------------------
// CVDisplayLink callback — fires on a private thread
// ---------------------------------------------------------------------------

static CVReturn displayLinkCallback(CVDisplayLinkRef /*displayLink*/,
                                    const CVTimeStamp* /*inNow*/,
                                    const CVTimeStamp* /*inOutputTime*/,
                                    CVOptionFlags /*flagsIn*/,
                                    CVOptionFlags* /*flagsOut*/,
                                    void* displayLinkContext) {
    // displayLinkContext is the ghostty_surface_t pointer.
    ghostty_surface_t surface = reinterpret_cast<ghostty_surface_t>(displayLinkContext);

    // Dispatch draw to the AppKit main thread.
    dispatch_async(dispatch_get_main_queue(), ^{
        ghostty_surface_draw(surface);
    });

    return kCVReturnSuccess;
}

// ---------------------------------------------------------------------------
// Lazy init — called once on the first mount
// ---------------------------------------------------------------------------

static bool ensureApp() {
    if (g_inited.load(std::memory_order_acquire)) return true;

    NSLog(@"[ghostty-native] initialising ghostty (one-time)");

    const char* resDir = getenv("GHOSTTY_RESOURCES_DIR");
    if (resDir) {
        NSLog(@"[ghostty-native] GHOSTTY_RESOURCES_DIR=%s", resDir);
    } else {
        NSLog(@"[ghostty-native] GHOSTTY_RESOURCES_DIR not set — Ghostty will auto-walk");
    }

    int rc = ghostty_init(0, nullptr);
    if (rc != GHOSTTY_SUCCESS) {
        NSLog(@"[ghostty-native] ghostty_init FAILED rc=%d", rc);
        return false;
    }

    g_config = ghostty_config_new();
    if (!g_config) {
        NSLog(@"[ghostty-native] ghostty_config_new FAILED");
        return false;
    }

    // Match the upstream Ghostty.app config-load sequence (Ghostty.Config.swift):
    //   1. ghostty_config_load_default_files  — discovers ~/.config/ghostty/config
    //      and ~/Library/Application Support/com.mitchellh.ghostty/config
    //   2. ghostty_config_load_recursive_files — resolves any `theme = ...` or
    //      `config-file = ...` directives found in the loaded files
    //   3. ghostty_config_finalize             — fills in defaults
    //
    // We intentionally skip ghostty_config_load_cli_args (not meaningful here).
    // The user's preferences from their installed Ghostty.app (font, theme,
    // palette, keybinds, etc.) now flow into this surface automatically.
    NSLog(@"[ghostty-native] loading user config (default files)");
    ghostty_config_load_default_files(g_config);

    NSLog(@"[ghostty-native] loading recursive config files (theme resolution)");
    ghostty_config_load_recursive_files(g_config);

    ghostty_config_finalize(g_config);

    // Log any config diagnostics so theme/parse errors are visible in Console.app.
    uint32_t diagCount = ghostty_config_diagnostics_count(g_config);
    if (diagCount > 0) {
        NSLog(@"[ghostty-native] %u config diagnostic(s):", (unsigned)diagCount);
        for (uint32_t i = 0; i < diagCount; i++) {
            ghostty_diagnostic_s diag = ghostty_config_get_diagnostic(g_config, i);
            NSLog(@"[ghostty-native]   diag[%u]: %s", (unsigned)i,
                  diag.message ? diag.message : "(null)");
        }
    } else {
        NSLog(@"[ghostty-native] config loaded cleanly (0 diagnostics)");
    }

    ghostty_runtime_config_s rt = {};
    rt.userdata = nullptr;
    rt.supports_selection_clipboard = false;
    rt.wakeup_cb = wakeup_cb;
    rt.action_cb = action_cb;
    rt.read_clipboard_cb = read_clipboard_cb;
    rt.confirm_read_clipboard_cb = confirm_read_clipboard_cb;
    rt.write_clipboard_cb = write_clipboard_cb;
    rt.close_surface_cb = close_surface_cb;

    g_app = ghostty_app_new(&rt, g_config);
    if (!g_app) {
        NSLog(@"[ghostty-native] ghostty_app_new FAILED");
        return false;
    }

    g_inited.store(true, std::memory_order_release);
    NSLog(@"[ghostty-native] ghostty app ready");
    return true;
}

// ---------------------------------------------------------------------------
// NAPI: mount(handleBuffer, { workspaceId, rect, scaleFactor, cwd? })
//       → { workspaceId, created: bool }
//
// If an entry already exists for this workspaceId:
//   • isAttached == NO → re-attach (wake up surface, add to superview).
//   • isAttached == YES → defensive resize + log warning (should not happen).
// If no entry exists → create surface from scratch.
// ---------------------------------------------------------------------------

static Napi::Value Mount(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2) {
        Napi::TypeError::New(env, "mount requires 2 args").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Arg 0 — native window handle (Buffer of pointer bytes)
    if (!info[0].IsBuffer()) {
        Napi::TypeError::New(env, "arg 0 must be Buffer").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    Napi::Buffer<uint8_t> handleBuf = info[0].As<Napi::Buffer<uint8_t>>();
    void* rawHandle = nullptr;
    size_t copyLen = std::min(handleBuf.ByteLength(), sizeof(rawHandle));
    memcpy(&rawHandle, handleBuf.Data(), copyLen);
    NSView* contentView = (__bridge NSView*)rawHandle;

    // Arg 1 — options { workspaceId, rect: {x,y,w,h}, scaleFactor, cwd? }
    if (!info[1].IsObject()) {
        Napi::TypeError::New(env, "arg 1 must be object {workspaceId,rect,scaleFactor,cwd?}").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    Napi::Object opts = info[1].As<Napi::Object>();

    std::string workspaceId = opts.Get("workspaceId").As<Napi::String>().Utf8Value();

    Napi::Object rectObj = opts.Get("rect").As<Napi::Object>();
    double rx = rectObj.Get("x").As<Napi::Number>().DoubleValue();
    double ry = rectObj.Get("y").As<Napi::Number>().DoubleValue();
    double rw = rectObj.Get("w").As<Napi::Number>().DoubleValue();
    double rh = rectObj.Get("h").As<Napi::Number>().DoubleValue();

    double scaleFactor = opts.Get("scaleFactor").As<Napi::Number>().DoubleValue();

    // cwd — optional; if undefined fall back to $HOME then /tmp.
    std::string cwdStr;
    Napi::Value cwdVal = opts.Get("cwd");
    if (cwdVal.IsString()) {
        cwdStr = cwdVal.As<Napi::String>().Utf8Value();
    }

    // Lazy init Ghostty
    if (!ensureApp()) {
        Napi::Error::New(env, "ghostty init failed").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    auto it = g_surfaces.find(workspaceId);

    if (it != g_surfaces.end()) {
        // Entry exists — this is a re-attach (workspace nav back).
        GhosttySurfaceEntry& entry = it->second;

        if (entry.isAttached) {
            // Should not happen in normal flow — log warning, just resize.
            NSLog(@"[ghostty-native] mount workspaceId=%s: already attached (defensive resize)",
                  workspaceId.c_str());
            double parentH = contentView.bounds.size.height;
            NSRect newFrame = cssRectToAppKit(rx, ry, rw, rh, parentH);
            [entry.view setFrame:newFrame];
            uint32_t physW = (uint32_t)(rw * scaleFactor);
            uint32_t physH = (uint32_t)(rh * scaleFactor);
            ghostty_surface_set_size(entry.surface, physW, physH);
            ghostty_surface_set_content_scale(entry.surface, scaleFactor, scaleFactor);
        } else {
            // Re-attach: add back to superview, wake display link.
            NSLog(@"[ghostty-native] mount workspaceId=%s: re-attaching existing surface",
                  workspaceId.c_str());

            double parentH = contentView.bounds.size.height;
            NSRect newFrame = cssRectToAppKit(rx, ry, rw, rh, parentH);
            [entry.view setFrame:newFrame];
            [contentView addSubview:entry.view];

            // Wake the renderer — surface is no longer occluded.
            ghostty_surface_set_occlusion(entry.surface, false);

            // Re-start the display link.
            CVDisplayLinkStart(entry.displayLink);

            // Update size in case the window was resized while hidden.
            uint32_t physW = (uint32_t)(rw * scaleFactor);
            uint32_t physH = (uint32_t)(rh * scaleFactor);
            ghostty_surface_set_size(entry.surface, physW, physH);
            ghostty_surface_set_content_scale(entry.surface, scaleFactor, scaleFactor);

            // Re-grab first responder.
            dispatch_async(dispatch_get_main_queue(), ^{
                if ([entry.view window]) {
                    [[entry.view window] makeFirstResponder:entry.view];
                }
            });

            entry.lastRect = CGRectMake(rx, ry, rw, rh);
            entry.lastScale = scaleFactor;
            entry.isAttached = YES;
        }

        Napi::Object result = Napi::Object::New(env);
        result.Set("workspaceId", Napi::String::New(env, workspaceId));
        result.Set("created", Napi::Boolean::New(env, false));
        return result;
    }

    // No existing entry — create surface from scratch.
    double parentH = contentView.bounds.size.height;
    NSRect frame = cssRectToAppKit(rx, ry, rw, rh, parentH);

    NSLog(@"[ghostty-native] mount workspaceId=%s: css(%.0f,%.0f,%.0fx%.0f) → appkit(%.0f,%.0f,%.0fx%.0f) parentH=%.0f scale=%.1f",
          workspaceId.c_str(),
          rx, ry, rw, rh, frame.origin.x, frame.origin.y, frame.size.width, frame.size.height, parentH, scaleFactor);

    OrpheusGhosttyView* termView = [[OrpheusGhosttyView alloc] initWithFrame:frame];
    [contentView addSubview:termView];

    // Surface config
    ghostty_surface_config_s surface_cfg = ghostty_surface_config_new();
    surface_cfg.platform_tag = GHOSTTY_PLATFORM_MACOS;
    surface_cfg.platform.macos.nsview = (__bridge void*)termView;
    surface_cfg.userdata = nullptr;
    surface_cfg.backend = GHOSTTY_SURFACE_IO_BACKEND_EXEC;
    surface_cfg.receive_userdata = nullptr;
    surface_cfg.receive_buffer = nullptr;
    surface_cfg.receive_resize = nullptr;
    surface_cfg.scale_factor = scaleFactor;
    surface_cfg.font_size = 13.0;

    // Use the cwd passed from JS; fall back to $HOME then /tmp.
    const char* home = getenv("HOME");
    const char* fallbackCwd = home ? home : "/tmp";
    surface_cfg.working_directory = cwdStr.empty() ? fallbackCwd : cwdStr.c_str();

    // Spawn the bundled wrapper script as the surface process.
    //
    // orpheus-claude.sh runs claude inside a zsh login session and, when claude
    // exits, exec's an interactive zsh so the terminal stays alive for further use.
    //
    // Ghostty on macOS wraps the command string via login(1):
    //   /usr/bin/login -flp <username> /bin/bash --noprofile --norc -c "exec -l <script>"
    // This gives a full login session so ~/.zprofile, ~/.zshrc, etc. are sourced
    // and ANTHROPIC_API_KEY / PATH are available.  The wrapper's #!/bin/zsh -l
    // shebang also sources login files before running claude.
    //
    // Path resolution: use [[NSBundle mainBundle] resourcePath] which maps to
    // Contents/Resources/ in the packaged app.  Fall back to bundlePath +
    // /Contents/Resources if resourcePath returns an unexpected value.
    NSString* resourcePath = [[NSBundle mainBundle] resourcePath];
    if (!resourcePath || resourcePath.length == 0) {
        // Fallback: derive from bundlePath.
        resourcePath = [[[NSBundle mainBundle] bundlePath]
                        stringByAppendingPathComponent:@"Contents/Resources"];
    }
    NSString* wrapperNSPath = [resourcePath
                               stringByAppendingPathComponent:@"orpheus-claude.sh"];
    const char* commandPath = [wrapperNSPath UTF8String];
    NSLog(@"[ghostty-native] wrapper script path: %@", wrapperNSPath);

    surface_cfg.command = commandPath;

    surface_cfg.env_vars = nullptr;
    surface_cfg.env_var_count = 0;
    surface_cfg.initial_input = nullptr;
    surface_cfg.wait_after_command = true;  // keep surface alive (academic: exec zsh never exits)
    surface_cfg.context = GHOSTTY_SURFACE_CONTEXT_WINDOW;

    NSLog(@"[ghostty-native] surface_new command=%s cwd=%s (from_js=%s)",
          commandPath,
          surface_cfg.working_directory,
          cwdStr.empty() ? "(fallback)" : "yes");

    ghostty_surface_t surface = nullptr;
    @try {
        surface = ghostty_surface_new(g_app, &surface_cfg);
    } @catch (NSException* ex) {
        NSLog(@"[ghostty-native] ghostty_surface_new EXCEPTION: %@", ex.reason);
        [termView removeFromSuperview];
        Napi::Error::New(env, std::string("ghostty_surface_new threw: ") +
                         [[ex reason] UTF8String]).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    if (!surface) {
        [termView removeFromSuperview];
        Napi::Error::New(env, "ghostty_surface_new returned NULL").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Wire the surface pointer back into the view so keyDown:/keyUp: can forward events.
    termView.surface = surface;

    // Make the terminal first responder so the user can type immediately.
    dispatch_async(dispatch_get_main_queue(), ^{
        if ([termView window]) {
            [[termView window] makeFirstResponder:termView];
        }
    });

    // Set initial size (physical pixels).
    uint32_t physW = (uint32_t)(rw * scaleFactor);
    uint32_t physH = (uint32_t)(rh * scaleFactor);
    ghostty_surface_set_size(surface, physW, physH);
    ghostty_surface_set_content_scale(surface, scaleFactor, scaleFactor);

    // Create CVDisplayLink — one per workspace, lives until destroy().
    // The display link is stopped/started on hide/mount but never recreated.
    CVDisplayLinkRef displayLink = nullptr;
    CVDisplayLinkCreateWithActiveCGDisplays(&displayLink);
    CVDisplayLinkSetOutputCallback(displayLink, displayLinkCallback,
                                   reinterpret_cast<void*>(surface));
    CVDisplayLinkStart(displayLink);

    // Store entry — view is retained by the map (ARC __strong).
    GhosttySurfaceEntry entry;
    entry.surface     = surface;
    entry.view        = termView;
    entry.displayLink = displayLink;
    entry.isAttached  = YES;
    entry.lastRect    = CGRectMake(rx, ry, rw, rh);
    entry.lastScale   = scaleFactor;
    g_surfaces[workspaceId] = entry;

    NSLog(@"[ghostty-native] mount workspaceId=%s created (physPx %ux%u)",
          workspaceId.c_str(), physW, physH);

    Napi::Object result = Napi::Object::New(env);
    result.Set("workspaceId", Napi::String::New(env, workspaceId));
    result.Set("created", Napi::Boolean::New(env, true));
    return result;
}

// ---------------------------------------------------------------------------
// NAPI: hide(workspaceId) → void
//
// Removes the NSView from its superview and stops the display link.
// The surface + shell process keep running in the background.
// isAttached is set to NO. View is retained in the map entry.
// ---------------------------------------------------------------------------

static Napi::Value Hide(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "hide requires workspaceId string").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string workspaceId = info[0].As<Napi::String>().Utf8Value();
    auto it = g_surfaces.find(workspaceId);
    if (it == g_surfaces.end()) {
        NSLog(@"[ghostty-native] hide workspaceId=%s: no entry (no-op)", workspaceId.c_str());
        return env.Undefined();
    }

    GhosttySurfaceEntry& entry = it->second;
    if (!entry.isAttached) {
        NSLog(@"[ghostty-native] hide workspaceId=%s: already hidden (no-op)", workspaceId.c_str());
        return env.Undefined();
    }

    NSLog(@"[ghostty-native] hide workspaceId=%s", workspaceId.c_str());

    // Tell Ghostty the surface is now occluded — renderer thread sleeps.
    ghostty_surface_set_occlusion(entry.surface, true);

    // Stop the display link — no more draw dispatches until mount re-attaches.
    CVDisplayLinkStop(entry.displayLink);

    // Remove from view hierarchy — view is retained in the map, not freed.
    [entry.view removeFromSuperview];

    entry.isAttached = NO;
    return env.Undefined();
}

// ---------------------------------------------------------------------------
// NAPI: resize(workspaceId, rect, scaleFactor) → void
//
// If attached: resize the view + notify Ghostty.
// If not attached: cache the rect for next mount.
// ---------------------------------------------------------------------------

static Napi::Value Resize(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 3) {
        Napi::TypeError::New(env, "resize requires 3 args").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string workspaceId = info[0].As<Napi::String>().Utf8Value();
    Napi::Object rectObj = info[1].As<Napi::Object>();
    double rx = rectObj.Get("x").As<Napi::Number>().DoubleValue();
    double ry = rectObj.Get("y").As<Napi::Number>().DoubleValue();
    double rw = rectObj.Get("w").As<Napi::Number>().DoubleValue();
    double rh = rectObj.Get("h").As<Napi::Number>().DoubleValue();
    double scaleFactor = info[2].As<Napi::Number>().DoubleValue();

    auto it = g_surfaces.find(workspaceId);
    if (it == g_surfaces.end()) {
        NSLog(@"[ghostty-native] resize workspaceId=%s: no entry (no-op)", workspaceId.c_str());
        return env.Undefined();
    }

    GhosttySurfaceEntry& entry = it->second;

    // Always cache the latest rect/scale.
    entry.lastRect  = CGRectMake(rx, ry, rw, rh);
    entry.lastScale = scaleFactor;

    if (entry.isAttached) {
        // Update NSView frame (with coordinate flip).
        NSView* parentView = [entry.view superview];
        double parentH = parentView ? parentView.bounds.size.height : rh;
        NSRect newFrame = cssRectToAppKit(rx, ry, rw, rh, parentH);
        [entry.view setFrame:newFrame];

        // Update Ghostty surface size.
        uint32_t physW = (uint32_t)(rw * scaleFactor);
        uint32_t physH = (uint32_t)(rh * scaleFactor);
        ghostty_surface_set_size(entry.surface, physW, physH);
        ghostty_surface_set_content_scale(entry.surface, scaleFactor, scaleFactor);
    }
    // If not attached: rect is cached above; will be applied on next mount.

    return env.Undefined();
}

// ---------------------------------------------------------------------------
// NAPI: destroy(workspaceId) → void
//
// Full teardown — call only on workspace archive or project removal.
// Idempotent: no-op if no entry exists.
//
// Performance design: user-visible cleanup runs synchronously so the IPC
// return is fast (<1ms) and the renderer unblocks immediately. The slow
// part — ghostty_surface_free (terminates the shell and waits for IO drain,
// typically 200ms–2s) — is deferred to the main queue via dispatch_async so
// it runs after this NAPI call returns.  The main thread is still occupied
// during the actual free, but the *perceived* archive is instant because the
// NSView has already been removed from the superview.
// ---------------------------------------------------------------------------

static Napi::Value Destroy(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "destroy requires workspaceId string").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string workspaceId = info[0].As<Napi::String>().Utf8Value();
    auto it = g_surfaces.find(workspaceId);
    if (it == g_surfaces.end()) {
        NSLog(@"[ghostty-native] destroy workspaceId=%s: no entry (no-op)", workspaceId.c_str());
        return env.Undefined();
    }

    NSLog(@"[ghostty-native] destroy workspaceId=%s (sync detach + async free)", workspaceId.c_str());

    // ---- Synchronous, fast — user-visible state disappears immediately ----
    // Move ownership out of the map and erase the entry so any concurrent
    // lookup (e.g. hide() racing with archive) sees no entry.
    GhosttySurfaceEntry doomed = std::move(it->second);
    g_surfaces.erase(it);

    // Detach the view so the workspace appears gone right away.
    // Nil out surface pointer first so any in-flight key events see nullptr
    // instead of soon-to-be-freed memory.
    if (doomed.view) {
        doomed.view.surface = nullptr;
        [doomed.view removeFromSuperview];
    }

    // Stop the display link so no more draw callbacks fire on the
    // to-be-freed surface. (Release is deferred to the async block.)
    if (doomed.displayLink) {
        CVDisplayLinkStop(doomed.displayLink);
    }

    // ---- Asynchronous, slow — process teardown after the IPC return ----
    // ghostty_surface_free MUST run on the main thread per Ghostty's API
    // contract, but it doesn't have to be synchronous with this NAPI call.
    // We allocate a heap copy of doomed so the block owns it cleanly
    // (avoids ObjC++ __block + std::move ARC interaction uncertainty).
    GhosttySurfaceEntry* heap = new GhosttySurfaceEntry(std::move(doomed));
    dispatch_async(dispatch_get_main_queue(), ^{
        if (heap->displayLink) {
            CVDisplayLinkRelease(heap->displayLink);
            heap->displayLink = nullptr;
        }
        if (heap->surface) {
            // Slow: blocks main thread here, but AFTER the IPC call has returned.
            ghostty_surface_free(heap->surface);
            heap->surface = nullptr;
        }
        heap->view = nil; // ARC release; removeFromSuperview already ran
        delete heap;
        NSLog(@"[ghostty-native] destroy workspaceId=<deferred>: surface freed");
    });

    return env.Undefined();
}

// ---------------------------------------------------------------------------
// Module init
// ---------------------------------------------------------------------------

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("mount",   Napi::Function::New(env, Mount));
    exports.Set("hide",    Napi::Function::New(env, Hide));
    exports.Set("resize",  Napi::Function::New(env, Resize));
    exports.Set("destroy", Napi::Function::New(env, Destroy));
    return exports;
}

NODE_API_MODULE(ghostty_native, Init)
