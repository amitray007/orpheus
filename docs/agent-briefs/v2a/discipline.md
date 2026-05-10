# Phase 2A — Discipline rules + common pitfalls

These rules adapt Phase 1's discipline to a UI package that links a C library through a community Swift wrapper. They exist so Phase 2C (and beyond) can build on a stable foundation without paying for FFI mistakes.

## Hard rules

### 1. No `import OrpheusCore` in `OrpheusTerminal`
Forbidden in `Sources/OrpheusTerminal/`:
- `import OrpheusCore`
- Any reference to `Project`, `Space`, `Terminal`, `SessionID`, `Database`, etc.

`OrpheusTerminal` is a UI primitive. UI feature code (Phase 2C) composes `OrpheusTerminal` + `OrpheusCore` in the app target. Don't preempt that integration.

### 2. Allowed imports only
- `Foundation`, `AppKit`, `SwiftUI`, `Combine`, `os.log` — Apple frameworks.
- `OrpheusDesign` — design tokens for terminal palette only. Don't reach for Components / Motion / Materials.
- `GhosttyKit`, `GhosttyTerminal` — the libghostty-spm products. Forbidden: `GhosttyTheme`, `ShellCraftKit` (the audit answers whether `ShellCraftKit` is even safe to depend on; until it does, don't link it).
- Nothing else. No third-party logging libraries, no Combine extensions, no SnapKit. If you want to add something, document the need in `handoff.md` first.

### 3. The wrapper is thin
`OrpheusTerminal` is a *thin* layer over `GhosttyTerminal`. Do **not**:
- Re-implement what `GhosttyTerminal` already provides.
- Build elaborate abstractions over libghostty (e.g. a generic "TerminalProtocol" with multiple implementations). One libghostty wrapper. One terminal API.
- Add convenience methods nobody asked for. Leave gold-plating to Phase 2C.

If you find yourself writing > 200 LOC inside one wrapper file, stop and ask whether you're inventing scope.

### 4. The C ABI is opaque
- `ghostty_*` symbols, `ghostty_app_t`, `ghostty_surface_t`, etc. live BEHIND the `OrpheusTerminalEngine` and `OrpheusTerminalSurface` actors. Nothing public exposes a `ghostty_*` type.
- If a caller (e.g. the future Phase 2C `OrpheusTerminalView` consumer) needs functionality that requires a C type, surface a Swift wrapper on the actor instead.
- This protects us when libghostty-spm ships an incompatible release — only the wrapper changes.

### 5. Pin the libghostty-spm tag exactly
- `Package.swift` uses `.exact("1.0.X")`, NOT `from:`.
- Lakr233 ships multiple times per week. `from:` would let an unintended bump land silently.
- Bumping the pin is its own commit with a message like `[orpheus] bump: libghostty-spm 1.0.X → 1.0.Y` and a note in the commit body about what changed (read the release notes on bump).

### 6. No PTY hand-rolling, no fork/exec
- libghostty owns the PTY. `OrpheusTerminal` does NOT call `forkpty(3)`, `posix_spawn`, or `Foundation.Process` for terminal-hosted commands.
- If you need a non-terminal-hosted process (e.g. running a quick `which claude` to validate availability before opening a terminal), use `OrpheusCore`'s `SubprocessManager` — but that's NOT this phase's concern. Phase 2C will compose the two.

### 7. No `print(...)` outside `OrpheusTerminalSmoke`
- In library code, log via a thin internal `OrpheusTerminalLogger` (`os.Logger` wrapper, subsystem `com.orpheus.terminal`).
- Smoke target's `main.swift` may use `print` for boot diagnostics. That's the only place.
- Tests don't print — assertions only.

### 8. No hardcoded user paths
- Same rule as Phase 1. Always derive via `FileManager.default.homeDirectoryForCurrentUser` or accept via injection.

### 9. Errors are typed
- Define `OrpheusTerminalError: Error, Sendable, Equatable, LocalizedError` in `Sources/OrpheusTerminal/OrpheusTerminalError.swift`.
- Cases (initial; expandable):
  - `engineInitFailed(reason: String)`
  - `surfaceCreationFailed(reason: String)`
  - `paletteApplyFailed(key: String, reason: String)`
  - `commandSpawnFailed(command: String, reason: String)`
- `LocalizedError.errorDescription` returns a non-empty user-readable string per case.
- Don't reuse `OrpheusCoreError` — different package, different error namespace. Phase 2C bridges them at the app boundary.

### 10. Crash-safety: the C lib comes first
- libghostty's surface owns a Metal layer + a PTY + a child process. Mishandling lifecycle = crash.
- **Always** call `ghostty_surface_free` (via the actor's `close()`) before letting the surface deinit.
- **Never** call C symbols from a `deinit` — actor isolation guarantees go out the window. Use explicit `close()` + a deinit-time assertion `assert(state == .closed, "surface deinit'd while open")` so we crash in debug if a call site forgets.

### 11. Phase 2A is parallel-safe with Phase 2B
- Don't touch `packages/OrpheusDesign/` except to read tokens.
- Don't touch `packages/OrpheusCore/`.
- Don't preempt Phase 2B's app target. The smoke harness is its own thing — it's not the start of `Orpheus.app`.

## Common pitfalls

### libghostty + sandbox
- Orpheus is unsandboxed. libghostty-spm ships a *trimmed* binary that adds `ShellCraftKit` for sandboxed App Store apps. The trimming may or may not affect us. Audit before depending on it.
- If audit reveals a problem: the fallback is building libghostty from upstream `ghostty-org/ghostty` ourselves (`zig build` → `XCFramework` → hand-rolled bindings). That's a separate sub-phase; report `BLOCKED`, don't try to do it inline.

### Metal layer hosting
- `CAMetalLayer` has strict ownership rules: a layer can't be hosted by two views at once, and removing a layer from a view causes the GPU pipeline to tear down.
- The pattern: `OrpheusTerminalNSView`'s `init` creates the layer, assigns to `self.layer`, sets `wantsLayer = true`. The surface's metal layer is exposed via the actor.
- If you find yourself wanting to "share" a layer between views or "swap" layers at runtime, stop — that path leads to crashes.

### Content scale + DPI
- Set `metalLayer.contentsScale = window.backingScaleFactor` on `viewDidMoveToWindow` AND on `viewDidChangeBackingProperties`.
- libghostty's `ghostty_surface_set_content_scale` must match. Out-of-sync scales render at the wrong size.

### IME (input method editor)
- CJK input requires `interpretKeyEvents`. Match Ghostty's `Surface.swift` IME logic *exactly* — they've debugged this for years; we won't get it right from first principles.
- `ghostty_surface_preedit` for marked text composition; `ghostty_surface_text` for committed text.

### Display link and frame pacing
- libghostty-spm depends on `Lakr233/MSDisplayLink`. Don't try to drive frames yourself with `CADisplayLink` or `CVDisplayLink`. The surface's render loop is owned by `GhosttyTerminal`.

### Process exit + orphan PTY
- When the surface is freed, libghostty terminates the child via SIGHUP and reaps the PTY.
- Confirm via `ps -ax | grep zsh` after closing the smoke window — no orphans.
- If we ever find an orphan, the cleanup path is broken; raise as a discipline regression.

### Don't actor-wrap pure values
- `KeyEvent`, `MouseEvent`, `SurfaceConfig`, `TerminalPalette` are value types. They don't need actors. Actors wrap *the C lifecycle* (engine, surface).

### Don't propagate libghostty errors as Swift errors
- `ghostty_*` C symbols return error codes (typically `int` — 0 = success, non-zero = failure). Translate at the actor boundary into `OrpheusTerminalError` cases. Don't expose the raw int through the public API.

### Don't optimise prematurely
- The first version of the engine + surface should be the simplest thing that works. Phase 2C will profile the integration; we'll fix what's actually slow then.

## When to break a rule

Same as Phase 1: don't, in this phase. If a rule genuinely blocks you, it's a spec gap — stop, flag in handoff, wait for resolution.

The exception is the audit: if the audit reveals libghostty-spm is incompatible with our use case, that's not a rule violation — it's a `BLOCKED` state. Report and stop. Don't try to work around fundamental incompatibilities silently.
