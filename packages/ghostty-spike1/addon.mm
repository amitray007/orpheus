// Ghostty Spike 1 — libghostty NAPI main-thread compatibility test.
// Goal: call ghostty_init → ghostty_app_new → ghostty_surface_new (dummy NSView)
//       → ghostty_surface_draw and verify no AppKit/Metal assertion fires.

#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>

#include <string>
#include <sstream>

// Include ghostty C API before napi — ghostty.h uses plain C linkage.
#include "ghostty.h"

// node-addon-api (C++ NAPI wrapper)
#include <napi.h>

// ---------------------------------------------------------------------------
// No-op runtime callbacks — required by ghostty_runtime_config_s
// ---------------------------------------------------------------------------

// Called by Ghostty's IO thread when there is work to process on the main
// thread (equivalent to a "needs tick" signal).
static void wakeup_cb(void* userdata) {
    NSLog(@"[spike1] wakeup_cb fired (from IO thread — do NOT call Ghostty here)");
    // In a real integration we would dispatch_async(main_queue, ^{ ghostty_app_tick(app); })
}

// Called when Ghostty wants to perform an action (new window, set title, etc.).
// Return false = we don't handle it; Ghostty may handle it internally.
static bool action_cb(ghostty_app_t app,
                      ghostty_target_s target,
                      ghostty_action_s action) {
    NSLog(@"[spike1] action_cb tag=%d", (int)action.tag);
    return false;
}

// Called when a surface wants to read clipboard content.
// Return false = deny / not supported.
static bool read_clipboard_cb(void* userdata,
                               ghostty_clipboard_e type,
                               void* state) {
    NSLog(@"[spike1] read_clipboard_cb type=%d", (int)type);
    return false;
}

// Called when Ghostty needs to confirm a clipboard read with the user.
static void confirm_read_clipboard_cb(void* userdata,
                                       const char* text,
                                       void* state,
                                       ghostty_clipboard_request_e request) {
    NSLog(@"[spike1] confirm_read_clipboard_cb request=%d", (int)request);
    // In a real integration: show a dialog, then call ghostty_surface_complete_clipboard_request
}

// Called when Ghostty wants to write text to the clipboard.
static void write_clipboard_cb(void* userdata,
                                ghostty_clipboard_e type,
                                const ghostty_clipboard_content_s* content,
                                size_t count,
                                bool confirm) {
    NSLog(@"[spike1] write_clipboard_cb type=%d count=%zu confirm=%d",
          (int)type, count, (int)confirm);
}

// Called when a surface requests to be closed.
static void close_surface_cb(void* userdata, bool process_alive) {
    NSLog(@"[spike1] close_surface_cb process_alive=%d", (int)process_alive);
}

// ---------------------------------------------------------------------------
// runSpike — exported NAPI function
// ---------------------------------------------------------------------------

static Napi::Value runSpike(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    std::ostringstream log;
    bool fatal = false;

    // Step 1 — confirm thread context
    BOOL isMain = [NSThread isMainThread];
    NSLog(@"[spike1] entered runSpike, isMainThread=%@", isMain ? @"YES" : @"NO");
    log << "isMainThread=" << (isMain ? "YES" : "NO") << "\n";

    // Step 2 — ghostty_init
    NSLog(@"[spike1] calling ghostty_init(0, NULL)");
    int initResult = 0;
    @try {
        initResult = ghostty_init(0, NULL);
    } @catch (NSException* ex) {
        log << "STEP2 ghostty_init EXCEPTION: "
            << [[ex reason] UTF8String] << "\n";
        fatal = true;
    }
    if (!fatal) {
        NSLog(@"[spike1] ghostty_init returned %d (0=GHOSTTY_SUCCESS)", initResult);
        log << "STEP2 ghostty_init=" << initResult
            << (initResult == GHOSTTY_SUCCESS ? " (OK)" : " (FAIL)") << "\n";
    }

    // Step 3 — ghostty_config_new + ghostty_config_finalize
    ghostty_config_t config = nullptr;
    if (!fatal) {
        NSLog(@"[spike1] calling ghostty_config_new()");
        @try {
            config = ghostty_config_new();
        } @catch (NSException* ex) {
            log << "STEP3 ghostty_config_new EXCEPTION: "
                << [[ex reason] UTF8String] << "\n";
            fatal = true;
        }
    }
    if (!fatal && config == nullptr) {
        log << "STEP3 ghostty_config_new returned NULL\n";
        fatal = true;
    }
    if (!fatal) {
        NSLog(@"[spike1] ghostty_config_new OK, calling ghostty_config_finalize()");
        @try {
            ghostty_config_finalize(config);
        } @catch (NSException* ex) {
            log << "STEP3 ghostty_config_finalize EXCEPTION: "
                << [[ex reason] UTF8String] << "\n";
            fatal = true;
        }
    }
    if (!fatal) {
        log << "STEP3 ghostty_config_new+finalize=OK\n";
        // Log any config diagnostics
        uint32_t diagCount = ghostty_config_diagnostics_count(config);
        NSLog(@"[spike1] config diagnostics count: %u", diagCount);
        if (diagCount > 0) {
            log << "STEP3 config diagnostics=" << diagCount << "\n";
            for (uint32_t i = 0; i < diagCount && i < 5; i++) {
                ghostty_diagnostic_s d = ghostty_config_get_diagnostic(config, i);
                if (d.message) {
                    NSLog(@"[spike1] config diagnostic[%u]: %s", i, d.message);
                    log << "  diag[" << i << "]=" << d.message << "\n";
                }
            }
        }
    }

    // Step 4 — ghostty_app_new with no-op callbacks
    ghostty_app_t app = nullptr;
    if (!fatal) {
        ghostty_runtime_config_s rt = {};
        rt.userdata = nullptr;
        rt.supports_selection_clipboard = false;
        rt.wakeup_cb = wakeup_cb;
        rt.action_cb = action_cb;
        rt.read_clipboard_cb = read_clipboard_cb;
        rt.confirm_read_clipboard_cb = confirm_read_clipboard_cb;
        rt.write_clipboard_cb = write_clipboard_cb;
        rt.close_surface_cb = close_surface_cb;

        NSLog(@"[spike1] calling ghostty_app_new()");
        @try {
            app = ghostty_app_new(&rt, config);
        } @catch (NSException* ex) {
            log << "STEP4 ghostty_app_new EXCEPTION: "
                << [[ex reason] UTF8String] << "\n";
            fatal = true;
        }
    }
    if (!fatal && app == nullptr) {
        log << "STEP4 ghostty_app_new returned NULL\n";
        fatal = true;
    }
    if (!fatal) {
        NSLog(@"[spike1] ghostty_app_new OK");
        log << "STEP4 ghostty_app_new=OK\n";
    }

    // Step 5 — create dummy NSView
    NSView* dummyView = nullptr;
    if (!fatal) {
        NSLog(@"[spike1] creating dummy NSView (800x600)");
        @try {
            NSRect frame = NSMakeRect(0, 0, 800, 600);
            dummyView = [[NSView alloc] initWithFrame:frame];
            // Make the view layer-backed (required for Metal)
            [dummyView setWantsLayer:YES];
        } @catch (NSException* ex) {
            log << "STEP5 NSView alloc EXCEPTION: "
                << [[ex reason] UTF8String] << "\n";
            fatal = true;
        }
    }
    if (!fatal && dummyView == nullptr) {
        log << "STEP5 NSView alloc returned nil\n";
        fatal = true;
    }
    if (!fatal) {
        NSLog(@"[spike1] dummy NSView created OK");
        log << "STEP5 NSView alloc=OK\n";
    }

    // Step 6 — ghostty_surface_new
    ghostty_surface_t surface = nullptr;
    if (!fatal) {
        ghostty_surface_config_s surface_cfg = ghostty_surface_config_new();
        surface_cfg.platform_tag = GHOSTTY_PLATFORM_MACOS;
        surface_cfg.platform.macos.nsview = (__bridge void*)dummyView;
        surface_cfg.userdata = nullptr;
        // Use the EXEC backend so Ghostty manages the PTY/shell itself.
        surface_cfg.backend = GHOSTTY_SURFACE_IO_BACKEND_EXEC;
        surface_cfg.scale_factor = 2.0;
        surface_cfg.font_size = 13.0;
        surface_cfg.working_directory = nullptr;
        surface_cfg.command = nullptr;
        surface_cfg.env_vars = nullptr;
        surface_cfg.env_var_count = 0;
        surface_cfg.initial_input = nullptr;
        surface_cfg.wait_after_command = false;
        surface_cfg.context = GHOSTTY_SURFACE_CONTEXT_WINDOW;

        NSLog(@"[spike1] calling ghostty_surface_new()");
        @try {
            surface = ghostty_surface_new(app, &surface_cfg);
        } @catch (NSException* ex) {
            log << "STEP6 ghostty_surface_new EXCEPTION: "
                << [[ex reason] UTF8String] << "\n";
            fatal = true;
        }
    }
    if (!fatal && surface == nullptr) {
        log << "STEP6 ghostty_surface_new returned NULL\n";
        fatal = true;
    }
    if (!fatal) {
        NSLog(@"[spike1] ghostty_surface_new OK");
        log << "STEP6 ghostty_surface_new=OK\n";
    }

    // Step 7 — set_size + set_content_scale
    if (!fatal) {
        NSLog(@"[spike1] calling ghostty_surface_set_size(800, 600)");
        @try {
            ghostty_surface_set_size(surface, 800, 600);
            ghostty_surface_set_content_scale(surface, 2.0, 2.0);
        } @catch (NSException* ex) {
            log << "STEP7 set_size/set_content_scale EXCEPTION: "
                << [[ex reason] UTF8String] << "\n";
            fatal = true;
        }
        if (!fatal) {
            NSLog(@"[spike1] set_size+set_content_scale OK");
            log << "STEP7 set_size+set_content_scale=OK\n";
        }
    }

    // Step 8 — ghostty_surface_draw (THE assertion test)
    if (!fatal) {
        NSLog(@"[spike1] calling ghostty_surface_draw() — main-thread assertion test");
        @try {
            ghostty_surface_draw(surface);
        } @catch (NSException* ex) {
            log << "STEP8 ghostty_surface_draw EXCEPTION: "
                << [[ex reason] UTF8String] << "\n";
            // Not necessarily fatal — log and continue to cleanup
        }
        if (!fatal) {
            NSLog(@"[spike1] ghostty_surface_draw returned without NSException");
            log << "STEP8 ghostty_surface_draw=RETURNED (check crash logs for silent abort)\n";
        }
    }

    // Step 9 — cleanup
    NSLog(@"[spike1] cleanup: surface_free, app_free, config_free");
    @try {
        if (surface != nullptr) {
            ghostty_surface_free(surface);
            log << "STEP9 surface_free=OK\n";
        }
        if (app != nullptr) {
            ghostty_app_free(app);
            log << "STEP9 app_free=OK\n";
        }
        if (config != nullptr) {
            ghostty_config_free(config);
            log << "STEP9 config_free=OK\n";
        }
    } @catch (NSException* ex) {
        log << "STEP9 cleanup EXCEPTION: "
            << [[ex reason] UTF8String] << "\n";
    }

    NSLog(@"[spike1] runSpike complete");
    log << "runSpike=COMPLETE\n";

    return Napi::String::New(env, log.str());
}

// ---------------------------------------------------------------------------
// Module init
// ---------------------------------------------------------------------------

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("runSpike",
                Napi::Function::New(env, runSpike));
    return exports;
}

NODE_API_MODULE(ghostty_spike1, Init)
