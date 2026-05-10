# Phase 2A — Inputs to read before writing any code

All paths are relative to the Orpheus code repo root: `/Users/maverick/code/projects/orpheus/`.

## Primary sources of truth (LOCKED — treat as contract)

### `docs/specs/architecture.md` § 2 — Terminal — libghostty
**LOCKED.** The architectural commitment to libghostty. Read this first; understand why we're not writing our own VT100 emulator.

### `docs/plan.md` Phase 2 section
**LOCKED.** Lists the full Phase 2 deliverables. Phase 2A's deliverables are the "libghostty integration" item plus the audit work; everything else (sidebar, splits, auto-restore, OrpheusDesign theming beyond a basic palette) is 2B/2C/2D.

### `docs/agent-briefs/v2a/tasks.md`
**LOCKED.** Concrete task breakdown. Anything in Phase 2 of `plan.md` that's relevant to FFI but not in `tasks.md` is an oversight — raise it.

### `docs/agent-briefs/v2a/discipline.md`
**LOCKED.** Hard rules + common pitfalls.

## Reference — read for context, don't depend on

### `packages/OrpheusCore/`
Phase 1's deliverable. **DO NOT IMPORT.** Reading the `Package.swift` and `AGENTS.md` is fine — mirror the conventions (one type per file, comments default to none, smoke executable as the gate, DisciplineLintTests target). But `OrpheusTerminal` does not depend on `OrpheusCore` at all. Composition happens in Phase 2C.

### `packages/OrpheusDesign/`
Phase 0's deliverable. Imported by `OrpheusTerminal` ONLY for the small subset of tokens needed to colour the terminal:
- `OrpheusColor.Surface.*` for terminal background
- `OrpheusColor.Text.*` for foreground
- `OrpheusColor.Accent.*` for cursor
- An ANSI palette mapping (8 base colours + 8 bright variants) — this can be hand-curated against `OrpheusColor.*` for now; the full design-system contract for terminal palettes is a Phase 2C decision.

Don't reach into `OrpheusDesign.Components` or `OrpheusDesign.Motion`. The terminal isn't a `View` in the OrpheusDesign sense.

### `docs/wireframes/wireframes-v0.5.md`
**LOCKED.** Skim only:
- W6 — terminal view. Phase 2A produces a stripped-down version of this (no chrome, no splits — just the terminal pane in a window).

You are not building W6 to spec in Phase 2A. The smoke window is intentionally crude. Phase 2C polishes it.

## External references

### `Lakr233/libghostty-spm`
- Repo: https://github.com/Lakr233/libghostty-spm
- Releases: https://github.com/Lakr233/libghostty-spm/releases — pick the most recent stable tag at the time you start (e.g. `1.0.1777879537` or later). Pin it exactly in `Package.swift` (use `.exact("1.0.X")` not `from:`).
- Products consumed by `OrpheusTerminal`:
  - `GhosttyKit` — re-exports the C ABI (`ghostty.h`). Useful when the Swift wrapper doesn't expose what we need.
  - `GhosttyTerminal` — Swift wrapper providing a native NSView/UIView, SwiftUI bridge, input handling, display link.
  - `GhosttyTheme` — 485 iTerm2 themes. **Don't use directly** — we'll inject our own Orpheus palette via `ghostty_config_t`.
  - `ShellCraftKit` — sandboxed shell emulation. **Audit before depending on it.** Orpheus is unsandboxed and spawns arbitrary commands; if `ShellCraftKit` mediates all spawns, that's a blocker.
- Transitive dependency: `Lakr233/MSDisplayLink ≥ 2.1.0`. SwiftPM will resolve it.

### Ghostty upstream — for understanding the C ABI
- `ghostty-org/ghostty/include/ghostty.h` — the canonical C header. Read it once to understand the `ghostty_app_t` / `ghostty_surface_t` lifecycle. Don't depend on it directly; libghostty-spm vendors it.
- `ghostty-org/ghostty/macos/Sources/Ghostty/Surface.swift` — Ghostty's own Swift wrapper around `ghostty_surface_t`. Read for patterns (callback registration, NSView lifecycle, IME). **DO NOT lift this file** — it's deeply entangled with Ghostty.app's `AppDelegate`. Lift the patterns, not the code.
- `ghostty-org/ghostling` — the canonical example for the *other* C API (`libghostty-vt`). Skim for context only; we're not using vt.
- Hashimoto's blog post "Libghostty Is Coming" (2025-09-22, mitchellh.com) — explains why upstream isn't shipping a stable embedding library yet.

### `Uzaaft/awesome-libghostty`
The community-maintained list of projects embedding libghostty. Useful for spot-checking patterns. Notable references for Mac embedders: Kytos (jwintz/kytos), Mori, Muxy. They all use either libghostty-spm or hand-rolled XCFrameworks with hand-written bindings.

## Not inputs for this phase

- The full Ghostty Swift codebase (`ghostty-org/ghostty/macos/Sources/Ghostty/Ghostty.App.swift`) — 2000+ LOC of macOS-app entanglement. Don't read it; you'll be tempted to copy patterns that don't apply.
- `OrpheusCore` source (other than `Package.swift` for convention reference).
- Phase 2B / 2C / 2D briefs (not yet written).
- Self-drive daemon (Phase 3).
- Voice pipeline (Phase 6).
