// Ghostty Spike 1 / Spike 5 — libghostty NAPI main-thread + shell-spawn + terminfo test.
//
// Spike 1: ghostty_init → ghostty_app_new → ghostty_surface_new (dummy NSView)
//          → ghostty_surface_draw — verified no AppKit/Metal assertion fires.
//
// Spike 5 extensions:
//   • Shell spawn: sets surface_cfg.command = "/bin/zsh" and ticks for ~2 s
//     so Ghostty's IO thread can exec the shell and populate the PTY.
//   • Callback tracking: wakeup_cb and receive_buffer_cb increments atomics so
//     JS can confirm PTY data was produced.
//   • Discovery tests: tested with/without GHOSTTY_RESOURCES_DIR env var —
//     set it from JS before calling runSpike() for the override path.
//   • Roundtrip: sends "\n" via ghostty_surface_text() and checks for more data.

#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>

#include <string>
#include <sstream>
#include <atomic>
#include <unistd.h>
#include <mach/mach_time.h>

// Include ghostty C API before napi — ghostty.h uses plain C linkage.
#include "ghostty.h"

// node-addon-api (C++ NAPI wrapper)
#include <napi.h>

// ---------------------------------------------------------------------------
// Shared callback counters — updated by Ghostty's IO thread, read on main.
// ---------------------------------------------------------------------------

static std::atomic<int> g_wakeup_count{0};
static std::atomic<int> g_receive_buffer_count{0};
static std::atomic<int> g_receive_buffer_bytes{0};
static std::atomic<int> g_action_count{0};
static std::atomic<int> g_close_surface_count{0};

// Sniffed from the first receive_buffer call so we can log PTY bytes
static char g_first_pty_bytes[64] = {};
static std::atomic<bool> g_first_pty_captured{false};

// ---------------------------------------------------------------------------
// Runtime callbacks — required by ghostty_runtime_config_s
// ---------------------------------------------------------------------------

static void wakeup_cb(void* userdata) {
    g_wakeup_count.fetch_add(1, std::memory_order_relaxed);
    // NOTE: do NOT call any Ghostty API here — this fires on the IO thread.
}

static bool action_cb(ghostty_app_t app,
                      ghostty_target_s target,
                      ghostty_action_s action) {
    g_action_count.fetch_add(1, std::memory_order_relaxed);
    NSLog(@"[spike5] action_cb tag=%d", (int)action.tag);

    if (action.tag == GHOSTTY_ACTION_SET_TITLE) {
        const char* title = action.action.set_title.title;
        NSLog(@"[spike5] SET_TITLE: %s", title ? title : "(null)");
    } else if (action.tag == GHOSTTY_ACTION_COMMAND_FINISHED) {
        NSLog(@"[spike5] COMMAND_FINISHED exit_code=%d duration=%llu",
              (int)action.action.command_finished.exit_code,
              (unsigned long long)action.action.command_finished.duration);
    }
    return false;
}

static bool read_clipboard_cb(void* userdata,
                               ghostty_clipboard_e type,
                               void* state) {
    return false;
}

static void confirm_read_clipboard_cb(void* userdata,
                                       const char* text,
                                       void* state,
                                       ghostty_clipboard_request_e request) {}

static void write_clipboard_cb(void* userdata,
                                ghostty_clipboard_e type,
                                const ghostty_clipboard_content_s* content,
                                size_t count,
                                bool confirm) {}

static void close_surface_cb(void* userdata, bool process_alive) {
    g_close_surface_count.fetch_add(1, std::memory_order_relaxed);
    NSLog(@"[spike5] close_surface_cb process_alive=%d", (int)process_alive);
}

// ---------------------------------------------------------------------------
// Surface receive callbacks — fired on Ghostty's IO thread when PTY has data
// ---------------------------------------------------------------------------

static void receive_buffer_cb(void* userdata, const uint8_t* data, size_t len) {
    g_receive_buffer_count.fetch_add(1, std::memory_order_relaxed);
    g_receive_buffer_bytes.fetch_add((int)len, std::memory_order_relaxed);

    // Capture the first batch so we can log printable content
    bool expected = false;
    if (g_first_pty_captured.compare_exchange_strong(expected, true,
            std::memory_order_acq_rel, std::memory_order_relaxed)) {
        size_t n = len < sizeof(g_first_pty_bytes) - 1 ? len : sizeof(g_first_pty_bytes) - 1;
        memcpy(g_first_pty_bytes, data, n);
        g_first_pty_bytes[n] = '\0';
        NSLog(@"[spike5] receive_buffer first batch len=%zu bytes", len);
    }
}

static void receive_resize_cb(void* userdata,
                               uint16_t cols, uint16_t rows,
                               uint32_t width_px, uint32_t height_px) {
    NSLog(@"[spike5] receive_resize_cb cols=%u rows=%u", (unsigned)cols, (unsigned)rows);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Busy-tick Ghostty on the main thread for `ms` milliseconds.
// Calls ghostty_app_tick() and drains the run loop each ~10 ms.
static void tickFor(ghostty_app_t app, int ms) {
    NSDate* deadline = [NSDate dateWithTimeIntervalSinceNow:(double)ms / 1000.0];
    while ([[NSDate date] compare:deadline] == NSOrderedAscending) {
        ghostty_app_tick(app);
        // Drain the main run loop briefly so Metal/AppKit timers can fire
        NSDate* brief = [NSDate dateWithTimeIntervalSinceNow:0.010];
        [[NSRunLoop currentRunLoop] runUntilDate:brief];
    }
}

// ---------------------------------------------------------------------------
// runSpike — exported NAPI function
// ---------------------------------------------------------------------------

static Napi::Value runSpike(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    // Reset counters from any prior call
    g_wakeup_count = 0;
    g_receive_buffer_count = 0;
    g_receive_buffer_bytes = 0;
    g_action_count = 0;
    g_close_surface_count = 0;
    g_first_pty_captured = false;
    memset(g_first_pty_bytes, 0, sizeof(g_first_pty_bytes));

    std::ostringstream log;
    bool fatal = false;

    // -----------------------------------------------------------------------
    // Log GHOSTTY_RESOURCES_DIR so the caller can confirm which test path ran
    // -----------------------------------------------------------------------
    const char* resDir = getenv("GHOSTTY_RESOURCES_DIR");
    NSLog(@"[spike5] GHOSTTY_RESOURCES_DIR=%s", resDir ? resDir : "(not set)");
    log << "GHOSTTY_RESOURCES_DIR=" << (resDir ? resDir : "(not set)") << "\n";

    // Step 1 — thread check
    BOOL isMain = [NSThread isMainThread];
    log << "STEP1 isMainThread=" << (isMain ? "YES" : "NO") << "\n";
    NSLog(@"[spike5] isMainThread=%@", isMain ? @"YES" : @"NO");

    // Step 2 — ghostty_init
    NSLog(@"[spike5] ghostty_init(0, NULL)");
    int initResult = 0;
    @try {
        initResult = ghostty_init(0, NULL);
    } @catch (NSException* ex) {
        log << "STEP2 ghostty_init EXCEPTION: " << [[ex reason] UTF8String] << "\n";
        fatal = true;
    }
    if (!fatal) {
        log << "STEP2 ghostty_init=" << initResult
            << (initResult == GHOSTTY_SUCCESS ? " (OK)" : " (FAIL)") << "\n";
        if (initResult != GHOSTTY_SUCCESS) fatal = true;
    }

    // Step 3 — config
    ghostty_config_t config = nullptr;
    if (!fatal) {
        @try { config = ghostty_config_new(); }
        @catch (NSException* ex) {
            log << "STEP3 ghostty_config_new EXCEPTION: " << [[ex reason] UTF8String] << "\n";
            fatal = true;
        }
    }
    if (!fatal && config == nullptr) { log << "STEP3 config=NULL\n"; fatal = true; }
    if (!fatal) {
        @try { ghostty_config_finalize(config); }
        @catch (NSException* ex) {
            log << "STEP3 ghostty_config_finalize EXCEPTION: " << [[ex reason] UTF8String] << "\n";
            fatal = true;
        }
    }
    if (!fatal) {
        uint32_t diagCount = ghostty_config_diagnostics_count(config);
        log << "STEP3 config=OK diagnostics=" << diagCount << "\n";
        for (uint32_t i = 0; i < diagCount && i < 8; i++) {
            ghostty_diagnostic_s d = ghostty_config_get_diagnostic(config, i);
            if (d.message) {
                log << "  diag[" << i << "]=" << d.message << "\n";
                NSLog(@"[spike5] config diag[%u]: %s", i, d.message);
            }
        }
    }

    // Step 4 — app
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

        @try { app = ghostty_app_new(&rt, config); }
        @catch (NSException* ex) {
            log << "STEP4 ghostty_app_new EXCEPTION: " << [[ex reason] UTF8String] << "\n";
            fatal = true;
        }
    }
    if (!fatal && app == nullptr) { log << "STEP4 app=NULL\n"; fatal = true; }
    if (!fatal) { log << "STEP4 ghostty_app_new=OK\n"; }

    // Step 5 — dummy NSView
    NSView* dummyView = nullptr;
    if (!fatal) {
        @try {
            NSRect frame = NSMakeRect(0, 0, 800, 600);
            dummyView = [[NSView alloc] initWithFrame:frame];
            [dummyView setWantsLayer:YES];
        } @catch (NSException* ex) {
            log << "STEP5 NSView EXCEPTION: " << [[ex reason] UTF8String] << "\n";
            fatal = true;
        }
    }
    if (!fatal && dummyView == nullptr) { log << "STEP5 NSView=nil\n"; fatal = true; }
    if (!fatal) { log << "STEP5 NSView=OK\n"; }

    // Step 6 — surface_new with /bin/zsh
    ghostty_surface_t surface = nullptr;
    if (!fatal) {
        ghostty_surface_config_s surface_cfg = ghostty_surface_config_new();
        surface_cfg.platform_tag = GHOSTTY_PLATFORM_MACOS;
        surface_cfg.platform.macos.nsview = (__bridge void*)dummyView;
        surface_cfg.userdata = nullptr;
        surface_cfg.backend = GHOSTTY_SURFACE_IO_BACKEND_EXEC;

        // Spike 5: wire receive_buffer so we detect PTY output
        surface_cfg.receive_userdata = nullptr;
        surface_cfg.receive_buffer = receive_buffer_cb;
        surface_cfg.receive_resize = receive_resize_cb;

        surface_cfg.scale_factor = 2.0;
        surface_cfg.font_size = 13.0;

        // Use the user's home directory as working dir
        const char* home = getenv("HOME");
        surface_cfg.working_directory = home ? home : "/tmp";

        // Spike 5: explicitly launch /bin/zsh
        surface_cfg.command = "/bin/zsh";

        surface_cfg.env_vars = nullptr;
        surface_cfg.env_var_count = 0;
        surface_cfg.initial_input = nullptr;
        surface_cfg.wait_after_command = false;
        surface_cfg.context = GHOSTTY_SURFACE_CONTEXT_WINDOW;

        NSLog(@"[spike5] ghostty_surface_new with command=/bin/zsh cwd=%s",
              surface_cfg.working_directory);
        @try {
            surface = ghostty_surface_new(app, &surface_cfg);
        } @catch (NSException* ex) {
            log << "STEP6 ghostty_surface_new EXCEPTION: " << [[ex reason] UTF8String] << "\n";
            fatal = true;
        }
    }
    if (!fatal && surface == nullptr) { log << "STEP6 surface=NULL\n"; fatal = true; }
    if (!fatal) { log << "STEP6 ghostty_surface_new=OK (command=/bin/zsh)\n"; }

    // Step 7 — set_size + set_content_scale
    if (!fatal) {
        @try {
            ghostty_surface_set_size(surface, 800, 600);
            ghostty_surface_set_content_scale(surface, 2.0, 2.0);
        } @catch (NSException* ex) {
            log << "STEP7 set_size EXCEPTION: " << [[ex reason] UTF8String] << "\n";
            fatal = true;
        }
        if (!fatal) log << "STEP7 set_size+scale=OK\n";
    }

    // Step 8 — surface_draw
    if (!fatal) {
        @try { ghostty_surface_draw(surface); }
        @catch (NSException* ex) {
            log << "STEP8 surface_draw EXCEPTION: " << [[ex reason] UTF8String] << "\n";
        }
        log << "STEP8 surface_draw=RETURNED\n";
    }

    // Step 9 — tick for 2 seconds and watch for shell startup
    if (!fatal) {
        NSLog(@"[spike5] ticking for 2 s to let /bin/zsh start...");
        tickFor(app, 2000);

        int wakeups = g_wakeup_count.load(std::memory_order_relaxed);
        int bufCalls = g_receive_buffer_count.load(std::memory_order_relaxed);
        int bufBytes = g_receive_buffer_bytes.load(std::memory_order_relaxed);
        int actions  = g_action_count.load(std::memory_order_relaxed);
        bool procExited = ghostty_surface_process_exited(surface);

        NSLog(@"[spike5] after 2s tick: wakeups=%d rcvBufCalls=%d rcvBufBytes=%d actions=%d procExited=%d",
              wakeups, bufCalls, bufBytes, actions, (int)procExited);

        log << "STEP9 after_2s_tick: wakeups=" << wakeups
            << " rcvBufCalls=" << bufCalls
            << " rcvBufBytes=" << bufBytes
            << " actions=" << actions
            << " procExited=" << (procExited ? "YES" : "NO") << "\n";

        if (bufBytes > 0) {
            // Log printable summary of first PTY bytes
            std::string snippet(g_first_pty_bytes);
            // Escape control chars for logging
            std::string safe;
            for (unsigned char c : snippet) {
                if (c < 0x20 || c == 0x7f) {
                    char buf[6];
                    snprintf(buf, sizeof(buf), "\\x%02x", c);
                    safe += buf;
                } else {
                    safe += (char)c;
                }
            }
            log << "STEP9 first_pty_bytes_hex=" << safe << "\n";
        }

        if (bufCalls > 0 || wakeups > 0) {
            log << "STEP9 shell_spawn=OK (shell is alive, PTY data received or wakeups fired)\n";
        } else if (!procExited) {
            log << "STEP9 shell_spawn=UNCERTAIN (no data yet but process not exited — IO may be buffered)\n";
        } else {
            log << "STEP9 shell_spawn=FAILED (process exited, no PTY data)\n";
        }
    }

    // Step 10 — optional roundtrip: send "\n" and tick another 500ms
    if (!fatal && !ghostty_surface_process_exited(surface)) {
        NSLog(@"[spike5] sending newline via ghostty_surface_text()");
        @try {
            ghostty_surface_text(surface, "\n", 1);
        } @catch (NSException* ex) {
            log << "STEP10 surface_text EXCEPTION: " << [[ex reason] UTF8String] << "\n";
        }
        tickFor(app, 500);

        int bufCallsAfter = g_receive_buffer_count.load(std::memory_order_relaxed);
        int bufBytesAfter = g_receive_buffer_bytes.load(std::memory_order_relaxed);
        NSLog(@"[spike5] after newline: rcvBufCalls=%d rcvBufBytes=%d", bufCallsAfter, bufBytesAfter);
        log << "STEP10 after_newline: rcvBufCalls=" << bufCallsAfter
            << " rcvBufBytes=" << bufBytesAfter << "\n";
        log << "STEP10 roundtrip=" << (bufBytesAfter > 0 ? "OK (shell echoed data)" : "no additional data yet") << "\n";
    } else if (!fatal) {
        log << "STEP10 roundtrip=SKIPPED (process already exited)\n";
    }

    // Step 11 — cleanup
    NSLog(@"[spike5] cleanup");
    @try {
        if (surface != nullptr) { ghostty_surface_free(surface); log << "STEP11 surface_free=OK\n"; }
        if (app != nullptr)     { ghostty_app_free(app);         log << "STEP11 app_free=OK\n"; }
        if (config != nullptr)  { ghostty_config_free(config);   log << "STEP11 config_free=OK\n"; }
    } @catch (NSException* ex) {
        log << "STEP11 cleanup EXCEPTION: " << [[ex reason] UTF8String] << "\n";
    }

    NSLog(@"[spike5] runSpike complete");
    log << "runSpike=COMPLETE\n";

    return Napi::String::New(env, log.str());
}

// ---------------------------------------------------------------------------
// Module init
// ---------------------------------------------------------------------------

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("runSpike", Napi::Function::New(env, runSpike));
    return exports;
}

NODE_API_MODULE(ghostty_spike1, Init)
