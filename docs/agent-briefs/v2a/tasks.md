# Phase 2A — Task breakdown

Concrete tasks derived from the README + locked decisions. Work them roughly top-to-bottom; each group is small enough to ship as one commit.

## Group 1 — Scaffold

1. **Init the `OrpheusTerminal` Swift Package.**
   - Location: `packages/OrpheusTerminal/` (sibling of `packages/OrpheusDesign/` and `packages/OrpheusCore/`).
   - `Package.swift` with these products:
     - library `OrpheusTerminal` — the public Swift surface
     - executable `OrpheusTerminalSmoke` — the smoke harness window
   - Targets:
     - `OrpheusTerminal`
     - `OrpheusTerminalSmoke` (depends on `OrpheusTerminal`)
     - `OrpheusTerminalTests` (depends on `OrpheusTerminal`)
     - `DisciplineLintTests` (sibling of the test target — same pattern as `OrpheusCore`)
   - External dependencies:
     - `Lakr233/libghostty-spm` — exact-version pin (look up the latest stable tag and pin via `.exact("1.0.X")`). Pull in products `GhosttyKit` and `GhosttyTerminal` only.
     - `OrpheusDesign` — local path dependency at `../OrpheusDesign`.
   - Deployment target: `.macOS(.v14)`.
   - Directory layout:
     - `Sources/OrpheusTerminal/View/` — `OrpheusTerminalView` (the SwiftUI wrapper) + the underlying NSViewRepresentable.
     - `Sources/OrpheusTerminal/Engine/` — the thin wrapper over `GhosttyTerminal`.
     - `Sources/OrpheusTerminal/Theme/` — the OrpheusDesign-token → libghostty-config palette mapping.
     - `Sources/OrpheusTerminal/Internal/` — small helpers (logging, file helpers if needed).
     - `Sources/OrpheusTerminalSmoke/` — `main.swift` + the test harness window.
     - `Tests/OrpheusTerminalTests/Engine/`, `…/View/`, `…/Theme/`.
     - `Tests/DisciplineLintTests/` — lint test target mirroring `OrpheusCore`.

## Group 2 — Audit (CRITICAL — do before any wrapper code)

2. **Verify `libghostty-spm` builds** in our SwiftPM context.
   - Add the dependency, resolve, run `swift build`.
   - Capture: GRDB-style `Package.resolved` is generated and tracked.

3. **Audit `ShellCraftKit` and the bundled binary's spawn path.**
   - Read `ShellCraftKit`'s `Package.swift` and source. Determine whether it mediates *all* command spawns or whether it's an opt-in module for sandboxed App-Store apps.
   - Check the bundled `GhosttyKit.xcframework`'s exposed symbols (e.g. `nm -gU` against the dylib inside) — confirm `ghostty_surface_new` and friends are present and not redirected through a `ShellCraftKit` shim.
   - **Acceptance criterion:** an unsandboxed Orpheus binary calling `ghostty_app_new` + `ghostty_surface_new` with a `command = "/bin/zsh"` spawn config can produce a working terminal that runs arbitrary commands (including `claude --version`, `which`, `ls /`).
   - If the audit reveals a hard dependency on `ShellCraftKit` for spawn, **STOP and report `BLOCKED`**. The fallback path (build libghostty from source ourselves) is a separate sub-phase pending user approval.

4. **Audit Metal layer hosting.**
   - Confirm `GhosttyTerminal`'s view exposes its `CAMetalLayer` so we can host it inside our own `NSView`/SwiftUI hierarchy. If `GhosttyTerminal` requires its own root window or top-level NSView, find out before wrapping.
   - If hosting requires a specific NSView subclass we don't control, document the constraint and use it; don't re-implement.

5. **Document audit findings** as a short appendix in `packages/OrpheusTerminal/AUDIT.md` (committed alongside the package). Include:
   - Pinned `libghostty-spm` tag.
   - Symbol verification result (`ghostty_surface_new` present in the bundled binary, etc.).
   - Spawn-path findings (sandboxed vs unsandboxed compatibility).
   - Metal-layer hosting constraints.
   - Anything Phase 2C should know.

## Group 3 — Engine wrapper

6. **`OrpheusTerminalEngine` actor.** Owns the `ghostty_app_t` lifecycle.
   - `Sources/OrpheusTerminal/Engine/OrpheusTerminalEngine.swift`
   - `public actor OrpheusTerminalEngine`
   - `init() async throws` — calls `ghostty_init` (if not already done) and constructs the app
   - One process holds **one** engine. Subsequent `init()` calls in the same process are a no-op (return the shared app via a guarded singleton, OR throw if double-initialised — pick one and document).
   - `func makeSurface(config: SurfaceConfig) async throws -> OrpheusTerminalSurface`
   - `deinit` or explicit `shutdown()` releases the C app.

7. **`SurfaceConfig` value type.**
   - `Sources/OrpheusTerminal/Engine/SurfaceConfig.swift`
   - `public struct SurfaceConfig: Sendable`
   - Fields: `command: String?`, `arguments: [String]`, `cwd: URL?`, `environment: [String: String]?`, `palette: TerminalPalette`, `cellSize: CellSize?`, `gridSize: GridSize?`.
   - All optional; defaults pick sensible values (command = `$SHELL`, palette = `.orpheusDefault`, cellSize = nil = libghostty default, etc.).

8. **`OrpheusTerminalSurface` actor.** Wraps a `ghostty_surface_t`.
   - `Sources/OrpheusTerminal/Engine/OrpheusTerminalSurface.swift`
   - `public actor OrpheusTerminalSurface`
   - Public surface (mirroring `ghostty_surface_*` minimally):
     - `func resize(width: Int, height: Int) async`
     - `func sendKey(_ event: KeyEvent) async`
     - `func sendText(_ text: String) async`
     - `func sendMouse(_ event: MouseEvent) async`
     - `var metalLayer: CAMetalLayer { get async }` — the layer to embed in NSView
     - `func close() async`
     - `var processExited: AsyncStream<ExitStatus> { get }` — Phase 2C will subscribe
   - Hide the `ghostty_surface_t` C handle behind the actor; never expose it publicly.

9. **`KeyEvent` / `MouseEvent` translation.**
   - `Sources/OrpheusTerminal/Engine/KeyEvent.swift`, `MouseEvent.swift`.
   - Translate Cocoa `NSEvent` → libghostty's `ghostty_input_key_s` / `ghostty_input_mouse_button_s` etc. The Ghostty Swift code in `Surface.swift` shows this pattern; mirror it (don't lift verbatim, but the modifier-flag mapping and key-code translation can follow Ghostty's logic exactly).

## Group 4 — View layer

10. **`OrpheusTerminalNSView`.**
    - `Sources/OrpheusTerminal/View/OrpheusTerminalNSView.swift`
    - `final class OrpheusTerminalNSView: NSView` — hosts the surface's `CAMetalLayer`.
    - Owns an `OrpheusTerminalSurface` (passed in init).
    - Implements:
      - `override var acceptsFirstResponder: Bool { true }`
      - `override func keyDown(with: NSEvent)` → translate to `KeyEvent`, forward to surface
      - `override func keyUp(with: NSEvent)` → same
      - `override func mouseDown/mouseUp/mouseMoved/mouseDragged/scrollWheel(with:)` → MouseEvent
      - `override func resizeSubviews(withOldSize:)` → call surface.resize
      - `override func viewDidMoveToWindow()` → set up content scale
      - IME: `override func interpretKeyEvents(_:)` for proper composition handling. Match Ghostty's Surface.swift IME logic.
    - The view's `layer` is the surface's `CAMetalLayer`. Set `wantsLayer = true` and assign in `init`.

11. **`OrpheusTerminalView` (SwiftUI).**
    - `Sources/OrpheusTerminal/View/OrpheusTerminalView.swift`
    - `public struct OrpheusTerminalView: NSViewRepresentable`
    - `init(surface: OrpheusTerminalSurface)` — the surface is created externally (engine + makeSurface) and injected. View doesn't own the engine.
    - `makeNSView` returns `OrpheusTerminalNSView`.
    - `updateNSView` is mostly a no-op; resize is handled by the underlying NSView's `resizeSubviews`.

## Group 5 — Theme bridge

12. **`TerminalPalette` value type.**
    - `Sources/OrpheusTerminal/Theme/TerminalPalette.swift`
    - `public struct TerminalPalette: Sendable, Equatable`
    - Fields:
      - `foreground: Color`, `background: Color`, `cursor: Color`, `selection: Color`
      - `ansi: AnsiPalette` — 16 colours (8 base + 8 bright)
    - `Color` is `OrpheusDesign.OrpheusColor.Resolved` (the resolved RGB, not the token wrapper).
    - `public static let orpheusDefault: TerminalPalette` — a hand-curated mapping against OrpheusDesign tokens. One palette is enough for 2A; the full design-token contract is 2C.

13. **`TerminalPalette → ghostty_config_t` apply function.**
    - `Sources/OrpheusTerminal/Theme/PaletteApply.swift`
    - `internal func apply(palette: TerminalPalette, to config: ghostty_config_t)` — translate palette colours into the libghostty config keys (`foreground`, `background`, `cursor-color`, `selection-foreground`, `palette = 0=...`, etc.). Use `ghostty_config_set_string` (or whatever the C API exposes; check `ghostty.h`).

## Group 6 — Smoke executable

14. **`OrpheusTerminalSmoke` harness.** `swift run OrpheusTerminalSmoke` from the package root must:
    - Open a 720×440 `NSWindow` titled "Orpheus Terminal — Phase 2A Smoke".
    - Construct an `OrpheusTerminalEngine` and call `makeSurface(...)` with:
      - `command = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"`
      - `arguments = ["-i", "-l"]`
      - `cwd = FileManager.default.homeDirectoryForCurrentUser`
      - `palette = .orpheusDefault`
    - Embed the surface in the window via `OrpheusTerminalNSView`.
    - Make the window key + visible.
    - Run the AppKit run loop (`NSApplication.shared.run()` after `setActivationPolicy(.regular)`).
    - On window close: call `surface.close()`, shutdown engine, terminate the app cleanly.

    The smoke is a real, interactive Mac app. It launches, you type `ls`, you see your home dir contents, you type `claude --version` (if installed) and see a version string, you ⌘W to close.

## Group 7 — Tests

15. **Engine tests.** `Tests/OrpheusTerminalTests/Engine/EngineTests.swift`.
    - Construct an engine, assert `ghostty_app_t` is created (if exposed) or that subsequent `makeSurface` succeeds.
    - Test that double-init is handled per the documented behaviour (no-op or throw).
    - Test surface lifecycle: create, close, no leaks (use `weak var` and force-resize-zero pattern; libghostty surfaces cleanly close when the actor goes out of scope).

16. **`KeyEvent` translation tests.** `Tests/OrpheusTerminalTests/Engine/KeyEventTests.swift`.
    - Build a synthetic `NSEvent` for a few common keys (return, escape, ⌘C, ⇧A, arrow keys).
    - Translate to `KeyEvent`.
    - Assert the resulting libghostty input struct fields are correct (key code, modifiers).

17. **Palette tests.** `Tests/OrpheusTerminalTests/Theme/PaletteTests.swift`.
    - Confirm `.orpheusDefault` produces non-zero alpha values for all 20 colour fields.
    - Confirm the apply function writes the expected libghostty config keys (mock the ghostty_config_set calls or capture them via a thin wrapper).

18. **Smoke harness sanity test.** `Tests/OrpheusTerminalTests/SmokeHarnessTests.swift`.
    - One test that builds the smoke target's main entry point WITHOUT running the run loop. Confirms the linker resolves and the engine + surface can be constructed in test mode (no window).
    - This is a regression guard, not a UI test.

19. **DisciplineLintTests.** `Tests/DisciplineLintTests/DisciplineLintTests.swift`.
    - Mirror the pattern from `packages/OrpheusCore/Tests/DisciplineLintTests/`.
    - Tests:
      - No `import OrpheusCore` in `Sources/OrpheusTerminal/` (Phase 2C-and-later concern).
      - No `print(` in `Sources/OrpheusTerminal/` (only `OrpheusTerminalSmoke/` may print).
      - No hardcoded `/Users/...` paths.
      - No `*.swift` basename collisions across the source tree (SwiftPM flattens).
      - Smoke target DOES contain a `print(` (sanity-check the inverse rule).

## Group 8 — Documentation

20. **`packages/OrpheusTerminal/README.md`** — module-by-module summary, public-API cheatsheet, "how to embed a terminal" snippet showing engine + surface + view, "running the smoke executable" section, locked decisions, link to `AUDIT.md`.

21. **`packages/OrpheusTerminal/AGENTS.md`** — discipline analogue mirroring `packages/OrpheusCore/AGENTS.md`. Highlights:
    - Public surface = `public struct` / `public actor`. No public classes.
    - Allowed imports: `SwiftUI`, `AppKit`, `Foundation`, `OrpheusDesign`, `GhosttyKit`, `GhosttyTerminal`.
    - Forbidden: `import OrpheusCore` (Phase 2C concern).
    - The wrapper layer is **thin** — never re-implement what `GhosttyTerminal` already does. Wrap only what Orpheus genuinely needs to vary.
    - `print(...)` allowed only in `Sources/OrpheusTerminalSmoke/`.

## Decisions to lock in this phase

These are open within the brief — pick one in code, document in README, surface in handoff:

- **Engine singleton vs per-instance.** libghostty's `ghostty_app_t` is process-global (one `ghostty_init` per process). Recommended default: hold the app inside a `OrpheusTerminalEngine.shared` actor singleton, but the public `init()` method works as if it constructs a new one (which internally returns the shared app). Document the lifecycle.
- **Window-close semantics.** When the smoke window closes, do we kill the shell hard (`SIGTERM`/`SIGKILL` via libghostty's surface free) or send EOF and wait? Recommended default: surface-free triggers libghostty's PTY cleanup, which sends SIGHUP. Tests confirm no zombie.
- **IME behaviour.** Match Ghostty's Surface.swift verbatim (the upstream pattern). Anything else is its own discussion.

If you make a different call than the recommendation above, justify it in `handoff.md`. If you make the recommended call, just confirm it.

---

## Out of scope (flag if you hit them)

- App shell, sidebar, toolbar — Phase 2B.
- Multi-terminal splits, layout management, drag UX — Phase 2C / 2D.
- Auto-restore from `OrpheusCore` persistence — Phase 2C.
- Spawning `claude` specifically (vs any shell command) — Phase 2C.
- Full OrpheusDesign token integration (typography, motion, materials) — Phase 2C.
- Voice — Phase 6.
- Self-drive — Phase 3.

If a task in this list can't be completed without touching out-of-scope code, **stop and flag it in your handoff report**.
