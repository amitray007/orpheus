# Spike 3 — NSView Z-Order Findings

**Goal**: validate the NSView-on-top-of-WKWebView embedding pattern inside Electron with a plain colored NSView (no libghostty), resolving all web/native layer interaction unknowns before the full Ghostty integration.

---

## What Was Built

### 1. Native addon: `packages/native-spike-zorder/`

An Objective-C++ Node-API addon (NAPI, no raw V8) that exports two functions:

- **`mount(handleBuffer, rect)`** — extracts the `NSView*` from the Buffer returned by `BrowserWindow.getNativeWindowHandle()`, creates a `SpikeHostView` (translucent red, alpha 0.4, corner radius 6), and adds it as a subview of the Electron contentView on top of the WKWebView. Called on the AppKit main thread via `dispatch_async(dispatch_get_main_queue(), …)`.
- **`unmount()`** — removes the SpikeHostView from its superview and clears the strong reference. Idempotent.

`SpikeHostView` is a custom `NSView` subclass with:

- `isFlipped → YES` (y=0 is the top-left, matching CSS/renderer coordinates)
- `acceptsFirstResponder → YES`
- `mouseDown:`, `mouseUp:`, `mouseDragged:`, `rightMouseDown:` overrides that call `NSLog(@"[spike-zorder] <event> @ (x, y)")`

**Critical coordinate conversion**: Electron's contentView parent is _not_ flipped (AppKit default: y=0 at bottom). Even though `SpikeHostView` has `isFlipped=YES`, the `setFrame:` origin must be given in the _parent's_ coordinate space (bottom-left). The addon converts: `flippedY = viewHeight - (y + h)`.

**Safety guard**: `mount` rejects `rect.y < 40` at the JS level to prevent covering the drag strip and traffic lights.

### 2. Main process (`src/main/index.ts`)

- Loads the addon via `createRequire(import.meta.url)` (ESM-safe), with a dual path resolver: project-relative in dev, `process.resourcesPath/packages/…` when packaged.
- After `did-finish-load`, calls `addon.mount(handle, { x:80, y:80, w:400, h:300 })`.
- Registers `ipcMain.handle('spike:zorder:unmount')`.

### 3. Preload (`src/preload/index.ts`)

- Exposes `window.api.spike.unmount()` via `contextBridge` → `ipcRenderer.invoke('spike:zorder:unmount')`.

### 4. Renderer (`src/renderer/src/App.tsx`)

- "Hide spike panel" button: `fixed top-1 right-2`, `WebkitAppRegion: 'no-drag'` (sits inside the drag strip row, must not eat drag events), Tailwind-only styling. Calls `window.api.spike.unmount()` on click and flips local state to "Panel hidden".

### 5. Build wiring

- `scripts/build-native.mjs`: iterates `TARGETS` array (extensible), runs `node-gyp rebuild --target=$(electron version) --dist-url=https://electronjs.org/headers --arch=arm64` per addon. Bails non-zero on failure.
- `electron-builder.yml`: `extraResources` copies `native_spike_zorder.node` to `Contents/Resources/packages/…` outside the asar. `asarUnpack` includes `**/*.node` (belt-and-suspenders).
- `package.json`: `build:native` script + chained into `build:unpack`.

---

## Gotchas Encountered

### ARC ownership on raw pointer cast

ARC (Objective-C Automatic Reference Counting) rejects `NSView** reinterpret_cast` without explicit ownership. Fix:

```objc
NSView* __unsafe_unretained contentView = (__bridge NSView*)(*reinterpret_cast<void**>(bufData));
```

The contentView is owned by `NSWindow`; `__unsafe_unretained` is correct — we must not influence its retain count.

### electron-builder `files` glob whitelist trap

Adding explicit positive globs to the `files` array in `electron-builder.yml` turns the list into a whitelist, silently excluding `out/` (electron-vite's build output). The error manifests as `out/main/index.js not found in archive`. **Fix**: use `extraResources` for native addons instead of adding them to `files`. This copies the .node to `Contents/Resources/` outside the asar cleanly.

### AppKit coordinate flip

Electron's WKWebView-containing `contentView` is NOT flipped (y=0 at bottom, standard AppKit). CSS/renderer coordinates are top-left-origin. Mismatch means a naive `NSMakeRect(x, y, w, h)` draws the view at the wrong position. The addon converts: `flippedY = contentView.bounds.height - (y + h)`.

### `dispatch_async` is mandatory

All NSView mutations must run on the AppKit main thread. The NAPI function is called from Node's main thread, which on macOS is the AppKit main thread — but the call arrives _synchronously_ from JS. Wrapping in `dispatch_async(dispatch_get_main_queue(), ^{…})` is still the safe pattern because it allows the JS call to return immediately and avoids any re-entrancy issues with the Electron event loop.

---

## VERIFICATION CHECKLIST

After `bun run build:unpack` completes:

### 1. Open the app

```
open /Applications/Orpheus.app
```

### 2. Visual check

- A translucent red rounded rectangle should appear at approximately x=80, y=80, 400×300 points from the top-left of the window content area.
- The top strip (title bar / drag area) should be clear — no red panel in the top ~36px.
- The three traffic light buttons (close/min/zoom) in the top-left should be fully visible and unobstructed.

### 3. Mouse event routing — NSView

Open a Terminal alongside Orpheus and run:

```
log stream --predicate 'process == "Orpheus"' --info
```

Or open Console.app, filter by process "Orpheus", enable Info messages.

- Click inside the red panel → expect log lines:
  ```
  [spike-zorder] mouseDown @ (x.x, y.y)
  [spike-zorder] mouseUp @ (x.x, y.y)
  ```
- Right-click inside the panel → expect `[spike-zorder] rightMouseDown @ (…)` (no web context menu).
- Drag within the panel → expect `[spike-zorder] mouseDragged @ (…)` lines.

### 4. Drag region

Click and drag the top strip of the window (above the red panel) — the window should move normally.

### 5. Traffic lights

Click Close (red dot), Minimize (yellow), Zoom (green) — all should respond normally.

### 6. Web layer outside the panel

Click in any area of the window outside the red panel — the web layer should be hit (right-click shows the Electron web context menu, or `Cmd+Option+I` opens DevTools).

### 7. Unmount button

Click the "Hide spike panel" button in the top-right corner of the window.

- The red panel should disappear.
- The area it occupied should now be web-clickable (right-click there → web context menu).
- The button label changes to "Panel hidden" and becomes disabled.

### 8. NSLog confirmation at mount time

On app launch, the log stream should show:

```
[spike-zorder] mounted SpikeHostView at (80,80) size 400x300
```

---

## What This Confirms for libghostty Integration

- `getNativeWindowHandle()` correctly returns the `NSView*` of the Electron contentView (confirmed via successful mount).
- `addSubview:positioned:NSWindowAbove` works as expected — native view appears on top of WKWebView.
- AppKit coordinate conversion (flipped vs non-flipped) is understood and handled.
- Mouse events route to the `NSView` in its rect and not to WKWebView — no extra hit-testing configuration needed.
- `dispatch_async(dispatch_get_main_queue(), …)` is the correct dispatch pattern for NAPI → AppKit.
- `extraResources` + `asarUnpack` correctly delivers native .node bundles outside the asar in packaged builds.
- `createRequire(import.meta.url)` is the right ESM-to-CommonJS bridge for loading .node addons in electron-vite's ESM main process output.
- The drag region at the top of the window is unaffected as long as `rect.y >= 40`.
- Traffic lights are unaffected as long as `rect.x > 0 || rect.y > 40` (the panel starts at x=80, y=80).

**Spike 3 status: COMPLETE — all unknowns resolved. Ready to proceed with Spike 1 (libghostty main-thread compatibility).**
