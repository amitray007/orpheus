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

#include <string>
#include <map>
#include <atomic>
#include <unistd.h>

// GhosttyKit C API
#include "ghostty.h"

// node-addon-api (C++ NAPI wrapper)
#include <napi.h>

// ---------------------------------------------------------------------------
// OrpheusGhosttyView — thin NSView subclass for the terminal surface.
// No keyboard/mouse handlers yet (next commit).
// ---------------------------------------------------------------------------

@interface OrpheusGhosttyView : NSView
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
    ghostty_config_finalize(g_config);

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
