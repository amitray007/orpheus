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
//   hide()    — removeFromSuperview + occlusion; keeps entry alive.
//   destroy() — full teardown; removes from map.
//   Orpheus quit → process exit GCs everything naturally.
//
// Threading model:
//   • NAPI handlers run on the main thread — all ghostty_* calls here are safe.
//   • ghostty's Metal renderer owns its own internal CVDisplayLink (created in
//     renderer/generic.zig:loopEnter) that fires on a private renderer thread,
//     notifying renderer.Thread's draw_now async → drawFrame(true).  This drives
//     all continuous rendering autonomously at vsync.  We do NOT need a second
//     host-side CVDisplayLink.  ghostty_surface_draw is called only for one-shot
//     events where an immediate sync draw is required (mount, resize).

#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>
#import <QuartzCore/QuartzCore.h>

#include <string>
#include <map>
#include <atomic>
#include <unistd.h>

// GhosttyKit C API
#include "ghostty.h"

// node-addon-api (C++ NAPI wrapper)
#include <napi.h>

// libuv — needed to schedule ghostty_app_tick() on the JS main loop from the
// Ghostty IO thread's wakeup_cb. See addon.mm:Init for setup.
#include <uv.h>

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
//   • ghostty_surface_mouse_pos expects top-left origin coords (y=0 at top of view).
//   • OrpheusGhosttyView has isFlipped = YES, so convertPoint:fromView:nil already
//     returns top-left origin — no additional flip is needed or correct.
//   • Ghostty's own SurfaceView_AppKit.swift is NOT flipped (default AppKit = bottom-left
//     origin), so IT applies `frame.height - pos.y` to flip to top-left before the API
//     call. We must NOT mirror that flip because our starting point is already top-left.
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
@property (nonatomic, copy) NSString* workspaceId;
@end

// Declared here (before @implementation OrpheusGhosttyView) so handleOcclusionChange:
// can reference them. Mirrored from the title TSFN pattern further below.
static Napi::ThreadSafeFunction g_occlusionTSFN;
static bool g_occlusionTSFNActive = false;

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

// Chromium-sanctioned hit-test bypass. RenderWidgetHostViewCocoa's
// -shouldIgnoreMouseEvent: walks up the AppKit superview chain at the click
// location looking for any view that responds to -nonWebContentView. When it
// finds one (us), it forwards the event to the standard responder chain
// instead of routing into Blink. Result: mouse events in the terminal region
// land on our keyDown:/mouseDown:/... handlers even though the WebContents
// NSView is z-ordered above us. No method swizzling required.
//
// Source: content/app_shim_remote_cocoa/render_widget_host_view_cocoa.mm
// (the same hook AppKit sheets and Chromium autofill popovers rely on).
- (BOOL)nonWebContentView {
    return YES;
}

// NOTE: file-drop-to-terminal — with the terminal as the BOTTOM sibling,
// AppKit picks the WebContents as the drag destination for file URLs
// (it registers for HTML5 file drag at the Chromium layer). The
// drag-forwarding swizzles in the #if 0 block below would fix this but
// are disabled pending on-device verification. If file-drop-to-terminal
// is broken, enable those swizzles (omitting the hitTest swizzle since
// nonWebContentView handles mouse routing).

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
//   2. convertPoint:fromView:nil → view-local coords
//
// Coordinate system explanation:
//   • OrpheusGhosttyView has isFlipped = YES, so convertPoint:fromView:nil
//     already returns top-left origin coords (y=0 at the top of the view).
//   • ghostty_surface_mouse_pos ALSO expects top-left origin coords.
//     Evidence: Ghostty's own SurfaceView_AppKit.swift (non-flipped NSView,
//     so its convertPoint gives BOTTOM-left origin) applies `frame.height - pos.y`
//     to flip from bottom-left to top-left before calling the API.
//   • Therefore: our view, already in top-left origin, must NOT apply the
//     extra flip. Applying it would double-invert: top-left → bottom-left,
//     making clicks at the top of the terminal land at the bottom and vice versa.
//
// Returns a struct so both x and y can be passed with a single call.
// ---------------------------------------------------------------------------

struct GhosttyMousePos { double x; double y; };

static GhosttyMousePos ghosttyPosForEvent(NSEvent *event, OrpheusGhosttyView *view) {
    NSPoint local = [view convertPoint:event.locationInWindow fromView:nil];
    // local is already in top-left origin (isFlipped=YES). Do NOT re-flip.
    return { local.x, local.y };
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
        if (c < 0x20 || c == 0x7f) return nil;  // C0 control char or DEL (0x7f) — libghostty encodes these from the keycode
        if (c >= 0xF700 && c <= 0xF8FF) return nil; // PUA (function keys etc.)
    }

    return chars;
}

// ---------------------------------------------------------------------------
// performKeyEquivalent: — intercept specific key combos before the macOS app
// menu or OS consumes them.
//
// Handled cases:
//   • Cmd+C / Cmd+V / Cmd+X (+ Shift variants) — clipboard triad; forwarded
//     to keyDown: before the Edit menu binds them.
//   • Control+Return — pass through verbatim; macOS would otherwise trigger
//     the default context menu action. Ref: SurfaceView_AppKit.swift ~1280-1287.
//   • Control+/ — remap to Control+_ to avoid the macOS system beep.
//     Ref: SurfaceView_AppKit.swift ~1289-1297.
//
// Synthetic events (timestamp == 0) are silently ignored in the default path
// to avoid double-encoding synthetic keys (e.g. the "escape" AppKit generates
// for Cmd+Period → cancel:). Ref: SurfaceView_AppKit.swift ~1300-1310.
// ---------------------------------------------------------------------------
- (BOOL)performKeyEquivalent:(NSEvent *)event {
    if (!self.surface) return NO;
    NSWindow* win = [self window];
    if (!win || [win firstResponder] != self) return NO;

    NSEventModifierFlags mods = event.modifierFlags;
    NSString* charsIgn = event.charactersIgnoringModifiers;
    if (charsIgn.length != 1) return NO;
    unichar c = [charsIgn characterAtIndex:0];

    // --- Control+Return: pass through so macOS menu doesn't swallow it ---
    if (c == '\r' && (mods & NSEventModifierFlagControl)) {
        // Build a synthetic key event with characters = "\r" (same as the
        // reference) so that ghostty's key encoder receives the correct text.
        // We reuse the event directly — it already carries \r as the keycode.
        [self keyDown:event];
        return YES;
    }

    // --- Control+/ → remap to Control+_ (avoids macOS system beep) ---
    if (c == '/' &&
        (mods & NSEventModifierFlagControl) &&
        !(mods & (NSEventModifierFlagShift | NSEventModifierFlagCommand | NSEventModifierFlagOption))) {

        // Synthesise an event identical to the original but with characters = "_".
        // This matches what the Swift reference does (SurfaceView_AppKit.swift ~1297-1351).
        NSEvent* remapped = [NSEvent keyEventWithType:event.type
                                             location:event.locationInWindow
                                        modifierFlags:event.modifierFlags
                                            timestamp:event.timestamp
                                         windowNumber:event.windowNumber
                                              context:nil
                                           characters:@"_"
                          charactersIgnoringModifiers:@"_"
                                            isARepeat:event.isARepeat
                                              keyCode:event.keyCode];
        if (remapped) {
            [self keyDown:remapped];
        } else {
            [self keyDown:event];
        }
        return YES;
    }

    // --- Cmd+C / Cmd+V / Cmd+X (clipboard triad) ---
    if (mods & NSEventModifierFlagCommand) {
        if (c == 'c' || c == 'C' || c == 'v' || c == 'V' || c == 'x' || c == 'X') {
            [self keyDown:event];
            return YES;
        }
    }

    // --- Synthetic event filter (zero timestamp) ---
    // AppKit synthesises events with timestamp == 0 (e.g. after cancel:).
    // Skip them to avoid double-encoding. Ref: SurfaceView_AppKit.swift ~1300-1310.
    if (event.timestamp == 0) return NO;

    return NO;
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

    // Translate modifiers through ghostty's macos-option-as-alt logic.
    // ghostty_surface_key_translation_mods maps raw AppKit mods to the
    // mods ghostty wants to see — e.g. when option-as-alt is active,
    // NSEventModifierFlagOption is remapped to Alt so that Option+Delete
    // emits ESC DEL (backward-kill-word) instead of the composed glyph ∂.
    // This mirrors the pattern in Ghostty's SurfaceView_AppKit.swift keyDown:.
    ghostty_input_mods_e rawMods   = modsFromEvent(event);
    ghostty_input_mods_e transMods = ghostty_surface_key_translation_mods(self.surface, rawMods);

    // Build translated NSEventModifierFlags: start from the original event flags
    // (preserves "hidden" bits used by dead-key / IME machinery) then force only
    // the 4 standard modifier flags on/off to match what transMods says.
    NSEventModifierFlags translationFlags = event.modifierFlags;
    // Shift
    if (transMods & GHOSTTY_MODS_SHIFT)
        translationFlags |=  NSEventModifierFlagShift;
    else
        translationFlags &= ~NSEventModifierFlagShift;
    // Control
    if (transMods & GHOSTTY_MODS_CTRL)
        translationFlags |=  NSEventModifierFlagControl;
    else
        translationFlags &= ~NSEventModifierFlagControl;
    // Option / Alt
    if (transMods & GHOSTTY_MODS_ALT)
        translationFlags |=  NSEventModifierFlagOption;
    else
        translationFlags &= ~NSEventModifierFlagOption;
    // Command / Super
    if (transMods & GHOSTTY_MODS_SUPER)
        translationFlags |=  NSEventModifierFlagCommand;
    else
        translationFlags &= ~NSEventModifierFlagCommand;

    // Build the translation event.  If the flags are unchanged we reuse the
    // original event object — important for IME correctness (object identity
    // is used by some input methods).  Otherwise synthesise a new NSEvent with
    // translated flags and recomputed characters so the text field reflects the
    // translated modifiers (e.g. ESC DEL instead of ∂ for Option+Delete).
    NSEvent *translationEvent = event;
    if (translationFlags != event.modifierFlags) {
        NSString *translatedChars = [event charactersByApplyingModifiers:translationFlags];
        NSEvent *synth = [NSEvent keyEventWithType:event.type
                                         location:event.locationInWindow
                                    modifierFlags:translationFlags
                                        timestamp:event.timestamp
                                     windowNumber:event.windowNumber
                                          context:nil
                                       characters:translatedChars ?: @""
                      charactersIgnoringModifiers:event.charactersIgnoringModifiers ?: @""
                                        isARepeat:event.isARepeat
                                          keyCode:event.keyCode];
        if (synth) translationEvent = synth;
    }

    ghostty_input_key_s key_ev = {};
    key_ev.action          = action;
    // key_ev.mods must carry the ORIGINAL (untranslated) mods so the Alt bit
    // survives to the key encoder — that's what triggers the ESC-prefix for
    // Option+key (e.g. Option+Delete → ESC DEL → backward-kill-word). The
    // translation mods (transMods) deliberately STRIP Alt for text composition
    // and must NOT be sent here. See vendor/ghostty/src/apprt/embedded.zig:
    // "The filtered mods should be used for key translation but should NOT be
    // sent back via the _key function -- the original mods should be used."
    key_ev.mods            = rawMods;
    key_ev.consumed_mods   = (ghostty_input_mods_e)(transMods &
                                ~(GHOSTTY_MODS_CTRL | GHOSTTY_MODS_SUPER));
    key_ev.keycode         = (uint32_t)event.keyCode; // raw macOS vkey
    key_ev.composing       = false;
    key_ev.unshifted_codepoint = 0;
    key_ev.text            = nullptr;

    // Compute unshifted codepoint (codepoint with no modifiers applied).
    // This is modifier-independent so we always derive it from the original event.
    NSString *bare = [event charactersByApplyingModifiers:0];
    if (bare && bare.length > 0) {
        NSUInteger cp = [bare characterAtIndex:0];
        if (cp < 0xD800 || cp > 0xDFFF) { // exclude surrogates
            key_ev.unshifted_codepoint = (uint32_t)cp;
        }
    }

    // Derive text from the translation event so the composed glyph (e.g. ∂)
    // is suppressed when option-as-alt is active and the translated characters
    // are used instead (e.g. the bare delete character for Option+Delete).
    NSString *textStr = ghosttyTextForEvent(translationEvent);

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
    // Pass translationEvent (not event) so IME sees the translated modifiers —
    // matches the Swift reference which calls interpretKeyEvents with translationEvent.
    // inKeyDown = YES prevents insertText:replacementRange: from double-sending.
    self.inKeyDown = YES;
    [self interpretKeyEvents:@[translationEvent]];
    self.inKeyDown = NO;
}

// ---------------------------------------------------------------------------
// keyUp:
// ---------------------------------------------------------------------------

- (void)keyUp:(NSEvent *)event {
    if (!self.surface) return;

    // Mirror keyDown: mods-translation so press/release modifier state is consistent
    // (fixes key-tracking confusion with macos-option-as-alt enabled).
    // Ref: SurfaceView_AppKit.swift ghosttyKeyEvent().
    ghostty_input_mods_e rawMods   = modsFromEvent(event);
    ghostty_input_mods_e transMods = ghostty_surface_key_translation_mods(self.surface, rawMods);

    ghostty_input_key_s key_ev = {};
    key_ev.action        = GHOSTTY_ACTION_RELEASE;
    key_ev.mods          = rawMods;
    key_ev.consumed_mods = (ghostty_input_mods_e)(transMods & ~(GHOSTTY_MODS_CTRL | GHOSTTY_MODS_SUPER));
    key_ev.keycode       = (uint32_t)event.keyCode;
    key_ev.composing     = false;
    key_ev.text          = nullptr;
    key_ev.unshifted_codepoint = 0;

    ghostty_surface_key(self.surface, key_ev);
}

// ---------------------------------------------------------------------------
// flagsChanged: — forward modifier-only press/release to libghostty.
// Without this, TUI apps that track bare modifier state (vim, emacs etc.)
// never see Shift/Ctrl/Opt/Cmd/Caps pressed or released alone.
// Ref: SurfaceView_AppKit.swift flagsChanged(with:) ~1355-1400.
// ---------------------------------------------------------------------------
- (void)flagsChanged:(NSEvent *)event {
    if (!self.surface) return;

    // Determine which modifier key changed based on keyCode.
    // Key codes (standard US layout, hardware-independent):
    //   0x39 = CapsLock, 0x38 = L-Shift, 0x3C = R-Shift,
    //   0x3B = L-Ctrl,   0x3E = R-Ctrl,   0x3A = L-Option, 0x3D = R-Option,
    //   0x37 = L-Cmd,    0x36 = R-Cmd
    uint32_t mod;
    switch (event.keyCode) {
        case 0x39: mod = GHOSTTY_MODS_CAPS;  break;
        case 0x38: /* fall through */
        case 0x3C: mod = GHOSTTY_MODS_SHIFT; break;
        case 0x3B: /* fall through */
        case 0x3E: mod = GHOSTTY_MODS_CTRL;  break;
        case 0x3A: /* fall through */
        case 0x3D: mod = GHOSTTY_MODS_ALT;   break;
        case 0x37: /* fall through */
        case 0x36: mod = GHOSTTY_MODS_SUPER; break;
        default:   return; // Unknown modifier key — ignore.
    }

    // Compute the current mods bitmask from the event's modifierFlags.
    ghostty_input_mods_e mods = modsFromEvent(event);

    // Determine press vs release:
    // If the relevant bit is set in the current mods, the key was pressed.
    // For right-side keys, additionally verify the correct side's raw bit
    // is set — if not, the opposite side is still held and this is a release.
    // Ref: SurfaceView_AppKit.swift flagsChanged ~1374-1397.
    ghostty_input_action_e action = GHOSTTY_ACTION_RELEASE;
    if ((uint32_t)mods & mod) {
        // The modifier family is active. Check right-side keys to ensure
        // the correct physical key (not the opposite side) caused the event.
        bool sidePressed = true;
        NSUInteger rawFlags = (NSUInteger)event.modifierFlags;
        switch (event.keyCode) {
            case 0x3C: sidePressed = (rawFlags & NX_DEVICERSHIFTKEYMASK) != 0; break;
            case 0x3E: sidePressed = (rawFlags & NX_DEVICERCTLKEYMASK)   != 0; break;
            case 0x3D: sidePressed = (rawFlags & NX_DEVICERALTKEYMASK)   != 0; break;
            case 0x36: sidePressed = (rawFlags & NX_DEVICERCMDKEYMASK)   != 0; break;
            default:   sidePressed = true; break;
        }
        if (sidePressed) {
            action = GHOSTTY_ACTION_PRESS;
        }
    }

    ghostty_input_key_s key_ev = {};
    key_ev.action          = action;
    key_ev.mods            = mods;
    key_ev.consumed_mods   = (ghostty_input_mods_e)0;
    key_ev.keycode         = (uint32_t)event.keyCode;
    key_ev.composing       = false;
    key_ev.text            = nullptr;
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
    // A DOM overlay (e.g. sidebar hover card) may have stolen first-responder;
    // re-establish libghostty focus so keyboard input reaches the terminal.
    ghostty_surface_set_focus(self.surface, true);

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
    // Guard: skip text injection if there is no current AppKit event — this can
    // happen via scripting or other non-event paths. Ref: SurfaceView_AppKit.swift ~1960.
    if (!NSApp.currentEvent) return;

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

// ---------------------------------------------------------------------------
// Drag-and-drop — accept file URLs (incl. images) and paste their absolute
// paths into the terminal. claude code's attachment detection picks up file
// paths from pasted text and treats them as attachments.
// ---------------------------------------------------------------------------

- (NSDragOperation)draggingEntered:(id<NSDraggingInfo>)sender {
    NSPasteboard* pb = sender.draggingPasteboard;
    if ([pb.types containsObject:NSPasteboardTypeFileURL] ||
        [pb canReadObjectForClasses:@[[NSURL class]]
                            options:@{NSPasteboardURLReadingFileURLsOnlyKey: @YES}]) {
        return NSDragOperationCopy;
    }
    return NSDragOperationNone;
}

- (NSDragOperation)draggingUpdated:(id<NSDraggingInfo>)sender {
    return [self draggingEntered:sender];
}

- (BOOL)prepareForDragOperation:(id<NSDraggingInfo>)sender {
    (void)sender;
    return YES;
}

- (BOOL)performDragOperation:(id<NSDraggingInfo>)sender {
    if (!self.surface) return NO;
    NSPasteboard* pb = sender.draggingPasteboard;
    NSArray<NSURL*>* urls = [pb readObjectsForClasses:@[[NSURL class]]
                                              options:@{NSPasteboardURLReadingFileURLsOnlyKey: @YES}];
    if (urls.count == 0) return NO;

    NSMutableString* text = [NSMutableString string];
    for (NSURL* url in urls) {
        NSString* path = url.path;
        if (!path) continue;
        // Quote paths containing spaces / shell metacharacters so claude sees
        // a single token. Standard POSIX single-quoting.
        NSCharacterSet* needsQuote = [NSCharacterSet characterSetWithCharactersInString:@" \t\"'$`\\(){}[]&|;<>*?#"];
        if ([path rangeOfCharacterFromSet:needsQuote].location != NSNotFound) {
            // Replace embedded single quotes with '"'"'
            NSString* escaped = [path stringByReplacingOccurrencesOfString:@"'" withString:@"'\"'\"'"];
            [text appendFormat:@"'%@' ", escaped];
        } else {
            [text appendFormat:@"%@ ", path];
        }
    }
    NSString* trimmed = [text stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
    if (trimmed.length == 0) return NO;

    const char* utf8 = [trimmed UTF8String];
    if (!utf8) return NO;
    ghostty_surface_text(self.surface, utf8, (uintptr_t)strlen(utf8));
    NSLog(@"[ghostty-native] performDragOperation: pasted %lu file path(s)", (unsigned long)urls.count);
    return YES;
}

- (void)viewDidMoveToWindow {
    [super viewDidMoveToWindow];
    // Remove old observer first (handles move-to-nil + window swap cases)
    [[NSNotificationCenter defaultCenter] removeObserver:self
                                                    name:NSWindowDidChangeOcclusionStateNotification
                                                  object:nil];
    if (self.window) {
        [[NSNotificationCenter defaultCenter] addObserver:self
                                                 selector:@selector(handleOcclusionChange:)
                                                     name:NSWindowDidChangeOcclusionStateNotification
                                                   object:self.window];
    }
}

- (void)handleOcclusionChange:(NSNotification*)note {
    if (!g_occlusionTSFNActive) return;
    if (!self.workspaceId) return;

    BOOL occluded = !(self.window.occlusionState & NSWindowOcclusionStateVisible);

    if (!occluded) {
        // Window came to foreground: re-assert focus + occlusion + draw
        if (self.surface) {
            ghostty_surface_set_focus(self.surface, true);
            ghostty_surface_set_occlusion(self.surface, true);
            ghostty_surface_draw(self.surface);
        }
    } else {
        // Window went to background: mark occluded (stops render link)
        if (self.surface) {
            ghostty_surface_set_occlusion(self.surface, false);
        }
    }

    // Fire callback to JS
    std::string wsId = [self.workspaceId UTF8String];
    bool isOccluded = (bool)occluded;
    g_occlusionTSFN.BlockingCall(
        new std::pair<std::string, bool>(wsId, isOccluded),
        [](Napi::Env env, Napi::Function jsCb, std::pair<std::string, bool>* data) {
            jsCb.Call({
                Napi::String::New(env, data->first),
                Napi::Boolean::New(env, data->second)
            });
            delete data;
        }
    );
}

- (void)dealloc {
    [[NSNotificationCenter defaultCenter] removeObserver:self];
}

@end

// ---------------------------------------------------------------------------
// GhosttySurfaceEntry + g_surfaces
// ---------------------------------------------------------------------------

// Forward-declare the loading overlay view so GhosttySurfaceEntry can hold a pointer to it.
@class OrpheusLoadingOverlayView;

struct GhosttySurfaceEntry {
    ghostty_surface_t surface;
    OrpheusGhosttyView* __strong view;
    BOOL isAttached;              // YES = view is in contentView superview
    CGRect lastRect;              // last known CSS rect (top-left origin, pre-flip)
    CGFloat lastScale;
    OrpheusLoadingOverlayView* __strong loadingOverlay; // nil when no overlay is present
};

// workspaceId → entry
static std::map<std::string, GhosttySurfaceEntry> g_surfaces;

#if 0
// ---------------------------------------------------------------------------
// WebContents -hitTest: swizzle.
//
// Why we need this: the libghostty NSView is parented as the BOTTOM sibling
// of the BrowserWindow's contentView so DOM popovers / overlays from the
// renderer naturally z-order on top of the terminal pixels. The downside is
// that mouse / drag / drop events at the terminal region default-route to
// the transparent WebContents NSView sitting above us — Chromium's
// -nonWebContentView hook only helps for views ABOVE the WebContents, not
// below — so typing, click-to-select, paste, and image drop into the
// terminal all break.
//
// Fix: install a method-impl swap on the WebContents NSView class's
// -hitTest: so that when the point falls inside any attached ghostty
// surface's frame, we return nil. AppKit then falls through to the next
// sibling at that point, which is the ghostty view. Outside terminal
// regions, the original implementation runs unchanged so DOM clicks /
// scrolls / drags work exactly as before.
//
// The swap is class-wide (affects all instances of that NSView class) but
// Orpheus only opens one BrowserWindow so we just see the main window's
// WebContents — and the override is a no-op when no ghostty surface is
// attached. Installed exactly once via dispatch_once on the first Mount()
// call. Falls back gracefully (logs + leaves clicks routed to the web
// layer) if Electron's class hierarchy shifts and we can't find the view.
// ---------------------------------------------------------------------------

// Held implementations of the WebContents NSView class's original methods so
// our swizzles can chain to them when the cursor / drag is outside terminal
// regions.
static IMP g_origWebContentsHitTestIMP = NULL;
static IMP g_origWebContentsDraggingEnteredIMP = NULL;
static IMP g_origWebContentsDraggingUpdatedIMP = NULL;
static IMP g_origWebContentsDraggingExitedIMP = NULL;
static IMP g_origWebContentsPrepareForDragOpIMP = NULL;
static IMP g_origWebContentsPerformDragOpIMP = NULL;
static IMP g_origWebContentsConcludeDragOpIMP = NULL;

// Tracks the ghostty view that "owns" the in-flight drag while it hovers
// inside a terminal frame. Cleared on exit / drop / window cross.
// __strong so the view stays alive for the drag's lifetime even if the
// surface map mutates mid-drag (defensive — shouldn't happen in practice).
static OrpheusGhosttyView* __strong g_dragForwardingTo = nil;

// Mouse hit-test override. Returns nil when `point` is inside a known
// ghostty frame so AppKit falls through to that sibling and delivers
// mouseDown:/etc. there instead of into Blink.
static NSView* orpheus_webContents_hitTest(id self, SEL _cmd, NSPoint point) {
    NSView* selfView = (NSView*)self;
    NSView* superview = selfView.superview;
    if (superview) {
        // `point` is in superview's coordinate space (AppKit's -hitTest:
        // contract). Each ghostty view's .frame is in the SAME coord space
        // because they're siblings under the same contentView.
        for (auto& kv : g_surfaces) {
            OrpheusGhosttyView* gv = kv.second.view;
            if (!gv || !kv.second.isAttached) continue;
            if (NSPointInRect(point, gv.frame)) {
                return nil;
            }
        }
    }
    if (g_origWebContentsHitTestIMP) {
        typedef NSView* (*Fn)(id, SEL, NSPoint);
        return ((Fn)g_origWebContentsHitTestIMP)(self, _cmd, point);
    }
    return selfView;
}

// Drag-destination resolution does NOT go through -hitTest:; AppKit picks
// the topmost view registered for the dragged pasteboard types, which (for
// file URLs) is the WebContents — its Chromium-side machinery registers
// for HTML5 file drag. So we swizzle the NSDraggingDestination methods on
// the WebContents class and forward to whichever ghostty view is under the
// cursor when the drag is happening, falling back to Chromium otherwise.

static OrpheusGhosttyView* findGhosttyForDrag(id self, id<NSDraggingInfo> sender) {
    NSView* selfView = (NSView*)self;
    NSView* superview = selfView.superview;
    if (!superview) return nil;
    NSPoint windowLoc = [sender draggingLocation];
    NSPoint inSuperview = [superview convertPoint:windowLoc fromView:nil];
    for (auto& kv : g_surfaces) {
        OrpheusGhosttyView* gv = kv.second.view;
        if (!gv || !kv.second.isAttached) continue;
        if (NSPointInRect(inSuperview, gv.frame)) {
            return gv;
        }
    }
    return nil;
}

static NSDragOperation orpheus_webContents_draggingEntered(id self, SEL _cmd, id<NSDraggingInfo> sender) {
    OrpheusGhosttyView* gv = findGhosttyForDrag(self, sender);
    if (gv) {
        g_dragForwardingTo = gv;
        return [gv draggingEntered:sender];
    }
    if (g_origWebContentsDraggingEnteredIMP) {
        typedef NSDragOperation (*Fn)(id, SEL, id<NSDraggingInfo>);
        return ((Fn)g_origWebContentsDraggingEnteredIMP)(self, _cmd, sender);
    }
    return NSDragOperationNone;
}

static NSDragOperation orpheus_webContents_draggingUpdated(id self, SEL _cmd, id<NSDraggingInfo> sender) {
    OrpheusGhosttyView* gv = findGhosttyForDrag(self, sender);
    if (gv) {
        if (g_dragForwardingTo != gv) {
            // Drag crossed boundaries (from web region or another terminal).
            if (g_dragForwardingTo) {
                [g_dragForwardingTo draggingExited:sender];
            }
            g_dragForwardingTo = gv;
            return [gv draggingEntered:sender];
        }
        return [gv draggingUpdated:sender];
    }
    if (g_dragForwardingTo) {
        [g_dragForwardingTo draggingExited:sender];
        g_dragForwardingTo = nil;
    }
    if (g_origWebContentsDraggingUpdatedIMP) {
        typedef NSDragOperation (*Fn)(id, SEL, id<NSDraggingInfo>);
        return ((Fn)g_origWebContentsDraggingUpdatedIMP)(self, _cmd, sender);
    }
    return NSDragOperationNone;
}

static void orpheus_webContents_draggingExited(id self, SEL _cmd, id<NSDraggingInfo> sender) {
    if (g_dragForwardingTo) {
        [g_dragForwardingTo draggingExited:sender];
        g_dragForwardingTo = nil;
        return;
    }
    if (g_origWebContentsDraggingExitedIMP) {
        typedef void (*Fn)(id, SEL, id<NSDraggingInfo>);
        ((Fn)g_origWebContentsDraggingExitedIMP)(self, _cmd, sender);
    }
}

static BOOL orpheus_webContents_prepareForDragOperation(id self, SEL _cmd, id<NSDraggingInfo> sender) {
    if (g_dragForwardingTo) {
        return [g_dragForwardingTo prepareForDragOperation:sender];
    }
    if (g_origWebContentsPrepareForDragOpIMP) {
        typedef BOOL (*Fn)(id, SEL, id<NSDraggingInfo>);
        return ((Fn)g_origWebContentsPrepareForDragOpIMP)(self, _cmd, sender);
    }
    return NO;
}

static BOOL orpheus_webContents_performDragOperation(id self, SEL _cmd, id<NSDraggingInfo> sender) {
    if (g_dragForwardingTo) {
        BOOL result = [g_dragForwardingTo performDragOperation:sender];
        g_dragForwardingTo = nil;
        return result;
    }
    if (g_origWebContentsPerformDragOpIMP) {
        typedef BOOL (*Fn)(id, SEL, id<NSDraggingInfo>);
        return ((Fn)g_origWebContentsPerformDragOpIMP)(self, _cmd, sender);
    }
    return NO;
}

static void orpheus_webContents_concludeDragOperation(id self, SEL _cmd, id<NSDraggingInfo> sender) {
    // performDragOperation should have already cleared g_dragForwardingTo on
    // a successful drop; clear defensively in case the drop was rejected.
    g_dragForwardingTo = nil;
    if (g_origWebContentsConcludeDragOpIMP) {
        typedef void (*Fn)(id, SEL, id<NSDraggingInfo>);
        ((Fn)g_origWebContentsConcludeDragOpIMP)(self, _cmd, sender);
    }
}

// Swap one method's implementation, caching the original. If the class
// doesn't have the method defined directly (only inherited), add it first
// so we override only this class without polluting the parent. Returns the
// original IMP (NULL on failure).
static IMP installSwizzle(Class cls, SEL sel, IMP newImpl, const char* typeEncoding) {
    Method m = class_getInstanceMethod(cls, sel);
    if (!m) return NULL;
    // If the method is inherited, add it locally first so method_setImplementation
    // only affects `cls` and its subclasses.
    if (!class_addMethod(cls, sel, newImpl, typeEncoding)) {
        // Method already exists on cls — swap in place.
        return method_setImplementation(m, newImpl);
    }
    return method_getImplementation(m);
}

static void installWebContentsRoutingSwizzles(NSView* contentView) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        if (!contentView) return;
        // Find Electron's WebContents-hosting NSView among the contentView's
        // siblings. Class name varies across Chromium versions — match on
        // both the wrapper (WebContentsViewCocoa) and the leaf
        // (RenderWidgetHostViewCocoa). Prefer the wrapper because that's
        // the sibling level where ghostty also lives, and Chromium hangs
        // the file-drag registration off the wrapper.
        NSView* wcv = nil;
        for (NSView* sub in contentView.subviews) {
            NSString* cls = NSStringFromClass([sub class]);
            if ([cls containsString:@"WebContentsView"]) {
                wcv = sub;
                break;
            }
        }
        if (!wcv) {
            for (NSView* sub in contentView.subviews) {
                NSString* cls = NSStringFromClass([sub class]);
                if ([cls containsString:@"RenderWidgetHostView"]) {
                    wcv = sub;
                    break;
                }
            }
        }
        if (!wcv) {
            NSLog(@"[ghostty-native] WebContents NSView not found in contentView.subviews; "
                  @"terminal-region input + drag routing will not work. Subview classes seen:");
            for (NSView* sub in contentView.subviews) {
                NSLog(@"[ghostty-native]   - %@", NSStringFromClass([sub class]));
            }
            return;
        }
        Class cls = [wcv class];

        // -hitTest: routes mouse events. Returns nil over a terminal frame so
        // AppKit falls through to ghostty's sibling NSView.
        g_origWebContentsHitTestIMP = installSwizzle(
            cls, @selector(hitTest:), (IMP)orpheus_webContents_hitTest,
            "@@:{CGPoint=dd}");

        // NSDraggingDestination methods — forward to ghostty's own
        // implementations when the cursor is over a terminal frame.
        g_origWebContentsDraggingEnteredIMP = installSwizzle(
            cls, @selector(draggingEntered:), (IMP)orpheus_webContents_draggingEntered,
            "L@:@");
        g_origWebContentsDraggingUpdatedIMP = installSwizzle(
            cls, @selector(draggingUpdated:), (IMP)orpheus_webContents_draggingUpdated,
            "L@:@");
        g_origWebContentsDraggingExitedIMP = installSwizzle(
            cls, @selector(draggingExited:), (IMP)orpheus_webContents_draggingExited,
            "v@:@");
        g_origWebContentsPrepareForDragOpIMP = installSwizzle(
            cls, @selector(prepareForDragOperation:),
            (IMP)orpheus_webContents_prepareForDragOperation, "B@:@");
        g_origWebContentsPerformDragOpIMP = installSwizzle(
            cls, @selector(performDragOperation:),
            (IMP)orpheus_webContents_performDragOperation, "B@:@");
        g_origWebContentsConcludeDragOpIMP = installSwizzle(
            cls, @selector(concludeDragOperation:),
            (IMP)orpheus_webContents_concludeDragOperation, "v@:@");

        NSLog(@"[ghostty-native] installed input + drag routing swizzles on %s",
              class_getName(cls));
    });
}
#endif

// Reverse map: surface pointer → workspaceId.
// Maintained in sync with g_surfaces to give O(log n) lookup in action_cb
// instead of the O(n) linear scan over g_surfaces.
static std::map<ghostty_surface_t, std::string> g_surfaceToWorkspaceId;

// Forward-declare the loading action TSFN so OrpheusLoadingActionTarget can
// reference it before the full TSFN block further down the file.
static Napi::ThreadSafeFunction g_loadingActionTSFN;
static bool g_loadingActionTSFNActive = false;

// ---------------------------------------------------------------------------
// Loading overlay theme — colors pushed from main process (resolved from the
// active app theme: midnight / daylight / eclipse). The native side stays
// dumb about theme names; it just renders whatever colors it was given.
// Reasonable midnight-ish defaults are used until main pushes the real values.
// ---------------------------------------------------------------------------

typedef struct {
    NSColor* backdrop;       // tint layered over the blur for theme deepening
    NSColor* card;           // card background (drawn at 0.94 alpha)
    NSColor* textPrimary;    // title color, spinner stroke
    NSColor* textSecondary;  // subtitle color, spinner fade
    NSColor* border;         // card hairline border
    BOOL     isDark;         // picks darkAqua appearance for the blur material
    CGFloat  tintAlpha;      // 0 = blur only; >0 paints backdrop at this alpha
                             // above the blur (used by eclipse to deepen the
                             // bluish-gray macOS dark blur into true black)
} OrpheusLoadingTheme;

static OrpheusLoadingTheme g_loadingTheme = {
    .backdrop      = nil,
    .card          = nil,
    .textPrimary   = nil,
    .textSecondary = nil,
    .border        = nil,
    .isDark        = YES,
    .tintAlpha     = 0.0
};

static NSColor* themeColorOr(NSColor* c, NSColor* fallback) {
    return c ? c : fallback;
}

// ---------------------------------------------------------------------------
// OrpheusLoadingOverlayView — translucent loading card drawn above the
// ghostty NSView while claude boots. Colors come from g_loadingTheme so the
// overlay always matches the active app theme.
// Lifecycle: created by SetLoadingOverlay when state = "showing";
// removed (with fade) when state = "hidden".
// ---------------------------------------------------------------------------

@interface OrpheusLoadingOverlayView : NSVisualEffectView

@property (nonatomic, strong) NSView*                  card;
@property (nonatomic, strong) NSTextField*             titleLabel;
@property (nonatomic, strong) NSTextField*             subtitleLabel;
@property (nonatomic, strong) NSView*                  spinnerHost;   // dot grid lives here
@property (nonatomic, strong) NSArray<CALayer*>*       dotLayers;     // 25 dots, row-major
@property (nonatomic, strong) CAShapeLayer*            spinnerLayer;  // unused after dotmatrix swap; kept for ABI
@property (nonatomic, strong) CATextLayer*             errorGlyphLayer;
@property (nonatomic, strong) NSButton*                actionButton;

// workspaceId used to fire the TSFN when the action button is clicked.
@property (nonatomic, copy)   NSString*      workspaceId;

- (void)updateWithState:(NSString*)state
                  title:(NSString*)title
               subtitle:(NSString*)subtitle
            actionLabel:(NSString*)actionLabel;

@end

// Singleton Obj-C target for the NSButton action.
@interface OrpheusLoadingActionTarget : NSObject
+ (instancetype)shared;
- (void)actionButtonClicked:(NSButton*)sender;
@end

@implementation OrpheusLoadingActionTarget
+ (instancetype)shared {
    static OrpheusLoadingActionTarget* s = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{ s = [[OrpheusLoadingActionTarget alloc] init]; });
    return s;
}
- (void)actionButtonClicked:(NSButton*)sender {
    NSString* wsId = sender.identifier;
    if (!wsId || wsId.length == 0) return;
    NSLog(@"[ghostty-native] loading action clicked workspaceId=%s", wsId.UTF8String);
    if (!g_loadingActionTSFNActive) return;
    std::string wsIdCpp = wsId.UTF8String;
    g_loadingActionTSFN.BlockingCall([wsIdCpp](Napi::Env env, Napi::Function cb) {
        cb.Call({ Napi::String::New(env, wsIdCpp) });
    });
}
@end

@implementation OrpheusLoadingOverlayView

- (instancetype)initWithFrame:(NSRect)frame workspaceId:(NSString*)wsId {
    self = [super initWithFrame:frame];
    if (!self) return nil;

    self.workspaceId = wsId;

    // Resolve colors from the app-theme palette pushed by the main process,
    // with sensible midnight-ish fallbacks if main hasn't called setLoadingTheme yet.
    NSColor* backdropColor = themeColorOr(g_loadingTheme.backdrop,
                                          [NSColor colorWithCalibratedRed:0x0b/255.0 green:0x0b/255.0 blue:0x0c/255.0 alpha:1.0]);
    NSColor* cardColor     = themeColorOr(g_loadingTheme.card,
                                          [NSColor colorWithCalibratedRed:0x16/255.0 green:0x16/255.0 blue:0x1a/255.0 alpha:1.0]);
    NSColor* borderColor   = themeColorOr(g_loadingTheme.border,
                                          [NSColor colorWithCalibratedRed:0x27/255.0 green:0x27/255.0 blue:0x2a/255.0 alpha:1.0]);

    // Frosted-glass backdrop. NSVisualEffectMaterialUnderWindowBackground gives
    // a transparent-looking surface that BLURS what's behind it — so the
    // terminal boot output is unreadable but the view doesn't feel like a
    // solid panel. Appearance follows the active app theme so dark themes
    // get dark blur, daylight gets light blur.
    self.material     = NSVisualEffectMaterialUnderWindowBackground;
    self.blendingMode = NSVisualEffectBlendingModeWithinWindow;
    self.state        = NSVisualEffectStateActive;
    self.appearance   = [NSAppearance appearanceNamed:(g_loadingTheme.isDark
                                                       ? NSAppearanceNameDarkAqua
                                                       : NSAppearanceNameAqua)];

    // Track the parent on resize.
    self.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;

    // Start invisible; caller animates to 1.
    self.alphaValue = 0.0;

    // Optional per-theme tint above the blur. macOS dark blur reads slightly
    // bluish-gray over a pure-black terminal (eclipse case) — making the
    // overlay look LIGHTER than the masked content. A tint layer over the
    // blur restores the deep-dark feel. Midnight/daylight pass tintAlpha=0
    // so this is a no-op for them.
    if (g_loadingTheme.tintAlpha > 0.001) {
        NSView* tint = [[NSView alloc] initWithFrame:self.bounds];
        tint.wantsLayer = YES;
        tint.layer.backgroundColor = [backdropColor colorWithAlphaComponent:g_loadingTheme.tintAlpha].CGColor;
        tint.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        [self addSubview:tint];
    }

    // ---- Card subview ----
    NSView* card = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 340, 142)];
    card.wantsLayer = YES;
    card.layer.cornerRadius = 14.0;
    // Card at ~0.94 alpha — visibly translucent against the backdrop but
    // solid enough to read clearly.
    card.layer.backgroundColor = [cardColor colorWithAlphaComponent:0.94].CGColor;
    card.layer.borderColor     = borderColor.CGColor;
    card.layer.borderWidth     = 1.0;
    // Subtle shadow.
    card.layer.shadowColor     = [NSColor blackColor].CGColor;
    card.layer.shadowOpacity   = 0.22;
    card.layer.shadowRadius    = 12.0;
    card.layer.shadowOffset    = CGSizeMake(0, -3);
    // Center the card in whatever size the overlay is.
    card.autoresizingMask = NSViewMinXMargin | NSViewMaxXMargin |
                            NSViewMinYMargin | NSViewMaxYMargin;
    [self addSubview:card];
    self.card = card;

    // ---- Spinner host (36 × 36) — native port of DotmSquare12.
    // 5×5 dot grid; each dot pulses via a center-origin ripple whose phase
    // is staggered by its Manhattan distance from the origin cell (row=1, col=1).
    // Mirrors src/renderer/src/components/ui/dotm-square-12.tsx and the
    // dmx-center-origin-ripple keyframe in dotmatrix-loader.css.
    // Cycle: 1500ms × (1 / 1.35) ≈ 1111ms; ring stagger: ring × 0.16 × cycle.
    const CGFloat hostSize = 36.0;
    NSView* spinnerHost = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, hostSize, hostSize)];
    spinnerHost.wantsLayer = YES;
    [card addSubview:spinnerHost];
    self.spinnerHost = spinnerHost;

    // 5×5 grid math: 5 dots × 5pt + 4 gaps × ~2.75pt = ~36pt total.
    static const int kGridSize = 5;
    static const CGFloat kDotSize = 5.0;
    const CGFloat gap = (hostSize - (kGridSize * kDotSize)) / (CGFloat)(kGridSize - 1);

    // dmx-center-origin-ripple keyframe values resolved against the default
    // opacity vars (base=0.16, mid=0.32, peak=1.00):
    //   0% → 0.625 * 0.16        = 0.100
    //   34% → 1.0                 = 1.000
    //   60% → 0.5 * (0.16+0.32)   = 0.240
    //   100% → same as 0%         = 0.100
    static const CGFloat kKeyOpacities[4] = { 0.100, 1.000, 0.240, 0.100 };
    static const CGFloat kKeyTimes[4]     = { 0.0,   0.34,  0.60,  1.0   };
    static const int kOriginRow = 1;
    static const int kOriginCol = 1;
    static const int kMaxManhattan = 6;
    static const CFTimeInterval kCycleSeconds = 1.500 / 1.350; // ≈ 1.111s
    static const CFTimeInterval kRingDelayScale = 0.16;

    NSColor* dotColor = themeColorOr(g_loadingTheme.textPrimary, [NSColor labelColor]);
    CFTimeInterval now = CACurrentMediaTime();

    NSMutableArray<CALayer*>* dots = [NSMutableArray arrayWithCapacity:kGridSize * kGridSize];
    for (int row = 0; row < kGridSize; row++) {
        for (int col = 0; col < kGridSize; col++) {
            CALayer* dot = [CALayer layer];
            dot.backgroundColor = dotColor.CGColor;
            dot.cornerRadius    = kDotSize / 2.0;
            CGFloat x = col * (kDotSize + gap);
            // spinnerHost is a non-flipped NSView (bottom-left origin), so row=0
            // (top) needs the largest y. Flip the row index.
            CGFloat y = (kGridSize - 1 - row) * (kDotSize + gap);
            dot.frame = CGRectMake(x, y, kDotSize, kDotSize);
            // Start dots at their resting opacity so there's no first-frame flash.
            dot.opacity = (float)kKeyOpacities[0];

            int ring = abs(row - kOriginRow) + abs(col - kOriginCol);
            if (ring > kMaxManhattan) ring = kMaxManhattan;
            CFTimeInterval delay = (CFTimeInterval)ring * kRingDelayScale * kCycleSeconds;

            CAKeyframeAnimation* anim = [CAKeyframeAnimation animationWithKeyPath:@"opacity"];
            anim.values   = @[ @(kKeyOpacities[0]), @(kKeyOpacities[1]),
                               @(kKeyOpacities[2]), @(kKeyOpacities[3]) ];
            anim.keyTimes = @[ @(kKeyTimes[0]),     @(kKeyTimes[1]),
                               @(kKeyTimes[2]),     @(kKeyTimes[3])     ];
            anim.duration       = kCycleSeconds;
            anim.repeatCount    = HUGE_VALF;
            anim.calculationMode = kCAAnimationLinear;
            anim.timingFunction  = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseInEaseOut];
            anim.removedOnCompletion = NO;
            // Stagger the phase by ring × 0.16 × cycle so the ripple emanates
            // from the origin cell instead of all 25 dots pulsing in lockstep.
            anim.beginTime = now + delay;

            [dot addAnimation:anim forKey:@"dotmatrix"];

            [spinnerHost.layer addSublayer:dot];
            [dots addObject:dot];
        }
    }
    self.dotLayers     = [dots copy];
    self.spinnerLayer  = nil; // legacy field — unused now but kept on the @interface

    // Error glyph — centered in the host, hidden by default.
    CATextLayer* errorLayer = [CATextLayer layer];
    errorLayer.string    = @"✕";
    errorLayer.fontSize  = 22.0;
    errorLayer.foregroundColor = [[NSColor systemRedColor] CGColor];
    errorLayer.alignmentMode   = kCAAlignmentCenter;
    errorLayer.contentsScale   = [[NSScreen mainScreen] backingScaleFactor];
    errorLayer.frame       = CGRectMake(0, (hostSize - 26) / 2.0, hostSize, 26);
    errorLayer.hidden      = YES;
    [spinnerHost.layer addSublayer:errorLayer];
    self.errorGlyphLayer = errorLayer;

    // ---- Title label ----
    NSTextField* titleLabel = [NSTextField labelWithString:@""];
    titleLabel.font      = [NSFont systemFontOfSize:14 weight:NSFontWeightSemibold];
    titleLabel.textColor = themeColorOr(g_loadingTheme.textPrimary, [NSColor labelColor]);
    titleLabel.alignment = NSTextAlignmentCenter;
    titleLabel.cell.wraps = NO;
    titleLabel.cell.lineBreakMode = NSLineBreakByTruncatingTail;
    [card addSubview:titleLabel];
    self.titleLabel = titleLabel;

    // ---- Subtitle label ----
    NSTextField* subLabel = [NSTextField labelWithString:@""];
    subLabel.font      = [NSFont systemFontOfSize:12];
    subLabel.textColor = themeColorOr(g_loadingTheme.textSecondary, [NSColor secondaryLabelColor]);
    subLabel.alignment = NSTextAlignmentCenter;
    subLabel.cell.wraps = NO;
    subLabel.cell.lineBreakMode = NSLineBreakByTruncatingTail;
    [card addSubview:subLabel];
    self.subtitleLabel = subLabel;

    // ---- Action button (hidden until needed) ----
    NSButton* btn = [[NSButton alloc] initWithFrame:NSZeroRect];
    btn.bezelStyle = NSBezelStylePush;
    btn.font       = [NSFont systemFontOfSize:12];
    btn.identifier = wsId; // passed through to the target so it knows the workspaceId
    btn.target     = [OrpheusLoadingActionTarget shared];
    btn.action     = @selector(actionButtonClicked:);
    btn.hidden     = YES;
    [card addSubview:btn];
    self.actionButton = btn;

    // Do an initial layout pass with a placeholder state.
    [self layoutCard:NO hasAction:NO];

    return self;
}

// Re-layout the card subviews based on whether subtitle and action are visible.
- (void)layoutCard:(BOOL)hasSubtitle hasAction:(BOOL)hasAction {
    const CGFloat cardW   = 340.0;
    const CGFloat padH    = 20.0; // horizontal padding inside card
    const CGFloat spinW   = 36.0; // dotmatrix grid
    const CGFloat spinH   = 36.0;
    const CGFloat spinTop = 26.0;
    const CGFloat gapSpinTitle = 16.0;
    const CGFloat titleH  = 20.0;
    const CGFloat gapSub  = 6.0;
    const CGFloat subH    = 17.0;
    const CGFloat gapBtn  = 12.0;
    const CGFloat btnH    = 24.0;
    const CGFloat botPad  = 22.0;

    // Compute total card height.
    CGFloat totalH = spinTop + spinH + gapSpinTitle + titleH;
    if (hasSubtitle) totalH += gapSub + subH;
    if (hasAction)   totalH += gapBtn + btnH;
    totalH += botPad;

    NSRect cardFrame = self.card.frame;
    cardFrame.size   = CGSizeMake(cardW, totalH);
    // Re-center: card was positioned via autoresizing from the previous layout;
    // we need to force position to center now.  Autoresizing margins will track
    // future resizes from this centered origin.
    NSSize parentSize = self.bounds.size;
    cardFrame.origin  = CGPointMake(
        floor((parentSize.width  - cardW)   / 2.0),
        floor((parentSize.height - totalH)  / 2.0)
    );
    self.card.frame = cardFrame;

    // Spinner host — centered horizontally, from top.
    CGFloat spinX = floor((cardW - spinW) / 2.0);
    self.spinnerHost.frame = NSMakeRect(spinX, totalH - spinTop - spinH, spinW, spinH);
    self.errorGlyphLayer.frame = CGRectMake(0, (spinH - 26.0) / 2.0, spinW, 26.0);

    // Title.
    CGFloat titleY = totalH - spinTop - spinH - gapSpinTitle - titleH;
    self.titleLabel.frame = NSMakeRect(padH, titleY, cardW - padH * 2, titleH);

    // Subtitle.
    if (hasSubtitle) {
        CGFloat subY = titleY - gapSub - subH;
        self.subtitleLabel.frame  = NSMakeRect(padH, subY, cardW - padH * 2, subH);
        self.subtitleLabel.hidden = NO;
    } else {
        self.subtitleLabel.hidden = YES;
    }

    // Action button.
    if (hasAction) {
        CGFloat subBottom = hasSubtitle
            ? self.subtitleLabel.frame.origin.y
            : titleY;
        CGFloat btnY = subBottom - gapBtn - btnH;
        CGFloat btnW = 160.0;
        self.actionButton.frame  = NSMakeRect(floor((cardW - btnW) / 2.0), btnY, btnW, btnH);
        self.actionButton.hidden = NO;
    } else {
        self.actionButton.hidden = YES;
    }
}

- (void)updateWithState:(NSString*)state
                  title:(NSString*)title
               subtitle:(NSString*)subtitle
            actionLabel:(NSString*)actionLabel {

    BOOL hasSubtitle = (subtitle != nil && subtitle.length > 0);
    BOOL hasAction   = (actionLabel != nil && actionLabel.length > 0);

    self.titleLabel.stringValue    = title    ?: @"";
    self.subtitleLabel.stringValue = subtitle ?: @"";
    if (hasAction) {
        [self.actionButton setTitle:actionLabel];
    }

    BOOL isError = [state isEqualToString:@"error"];
    for (CALayer* dot in self.dotLayers) {
        dot.hidden = isError;
    }
    self.errorGlyphLayer.hidden = !isError;

    [self layoutCard:hasSubtitle hasAction:hasAction];
}

@end

// ---------------------------------------------------------------------------
// Title ThreadSafeFunction — marshals SET_TITLE from Ghostty's IO thread
// back to V8.
// ---------------------------------------------------------------------------

static Napi::ThreadSafeFunction g_titleTSFN;
static bool g_titleTSFNActive = false;

// Diagnostic: when set, every action_cb invocation forwards its tag value
// (integer) to JS. Used to debug the title flow.
static Napi::ThreadSafeFunction g_actionTraceTSFN;
static bool g_actionTraceTSFNActive = false;

static Napi::Value SetTitleCallback(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "setTitleCallback requires a function").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (g_titleTSFNActive) {
        g_titleTSFN.Release();
        g_titleTSFNActive = false;
    }
    g_titleTSFN = Napi::ThreadSafeFunction::New(
        env,
        info[0].As<Napi::Function>(),
        "ghostty-title-callback",
        0,   // unlimited queue
        1    // single thread
    );
    g_titleTSFNActive = true;
    return env.Undefined();
}

static Napi::Value SetOcclusionCallback(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "setOcclusionCallback requires a function").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (g_occlusionTSFNActive) {
        g_occlusionTSFN.Release();
        g_occlusionTSFNActive = false;
    }
    g_occlusionTSFN = Napi::ThreadSafeFunction::New(
        env,
        info[0].As<Napi::Function>(),
        "ghostty-occlusion-callback",
        0,   // unlimited queue
        1    // single thread
    );
    g_occlusionTSFNActive = true;
    return env.Undefined();
}

static Napi::Value SetActionTraceCallback(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "setActionTraceCallback requires a function").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (g_actionTraceTSFNActive) {
        g_actionTraceTSFN.Release();
        g_actionTraceTSFNActive = false;
    }
    g_actionTraceTSFN = Napi::ThreadSafeFunction::New(
        env,
        info[0].As<Napi::Function>(),
        "ghostty-action-trace-callback",
        0,
        1
    );
    g_actionTraceTSFNActive = true;
    return env.Undefined();
}

static Napi::Value SetLoadingActionCallback(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "setLoadingActionCallback requires a function").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (g_loadingActionTSFNActive) {
        g_loadingActionTSFN.Release();
        g_loadingActionTSFNActive = false;
    }
    g_loadingActionTSFN = Napi::ThreadSafeFunction::New(
        env,
        info[0].As<Napi::Function>(),
        "ghostty-loading-action-callback",
        0,
        1
    );
    g_loadingActionTSFNActive = true;
    return env.Undefined();
}

// NAPI: setLoadingTheme({ backdrop, card, textPrimary, textSecondary, border }) → void
// Each value is a 3-element [r, g, b] array (0-255). Called by main on app
// startup and whenever uiState.theme changes. Replaces the cached g_loadingTheme;
// existing overlay views are NOT re-tinted in place (overlays are short-lived).
static NSColor* parseRgbArray(Napi::Value v) {
    if (!v.IsArray()) return nil;
    Napi::Array arr = v.As<Napi::Array>();
    if (arr.Length() < 3) return nil;
    double r = arr.Get((uint32_t)0).As<Napi::Number>().DoubleValue();
    double g = arr.Get((uint32_t)1).As<Napi::Number>().DoubleValue();
    double b = arr.Get((uint32_t)2).As<Napi::Number>().DoubleValue();
    return [NSColor colorWithCalibratedRed:r / 255.0
                                     green:g / 255.0
                                      blue:b / 255.0
                                     alpha:1.0];
}

static Napi::Value SetLoadingTheme(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "setLoadingTheme requires an object").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    Napi::Object obj = info[0].As<Napi::Object>();
    NSColor* backdrop      = parseRgbArray(obj.Get("backdrop"));
    NSColor* card          = parseRgbArray(obj.Get("card"));
    NSColor* textPrimary   = parseRgbArray(obj.Get("textPrimary"));
    NSColor* textSecondary = parseRgbArray(obj.Get("textSecondary"));
    NSColor* border        = parseRgbArray(obj.Get("border"));
    Napi::Value isDarkVal  = obj.Get("isDark");
    BOOL isDark = isDarkVal.IsBoolean() ? (isDarkVal.As<Napi::Boolean>().Value() ? YES : NO) : YES;
    Napi::Value tintAlphaVal = obj.Get("tintAlpha");
    CGFloat tintAlpha = tintAlphaVal.IsNumber() ? (CGFloat)tintAlphaVal.As<Napi::Number>().DoubleValue() : 0.0;

    g_loadingTheme.backdrop      = backdrop;
    g_loadingTheme.card          = card;
    g_loadingTheme.textPrimary   = textPrimary;
    g_loadingTheme.textSecondary = textSecondary;
    g_loadingTheme.border        = border;
    g_loadingTheme.isDark        = isDark;
    g_loadingTheme.tintAlpha     = tintAlpha;

    NSLog(@"[ghostty-native] setLoadingTheme applied (isDark=%d tintAlpha=%.2f)",
          (int)isDark, (double)tintAlpha);
    return env.Undefined();
}

// ---------------------------------------------------------------------------
// Runtime callbacks (required by ghostty_runtime_config_s)
// ---------------------------------------------------------------------------

// Forward refs — actual definitions live further down with the rest of the
// app-lifecycle globals, but the wakeup hop needs them before that point.
static ghostty_app_t g_app;
static std::atomic<bool> g_inited;

// Async handle that hops from Ghostty's IO thread back to the JS main thread
// to call ghostty_app_tick(). Per embedded.zig:1423: "Tick the event loop.
// This should be called whenever the 'wakeup' callback is invoked for the
// runtime." Without this, surface mailbox messages (set_title, set_tab_title,
// pwd, etc.) never drain — the actions fire inside Ghostty but never reach
// our action_cb.
static uv_async_t g_tickAsync;
static std::atomic<bool> g_tickAsyncInited{false};

// Safety-net damage flag. Set (from wakeup_cb on Ghostty's IO thread) whenever
// Ghostty has IO activity that should produce a frame. Drained by a 10Hz
// NSTimer on the main thread that issues one ghostty_surface_draw per attached
// surface when the flag is set. Guarantees any damage presents within 100ms
// even if the internal display link misses it (e.g. right after a re-attach).
// At true idle the flag stays 0 → zero GPU work.
static std::atomic<uint32_t> g_damageFlag{0};

static void tick_async_cb(uv_async_t* /*handle*/) {
    if (g_inited.load(std::memory_order_acquire) && g_app) {
        ghostty_app_tick(g_app);
    }
}

static void wakeup_cb(void* /*userdata*/) {
    // Called from Ghostty's IO thread — do not call ghostty_* here.
    // Set the damage flag so the main-thread safety timer can issue a draw;
    // then marshal to the JS main thread to call ghostty_app_tick().
    g_damageFlag.store(1, std::memory_order_release);
    if (g_tickAsyncInited.load(std::memory_order_acquire)) {
        uv_async_send(&g_tickAsync);
    }
}

static bool action_cb(ghostty_app_t /*app*/,
                      ghostty_target_s target,
                      ghostty_action_s action) {
    // Diagnostic: forward every tag NAME (string) to JS via the trace TSFN.
    if (g_actionTraceTSFNActive) {
        const char* tagName = "(unknown)";
        switch (action.tag) {
            case GHOSTTY_ACTION_QUIT: tagName = "QUIT"; break;
            case GHOSTTY_ACTION_NEW_WINDOW: tagName = "NEW_WINDOW"; break;
            case GHOSTTY_ACTION_NEW_TAB: tagName = "NEW_TAB"; break;
            case GHOSTTY_ACTION_CLOSE_TAB: tagName = "CLOSE_TAB"; break;
            case GHOSTTY_ACTION_SIZE_LIMIT: tagName = "SIZE_LIMIT"; break;
            case GHOSTTY_ACTION_INITIAL_SIZE: tagName = "INITIAL_SIZE"; break;
            case GHOSTTY_ACTION_CELL_SIZE: tagName = "CELL_SIZE"; break;
            case GHOSTTY_ACTION_SCROLLBAR: tagName = "SCROLLBAR"; break;
            case GHOSTTY_ACTION_RENDER: tagName = "RENDER"; break;
            case GHOSTTY_ACTION_DESKTOP_NOTIFICATION: tagName = "DESKTOP_NOTIFICATION"; break;
            case GHOSTTY_ACTION_SET_TITLE: tagName = "SET_TITLE"; break;
            case GHOSTTY_ACTION_SET_TAB_TITLE: tagName = "SET_TAB_TITLE"; break;
            case GHOSTTY_ACTION_PROMPT_TITLE: tagName = "PROMPT_TITLE"; break;
            case GHOSTTY_ACTION_PWD: tagName = "PWD"; break;
            case GHOSTTY_ACTION_MOUSE_SHAPE: tagName = "MOUSE_SHAPE"; break;
            case GHOSTTY_ACTION_MOUSE_VISIBILITY: tagName = "MOUSE_VISIBILITY"; break;
            case GHOSTTY_ACTION_MOUSE_OVER_LINK: tagName = "MOUSE_OVER_LINK"; break;
            case GHOSTTY_ACTION_RENDERER_HEALTH: tagName = "RENDERER_HEALTH"; break;
            case GHOSTTY_ACTION_RING_BELL: tagName = "RING_BELL"; break;
            case GHOSTTY_ACTION_COLOR_CHANGE: tagName = "COLOR_CHANGE"; break;
            case GHOSTTY_ACTION_CONFIG_CHANGE: tagName = "CONFIG_CHANGE"; break;
            case GHOSTTY_ACTION_SECURE_INPUT: tagName = "SECURE_INPUT"; break;
            case GHOSTTY_ACTION_PROGRESS_REPORT: tagName = "PROGRESS_REPORT"; break;
            case GHOSTTY_ACTION_COMMAND_FINISHED: tagName = "COMMAND_FINISHED"; break;
            case GHOSTTY_ACTION_KEY_SEQUENCE: tagName = "KEY_SEQUENCE"; break;
            case GHOSTTY_ACTION_KEY_TABLE: tagName = "KEY_TABLE"; break;
            case GHOSTTY_ACTION_OPEN_URL: tagName = "OPEN_URL"; break;
            case GHOSTTY_ACTION_COPY_TITLE_TO_CLIPBOARD: tagName = "COPY_TITLE_TO_CLIPBOARD"; break;
            case GHOSTTY_ACTION_QUIT_TIMER: tagName = "QUIT_TIMER"; break;
            case GHOSTTY_ACTION_FLOAT_WINDOW: tagName = "FLOAT_WINDOW"; break;
            case GHOSTTY_ACTION_OPEN_CONFIG: tagName = "OPEN_CONFIG"; break;
            case GHOSTTY_ACTION_RELOAD_CONFIG: tagName = "RELOAD_CONFIG"; break;
            case GHOSTTY_ACTION_CLOSE_WINDOW: tagName = "CLOSE_WINDOW"; break;
            case GHOSTTY_ACTION_UNDO: tagName = "UNDO"; break;
            case GHOSTTY_ACTION_REDO: tagName = "REDO"; break;
            case GHOSTTY_ACTION_CHECK_FOR_UPDATES: tagName = "CHECK_FOR_UPDATES"; break;
            case GHOSTTY_ACTION_SHOW_CHILD_EXITED: tagName = "SHOW_CHILD_EXITED"; break;
            case GHOSTTY_ACTION_SHOW_ON_SCREEN_KEYBOARD: tagName = "SHOW_ON_SCREEN_KEYBOARD"; break;
            case GHOSTTY_ACTION_START_SEARCH: tagName = "START_SEARCH"; break;
            case GHOSTTY_ACTION_END_SEARCH: tagName = "END_SEARCH"; break;
            case GHOSTTY_ACTION_SEARCH_TOTAL: tagName = "SEARCH_TOTAL"; break;
            case GHOSTTY_ACTION_SEARCH_SELECTED: tagName = "SEARCH_SELECTED"; break;
            case GHOSTTY_ACTION_READONLY: tagName = "READONLY"; break;
            case GHOSTTY_ACTION_INSPECTOR: tagName = "INSPECTOR"; break;
            case GHOSTTY_ACTION_RENDER_INSPECTOR: tagName = "RENDER_INSPECTOR"; break;
            default: break;
        }
        int tagInt = (int)action.tag;
        std::string tagStr = std::string(tagName) + "(" + std::to_string(tagInt) + ")";
        g_actionTraceTSFN.BlockingCall(
            new std::string(tagStr),
            [](Napi::Env env, Napi::Function jsCb, std::string* data) {
                jsCb.Call({ Napi::String::New(env, *data) });
                delete data;
            }
        );
    }

    if (action.tag == GHOSTTY_ACTION_SET_TITLE ||
        action.tag == GHOSTTY_ACTION_SET_TAB_TITLE) {
        // Both share the same ghostty_action_set_title_s payload shape, but
        // they're addressed differently in the union — set_title vs set_tab_title.
        const char* rawTitle = (action.tag == GHOSTTY_ACTION_SET_TITLE)
            ? action.action.set_title.title
            : action.action.set_tab_title.title;

        if (g_titleTSFNActive && target.tag == GHOSTTY_TARGET_SURFACE) {
            ghostty_surface_t surf = target.target.surface;
            // Fast O(log n) reverse-map lookup; fall back to linear scan if missed.
            std::string workspaceId;
            auto rmIt = g_surfaceToWorkspaceId.find(surf);
            if (rmIt != g_surfaceToWorkspaceId.end()) {
                workspaceId = rmIt->second;
            } else {
                for (auto& [id, entry] : g_surfaces) {
                    if (entry.surface == surf) { workspaceId = id; break; }
                }
            }
            if (!workspaceId.empty()) {
                std::string title = rawTitle ? rawTitle : "";
                g_titleTSFN.BlockingCall(
                    new std::pair<std::string, std::string>(workspaceId, title),
                    [](Napi::Env env, Napi::Function jsCb, std::pair<std::string, std::string>* data) {
                        jsCb.Call({
                            Napi::String::New(env, data->first),
                            Napi::String::New(env, data->second)
                        });
                        delete data;
                    }
                );
            }
        }
    }

    // Note: GHOSTTY_ACTION_RENDER is NOT handled here.
    //
    // For the embedded apprt (Orpheus), must_draw_from_app_thread is false
    // (it's only true for apprt/gtk/App.zig).  Ghostty's renderer.Thread.drawFrame
    // therefore calls self.renderer.drawFrame(false) directly on its own renderer
    // thread rather than pushing a redraw_surface action.  Because hasVsync()
    // returns true (ghostty's own internal CVDisplayLink is running in
    // generic.zig:loopEnter), drawFrame(false) also returns immediately when
    // called from the normal render timer path — the display link drives all
    // continuous rendering autonomously.  GHOSTTY_ACTION_RENDER is never emitted
    // for this build.  All rendering is handled by ghostty's own display link
    // without any host involvement.

    return false;
}

// ---------------------------------------------------------------------------
// Clipboard callbacks — NSPasteboard integration
//
// Ghostty uses three callbacks to broker clipboard access:
//
//   write_clipboard_cb  — terminal wants to SET the clipboard (Cmd+C, OSC 52
//                         write).  We receive an array of {mime, data} pairs
//                         and write the plain-text item to NSPasteboard.
//
//   read_clipboard_cb   — terminal wants to READ the clipboard (Cmd+V / OSC 52
//                         read).  This callback is async: return true to signal
//                         we'll deliver the result, then call
//                         ghostty_surface_complete_clipboard_request when ready.
//                         The `state` pointer is an opaque token we hand back.
//
//   confirm_read_clipboard_cb — some OSC-52 flows ask the host to confirm
//                         before exposing clipboard contents.  For v1 we
//                         auto-approve all reads.  A user-facing confirmation
//                         dialog is a follow-up (add an NSAlert here if
//                         paste-protection requests come in from real workloads).
//
// Threading: AppKit pasteboard operations MUST run on the main thread.  All
// three callbacks dispatch to the main queue to be safe — Ghostty may call
// them from its IO thread.
// ---------------------------------------------------------------------------

// write_clipboard_cb — called when the terminal wants to write to the clipboard.
//
// `content` is an array of `count` {mime, data} pairs.  We look for the first
// "text/plain" (or plain-C-string) entry and write it to NSPasteboard.
//
// `confirm` = true means the OSC-52 sequence asked for explicit confirmation
// before writing.  For v1 we ignore the flag and always write.  If abuse is
// observed (e.g. a remote host silently clobbering the pasteboard), add an
// NSAlert here gated on `confirm`.
static void write_clipboard_cb(void* /*userdata*/,
                                ghostty_clipboard_e /*type*/,
                                const ghostty_clipboard_content_s* content,
                                size_t count,
                                bool /*confirm*/) {
    if (!content || count == 0) {
        NSLog(@"[ghostty-native] write_clipboard_cb: empty content, skip");
        return;
    }

    // Find the first plain-text item in the content array.
    // Ghostty typically sends mime="text/plain;charset=utf-8" or similar.
    const char* text = nullptr;
    for (size_t i = 0; i < count; i++) {
        if (content[i].data && content[i].data[0] != '\0') {
            // Prefer a mime type that looks like plain text; fall back to first
            // non-empty item.
            const char* mime = content[i].mime ? content[i].mime : "";
            if (strstr(mime, "text/plain") != nullptr || text == nullptr) {
                text = content[i].data;
                if (strstr(mime, "text/plain") != nullptr) break; // prefer exact match
            }
        }
    }

    if (!text) {
        NSLog(@"[ghostty-native] write_clipboard_cb: no usable text in %zu item(s)", count);
        return;
    }

    // Capture the text before the async dispatch (content pointer is only valid
    // during this callback).
    NSString* str = [NSString stringWithUTF8String:text];
    if (!str) {
        NSLog(@"[ghostty-native] write_clipboard_cb: UTF-8 decode failed");
        return;
    }

    // Pasteboard operations must run on the main thread.
    dispatch_async(dispatch_get_main_queue(), ^{
        NSPasteboard* pb = [NSPasteboard generalPasteboard];
        [pb clearContents];
        [pb setString:str forType:NSPasteboardTypeString];
    });
}

// read_clipboard_cb — called when the terminal wants to read from the clipboard.
//
// We must return true (async) and later call
// ghostty_surface_complete_clipboard_request(surface, text, state, true).
// The `state` token identifies the pending request on the Ghostty side.
//
// Because this callback doesn't receive a surface_t directly, we find the
// first currently-attached surface in g_surfaces.  In Orpheus there is always
// exactly one visible (attached) surface at a time, so this is safe.
static bool read_clipboard_cb(void* /*userdata*/,
                               ghostty_clipboard_e /*type*/,
                               void* state) {
    // Capture `state` for the async block — it's the opaque request token.
    void* capturedState = state;

    dispatch_async(dispatch_get_main_queue(), ^{
        // Find the first attached surface to deliver the result to.
        ghostty_surface_t targetSurface = nullptr;
        for (auto& kv : g_surfaces) {
            if (kv.second.isAttached && kv.second.surface) {
                targetSurface = kv.second.surface;
                break;
            }
        }

        if (!targetSurface) {
            NSLog(@"[ghostty-native] read_clipboard_cb: no attached surface, aborting");
            return;
        }

        NSString* contents = [[NSPasteboard generalPasteboard]
                              stringForType:NSPasteboardTypeString];

        if (contents) {
            const char* bytes = [contents UTF8String];
            ghostty_surface_complete_clipboard_request(targetSurface, bytes, capturedState, true);
        } else {
            ghostty_surface_complete_clipboard_request(targetSurface, "", capturedState, true);
        }
    });

    // Return true = we will deliver the result asynchronously.
    return true;
}

// confirm_read_clipboard_cb — called when Ghostty wants explicit user approval
// before exposing clipboard contents to the terminal (OSC-52 anti-paste-attack).
//
// For v1 we auto-approve all reads.  To add a real confirmation prompt, replace
// the body with an NSAlert sheet and call ghostty_surface_complete_clipboard_request
// only if the user clicks "Allow".
static void confirm_read_clipboard_cb(void* /*userdata*/,
                                       const char* /*text*/,
                                       void* state,
                                       ghostty_clipboard_request_e /*req*/) {
    // Auto-approve: find the first attached surface and confirm immediately.
    dispatch_async(dispatch_get_main_queue(), ^{
        ghostty_surface_t targetSurface = nullptr;
        for (auto& kv : g_surfaces) {
            if (kv.second.isAttached && kv.second.surface) {
                targetSurface = kv.second.surface;
                break;
            }
        }
        if (targetSurface) {
            ghostty_surface_complete_clipboard_request(targetSurface, nullptr, state, true);
        }
    });
}

static void close_surface_cb(void* /*userdata*/, bool process_alive) {
    NSLog(@"[ghostty-native] close_surface_cb process_alive=%d", (int)process_alive);
}

// ---------------------------------------------------------------------------
// Global app state (lazily inited on first mount)
// GhosttySurfaceEntry and g_surfaces are declared above the runtime callbacks
// so that action_cb can iterate g_surfaces for the PWD auto-launch guard.
// g_app and g_inited are forward-declared near wakeup_cb so the IO-thread
// hop can see them; only g_config lives entirely here.
// ---------------------------------------------------------------------------

static ghostty_config_t g_config = nullptr;
static const char* g_resDir = nullptr;  // set once in ensureApp, used by reloadGhosttyConfig

// ---------------------------------------------------------------------------
// Build, load, and finalise a ghostty config using the standard Orpheus
// load order:  default files → bundled overrides → user config → recursive
// files → finalise.  resDir may be NULL (GHOSTTY_RESOURCES_DIR not set).
// Returns a finalised ghostty_config_t; caller owns it (ghostty_config_free).
// ---------------------------------------------------------------------------

static ghostty_config_t buildGhosttyConfig(const char* resDir) {
    ghostty_config_t cfg = ghostty_config_new();
    if (!cfg) {
        NSLog(@"[ghostty-native] ghostty_config_new FAILED");
        return nullptr;
    }

    NSLog(@"[ghostty-native] loading user config (default files)");
    ghostty_config_load_default_files(cfg);

    // Bundled Orpheus overrides — applied after the user's ~/.config/ghostty
    // so these values win over the user's own Ghostty.app preferences.
    if (resDir) {
        NSString* overridePath = [NSString stringWithFormat:@"%s/orpheus-overrides.conf", resDir];
        if ([[NSFileManager defaultManager] fileExistsAtPath:overridePath]) {
            NSLog(@"[ghostty-native] applying Orpheus overrides: %@", overridePath);
            ghostty_config_load_file(cfg, [overridePath UTF8String]);
        } else {
            NSLog(@"[ghostty-native] no Orpheus overrides found at %@", overridePath);
        }
    }

    // User-editable Ghostty config — layered after bundled Orpheus overrides so
    // user settings win. ORPHEUS_GHOSTTY_CONFIG is set by the main process and
    // points to a runtime-generated file. When unset, this is a no-op.
    const char* userCfgPath = getenv("ORPHEUS_GHOSTTY_CONFIG");
    if (userCfgPath && userCfgPath[0] != '\0') {
        NSString* userCfgNS = [NSString stringWithUTF8String:userCfgPath];
        if ([[NSFileManager defaultManager] fileExistsAtPath:userCfgNS]) {
            NSLog(@"[ghostty-native] applying user Ghostty config: %@", userCfgNS);
            ghostty_config_load_file(cfg, userCfgPath);
        } else {
            NSLog(@"[ghostty-native] ORPHEUS_GHOSTTY_CONFIG set but file not found: %@", userCfgNS);
        }
    }

    NSLog(@"[ghostty-native] loading recursive config files (theme resolution)");
    ghostty_config_load_recursive_files(cfg);

    ghostty_config_finalize(cfg);

    // Log any config diagnostics so theme/parse errors are visible in Console.app.
    uint32_t diagCount = ghostty_config_diagnostics_count(cfg);
    if (diagCount > 0) {
        NSLog(@"[ghostty-native] %u config diagnostic(s):", (unsigned)diagCount);
        for (uint32_t i = 0; i < diagCount; i++) {
            ghostty_diagnostic_s diag = ghostty_config_get_diagnostic(cfg, i);
            NSLog(@"[ghostty-native]   diag[%u]: %s", (unsigned)i,
                  diag.message ? diag.message : "(null)");
        }
    } else {
        NSLog(@"[ghostty-native] config loaded cleanly (0 diagnostics)");
    }

    return cfg;
}

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
    g_resDir = resDir;  // stash for config reloads

    int rc = ghostty_init(0, nullptr);
    if (rc != GHOSTTY_SUCCESS) {
        NSLog(@"[ghostty-native] ghostty_init FAILED rc=%d", rc);
        return false;
    }

    g_config = buildGhosttyConfig(resDir);
    if (!g_config) return false;

    ghostty_runtime_config_s rt = {};
    rt.userdata = nullptr;
    rt.supports_selection_clipboard = false;  // macOS has no separate X11-style selection clipboard
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

    // Safety-net 10Hz timer: if g_damageFlag was raised by wakeup_cb (meaning
    // Ghostty has IO activity), issue one synchronous draw per attached surface
    // on the main thread. This guarantees any missed frame from the internal
    // display link presents within 100ms. At idle g_damageFlag==0 → no GPU
    // work. Added to NSRunLoopCommonModes so it fires during scroll/tracking.
    // g_surfaces is only mutated on the main thread; the timer fires on main
    // (same thread), so iteration is safe without additional locking.
    NSTimer* safetyTimer = [NSTimer timerWithTimeInterval:0.1
                                                  repeats:YES
                                                    block:^(NSTimer* /*t*/) {
        if (!g_damageFlag.exchange(0, std::memory_order_acq_rel)) return;
        for (auto& kv : g_surfaces) {
            GhosttySurfaceEntry& e = kv.second;
            if (e.isAttached && e.surface) {
                ghostty_surface_draw(e.surface);
            }
        }
    }];
    [[NSRunLoop mainRunLoop] addTimer:safetyTimer forMode:NSRunLoopCommonModes];

    // Prevent App Nap: a backgrounded Orpheus would otherwise have its main-thread
    // NSTimers (incl. the 10Hz terminal safety timer) coalesced/suspended, which
    // stalls terminal rendering until foreground. Hold a user-initiated activity
    // for the process lifetime. NSActivityLatencyCritical keeps timers prompt.
    // ARC: __strong static keeps the object alive without manual retain.
    static __strong id<NSObject> s_appNapActivity = nil;
    if (!s_appNapActivity) {
        s_appNapActivity = [[NSProcessInfo processInfo]
            beginActivityWithOptions:(NSActivityUserInitiated | NSActivityLatencyCritical)
                              reason:@"Active terminal rendering"];
    }

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

// Returns the CGColor used to fill the terminal view's layer background before
// ghostty's GPU layer renders its first frame. Midnight theme surface-base
// (#0b0b0c) hardcoded as gap-fill fallback. A sub-second flash; threading the
// active theme into native is not worth it.
static CGColorRef orpheusGapFillColor() {
    static CGColorRef color = nil;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        color = CGColorRetain(
            [NSColor colorWithSRGBRed:0x0b/255.0
                                green:0x0b/255.0
                                 blue:0x0c/255.0
                                alpha:1.0].CGColor
        );
    });
    return color;
}

// Decorative-only backstop: a full-bounds opaque dark fill pinned at the bottom
// of the contentView so transparent window regions never reveal the desktop.
// It MUST be invisible to hit-testing: Chromium's -shouldIgnoreMouseEvent: hit-
// tests the cursor point and walks the resulting view for -nonWebContentView to
// route terminal input. A plain NSView would answer hitTest: with itself and,
// lacking -nonWebContentView, cause terminal-region events to be misrouted into
// the web layer (freezing the terminal). Returning nil keeps it out of all
// event routing — it only ever draws.
@interface OrpheusBackstopView : NSView
@end
@implementation OrpheusBackstopView
- (NSView*)hitTest:(NSPoint)point { return nil; }
- (BOOL)acceptsFirstResponder { return NO; }
- (BOOL)wantsLayer { return YES; }
@end

// Persistent opaque app-dark backstop pinned to the bottom of the contentView.
// Any transparent region (the workspace "hole" before the terminal NSView is
// attached, or during a workspace switch) reveals this instead of the desktop
// behind the transparent window. Created once; never removed. Terminal NSViews
// mount ABOVE it; WebContents stays above both (it was already above terminals
// when terminals were at the bottom — moving the backstop below them preserves
// that invariant). Plain NSView has no backgroundColor property, so we must
// make it layer-backed and set layer.backgroundColor.
static NSView* ensureBackstopView(NSView* contentView) {
    static dispatch_once_t once;
    static __strong NSView* backstop = nil;  // retained for process lifetime (ARC)
    dispatch_once(&once, ^{
        backstop = [[OrpheusBackstopView alloc] initWithFrame:contentView.bounds];
        backstop.wantsLayer = YES;
        backstop.layer.backgroundColor = orpheusGapFillColor();
        backstop.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        // Insert at the very bottom (index 0). NSWindowBelow relativeTo:nil
        // is AppKit's canonical way to request "insert at subview index 0."
        [contentView addSubview:backstop positioned:NSWindowBelow relativeTo:nil];
    });
    return backstop;
}

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

    // Install the persistent app-dark backstop once. Any transparent window
    // region (workspace hole, cold-start gap, switch gap) shows app-dark
    // instead of the macOS desktop. Terminals mount above it (see below).
    NSView* backstop = ensureBackstopView(contentView);

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

    // env — optional Record<string,string>; forwarded to the surface process.
    // Keys and values are strdup'd for the lifetime of this mount call and
    // freed after ghostty_surface_new returns (new surfaces only; re-attaches
    // ignore env because the process is already running).
    std::vector<std::pair<std::string, std::string>> envPairs;
    Napi::Value envVal = opts.Get("env");
    if (envVal.IsObject()) {
        Napi::Object envObj = envVal.As<Napi::Object>();
        Napi::Array envKeys = envObj.GetPropertyNames();
        for (uint32_t i = 0; i < envKeys.Length(); i++) {
            Napi::Value k = envKeys.Get(i);
            Napi::Value v = envObj.Get(k);
            if (k.IsString() && v.IsString()) {
                envPairs.push_back({
                    k.As<Napi::String>().Utf8Value(),
                    v.As<Napi::String>().Utf8Value()
                });
            }
        }
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
            // Re-attach: add back to superview, wake renderer.
            NSLog(@"[ghostty-native] mount workspaceId=%s: re-attaching existing surface",
                  workspaceId.c_str());
            entry.view.workspaceId = [NSString stringWithUTF8String:workspaceId.c_str()];

            double parentH = contentView.bounds.size.height;
            NSRect newFrame = cssRectToAppKit(rx, ry, rw, rh, parentH);
            [entry.view setFrame:newFrame];
            // Position the terminal ABOVE the persistent backstop so the backstop
            // remains the bottom-most sibling. WebContents stays above us — it was
            // already above terminals when they were at the bottom; moving the
            // backstop below terminals preserves that invariant.
            [contentView addSubview:entry.view positioned:NSWindowAbove relativeTo:backstop];
            // Gap-fill: paint the pre-first-frame gap app-dark so a workspace
            // switch shows the background color instead of the desktop.
            entry.view.layer.backgroundColor = orpheusGapFillColor();

            // Wake the renderer: the ghostty_surface_set_occlusion parameter is
            // `visible` (NOT `occluded`). Setting it true marks the surface
            // visible → ghostty's setVisible(true) restarts the internal
            // CVDisplayLink (generic.zig:setVisible). The link only starts when
            // BOTH visible AND focused are true (generic.zig:1059), so we set
            // focus first to open that gate. makeFirstResponder may be async;
            // setting focus here synchronously ensures the gate is open before
            // the display link tries to start. The 10Hz safety timer covers any
            // residual window between these calls and the first tick.
            ghostty_surface_set_focus(entry.surface, true);
            ghostty_surface_set_occlusion(entry.surface, true);  // visible=true → restarts display link

            // Update size in case the window was resized while hidden.
            uint32_t physW = (uint32_t)(rw * scaleFactor);
            uint32_t physH = (uint32_t)(rh * scaleFactor);
            ghostty_surface_set_size(entry.surface, physW, physH);
            ghostty_surface_set_content_scale(entry.surface, scaleFactor, scaleFactor);

            // One synchronous draw so the first frame paints immediately,
            // before the display link fires its first tick. Runs on main ✓.
            ghostty_surface_draw(entry.surface);

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
    termView.workspaceId = [NSString stringWithUTF8String:workspaceId.c_str()];
    // Same z-order rationale as the re-attach branch above.
    [contentView addSubview:termView positioned:NSWindowAbove relativeTo:backstop];
    // Gap-fill: set background so the pre-first-frame gap shows app-dark.
    termView.layer.backgroundColor = orpheusGapFillColor();
    // Accept file URLs (images, any files) so claude attachments work via drop.
    [termView registerForDraggedTypes:@[NSPasteboardTypeFileURL]];

    // Surface config
    ghostty_surface_config_s surface_cfg = ghostty_surface_config_new();
    surface_cfg.platform_tag = GHOSTTY_PLATFORM_MACOS;
    surface_cfg.platform.macos.nsview = (__bridge void*)termView;
    // Set userdata to a non-null sentinel so libghostty machinery that gates on
    // userdata-presence (mirrored from the GhosttyKit-spm Swift wrapper which
    // sets this to a bridge pointer) doesn't short-circuit. We don't actually
    // need a per-surface bridge — g_surfaces map is keyed by workspaceId.
    static int s_userdataSentinel = 1;
    surface_cfg.userdata = &s_userdataSentinel;
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
    NSLog(@"[ghostty-native] wrapper script path: %@", wrapperNSPath);

    // Single-quote the path so ghostty's shell command ("bash -c exec -l <cmd>")
    // handles spaces in the bundle path (e.g. "Orpheus Dev.app") correctly.
    // The path is a filesystem path and cannot contain single quotes.
    NSString* quotedPath = [NSString stringWithFormat:@"'%@'", wrapperNSPath];
    const char* commandPath = [quotedPath UTF8String];

    surface_cfg.command = commandPath;

    // Build env_vars array from JS-provided key/value pairs.
    // The ghostty_env_var_s structs and their strings must live through
    // ghostty_surface_new. We strdup the strings here and free them after
    // the call returns. The ghostty config takes copies internally.
    std::vector<ghostty_env_var_s> envVarStructs;
    std::vector<char*> envVarKeys;   // strdup'd, freed below
    std::vector<char*> envVarValues; // strdup'd, freed below

    if (!envPairs.empty()) {
        for (const auto& kv : envPairs) {
            char* keyCopy   = strdup(kv.first.c_str());
            char* valueCopy = strdup(kv.second.c_str());
            envVarKeys.push_back(keyCopy);
            envVarValues.push_back(valueCopy);
            ghostty_env_var_s ev;
            ev.key   = keyCopy;
            ev.value = valueCopy;
            envVarStructs.push_back(ev);
        }
        surface_cfg.env_vars     = envVarStructs.data();
        surface_cfg.env_var_count = (size_t)envVarStructs.size();
        NSLog(@"[ghostty-native] surface env_vars count=%zu", envVarStructs.size());
        for (const auto& ev : envVarStructs) {
            NSLog(@"[ghostty-native]   env %s=%s", ev.key, ev.value);
        }
    } else {
        surface_cfg.env_vars     = nullptr;
        surface_cfg.env_var_count = 0;
    }

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
        // Free strdup'd env var strings before returning.
        for (char* p : envVarKeys)   free(p);
        for (char* p : envVarValues) free(p);
        [termView removeFromSuperview];
        Napi::Error::New(env, std::string("ghostty_surface_new threw: ") +
                         [[ex reason] UTF8String]).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // ghostty_surface_new has copied env var data internally; safe to free now.
    for (char* p : envVarKeys)   free(p);
    for (char* p : envVarValues) free(p);

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

    // Ghostty defaults visible=true for new surfaces, so the display link
    // should start as soon as focus is set. Set focus explicitly here for
    // parity with the re-attach path and to satisfy the visible+focused gate
    // (generic.zig:1059) before the first draw. Then issue a synchronous
    // one-shot draw so the first frame paints before the display link ticks.
    // Runs on main ✓.
    ghostty_surface_set_focus(surface, true);
    ghostty_surface_draw(surface);

    // Store entry — view is retained by the map (ARC __strong).
    // ghostty's own internal CVDisplayLink (created in generic.zig:loopEnter)
    // drives all rendering autonomously on a private renderer thread; we do
    // not need a host-side display link.
    GhosttySurfaceEntry entry;
    entry.surface    = surface;
    entry.view       = termView;
    entry.isAttached = YES;
    entry.lastRect   = CGRectMake(rx, ry, rw, rh);
    entry.lastScale  = scaleFactor;
    g_surfaces[workspaceId] = entry;
    g_surfaceToWorkspaceId[surface] = workspaceId;

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
// Removes the NSView from its superview and signals occlusion to ghostty.
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

    // Tell Ghostty the surface is no longer visible — parameter is `visible`
    // (NOT `occluded`), so visible=false stops the internal display link
    // (generic.zig:setVisible). Clear focus first so both visible and focused
    // gates are false; this prevents the link from accidentally restarting.
    ghostty_surface_set_focus(entry.surface, false);
    ghostty_surface_set_occlusion(entry.surface, false);  // visible=false → stops display link

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

// ---------------------------------------------------------------------------
// NAPI: setLoadingOverlay(workspaceId, state, copy) → void
//
// state ∈ { "showing" | "slow" | "error" | "hidden" }
// copy  = { title, subtitle?, actionLabel? }
//
// "showing" — create overlay if missing (added above the ghostty view in
//             superview z-order), animate opacity 0→1 over 120ms. Updates copy
//             if called again while already visible.
// "slow"    — same overlay, action button now visible with actionLabel text.
// "error"   — spinner replaced by ✕ glyph; title becomes error reason.
// "hidden"  — animate opacity 1→0 over 100ms, then removeFromSuperview.
//             Idempotent — no-op if there is no overlay or no entry.
// ---------------------------------------------------------------------------

static Napi::Value SetLoadingOverlay(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 3 || !info[0].IsString() || !info[1].IsString() || !info[2].IsObject()) {
        Napi::TypeError::New(env, "setLoadingOverlay requires (workspaceId, state, copy)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string workspaceId = info[0].As<Napi::String>().Utf8Value();
    std::string state       = info[1].As<Napi::String>().Utf8Value();
    Napi::Object copyObj    = info[2].As<Napi::Object>();

    std::string titleStr, subtitleStr, actionLabelStr;
    Napi::Value titleVal = copyObj.Get("title");
    if (titleVal.IsString()) titleStr = titleVal.As<Napi::String>().Utf8Value();
    Napi::Value subVal = copyObj.Get("subtitle");
    if (subVal.IsString()) subtitleStr = subVal.As<Napi::String>().Utf8Value();
    Napi::Value actVal = copyObj.Get("actionLabel");
    if (actVal.IsString()) actionLabelStr = actVal.As<Napi::String>().Utf8Value();

    // "hidden" with no surface entry — pure no-op (no throw).
    auto it = g_surfaces.find(workspaceId);
    if (it == g_surfaces.end()) {
        if (state == "hidden") return env.Undefined();
        NSLog(@"[ghostty-native] setLoadingOverlay workspaceId=%s: no entry (no-op for state=%s)",
              workspaceId.c_str(), state.c_str());
        return env.Undefined();
    }

    // Capture by value for the dispatch block.
    NSString* nsWorkspaceId  = [NSString stringWithUTF8String:workspaceId.c_str()];
    NSString* nsState        = [NSString stringWithUTF8String:state.c_str()];
    NSString* nsTitle        = [NSString stringWithUTF8String:titleStr.c_str()];
    NSString* nsSubtitle     = subtitleStr.empty()     ? nil : [NSString stringWithUTF8String:subtitleStr.c_str()];
    NSString* nsActionLabel  = actionLabelStr.empty()  ? nil : [NSString stringWithUTF8String:actionLabelStr.c_str()];
    GhosttySurfaceEntry& entry = it->second;

    // We need a stable pointer to the entry's overlay field for the block.
    // Safe because: entries are never moved after insertion (std::map guarantee),
    // and this dispatch runs on the main queue (same thread as all map mutations).
    OrpheusLoadingOverlayView* __strong* overlayPtr = &entry.loadingOverlay;
    NSView* ghosttyView = entry.view;

    dispatch_async(dispatch_get_main_queue(), ^{
        // ---- "hidden" — fade out and remove ----
        if ([nsState isEqualToString:@"hidden"]) {
            OrpheusLoadingOverlayView* ov = *overlayPtr;
            if (!ov) return;
            NSLog(@"[ghostty-native] setLoadingOverlay workspaceId=%s: hiding", nsWorkspaceId.UTF8String);
            CABasicAnimation* fade = [CABasicAnimation animationWithKeyPath:@"opacity"];
            fade.fromValue = @(ov.alphaValue);
            fade.toValue   = @(0.0);
            fade.duration  = 0.1;
            // Remove after animation completes.
            [CATransaction begin];
            [CATransaction setCompletionBlock:^{
                [ov removeFromSuperview];
            }];
            [ov.layer addAnimation:fade forKey:@"fadeOut"];
            ov.alphaValue = 0.0;
            [CATransaction commit];
            *overlayPtr = nil;
            return;
        }

        // ---- "showing" / "slow" / "error" — create if needed, then update ----
        OrpheusLoadingOverlayView* ov = *overlayPtr;

        if (!ov) {
            if (!ghosttyView) {
                NSLog(@"[ghostty-native] setLoadingOverlay workspaceId=%s: ghostty view missing, deferring",
                      nsWorkspaceId.UTF8String);
                return;
            }
            // Attach as a CHILD of the ghostty view itself (not a sibling) so
            // the overlay rect always matches the terminal rect exactly — no
            // chance of covering the sidebar / tabs / header. The autoresizing
            // mask on the view makes it track terminal:resize for free.
            NSRect overlayFrame = ghosttyView.bounds;
            ov = [[OrpheusLoadingOverlayView alloc] initWithFrame:overlayFrame
                                                      workspaceId:nsWorkspaceId];
            [ghosttyView addSubview:ov];
            *overlayPtr = ov;
            NSLog(@"[ghostty-native] setLoadingOverlay workspaceId=%s: created overlay",
                  nsWorkspaceId.UTF8String);

            // Fade in.
            CABasicAnimation* fadeIn = [CABasicAnimation animationWithKeyPath:@"opacity"];
            fadeIn.fromValue = @(0.0);
            fadeIn.toValue   = @(1.0);
            fadeIn.duration  = 0.12;
            [CATransaction begin];
            [ov.layer addAnimation:fadeIn forKey:@"fadeIn"];
            ov.alphaValue = 1.0;
            [CATransaction commit];
        }

        NSLog(@"[ghostty-native] setLoadingOverlay workspaceId=%s: state=%s",
              nsWorkspaceId.UTF8String, nsState.UTF8String);
        [ov updateWithState:nsState title:nsTitle subtitle:nsSubtitle actionLabel:nsActionLabel];
    });

    return env.Undefined();
}

// NAPI: focus(workspaceId) — make the workspace's terminal view first responder.
// Called when Orpheus regains app focus so typing goes directly to the terminal.
static Napi::Value Focus(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "focus requires workspaceId string").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::string workspaceId = info[0].As<Napi::String>().Utf8Value();
    auto it = g_surfaces.find(workspaceId);
    if (it == g_surfaces.end()) return env.Undefined();
    GhosttySurfaceEntry& entry = it->second;
    if (!entry.isAttached || !entry.view) return env.Undefined();
    // Re-assert ghostty's focus + visibility so the internal display link
    // restarts. The window 'focus' handler calls this on foreground-regain;
    // makeFirstResponder alone does NOT re-open ghostty's visible+focused gate,
    // which is why a long-backgrounded terminal stayed frozen until a full
    // re-mount. set_focus first (opens the gate), then set_occlusion(true)
    // (marks visible → restarts the link), then one synchronous draw.
    if (entry.surface) {
        ghostty_surface_set_focus(entry.surface, true);
        ghostty_surface_set_occlusion(entry.surface, true);
        ghostty_surface_draw(entry.surface);
    }
    dispatch_async(dispatch_get_main_queue(), ^{
        NSWindow* win = [entry.view window];
        if (win) [win makeFirstResponder:entry.view];
    });
    return env.Undefined();
}

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
    if (doomed.surface) {
        g_surfaceToWorkspaceId.erase(doomed.surface);
    }

    // Detach the view so the workspace appears gone right away.
    // Nil out surface pointer first so any in-flight key events see nullptr
    // instead of soon-to-be-freed memory.
    if (doomed.view) {
        doomed.view.surface = nullptr;
        [doomed.view removeFromSuperview];
    }

    // ---- Asynchronous, slow — process teardown after the IPC return ----
    // ghostty_surface_free MUST run on the main thread per Ghostty's API
    // contract, but it doesn't have to be synchronous with this NAPI call.
    // We allocate a heap copy of doomed so the block owns it cleanly
    // (avoids ObjC++ __block + std::move ARC interaction uncertainty).
    GhosttySurfaceEntry* heap = new GhosttySurfaceEntry(std::move(doomed));
    dispatch_async(dispatch_get_main_queue(), ^{
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
// NAPI: sendInput(workspaceId, utf8Text) → boolean
//
// Writes raw UTF-8 text directly into the workspace's PTY via
// ghostty_surface_text.  Returns true on success, false when no surface
// exists for the given workspaceId.
//
// Threading: NAPI handlers run on the main thread; ghostty_surface_text is
// safe to call from there (mirrors performDragOperation which calls it
// directly with no dispatch).
// ---------------------------------------------------------------------------

static Napi::Value SendInput(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, "sendInput requires (workspaceId: string, text: string)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string workspaceId = info[0].As<Napi::String>().Utf8Value();
    std::string utf8Text    = info[1].As<Napi::String>().Utf8Value();

    auto it = g_surfaces.find(workspaceId);
    if (it == g_surfaces.end()) {
        NSLog(@"[ghostty-native] sendInput workspaceId=%s: no surface (returning false)",
              workspaceId.c_str());
        return Napi::Boolean::New(env, false);
    }

    ghostty_surface_t surface = it->second.surface;
    if (!surface) {
        return Napi::Boolean::New(env, false);
    }

    ghostty_surface_text(surface, utf8Text.c_str(), (uintptr_t)utf8Text.length());
    return Napi::Boolean::New(env, true);
}

// ---------------------------------------------------------------------------
// NAPI: sendKeys(workspaceId, keys) → boolean
//
// Sends an array of synthetic key events into the workspace's surface via
// ghostty_surface_key.  Each element carries:
//   keycode  — raw macOS virtual key code (same as NSEvent.keyCode)
//   mods     — ghostty_input_mods_e bitmask (optional, defaults to NONE)
//   action   — 'press' | 'release' | 'repeat' (optional, defaults to 'press')
//
// Returns false when no surface is found for the given workspaceId.
//
// key_ev.text is intentionally left nullptr: synthetic input injected via
// this path goes through the keycode/mods channel; the text field is only
// needed for real IME-committed characters (see insertText:replacementRange:
// in OrpheusGhosttyView).  Libghostty derives the correct byte sequence from
// keycode + mods for control characters, function keys, and printable ASCII.
// ---------------------------------------------------------------------------

static Napi::Value SendKeys(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsArray()) {
        Napi::TypeError::New(env,
            "sendKeys requires (workspaceId: string, keys: Array<{keycode,mods?,action?}>)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string workspaceId = info[0].As<Napi::String>().Utf8Value();

    auto it = g_surfaces.find(workspaceId);
    if (it == g_surfaces.end()) {
        NSLog(@"[ghostty-native] sendKeys workspaceId=%s: no surface (returning false)",
              workspaceId.c_str());
        return Napi::Boolean::New(env, false);
    }

    ghostty_surface_t surface = it->second.surface;
    if (!surface) {
        return Napi::Boolean::New(env, false);
    }

    Napi::Array keys = info[1].As<Napi::Array>();
    uint32_t len = keys.Length();

    for (uint32_t i = 0; i < len; i++) {
        Napi::Value item = keys.Get(i);
        if (!item.IsObject()) continue;
        Napi::Object obj = item.As<Napi::Object>();

        // keycode — required
        Napi::Value keycodeVal = obj.Get("keycode");
        if (!keycodeVal.IsNumber()) continue;
        uint32_t keycode = keycodeVal.As<Napi::Number>().Uint32Value();

        // mods — optional; defaults to GHOSTTY_MODS_NONE (0)
        uint32_t mods = 0;
        Napi::Value modsVal = obj.Get("mods");
        if (modsVal.IsNumber()) {
            mods = modsVal.As<Napi::Number>().Uint32Value();
        }

        // action — optional; defaults to GHOSTTY_ACTION_PRESS
        ghostty_input_action_e action = GHOSTTY_ACTION_PRESS;
        Napi::Value actionVal = obj.Get("action");
        if (actionVal.IsString()) {
            std::string actionStr = actionVal.As<Napi::String>().Utf8Value();
            if (actionStr == "release") {
                action = GHOSTTY_ACTION_RELEASE;
            } else if (actionStr == "repeat") {
                action = GHOSTTY_ACTION_REPEAT;
            }
            // 'press' and any unknown string → GHOSTTY_ACTION_PRESS (default)
        }

        ghostty_input_key_s key_ev = {};
        key_ev.action             = action;
        key_ev.mods               = (ghostty_input_mods_e)mods;
        key_ev.consumed_mods      = (ghostty_input_mods_e)0;
        key_ev.keycode            = keycode;
        key_ev.text               = nullptr;
        key_ev.unshifted_codepoint = 0;
        key_ev.composing          = false;

        ghostty_surface_key(surface, key_ev);
    }

    return Napi::Boolean::New(env, true);
}

// ---------------------------------------------------------------------------
// ReloadGhosttyConfig — rebuild config and push to the running app + surfaces.
// Called from the main process after writing a new user Ghostty config file.
// ---------------------------------------------------------------------------
static Napi::Value ReloadGhosttyConfig(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!g_app) {
        NSLog(@"[ghostty-native] reloadGhosttyConfig: called before init, ignoring");
        return Napi::Boolean::New(env, false);
    }

    ghostty_config_t newConfig = buildGhosttyConfig(g_resDir);
    if (!newConfig) {
        NSLog(@"[ghostty-native] reloadGhosttyConfig: buildGhosttyConfig failed");
        return Napi::Boolean::New(env, false);
    }

    // Push the new config to the app. ghostty_app_update_config takes *const Config —
    // Ghostty clones the config internally (see embedded.zig performAction .config_change),
    // so the caller retains ownership and must free the old g_config itself.
    ghostty_app_update_config(g_app, newConfig);

    // Also push to all live surfaces so already-open terminals pick up the change.
    for (auto& [id, entry] : g_surfaces) {
        if (entry.surface) {
            ghostty_surface_update_config(entry.surface, newConfig);
        }
    }

    // Free the old config now that update_config has cloned it, then adopt the new one.
    ghostty_config_free(g_config);
    g_config = newConfig;

    NSLog(@"[ghostty-native] config reloaded successfully");
    return Napi::Boolean::New(env, true);
}

// ---------------------------------------------------------------------------
// Module init
// ---------------------------------------------------------------------------

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    // Bind the tick uv_async to Node's event loop so wakeup_cb can hop back
    // to the JS main thread. The handle is unref'd so it doesn't prevent
    // process exit; it stays valid for the addon's lifetime.
    uv_loop_t* loop = nullptr;
    if (napi_get_uv_event_loop(env, &loop) == napi_ok && loop) {
        if (uv_async_init(loop, &g_tickAsync, tick_async_cb) == 0) {
            uv_unref(reinterpret_cast<uv_handle_t*>(&g_tickAsync));
            g_tickAsyncInited.store(true, std::memory_order_release);
        } else {
            NSLog(@"[ghostty-native] uv_async_init FAILED — terminal titles will not update");
        }
    } else {
        NSLog(@"[ghostty-native] napi_get_uv_event_loop FAILED — terminal titles will not update");
    }

    exports.Set("mount",             Napi::Function::New(env, Mount));
    exports.Set("hide",              Napi::Function::New(env, Hide));
    exports.Set("resize",            Napi::Function::New(env, Resize));
    exports.Set("destroy",           Napi::Function::New(env, Destroy));
    exports.Set("focus",             Napi::Function::New(env, Focus));
    exports.Set("setTitleCallback",         Napi::Function::New(env, SetTitleCallback));
    exports.Set("setOcclusionCallback",     Napi::Function::New(env, SetOcclusionCallback));
    exports.Set("setActionTraceCallback",   Napi::Function::New(env, SetActionTraceCallback));
    exports.Set("setLoadingOverlay",        Napi::Function::New(env, SetLoadingOverlay));
    exports.Set("setLoadingActionCallback", Napi::Function::New(env, SetLoadingActionCallback));
    exports.Set("setLoadingTheme",          Napi::Function::New(env, SetLoadingTheme));
    exports.Set("sendInput",                Napi::Function::New(env, SendInput));
    exports.Set("sendKeys",                 Napi::Function::New(env, SendKeys));
    exports.Set("reloadGhosttyConfig",      Napi::Function::New(env, ReloadGhosttyConfig));
    return exports;
}

NODE_API_MODULE(ghostty_native, Init)
