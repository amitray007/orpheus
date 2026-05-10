# Phase 2A — libghostty-spm Audit

**Date:** 2026-05-10  
**Pinned tag:** `1.0.1777879537`  
**Auditor:** Phase 2A build agent

---

## 1. Pinned tag and binary provenance

- Tag: `1.0.1777879537` (published 2026-05-04 07:33 UTC — most recent stable release at audit time)
- Binary: `GhosttyKit.xcframework.zip` from `storage.1.0.1777879537` release
- Checksum: `45e9e57f8f02662f60a5619ede84107eb5c931236e94730cbf417b991096013f`
- Binary slices: `macos-arm64_x86_64`, `ios-arm64_x86_64-simulator`, `ios-arm64_x86_64-maccatalyst`, `ios-arm64`
- We use the `macos-arm64_x86_64` slice only.

---

## 2. Symbol verification

`nm -gU` on `GhosttyKit.xcframework/macos-arm64_x86_64/libghostty.a` confirmed
all critical symbols are present and **not** routed through any ShellCraftKit shim:

| Symbol | Address | Result |
|--------|---------|--------|
| `_ghostty_init` | `0x10a60` | PASS |
| `_ghostty_app_new` | `0x18498c` | PASS |
| `_ghostty_surface_new` | `0x1ffbe0` | PASS |
| `_ghostty_surface_free` | `0x2d79bc` | PASS |
| `_ghostty_surface_key` | `0x2daf40` | PASS |
| `_ghostty_surface_text` | (present) | PASS |
| `_ghostty_surface_mouse_button` | `0x2dd3b4` | PASS |
| `_ghostty_surface_set_size` | (present) | PASS |
| `_ghostty_surface_set_content_scale` | (present) | PASS |
| `_ghostty_config_new` | `0x2ec79c` | PASS |
| `_ghostty_config_load_file` | `0x2edbb4` | PASS |

No `ShellCraftKit_*` prefix symbols observed in the binary — ShellCraftKit is
Swift-layer only and is a separately compiled module that we do not link.

---

## 3. ShellCraftKit / unsandboxed spawn

**Finding: ShellCraftKit is opt-in and sandboxed-App-Store-only. Orpheus is unaffected.**

`ShellCraftKit` is a separate SwiftPM target in libghostty-spm. It provides a
fake in-memory shell (implemented entirely in Swift) for apps that cannot spawn
subprocesses due to App Store sandbox restrictions.

Key details from source inspection:
- `TerminalSessionBackend` is an enum: `.exec` (real PTY) or `.inMemory(InMemoryTerminalSession)` (ShellCraftKit).
- The default `TerminalSurfaceOptions` uses `.exec`.
- `ShellCraftKit` is loaded only when the caller sets `backend = .inMemory(...)`.
- Orpheus is unsandboxed and uses `backend = .exec` (the default), which maps to
  `GHOSTTY_SURFACE_IO_BACKEND_EXEC` in the C ABI — this path runs arbitrary commands
  via a real PTY with no sandboxing.
- `ShellCraftKit` is NOT listed as a dependency of `GhosttyKit` or `GhosttyTerminal`
  in `Package.swift` — it's a sibling product that downstream apps opt into.

**Verdict: PASS. Unsandboxed arbitrary command spawn is fully supported.**

---

## 4. Metal layer hosting

**Finding: AppTerminalView exposes its CAMetalLayer and is embeddable in any NSView hierarchy.**

`AppTerminalView` (the AppKit view in `GhosttyTerminal`):
- Creates a `CAMetalLayer` in `commonInit()`, assigns it to `self.layer`, and
  exposes it via a `metalLayer` ivar.
- Does NOT require a Ghostty-owned root window — it's a standard `NSView` subclass
  that can be added to any view hierarchy.
- Handles `viewDidMoveToWindow`, `viewDidChangeBackingProperties`, and
  `viewDidChangeEffectiveAppearance` internally.
- Drives the Metal render loop via `MSDisplayLink` (a `DispatchQueue`-based
  display link from `Lakr233/MSDisplayLink`) — we do NOT need to manage frames.

Our wrapper (`OrpheusTerminalNSView`) embeds `AppTerminalView` as a constrained
subview using Auto Layout, which correctly propagates frame changes through
AppKit's layout system.

**Verdict: PASS. CAMetalLayer is accessible and Metal hosting works via standard NSView embedding.**

---

## 5. IME / input handling

`GhosttyTerminal`'s `AppTerminalView` provides a complete, production-quality
input stack mirroring Ghostty's native AppKit implementation:

- `TerminalKeyEventHandler` handles `keyDown`, `keyUp`, `flagsChanged`.
- `TerminalTextInputHandler` + `NSTextInputClient` conformance for IME (CJK
  composition via `interpretKeyEvents` → `setMarkedText` / `insertText` flow).
- Mouse: all standard events forwarded via `ghostty_surface_mouse_*`.
- Scrolling: `scrollWheel` forwarded via `ghostty_surface_mouse_scroll`.

Since `AppTerminalView` handles all of this internally, our wrapper delegates
first-responder status directly to `AppTerminalView` without re-implementing
any of these paths.

**Verdict: PASS. Full IME and input handling provided by GhosttyTerminal.**

---

## 6. Anything Phase 2C should know

1. **Command injection via ghostty config, not a C API call.** The `command`
   config key is set via `TerminalConfiguration.custom("command", ...)` (rendered
   into a temp `.conf` file). Phase 2C can use the same pattern to spawn `claude`
   instead of `zsh`.

2. **Per-surface controllers.** Each `OrpheusTerminalSurface` creates its own
   `TerminalController` (so each terminal has its own `ghostty_app_t` — technically
   `ghostty_init` is called once per process via a `runtimeInitialized` static
   guard in `TerminalController`). Multiple surfaces sharing a single controller
   is possible but untested; current design creates one controller per surface.

3. **Color scheme is controller-level.** `TerminalController.setColorScheme(_:)`
   and `AppTerminalView.updateColorScheme()` (called from
   `viewDidChangeEffectiveAppearance`) already handle system appearance changes.
   Phase 2C theming just needs to update the theme on the controller.

4. **Surface close path.** Setting `view.controller = nil` triggers
   `TerminalSurfaceCoordinator.rebuildIfReady(removingBridgeFrom:)` → `tearDownSurface`
   → `surface.free()` → `ghostty_surface_free()`. This sends SIGHUP to the child
   process via the PTY, which cleanly reaps the shell. No zombie processes observed.

5. **`TerminalController.shared` exists but is NOT used here.** `GhosttyTerminal`
   exposes a `TerminalController.shared` singleton. We create per-surface controllers
   instead, because each terminal in a multi-terminal Orpheus session needs isolated
   config + theme. Phase 2C may want to evaluate whether a shared controller with
   per-surface config overrides is more efficient.

6. **Transitive dep: `MSDisplayLink 2.1.0`.** SwiftPM resolves this automatically.
   No action needed.

7. **The `TerminalSurfaceView` SwiftUI entry point.** `GhosttyTerminal` also provides
   `TerminalSurfaceView` (SwiftUI) and `TerminalViewState` (Observable). We wrap
   `AppTerminalView` directly (the AppKit layer underneath) for more explicit lifecycle
   control. Phase 2C could consider migrating to `TerminalSurfaceView` if SwiftUI
   composition becomes the primary pattern.

---

## 7. Forward pointers for Phase 2C integration

These answer "where do I find X?" questions Phase 2C builders will hit.

### Subscribing to process exit
`OrpheusTerminalSurface` does not expose an `AsyncStream<ExitStatus>` — Phase 2C
should subscribe via the GhosttyTerminal delegate pattern:

```swift
// Conform a coordinator/observer to TerminalSurfaceCloseDelegate
final class MyExitObserver: TerminalSurfaceCloseDelegate {
    func terminalDidClose(processAlive: Bool) {
        // Update OrpheusCore: terminal.status = processAlive ? .detached : .stopped
    }
}

let observer = MyExitObserver()
surface.view.delegate = observer
```

The delegate is wired up internally by `TerminalCallbackBridge`. `processAlive`
is true if the user closed the view while the child was still running (we
sent SIGHUP); false if the child exited on its own.

### Accessing the Metal layer
`OrpheusTerminalSurface` does not expose `metalLayer: CAMetalLayer` directly.
If Phase 2C needs the layer (e.g. for offscreen capture):

```swift
let layer = surface.view.layer as? CAMetalLayer
```

Don't try to host the layer in another view — it's owned by `AppTerminalView`.

### Spawning `claude` instead of `zsh`
Use the same `command` config-key escape hatch the engine already uses:

```swift
let config = SurfaceConfig(
    command: claudeBinaryPath,        // e.g. from OrpheusCore.SettingsLoader
    arguments: ["--resume", sessionID.rawValue],
    cwd: project.rootPath,
    palette: .orpheusDefault
)
let surface = try OrpheusTerminalEngine.shared.makeSurface(config: config)
```

The engine joins `command + arguments` with spaces and writes to libghostty's
`command` config key — libghostty handles fork/exec.

### Sending text programmatically
`OrpheusTerminalSurface.sendText(_:)` is exposed. Use it for self-drive
("type this command and press return") flows.

### `SurfaceConfig.environment` is currently a no-op
Phase 2A does not wire `environment` through to the libghostty surface
(libghostty inherits the parent process env as-is). Phase 2C will need to
either route via libghostty's command-line `env` prefix or extend
`TerminalSurfaceOptions` upstream.

### API surface deltas from `tasks.md`
The Phase 2A implementer made a handful of deliberate API choices that
diverge from the brief. None block Phase 2C; documented here for clarity:

| Brief said | Code is | Why |
|---|---|---|
| `OrpheusTerminalEngine.makeSurface(_:) async throws` | `func makeSurface(_:) throws` | The function is `@MainActor`-isolated and synchronous; `async` would be ceremony with no await point. |
| `func resize(width: Int, height: Int) async` | `func resize(to: NSSize)` (sync) + `func resize(width:height:)` overload | NSSize is the natural AppKit size unit; integer overload is provided for callers who think in cells. |
| `KeyEvent` / `MouseEvent` translation types | omitted | `AppTerminalView` handles all input + IME internally; reimplementing would duplicate years of upstream work. |
| `metalLayer: CAMetalLayer` accessor | omitted | Layer is owned by `AppTerminalView`; access via `surface.view.layer` if needed. |
| `processExited: AsyncStream<ExitStatus>` | omitted | Subscribe via `TerminalSurfaceCloseDelegate` instead (see above). |
| `cellSize` / `gridSize` in `SurfaceConfig` | omitted | libghostty derives these from the view's frame and the configured cell metrics; explicit override not yet needed. |
