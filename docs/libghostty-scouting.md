# libghostty Integration Scouting — Orpheus

## TL;DR

libghostty is real, ships with Ghostty today, and has a documented C API (`include/ghostty.h`) with ~90 exported functions. The macOS app is literally built on it — so the renderer quality bar is already proven. The **good news**: the embedding model (pass your NSView, get a GPU-rendered Metal surface back) is straightforward and has at least two public reference implementations (Kytos, Ghostling). The **hard news**: the full embedding API (`ghostty_app_new`, `ghostty_surface_new` with a real NSView) is the macOS-only path and the API signatures are **explicitly unstable** — no versioned release yet. Ghostling uses only libghostty-vt (VT-state layer only, no GPU rendering), not the full embedding API. Wiring the Metal-backed NSView into Electron's WKWebView-owned window is achievable (wgpu-electron pattern is documented) but requires an Objective-C++ native module bridging two thread boundaries. No one has published a working Electron + libghostty integration yet (the `electron-libghostty` npm package is 0.0.0 / skeleton-only, Unlicense).

**Biggest risk / biggest unknown:** Whether `ghostty_surface_new` with a caller-supplied NSView can be called from a Node.js native addon (Objective-C++ compiled by node-gyp) without triggering Ghostty's internal assertion that it is being called from a proper AppKit event loop. Unknown — needs a spike before any estimate.

---

## 1. libghostty as an Embeddable Surface

### 1a. API existence and location

libghostty is not a promise — it is live code. The canonical C header is:

```
include/ghostty.h          ← the public C API (~90 GHOSTTY_API symbols)
include/ghostty/           ← sub-headers (vt.h for libghostty-vt)
include/module.modulemap   ← Clang module map for Swift consumers
```

Source: [ghostty-org/ghostty — include/](https://github.com/ghostty-org/ghostty)

There are **two distinct library surfaces**:

| Library             | What it provides                                                      | GPU rendering?     | Stability                            |
| ------------------- | --------------------------------------------------------------------- | ------------------ | ------------------------------------ |
| `libghostty-vt`     | VT parser, terminal state, render-state query API, key/mouse encoders | No — caller draws  | Public alpha, API in flux            |
| `libghostty` (full) | Everything above + Metal renderer, PTY lifecycle, real NSView surface | Yes — Metal-backed | Unstable, macOS-only consumer so far |

For Orpheus (target: full Metal rendering, not roll-your-own renderer), the relevant library is the **full `libghostty`** — `ghostty_app_new` / `ghostty_surface_new` path. This is what the Ghostty macOS app uses internally.

**Key symbols from `include/ghostty.h`** (as of tip, May 2026):

```c
// Lifecycle
int ghostty_init(uintptr_t argc, char** argv);
ghostty_config_t ghostty_config_new();
void ghostty_config_free(ghostty_config_t);
void ghostty_config_finalize(ghostty_config_t);

ghostty_app_t ghostty_app_new(const ghostty_runtime_config_s*, ghostty_config_t);
void ghostty_app_free(ghostty_app_t);
void ghostty_app_tick(ghostty_app_t);       // pump event loop

// Surface (one per terminal pane)
ghostty_surface_config_s ghostty_surface_config_new();
ghostty_surface_t ghostty_surface_new(ghostty_app_t, const ghostty_surface_config_s*);
void ghostty_surface_free(ghostty_surface_t);

// Rendering (called by the host on display link callback)
void ghostty_surface_draw(ghostty_surface_t);
void ghostty_surface_refresh(ghostty_surface_t);
void ghostty_surface_set_size(ghostty_surface_t, uint32_t w_px, uint32_t h_px);
void ghostty_surface_set_content_scale(ghostty_surface_t, double x, double y);
void ghostty_surface_set_display_id(ghostty_surface_t, uint32_t);

// Input
bool ghostty_surface_key(ghostty_surface_t, ghostty_input_key_s);
void ghostty_surface_text(ghostty_surface_t, const char*, uintptr_t);
void ghostty_surface_preedit(ghostty_surface_t, const char*, uintptr_t);
void ghostty_surface_mouse_button(ghostty_surface_t, ...);
void ghostty_surface_mouse_pos(ghostty_surface_t, ...);
void ghostty_surface_mouse_scroll(ghostty_surface_t, ...);

// NSView plumbing
typedef struct { void* nsview; } ghostty_platform_macos_s;
// ghostty_surface_config_s.platform.macos.nsview = (__bridge void*)yourNSView
```

The `ghostty_surface_config_s.platform.macos.nsview` field is how you hand over your `NSView*`. libghostty then installs a `CAMetalLayer` on that view and takes ownership of rendering into it.

**Stability caveat:** Mitchell Hashimoto's own words: "the functionality is extremely stable … but the API signatures are still in flux." ([Libghostty Is Coming](https://mitchellh.com/writing/libghostty-is-coming)). There is no semver tag yet. Expect breaking changes in function signatures between Ghostty releases.

### 1b. Build system

Ghostty is built with **Zig**. The `build.zig` exposes two paths relevant to embedding:

- `zig build -Demit_lib_vt=true` → produces `libghostty-vt.a` (static) + `libghostty-vt.dylib` (shared) + optionally a universal `.xcframework` for Apple consumption.
- The **full** libghostty (with Metal renderer) is produced as an `.xcframework` via `zig build -Demit_xcframework=true`. This is what the Ghostty macOS Xcode project links against.

Third parties have two practical options:

1. **Build from Ghostty source** using Zig, output an xcframework or static `.a`, then link it from node-gyp/cmake-js. Requires: Zig 0.15.x (for current tip), Xcode, macOS SDK, iOS SDK (for xcframework), Metal toolchain.
2. **Consume Ghostty.app's embedded dylib** — fragile (private, no version guarantee), not recommended.

There are **no prebuilt artifacts** published to a registry. You build it yourself.

The Kytos project uses option 1 (build xcframework via `zig build -Doptimize=ReleaseFast`, wrap in xcframework, declare in XcodeGen). For Node.js native addon use, you would do the same and then reference the xcframework or static `.a` from `binding.gyp` / `CMakeLists.txt`.

Required linker flags (from Kytos): `-framework Carbon` (HID), `-framework Metal`, `-framework MetalKit`.

Ghostty also requires a resource bundle at runtime — it looks for `terminfo/78/xterm-ghostty` by walking up from the executable. This bundle must ship inside the Electron app bundle. Unknown: whether the resource discovery heuristic works when called from inside a `.node` addon inside Electron. **Needs spike.**

### 1c. License

MIT. Full text: [ghostty-org/ghostty — LICENSE](https://github.com/ghostty-org/ghostty/blob/main/LICENSE)

```
MIT License
Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors
```

No sublicensing restriction, no attribution-in-UI requirement. The standard MIT "keep the copyright notice" condition applies — include the LICENSE text in your distributed app. No "open-source-if-you-use-this" (copyleft) component. **Clean for a closed-source commercial product.** Ghostty's Zig dependencies are bundled in `build.zig.zon`; you should audit those for any non-MIT straggler, but the upstream project is MIT.

### 1d. Thread model / lifecycle

From Ghostty source and Kytos implementation:

- **All libghostty API calls must run on the macOS main thread** (same constraint as AppKit). The Ghostty Swift code marks virtually every surface call `@MainActor`.
- Internally, Ghostty spins up: an **IO thread** per surface (PTY read/write, VT parsing) and a **renderer thread** per surface (Metal draw at display-link rate). The host app does not manage these — they are opaque.
- `ghostty_app_tick(app)` must be called periodically from the main thread to process pending actions (clipboard, title changes, etc.).
- Multi-instance: `ghostty_surface_new` can be called multiple times against the same `ghostty_app_t`. Each call spawns its own IO + renderer threads. Memory cost is non-trivial (Metal resources per surface + PTY buffers + scrollback). Unknown: upper bound on simultaneous surfaces without degraded frame rate — **needs spike on a target Mac spec**.
- `ghostty_surface_free` must also be called from the main thread.

### 1e. Internal architecture

([DeepWiki — ghostty-org/ghostty](https://deepwiki.com/ghostty-org/ghostty))

- **apprt**: abstraction layer between the core and the UI toolkit. On macOS, apprt is Swift/AppKit. For a third-party embedder, you implement the `ghostty_runtime_config_s` callbacks instead.
- **Renderer**: Metal on macOS, OpenGL on Linux. Uses IOSurfaceLayer with a display-link callback for frame pacing.
- **Termio**: PTY lifecycle. Spawns the shell, reads bytes, feeds the VT parser.
- The Swift `SurfaceView` subclass (`SurfaceView_AppKit.swift`) shows the pattern: subclass `NSView`, call `ghostty_surface_new` passing `self` as the nsview, then forward AppKit events to the appropriate `ghostty_surface_*` functions.

---

## 2. Native NSView Embedding Inside Electron BrowserWindow

### 2a. Prior art

| App                         | Renderer approach                                       | Embedding style          |
| --------------------------- | ------------------------------------------------------- | ------------------------ |
| Hyper                       | xterm.js (Canvas)                                       | Web-only, no native view |
| Tabby                       | xterm.js                                                | Web-only                 |
| VS Code integrated terminal | xterm.js + CanvasRenderer / WebGL                       | Web-only                 |
| Wave Terminal               | Electron + xterm.js                                     | Web-only                 |
| Warp                        | Standalone native app (Rust/Metal, custom UI framework) | Not Electron at all      |
| Zed                         | Standalone native app (Rust/GPUI)                       | Not Electron at all      |
| Ghostty (standalone)        | Native Metal/AppKit, Zig core                           | Not Electron             |
| Kytos                       | Native macOS (Swift + libghostty xcframework)           | Not Electron             |
| **electron-libghostty**     | npm 0.0.0 skeleton, no source                           | Unknown                  |

No production Electron app is known to embed a Metal-backed NSView terminal. The closest public reference for the _pattern_ is embedding wgpu (a Rust Metal renderer) inside Electron: [Using wgpu with Electron on macOS](https://www.monkeynut.org/wgpu-electron/).

### 2b. What `getNativeWindowHandle()` actually returns

On macOS, `BrowserWindow.getNativeWindowHandle()` returns a `Buffer` containing the pointer value of the `NSView*` that is the **contentView** of the `NSWindow`. Source: [Electron issue #7460](https://github.com/electron/electron/issues/7460).

In Objective-C++:

```objc
NSView* contentView = *reinterpret_cast<NSView**>(buffer.Data());
```

This is the root `WKWebView`-containing hierarchy. You do **not** receive the `NSWindow*` directly.

### 2c. Three approaches to mount a Metal NSView

#### Approach A — Subview of contentView (recommended starting point)

Add your custom `NSView` (with `CAMetalLayer`) as a subview of the Electron contentView, positioned to fill the terminal area.

```objc
// In native addon, on main thread:
GhosttyHostView* termView = [[GhosttyHostView alloc] initWithFrame: terminalRect];
[contentView addSubview: termView];
// Then: ghostty_surface_new(app, &cfg) with cfg.platform.macos.nsview = termView
```

Positioning: the renderer tells the main process the terminal rect (in logical pixels) via IPC. The native addon converts to screen coordinates and calls `[termView setFrame:]`.

**Pros**: simplest, no separate NSWindow to manage, resize/z-order works naturally.
**Cons**: The WKWebView (Electron's web layer) sits in the same view hierarchy. By default, the WKWebView's `CALayer` composite sits on top of any sibling subview added _before_ it. To punch a hole, the renderer must render the terminal area with `background: transparent` and the native view must be positioned _behind_ the web layer in z-order (use `[contentView sortSubviewsUsingFunction:...]` or insert below the WKWebView subview).

**Z-order nuance**: Electron's contentView contains the WKWebView as a direct child. Subviews added to contentView are layered in insertion order. Adding termView _before_ the WKWebView (not straightforward since WKWebView is already there) puts it beneath; adding it after puts it on top. For a "hole" effect, you want it **beneath** the WKWebView with web content transparent in the terminal region. Alternatively, add it **on top** and accept that it will receive all mouse/keyboard events in its frame (which you want for the terminal anyway).

Recommended: add the terminal NSView **on top** of the WKWebView in the terminal region. The renderer leaves that region transparent/empty (no DOM content there). Clicks and keyboard events for the terminal area route to the native NSView, not to WKWebView.

#### Approach B — Child NSWindow (panel)

Attach a borderless `NSPanel` to the main `NSWindow` as a child window:

```objc
[mainWindow addChildWindow: termPanel ordered: NSWindowAbove];
```

The panel's frame tracks the terminal region via IPC + `setFrame:`.

**Pros**: complete isolation from WKWebView layer hierarchy, trivial z-order.
**Cons**: window ordering complexity during Mission Control / Exposé / full-screen transitions; the panel may not follow correctly in split-view; two windows make task-switching and screen recording more complex; `setFrame:` calls to synchronize with web layout can produce visible lag (one-frame delay).

#### Approach C — CALayer composition

Inject a custom `CALayer` into the WKWebView's layer tree, beneath the content layer.

**Pros**: theoretically pixel-perfect compositor integration.
**Cons**: undocumented, brittle, WKWebView's internal layer tree changes across macOS versions, no public API, extremely high maintenance. **Not recommended.**

### 2d. Focus, keyboard, and IME

The most complex piece. When the user clicks in the terminal:

1. The NSView's `acceptsFirstResponder` returns YES; it becomes first responder.
2. Keyboard events flow to the NSView's `keyDown:` / `keyUp:`; you forward them to `ghostty_surface_key()`.
3. For IME (CJK, dead keys): the NSView must implement `NSTextInputClient`. libghostty exposes the necessary primitives: `ghostty_surface_text()` (committed text), `ghostty_surface_preedit()` (marked text), `ghostty_surface_ime_point()` (IME candidate position). The Kytos implementation confirms this works correctly.
4. Electron's web content also wants keyboard events. While the terminal NSView is first responder, WKWebView does **not** receive keyboard events. You must explicitly call `[NSApp.mainWindow makeFirstResponder: webView]` to return focus to the web layer when the user clicks outside the terminal.

**Risk**: Electron's own key event handling (global shortcuts, devtools toggle, etc.) runs in the browser process. Some of these intercept events before AppKit dispatch. Needs testing — especially `Cmd+,`, `Cmd+W`, and similar chords that Electron itself handles.

### 2e. Drag region

Electron's `titleBarStyle: 'hiddenInset'` uses a transparent drag region defined in CSS (`-webkit-app-region: drag`). The WKWebView implements this by hit-testing regions. A native NSView on top of the drag region will **eat mouse events** before WKWebView sees them, so the drag region will stop working wherever the terminal NSView overlaps it. The terminal NSView should be positioned to **not overlap the drag strip** at the top of the window (leave ~28–36 px at the top untouched, or handle dragging separately in the native view for that subregion).

### 2f. Vibrancy and traffic lights

Traffic light buttons are part of the `NSWindow` chrome, not the WKWebView. A subview of contentView does not block traffic lights as long as the subview frame does not extend into the traffic light region (top-left ~68px × 40px at standard size). The native NSView must be sized to avoid this area.

Vibrancy (`NSVisualEffectView`) would need to be added as a separate subview underneath the terminal NSView if a frosted-glass background under the terminal is desired — Ghostty handles its own background rendering, so typically you would just let Ghostty render a solid background color.

### 2g. Retina, display profile changes, full-screen

- Retina: `ghostty_surface_set_content_scale(surface, 2.0, 2.0)` for 2x displays. Electron fires `did-change-display-state` (or you can observe `NSWindowDidChangeBackingPropertiesNotification` in the native addon). Pass the new scale to Ghostty.
- Display profile / HDR changes: Ghostty internally handles the Metal pixel format. Set `ghostty_surface_set_display_id(surface, displayID)` when the window moves to a different display (observe `NSWindowDidChangeScreenNotification`).
- Full-screen: Electron native full-screen (`NSWindow enterFullScreenMode`) can trigger re-layout. The terminal NSView should respond to `setFrameSize:` by calling `ghostty_surface_set_size()` and `ghostty_surface_set_content_scale()`. Using `NSLayoutConstraints` (as the wgpu-electron guide does) lets macOS handle the resize automatically without an explicit IPC round-trip per frame.

---

## 3. Realistic Integration Plan for Orpheus

### 3a. Hello-world milestone

Goal: a single terminal pane backed by libghostty, inside the Electron BrowserWindow, running `bash`, showing characters, accepting keyboard input.

Steps:

1. **Build libghostty as xcframework** from Ghostty source on a macOS dev machine with Zig 0.15.x + Xcode. Target: `arm64-macos` (Apple Silicon) + optionally `x86_64-macos` for Intel. Output: `GhosttyKit.xcframework` containing the static library, `ghostty.h`, and the module map.

2. **Create the native addon** (`packages/ghostty-native`). Use **cmake-js** as the build tool (see §3b). Write an Objective-C++ source file (`addon.mm`) that:
   - Exports NAPI functions: `init(configKVPairs)`, `mountSurface(nsviewPtr, width, height, scaleFactor)`, `resize(width, height, scaleFactor)`, `focus(bool)`, `sendKey(keyEvent)`, `sendMouseButton(...)`, `sendMouseScroll(...)`, `teardown()`.
   - On `init`: calls `ghostty_init`, `ghostty_config_new`, `ghostty_config_finalize`, `ghostty_app_new` with a `ghostty_runtime_config_s` supplying the five callbacks (wakeup, action, clipboard-read, clipboard-confirm, clipboard-write, close-surface).
   - On `mountSurface`: creates a custom `NSView` subclass, adds it as a subview of the passed contentView pointer, calls `ghostty_surface_new`.
   - Sets up a `CVDisplayLink` callback that calls `ghostty_surface_draw` at display refresh rate.

3. **Wire the IPC** between Electron renderer and main process (see §3c). Renderer emits `terminal:mount` with its bounding rect; main process calls the native addon on the main thread.

4. **Test**: window opens, bash prompt appears, characters echo, Ctrl+C works, resize reflows.

### 3b. Native module: build tooling recommendation

**Recommended: cmake-js + prebuildify**

- `cmake-js` handles Electron header discovery automatically (`--runtime=electron --target=39.0.0`), has first-class Electron support, and is more flexible than node-gyp for C/C++ projects that link non-Node libraries (like an xcframework).
- `prebuildify` wraps cmake-js to produce prebuilt `.node` binaries per `electron-ABI`. Ship these in the npm package so end-users don't need Zig or Xcode installed.
- **node-gyp** is viable but more cumbersome for linking Apple frameworks; the `binding.gyp` DSL is less expressive than CMakeLists.txt for finding xcframework paths.
- **NAN is dead** — use **Node-API (NAPI)**. It is ABI-stable across Node.js minor versions. Electron 39 bundles Node.js 22.21.1; Node-API in Node 22 is v9. NAPI guarantees the addon works across Electron minor/patch releases without recompile.

Module name suggestion: `@orpheus/ghostty-native` (scoped, reflects ownership). Internal directory: `packages/ghostty-native/`.

**Electron ABI concern**: Electron's V8 ABI is not identical to Node.js V8 ABI. NAPI mitigates this — NAPI addons are stable across both. If you use any raw V8 API (e.g., `v8::String::New`), you must recompile per Electron version. Stick to NAPI-only. Reference: [Electron — Using Native Node Modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules).

### 3c. IPC shape (concrete contract)

All messages flow through the contextBridge / `ipcMain` layer. The renderer never holds a native handle directly.

```typescript
// Renderer → Main
ipcRenderer.invoke('terminal:mount', {
  windowId: number,        // BrowserWindow id
  rect: { x, y, w, h },   // logical pixels, relative to contentView
  scaleFactor: number,     // window.devicePixelRatio
  shell: string,           // e.g. '/bin/zsh'
  cwd: string,
}): Promise<{ surfaceId: string }>

ipcRenderer.invoke('terminal:resize', {
  surfaceId: string,
  rect: { x, y, w, h },
  scaleFactor: number,
})

ipcRenderer.invoke('terminal:focus', { surfaceId: string, focused: boolean })

ipcRenderer.invoke('terminal:setFontSize', { surfaceId: string, size: number })

ipcRenderer.invoke('terminal:destroy', { surfaceId: string })

// Main → Renderer (push events)
ipcMain.emit('terminal:titleChanged', { surfaceId, title: string })
ipcMain.emit('terminal:cwdChanged', { surfaceId, cwd: string })
ipcMain.emit('terminal:exited', { surfaceId, exitCode: number })
ipcMain.emit('terminal:bell', { surfaceId })
ipcMain.emit('terminal:clipboardWrite', { surfaceId, text: string })
```

All `terminal:*` calls on the main side dispatch to the native addon on the main thread (required by AppKit). The native addon's `wakeup_cb` callback (called from Ghostty's IO thread) should schedule `ghostty_app_tick` on the main thread via `dispatch_async(dispatch_get_main_queue(), ...)`.

### 3d. Multi-pane / multi-tab

Each pane = one `ghostty_surface_t` = one PTY thread + one renderer thread. Memory: rough estimate ~30–60 MB per surface (Metal resources, scrollback buffer at default size, font atlas). CPU: renderer thread idles when surface is occluded — call `ghostty_surface_set_occlusion(surface, true)` when a pane is hidden.

For tabs: `ghostty_surface_set_occlusion` on the inactive tabs' surfaces. They continue running (shell keeps executing) but Metal rendering is paused.

For splits: multiple `ghostty_surface_t` instances with non-overlapping `setFrame:` rects. All share the same `ghostty_app_t`.

**Deferral**: multi-pane is V2. For V1, one `ghostty_surface_t` per window.

### 3e. Event ownership summary

| Event              | Owner                           | Mechanism                                                                    |
| ------------------ | ------------------------------- | ---------------------------------------------------------------------------- |
| Keyboard down/up   | Native NSView                   | `NSResponder.keyDown:` → `ghostty_surface_key()`                             |
| IME composition    | Native NSView                   | `NSTextInputClient` → `ghostty_surface_preedit()` / `ghostty_surface_text()` |
| Mouse button       | Native NSView                   | `NSResponder.mouseDown:` → `ghostty_surface_mouse_button()`                  |
| Mouse scroll       | Native NSView                   | `NSResponder.scrollWheel:` → `ghostty_surface_mouse_scroll()`                |
| Resize             | NSView `setFrameSize:` override | → `ghostty_surface_set_size()` + `ghostty_surface_set_content_scale()`       |
| Font size          | IPC `terminal:setFontSize`      | Config update: `ghostty_config_*` + `ghostty_surface_update_config()`        |
| Frame draw         | CVDisplayLink or CADisplayLink  | → `ghostty_surface_draw()` on renderer thread                                |
| Title / CWD change | Ghostty action_cb               | → IPC push to renderer                                                       |
| Clipboard          | Ghostty read/write clipboard_cb | → IPC to renderer, which uses `navigator.clipboard` API                      |

### 3f. Font loading

libghostty handles font selection itself via **CoreText**. You pass a font-family name string through Ghostty config (`font-family = "JetBrains Mono"`) and Ghostty queries CoreText at startup. You do not feed raw font data. For V1, use the config to set the font; expose `terminal:setFontSize` over IPC to scale it at runtime via `ghostty_surface_update_config`.

---

## 4. Risks and Unknowns

### 4a. Highest-risk piece

**Main thread requirement inside a Node.js addon.**

Ghostty requires all API calls on the macOS main thread. Node.js addons run on Node's main thread, which is also the Electron main process thread — and on macOS, if the Electron app initializes an `NSApp` (which it does), this thread is the AppKit main thread. In theory this is fine. In practice:

- Ghostty's internals call into AppKit/Metal, which assert they are on the main thread.
- If any Ghostty call ends up on the Node.js libuv thread pool (e.g., triggered by an async NAPI call), it will crash.
- The `wakeup_cb` is called from Ghostty's internal IO thread and must dispatch work back to the main thread — the pattern is `dispatch_async(dispatch_get_main_queue(), block)`. This adds latency but is safe.

**This is the spike that must happen before any estimate is meaningful.** A minimal test: call `ghostty_init` + `ghostty_app_new` from an Objective-C++ NAPI addon loaded by Electron and verify no assertion fires, no crash, and a Metal layer appears. Time box: 1–2 days.

### 4b. What would push us back to xterm.js temporarily?

If the main-thread spike fails and the fix is non-trivial (e.g., Ghostty's event model fundamentally conflicts with Electron's NSApp setup), xterm.js is a viable **temporary scaffolding** — not a permanent answer. Specifically:

- Implement the IPC shape (`terminal:mount`, `terminal:resize`, etc.) against an xterm.js-backed surface first.
- Keep the native NSView mounting and event-forwarding code as stubs.
- Once the Ghostty main-thread issue is resolved (either by a patch to Ghostty's macOS embedding API or a workaround), swap the surface backend without touching the IPC layer.

Caveat: this adds 2–4 weeks of throwaway code. Only worth it if other UI work (editor, sidebar, layout) is blocked on a working terminal surface.

### 4c. macOS version floor and GPU

- **Ghostty 1.3** (current stable at time of writing) requires **macOS 13 Ventura**. Ghostty 1.4+ will require **macOS 14 Sonoma** (released March 2026 per release notes). Source: [Ghostty — 1.3.0 release notes](https://ghostty.org/docs/install/release-notes/1-3-0).
- **Electron 39** bundles Node.js 22.21.1 and Chrome 142 / V8 14.2. Electron's own macOS floor is macOS 11 Big Sur (typically), but in practice Metal on macOS 12+ is required for modern CAMetalLayer behavior.
- **Effective floor for Orpheus**: macOS 14 (Sonoma) once you pin to libghostty from Ghostty 1.4+. This covers ~80%+ of active macOS installs by end of 2026.
- **GPU**: Metal is required. This excludes ancient Intel GPUs that only support Metal 1 feature set — not a meaningful concern for a developer IDE targeting recent hardware.
- **Retina / ProMotion**: libghostty handles ProMotion (120 Hz) natively via display link. Confirmed working at 120fps in Kytos on ProMotion displays.

### 4d. License / IP risk

- Ghostty: MIT, no surprises. Closed-source commercial app using MIT code is textbook-fine.
- Ghostty's Zig dependencies (listed in `build.zig.zon`): need a one-time audit pass. The main suspects (freetype, harfbuzz, etc.) are typically MIT/FreeType/LGPL. LGPL _could_ be a concern for static linking in a closed-source app — unknown without the full dependency audit. **Action item**: run `zig build --fetch` and inspect each dependency's license.
- The Ghostty resource bundle (terminfo, shell integration scripts) ships with Ghostty under MIT. Including it in Orpheus's app bundle is permitted.

---

## 5. Concrete Next Steps (De-risking Spikes)

**Spike 1 — Main-thread compatibility test** (highest priority, ~2 days)
Write a minimal Objective-C++ NAPI addon (`addon.mm`) that calls `ghostty_init`, `ghostty_app_new`, and `ghostty_surface_new` (with a dummy NSView) from the Electron main process. Verify no AppKit assertion fires, the Metal surface initializes, and `ghostty_surface_draw` completes a frame. Ship as a test binary — no UI, just stdout confirmation. Resolves the central unknown.

**Spike 2 — xcframework build reproducibility** (~1 day)
Document the exact `zig build` invocation + Zig version + Xcode version that produces a working `GhosttyKit.xcframework` for arm64. Automate as a `scripts/build-ghostty.sh`. Pinning Ghostty to a specific commit hash in that script is essential given API instability.

**Spike 3 — NSView subview z-order + hole rendering** (~1 day)
In a standalone Electron app (no libghostty yet), add a plain colored `NSView` as a subview of the contentView above the WKWebView. Verify: (a) it appears on top, (b) mouse events route to it and not WKWebView in that region, (c) the drag strip above it still works, (d) traffic lights are unobscured. Resolves the web/native layer interaction unknowns without the Ghostty build dependency.

**Spike 4 — Dependency license audit** (~half day)
Run `zig build --fetch` on the pinned Ghostty commit, collect all `build.zig.zon` transitive dependencies, list their licenses. Flag any non-permissive license (LGPL, GPL). Resolves IP risk question.

**Spike 5 — Resource bundle path resolution** (~half day)
Start the Ghostty `ghostty_app_t` inside the Electron process and verify it finds its `terminfo/78/xterm-ghostty` resource file. The search heuristic walks up from the executable; in Electron the executable is in `Orpheus.app/Contents/MacOS/`. Place the Ghostty resources at `Orpheus.app/Contents/Resources/ghostty/` and test whether Ghostty's discovery finds it — or whether a `GHOSTTY_RESOURCES_DIR` env var override is needed.

---

## References

- [Ghostty GitHub repo](https://github.com/ghostty-org/ghostty) — source of `include/ghostty.h`
- [Libghostty Is Coming — Mitchell Hashimoto](https://mitchellh.com/writing/libghostty-is-coming)
- [ghostty-org/ghostling — minimal libghostty-vt C example](https://github.com/ghostty-org/ghostling)
- [awesome-libghostty](https://github.com/Uzaaft/awesome-libghostty)
- [Kytos: A Native macOS Terminal Built on Ghostty](https://jwintz.gitlabpages.inria.fr/jwintz/blog/2026-03-14-kytos-terminal-on-ghostty/) — best public reference for the NSView + CAMetalLayer pattern
- [Using wgpu with Electron on macOS](https://www.monkeynut.org/wgpu-electron/) — definitive guide for NSView subview inside Electron
- [Electron — Native Code and Electron (macOS / Objective-C)](https://www.electronjs.org/docs/latest/tutorial/native-code-and-electron-objc-macos)
- [Electron — Using Native Node Modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)
- [Electron issue #7460 — getNativeWindowHandle returns NSView\*](https://github.com/electron/electron/issues/7460)
- [Ghostty macOS release requirements](https://ghostty.org/docs/install/release-notes/1-3-0)
- [ghostty-org/ghostty — LICENSE (MIT)](https://github.com/ghostty-org/ghostty/blob/main/LICENSE)
- [Ghostty architecture — DeepWiki](https://deepwiki.com/ghostty-org/ghostty)
- [Ghostty build from source](https://ghostty.org/docs/install/build)

---

## 6. Update: switching to prebuilt xcframework (2026-05-11)

Building Ghostty from source is currently blocked on this machine: Zig 0.15.2 cannot
link against the Xcode 26.4 SDK on macOS 26 Tahoe due to a linker TBD-identifier change
that Zig's linker driver does not yet handle. Ghostty does not support Zig 0.16 yet, so
there is no forward path through the toolchain until either Ghostty bumps its minimum Zig
version or Zig releases a 0.15.x patch.

To unblock integration work, we are switching to the prebuilt `GhosttyKit.xcframework`
published by [`Lakr233/libghostty-spm`](https://github.com/Lakr233/libghostty-spm) (MIT
license, single maintainer, weekly auto-rebuilds triggered by Ghostty CI). The artifact
is a four-slice xcframework (macOS universal arm64+x86_64, plus iOS and Catalyst slices
we ignore) and wraps Ghostty v1.3.1. The macOS slice provides `libghostty.a` and
`ghostty.h` with the full embedding API confirmed above.

**Trust caveat**: this is a single-maintainer community wrapper — it is not an official
Ghostty artifact. Mitigation: we pin the artifact by its SHA-256 hash in
`scripts/fetch-libghostty.sh`; any tampered or accidentally swapped release will fail
the verification step loudly at fetch time. Future bumps must update both the URL and the
hash constant together.

The Ghostty source clone (`vendor/ghostty/`) is retained alongside the xcframework. It
provides `terminfo/78/xterm-ghostty` and the shell-integration scripts that the native
addon will need to locate at runtime inside the Electron app bundle (see §3b Spike 5).

**Next step**: the native addon (`packages/ghostty-native/`) will link against
`vendor/GhosttyKit.xcframework/macos-arm64_x86_64/libghostty.a` using cmake-js and
bind the C API via NAPI (Node-API v9). The IPC shape is already defined in §3c above.
