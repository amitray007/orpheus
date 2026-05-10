# OrpheusTerminal

Phase 2A of Orpheus — the terminal-rendering primitive.

A thin Swift Package wrapping `Lakr233/libghostty-spm` (tag `1.0.1777879537`)
that embeds a libghostty-rendered, Metal-backed terminal in an Orpheus-owned
`NSView`. Proves the binding works end-to-end before Phase 2C builds the full
terminal hosting layer.

**See `AUDIT.md` for the full integration audit findings.**

---

## Modules

### Engine
- `OrpheusTerminalEngine` — manages the `TerminalController` + `ghostty_app_t` lifecycle. Process-wide singleton.
- `OrpheusTerminalSurface` — wraps `AppTerminalView` + `TerminalController` for one terminal session.
- `SurfaceConfig` — value type for shell command, palette, cwd, environment.

### View
- `OrpheusTerminalNSView` — `NSView` container that embeds `AppTerminalView` using Auto Layout.
- `OrpheusTerminalView` — SwiftUI `NSViewRepresentable` wrapper.

### Theme
- `TerminalPalette` — 20-field color palette (fg / bg / cursor / selection / 16 ANSI). Includes `.orpheusDefault` (dark, derived from OrpheusDesign locked v0 tokens).
- `PaletteApply.swift` — `makeConfiguration(for:)` translates a `TerminalPalette` into a `TerminalConfiguration` for injection into libghostty.

### Internal
- `OrpheusTerminalLogger` — `os.Logger` wrapper (subsystem `com.orpheus.terminal`).
- `OrpheusTerminalError` — typed error enum (engine init, surface creation, palette apply, command spawn).

---

## How to embed a terminal

```swift
import OrpheusTerminal

// 1. Create a surface (must be on main thread)
@MainActor
func makeTerminal() throws -> OrpheusTerminalSurface {
    let engine = OrpheusTerminalEngine.shared
    let config = SurfaceConfig(
        command: ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh",
        arguments: ["-i", "-l"],
        cwd: FileManager.default.homeDirectoryForCurrentUser,
        palette: .orpheusDefault
    )
    return try engine.makeSurface(config: config)
}

// 2. AppKit: embed in a view hierarchy
let surface = try makeTerminal()
let hostView = OrpheusTerminalNSView(surface: surface)
containerView.addSubview(hostView)
// ... add constraints ...

// 3. SwiftUI: use the representable
OrpheusTerminalView(surface: surface)

// 4. Close cleanly on window close
surface.close()
```

---

## Running the smoke executable

```bash
cd packages/OrpheusTerminal
swift run OrpheusTerminalSmoke
```

Opens a 720×440 `NSWindow` titled "Orpheus Terminal — Phase 2A Smoke" with a
live `zsh -i -l` shell. Type `ls`, `pwd`, `claude --version` etc. Close with
⌘W or Ctrl-D.

```bash
# Verify it opens and stays open (exit 124 = timeout-killed, window was open)
/opt/homebrew/bin/timeout 5 .build/debug/OrpheusTerminalSmoke; echo "exit=$?"
```

---

## Discipline

See `AGENTS.md` for the full rule set. Key points:

- `import OrpheusCore` is **forbidden** in `Sources/OrpheusTerminal/`. Composition happens in Phase 2C.
- `print(...)` is **forbidden** in `Sources/OrpheusTerminal/`. Use `OrpheusTerminalLogger.<category>`.
- `ShellCraftKit` is **not** linked — we use `backend = .exec` for real PTY spawn.
- The wrapper is **thin** — don't re-implement what `GhosttyTerminal` provides.

---

## Decisions locked in Phase 2A

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Binding strategy | `Lakr233/libghostty-spm` `.exact("1.0.1777879537")` | Community-maintained, MIT, ships pre-built XCFramework. Exact pin per discipline rule. |
| C-API path | `GHOSTTY_SURFACE_IO_BACKEND_EXEC` (real PTY, unsandboxed) | ShellCraftKit's in-memory backend is for sandboxed App Store apps only. |
| Engine lifecycle | Per-surface `TerminalController`, process-wide `ghostty_init` guard | `ghostty_init` is called once per process (static guard in TerminalController). Multiple surfaces each get their own TerminalController for isolated config + theme. |
| Window-close semantics | `view.controller = nil` → `tearDownSurface` → SIGHUP | The public teardown path in GhosttyTerminal. No zombie shells observed in testing. |
| IME approach | Delegated to `AppTerminalView` / `TerminalKeyEventHandler` | GhosttyTerminal mirrors Ghostty's own AppKit IME implementation. Don't reinvent. |
| Metal layer | Owned by `AppTerminalView`; embedded via Auto Layout subview | AppTerminalView's `CAMetalLayer` is accessible as `layer`; standard NSView embedding works. |

---

## Links

- `AUDIT.md` — integration audit (ShellCraftKit findings, symbol verification, Metal hosting constraints)
- `Lakr233/libghostty-spm` — https://github.com/Lakr233/libghostty-spm
- `Lakr233/libghostty-spm/releases/tag/1.0.1777879537` — pinned release
