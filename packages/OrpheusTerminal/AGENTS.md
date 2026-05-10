# Conventions for OrpheusTerminal

These rules apply to every file in `Sources/OrpheusTerminal/`. They mirror
`packages/OrpheusCore/AGENTS.md` adapted for a UI + FFI library.

## Public surface shape

- All public types are `public struct`, `public enum`, or `public final class`
  (for `@MainActor` wrapper types that must be `final`).
- No public classes that aren't final.
- `@MainActor` isolation for all types that touch `AppTerminalView`, `CAMetalLayer`,
  or `TerminalController` — these are main-thread-only objects.
- Value types (`SurfaceConfig`, `TerminalPalette`, `TerminalPalette.RGBA`,
  `TerminalPalette.AnsiPalette`, `OrpheusTerminalError`) are `Sendable`.

## Allowed imports

In `Sources/OrpheusTerminal/`:
- `Foundation`, `AppKit`, `SwiftUI`, `Combine`, `os.log` — Apple frameworks.
- `OrpheusDesign` — for palette tokens only. Don't reach into `Components`,
  `Motion`, or `Materials`.
- `GhosttyKit`, `GhosttyTerminal` — the libghostty-spm products.
- Nothing else. No third-party logging libraries, no Combine extensions.

Forbidden anywhere in `Sources/OrpheusTerminal/`:
- `import OrpheusCore` — Phase 2C concern. `OrpheusTerminal` is a UI primitive.
- `import ShellCraftKit` — sandboxed App Store only; incompatible with Orpheus's
  unsandboxed arbitrary-command use case.
- `import GhosttyTheme` — we inject our own Orpheus palette via `TerminalConfiguration`.

## The wrapper is thin

`OrpheusTerminal` is a thin layer over `GhosttyTerminal`. Do NOT:
- Re-implement what `AppTerminalView` / `TerminalSurfaceCoordinator` already provides
  (Metal layer setup, `viewDidMoveToWindow`, IME, display link, key/mouse dispatch).
- Build elaborate abstractions over libghostty (e.g. a generic "TerminalProtocol"
  with multiple implementations). One libghostty wrapper. One terminal API.
- Add convenience methods nobody asked for. Leave gold-plating to Phase 2C.

If you find yourself writing > 200 LOC inside one wrapper file, stop and ask
whether you're inventing scope.

## The C ABI is opaque

`ghostty_*` types (`ghostty_app_t`, `ghostty_surface_t`, etc.) live behind
`GhosttyTerminal`'s types (`TerminalController`, `AppTerminalView`). The public
`OrpheusTerminalEngine` and `OrpheusTerminalSurface` surfaces never expose a
`ghostty_*` type. If a caller needs functionality that requires a C type, surface
a Swift wrapper instead.

## Pin the libghostty-spm tag exactly

`Package.swift` uses `.exact("1.0.X")`, never `from:`. Bumping the pin is its own
commit: `[orpheus] bump: libghostty-spm 1.0.X → 1.0.Y` with a note on what changed.

## No PTY hand-rolling, no fork/exec

libghostty owns the PTY. `OrpheusTerminal` does NOT call `forkpty(3)`,
`posix_spawn`, or `Foundation.Process` for terminal-hosted commands. Non-terminal
processes (e.g. `which claude`) go through `OrpheusCore.SubprocessManager` in
Phase 2C — NOT here.

## No `print(...)` outside OrpheusTerminalSmoke

Use `OrpheusTerminalLogger.<category>` in library code:
```swift
OrpheusTerminalLogger.engine.info("...")
OrpheusTerminalLogger.surface.debug("...")
OrpheusTerminalLogger.view.warning("...")
OrpheusTerminalLogger.theme.error("...")
```

Only `Sources/OrpheusTerminalSmoke/main.swift` may call `print(...)`.

## No hardcoded user paths

Never write `"/Users/..."`. Derive paths via
`FileManager.default.homeDirectoryForCurrentUser` or accept via injection.

## Errors are typed

All errors are `OrpheusTerminalError` cases. Add new cases as concrete code
drives them. Every case conforms to `LocalizedError` with a non-empty
`errorDescription`. Do NOT throw `NSError` or stringly-typed errors.

## Crash-safety

- `AppTerminalView` owns the Metal layer + PTY + child process. Call `surface.close()`
  before releasing `OrpheusTerminalSurface`.
- The close path: `view.controller = nil` → `TerminalSurfaceCoordinator.tearDownSurface`
  → `TerminalSurface.free()` → `ghostty_surface_free()` → SIGHUP to child.
- Verify no orphan shells after close: `ps -ax | grep zsh` should be clean.

## Test discipline

- Use `withTaskGroup` + sleep-timeout for any async stream consumption (see
  `OrpheusCore/Tests` for the canonical pattern). Never use `for await x in stream
  { if Date() >= deadline { break } }` — that pattern hangs.
- `@MainActor` test classes for any test touching `AppTerminalView` or
  `OrpheusTerminalEngine`.
- No `print(...)` in tests — assertions only.

## Comments

Default to writing none. Add a single-line WHY-only comment for:
- Non-obvious invariants.
- Workarounds for framework bugs (e.g. the `controller = nil` close path).
- Load-bearing constraints that would surprise a reader.
