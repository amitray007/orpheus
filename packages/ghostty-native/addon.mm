// ghostty-native — production lifecycle addon for Orpheus.
//
// Exports three synchronous NAPI functions (all called on the AppKit main thread
// from the Electron main process):
//
//   mount(handleBuffer, { x, y, w, h }, scaleFactor)  → { surfaceId }
//   unmount(surfaceId)                                 → void
//   resize(surfaceId, { x, y, w, h }, scaleFactor)    → void
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
//   • mouseDown: makes the view first responder so keystrokes route here.
//   • Full mouse-button/scroll forwarding to ghostty_surface_mouse_button /
//     ghostty_surface_mouse_scroll is NOT in scope this commit.
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
// mouseDown: — grab first responder so subsequent keystrokes come here.
// Full mouse forwarding (ghostty_surface_mouse_button) is next commit.
// ---------------------------------------------------------------------------

- (void)mouseDown:(NSEvent *)event {
    [self.window makeFirstResponder:self];
    // Don't call super — swallow the click for the terminal area.
    // If clicking sidebar/topbar fails to return focus to WKWebView after this
    // commit, surface it in the next mouse-input commit (not in scope here).
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
// ---------------------------------------------------------------------------

struct SurfaceEntry {
    ghostty_surface_t surface;
    OrpheusGhosttyView* __strong view;
    CVDisplayLinkRef displayLink;
};

static ghostty_app_t    g_app    = nullptr;
static ghostty_config_t g_config = nullptr;
static std::atomic<bool> g_inited{false};

// surfaceId → entry
static std::map<std::string, SurfaceEntry> g_surfaces;
static uint64_t g_nextId = 1;

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
// NAPI: mount(handleBuffer, rect, scaleFactor) → { surfaceId }
// ---------------------------------------------------------------------------

static Napi::Value Mount(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 3) {
        Napi::TypeError::New(env, "mount requires 3 args").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Arg 0 — native window handle (Buffer of pointer bytes)
    if (!info[0].IsBuffer()) {
        Napi::TypeError::New(env, "arg 0 must be Buffer").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    Napi::Buffer<uint8_t> handleBuf = info[0].As<Napi::Buffer<uint8_t>>();
    // The handle is a pointer value serialised as little-endian bytes.
    void* rawHandle = nullptr;
    size_t copyLen = std::min(handleBuf.ByteLength(), sizeof(rawHandle));
    memcpy(&rawHandle, handleBuf.Data(), copyLen);
    NSView* contentView = (__bridge NSView*)rawHandle;

    // Arg 1 — rect { x, y, w, h }
    if (!info[1].IsObject()) {
        Napi::TypeError::New(env, "arg 1 must be object {x,y,w,h}").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    Napi::Object rectObj = info[1].As<Napi::Object>();
    double rx = rectObj.Get("x").As<Napi::Number>().DoubleValue();
    double ry = rectObj.Get("y").As<Napi::Number>().DoubleValue();
    double rw = rectObj.Get("w").As<Napi::Number>().DoubleValue();
    double rh = rectObj.Get("h").As<Napi::Number>().DoubleValue();

    // Arg 2 — scaleFactor (devicePixelRatio)
    double scaleFactor = info[2].As<Napi::Number>().DoubleValue();

    // Lazy init Ghostty
    if (!ensureApp()) {
        Napi::Error::New(env, "ghostty init failed").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Create the OrpheusGhosttyView at the right AppKit rect.
    double parentH = contentView.bounds.size.height;
    NSRect frame = cssRectToAppKit(rx, ry, rw, rh, parentH);

    NSLog(@"[ghostty-native] mount: css(%.0f,%.0f,%.0fx%.0f) → appkit(%.0f,%.0f,%.0fx%.0f) parentH=%.0f scale=%.1f",
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

    const char* home = getenv("HOME");
    surface_cfg.working_directory = home ? home : "/tmp";

    // Use $SHELL if set, else /bin/zsh.
    const char* shell = getenv("SHELL");
    surface_cfg.command = (shell && shell[0]) ? shell : "/bin/zsh";

    surface_cfg.env_vars = nullptr;
    surface_cfg.env_var_count = 0;
    surface_cfg.initial_input = nullptr;
    surface_cfg.wait_after_command = false;
    surface_cfg.context = GHOSTTY_SURFACE_CONTEXT_WINDOW;

    NSLog(@"[ghostty-native] surface_new shell=%s cwd=%s",
          surface_cfg.command, surface_cfg.working_directory);

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

    // Start CVDisplayLink — fires every vsync; callback dispatches draw to main thread.
    CVDisplayLinkRef displayLink = nullptr;
    CVDisplayLinkCreateWithActiveCGDisplays(&displayLink);
    CVDisplayLinkSetOutputCallback(displayLink, displayLinkCallback,
                                   reinterpret_cast<void*>(surface));
    CVDisplayLinkStart(displayLink);

    // Generate surfaceId.
    std::string surfaceId = "surface-" + std::to_string(g_nextId++);

    SurfaceEntry entry;
    entry.surface    = surface;
    entry.view       = termView;
    entry.displayLink = displayLink;
    g_surfaces[surfaceId] = entry;

    NSLog(@"[ghostty-native] mounted surface %s (physPx %ux%u)", surfaceId.c_str(), physW, physH);

    Napi::Object result = Napi::Object::New(env);
    result.Set("surfaceId", Napi::String::New(env, surfaceId));
    return result;
}

// ---------------------------------------------------------------------------
// NAPI: unmount(surfaceId) → void
// ---------------------------------------------------------------------------

static Napi::Value Unmount(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "unmount requires surfaceId string").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string surfaceId = info[0].As<Napi::String>().Utf8Value();
    auto it = g_surfaces.find(surfaceId);
    if (it == g_surfaces.end()) {
        NSLog(@"[ghostty-native] unmount: unknown surfaceId %s", surfaceId.c_str());
        return env.Undefined();
    }

    SurfaceEntry& entry = it->second;

    // Stop and release the display link first.
    if (entry.displayLink) {
        CVDisplayLinkStop(entry.displayLink);
        CVDisplayLinkRelease(entry.displayLink);
        entry.displayLink = nullptr;
    }

    // Nil out the view's surface pointer so in-flight key events don't use freed memory.
    if (entry.view) {
        entry.view.surface = nullptr;
    }

    // Free the Ghostty surface.
    if (entry.surface) {
        ghostty_surface_free(entry.surface);
        entry.surface = nullptr;
    }

    // Remove the NSView from its parent.
    if (entry.view) {
        [entry.view removeFromSuperview];
        entry.view = nil;
    }

    g_surfaces.erase(it);
    NSLog(@"[ghostty-native] unmounted surface %s", surfaceId.c_str());
    return env.Undefined();
}

// ---------------------------------------------------------------------------
// NAPI: resize(surfaceId, rect, scaleFactor) → void
// ---------------------------------------------------------------------------

static Napi::Value Resize(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 3) {
        Napi::TypeError::New(env, "resize requires 3 args").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string surfaceId = info[0].As<Napi::String>().Utf8Value();
    Napi::Object rectObj = info[1].As<Napi::Object>();
    double rx = rectObj.Get("x").As<Napi::Number>().DoubleValue();
    double ry = rectObj.Get("y").As<Napi::Number>().DoubleValue();
    double rw = rectObj.Get("w").As<Napi::Number>().DoubleValue();
    double rh = rectObj.Get("h").As<Napi::Number>().DoubleValue();
    double scaleFactor = info[2].As<Napi::Number>().DoubleValue();

    auto it = g_surfaces.find(surfaceId);
    if (it == g_surfaces.end()) {
        NSLog(@"[ghostty-native] resize: unknown surfaceId %s", surfaceId.c_str());
        return env.Undefined();
    }

    SurfaceEntry& entry = it->second;

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

    return env.Undefined();
}

// ---------------------------------------------------------------------------
// Module init
// ---------------------------------------------------------------------------

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("mount",   Napi::Function::New(env, Mount));
    exports.Set("unmount", Napi::Function::New(env, Unmount));
    exports.Set("resize",  Napi::Function::New(env, Resize));
    return exports;
}

NODE_API_MODULE(ghostty_native, Init)
