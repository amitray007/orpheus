# Phase 2A — libghostty FFI (`OrpheusTerminal`)

**Role:** You are a build agent implementing the terminal-rendering foundation for Orpheus.
**Output:** a standalone Swift Package called `OrpheusTerminal` plus a small smoke executable that proves a libghostty-backed terminal can be embedded in our own NSWindow, spawn a shell, take keyboard input, and render output.

**Scope in one sentence:** wire `Lakr233/libghostty-spm` into a thin Orpheus-owned Swift Package, prove the binding works end-to-end against an unsandboxed shell spawn, and lock the API surface that Phase 2C's `OrpheusTerminalView` will sit on top of.

---

## Why this phase exists

Phase 2 (Shell + Terminal) is the most technically heavy phase of v0. The single biggest risk inside it is **libghostty integration** — Ghostty's embedding C API is officially "not yet stable" per the upstream maintainers, and the only widely-used Swift distribution today is community-maintained. If the embedding doesn't work, no Mac IDE built around Claude Code happens.

Phase 2A is structured to fail fast on that risk. We isolate the FFI work into its own package with a smoke executable (a window, a terminal, a shell) before any other Phase 2 work depends on it. If the binding breaks, we know it now — not after we've built a sidebar, a session manager, and a split pane around it.

Phase 1 produced the headless data layer (`OrpheusCore`). Phase 0 produced the design system (`OrpheusDesign`). Phase 2A produces the **terminal-rendering primitive**. Phase 2B will build the app shell around it (no terminals yet, just the chrome). Phase 2C will compose 2A + 2B + Phase 1's `SubprocessManager` into the actual feature: terminals running `claude` inside spaces inside projects.

---

## What "done" looks like

Gate criteria for Phase 2A specifically (a subset of Phase 2's full gate, scoped to the FFI):

- [ ] `swift build` for `packages/OrpheusTerminal/` is clean against the pinned `libghostty-spm` tag
- [ ] `swift run OrpheusTerminalSmoke` opens a 720×440 macOS window
- [ ] The window contains a libghostty-rendered terminal surface (Metal-backed, GPU-accelerated)
- [ ] The terminal spawns `/bin/zsh -i -l` (or the user's `$SHELL`) at app start
- [ ] Keyboard input reaches the shell; pressed keys land inside the running shell
- [ ] Shell output is rendered back into the surface
- [ ] Resizing the window resizes the terminal correctly (no crash, no garbled grid)
- [ ] Closing the window terminates the shell process cleanly (no zombie)
- [ ] The terminal honours one set of OrpheusDesign palette tokens (foreground / background / cursor / 8 ANSI colours) — proves the theming integration point works
- [ ] Basic shell integration works: `cd`, `ls`, `pwd`, `claude --version` (if Claude Code is on PATH) all behave normally

The smoke artefact is a real Mac window you launch. That's the human-verifiable gate. The output isn't a CLI postcard like Phase 1's — it's literally a working terminal you can type into.

---

## Reading order

Before doing anything, read in this order:

1. **`inputs.md`** (this folder) — the exact set of files / external references to read with locked status.
2. **`docs/agent-briefs/v2a/tasks.md`** (this folder) — concrete task breakdown.
3. **`docs/agent-briefs/v2a/discipline.md`** (this folder) — hard rules + common pitfalls.
4. **`docs/agent-briefs/v2a/handoff.md`** (this folder) — what to produce, where it goes, how to report done.
5. **`docs/specs/architecture.md` § 2 Terminal — libghostty** — the architectural commitment.
6. **`docs/plan.md` Phase 2 section** — for the overall Phase 2 goal; understand which deliverables are 2A vs 2B vs 2C vs 2D.

The brief is the contract. If anything in this prompt conflicts with the brief, the brief wins.

---

## Locked decisions (do not propose alternatives)

These were resolved with the user before this brief was written. Don't relitigate.

- **Binding strategy: `Lakr233/libghostty-spm`** consumed as a Swift Package dependency. Pin a specific tag at integration time (most recent stable; verify it builds against Ghostty `v1.3.x`). License is MIT for both the wrapper and the bundled binary.
- **Wrapper layer: thin.** Build a thin `OrpheusTerminal` Swift Package on top of `GhosttyTerminal` (the wrapper module inside libghostty-spm). Re-export only what we need; do not duplicate Lakr233's wrapper.
- **C-API path: the embedded apprt** (`ghostty.h`, `ghostty_app_t` / `ghostty_surface_t`). NOT `libghostty-vt` (the renderless future API). The embedded apprt gives us a Metal-rendered terminal surface in a few hundred LOC; `libghostty-vt` would mean writing our own Metal renderer.
- **Audit pre-flight:** verify that libghostty-spm's bundled trimmed binary supports unsandboxed arbitrary command spawn before building the wrapper. If `ShellCraftKit`'s host-managed I/O backend forces sandboxed shell-only spawn, **stop and report `BLOCKED`** — the next step is option 2 (build libghostty from source ourselves), which is a separate sub-phase.
- **Deployment target: macOS 14+** (matches Phase 0 and Phase 1). libghostty-spm requires macOS 13+; we stay at 14+ for SwiftUI consistency.
- **No PTY hand-rolling.** libghostty owns the PTY. Our wrapper does not fork/exec or open PTYs directly. Phase 1's `SubprocessManager` is for headless processes only — Phase 2C will keep using it for non-terminal-hosted spawns; terminal-hosted commands go through libghostty.

---

## Non-goals for Phase 2A

- **No app shell.** No `Orpheus.app` target, no main window with sidebar/toolbar/onboarding. The smoke executable is a single-window test harness, not the real app. App shell is Phase 2B.
- **No `OrpheusCore` integration.** `OrpheusTerminal` does not import `OrpheusCore` and does not know about `Project`/`Space`/`Terminal` records. Composing OrpheusTerminal + OrpheusCore lives in Phase 2C.
- **No splits / multi-terminal layouts.** One window, one terminal. Splits are 2C.
- **No claude spawning.** Phase 2A spawns `/bin/zsh -i -l` (or `$SHELL`) only. Phase 2C will wire `claude` through.
- **No auto-restore.** No persistence integration. Each smoke run is a fresh terminal.
- **No design-token theming beyond a basic palette.** Hard-code one Orpheus palette mapping (foreground / background / cursor / 8 ANSI colors) to prove the theming hook works. Full palette + dynamic theming is 2C.
- **No `libghostty-vt` migration.** Future Phase 3+ concern.

---

## Companion phases

- **Phase 0 (Design System) — DONE.** `OrpheusDesign` is imported only for the basic palette tokens we wire into libghostty's config. Don't reach into other categories (typography, motion) — terminals don't use those.
- **Phase 1 (Core Foundation) — DONE.** `OrpheusCore` is **NOT** imported by `OrpheusTerminal`. The wrapper is UI-only and config-driven; persistence + session registry stay in Phase 2C's app target.
- **Phase 2B (App shell + sidebar) — NEXT.** Will compose `OrpheusDesign` chrome + `OrpheusCore` data; doesn't touch `OrpheusTerminal` directly.
- **Phase 2C (Terminal hosting + splits) — AFTER 2B.** This is where `OrpheusTerminal` becomes load-bearing. Phase 2A's job is to make 2C's job mechanical.

---

## When to stop and ask

Phase 2A's biggest unknown is whether the libghostty-spm trimmed binary works for our use case. If during the audit (Task 3 in `tasks.md`) you discover that:

- The bundled binary forces a sandboxed shell-only spawn path, OR
- IME / mouse / clipboard plumbing is broken or missing for embedders, OR
- The Metal layer can't be hosted inside a custom NSView (e.g. only works inside a specific Ghostty-provided view), OR
- The bundled binary's API surface is incompatible with the C ABI documented in upstream `ghostty.h`,

**stop work and write a `BLOCKED` session file** per `handoff.md`. The fallback (build libghostty from source ourselves, hand-roll bindings) is a different sub-phase and needs explicit user approval before you switch.

If a smaller concern surfaces (e.g. one specific feature is missing but the core works), `DONE_WITH_CONCERNS` and document it. Don't silently work around major gaps.
