# Phase 1 — Core Foundation (`OrpheusCore`)

**Role:** You are a build agent implementing the headless plumbing layer for Orpheus.
**Output:** a standalone **Swift Package** called `OrpheusCore` that every UI module imports for state, persistence, session discovery, and subprocess control.

**Scope in one sentence:** build the data model, persistence, configuration, session registry, JSONL watcher, and subprocess manager so Phase 2 onward can compose a UI on top of a working core — with **no UI** of its own.

---

## Why this phase exists

Phase 0 produced the design layer; Phase 1 produces the data layer. Every feature surface in v0 reads from or writes to the structures built here:

- The sidebar (Phase 2) iterates `Project ▸ Space ▸ Terminal` records out of the data model.
- The terminal layer (Phase 2) asks `SubprocessManager` to spawn `claude` with the right flags.
- The chat viewer (Phase 3) tails session JSONL via `JSONLWatcher` events.
- The command palette (Phase 2/3) queries the FTS5 sessions index.
- Self-drive (Phase 3) mutates state through the same data model the UI uses.

Building this headlessly first means feature phases never race plumbing decisions. It also means Phase 1 can run **in parallel** with Phase 0 and 0.5 — though by the time you're reading this, Phase 0 is done.

---

## What "done" looks like

Gate criteria from `docs/plan.md` Phase 1:

- [ ] Data model persisted and round-trips through SQLite cleanly
- [ ] `claude` can be spawned and exit-code-handled from core
- [ ] Session registry populates and updates reactively
- [ ] Settings merge predictably across global + project scopes

Plus a **headless smoke gate**: an executable target `OrpheusCoreSmoke` that, when run, prints a one-page report demonstrating each subsystem working against a temp SQLite + temp `~/.claude/projects/` fixture. The smoke output is the human-verifiable equivalent of Phase 0's catalog window.

---

## Reading order

Before doing anything, read in this order:

1. **`inputs.md`** (this folder) — the exact set of files to read with locked status.
2. **`docs/specs/architecture.md`** — the 8-layer stack. Read the Core, Terminal, and Persistence sections in detail; skim the rest.
3. **`docs/plan.md` → Phase 1 section** — official deliverables + gate criteria.
4. **`docs/plan.md` → Phase 2 section** — the immediate downstream consumer. Knowing what Phase 2 will demand sharpens the Core API.
5. **`tasks.md`** (this folder) — concrete task breakdown derived from the plan.
6. **`discipline.md`** (this folder) — hard rules + common pitfalls.
7. **`handoff.md`** (this folder) — what to produce, where it goes, how to report done.

The brief is the contract. If anything in this prompt conflicts with the brief, the brief wins.

---

## Non-goals for Phase 1

- **No UI.** Not even a smoke window. The smoke artefact is a CLI report.
- **No `OrpheusDesign` integration.** Phase 1 produces no styled views. Don't import the design package.
- **No libghostty integration.** Phase 2's job. The subprocess manager spawns `claude` as a generic process; PTY hosting + ghostty embedding is later.
- **No self-drive daemon.** Phase 3 owns `~/.orpheus/orpheus.sock`. Phase 1 produces the *data model* that the daemon will mutate, but not the daemon itself.
- **No actual terminal emulation.** Phase 1 reads JSONL; it does not parse ANSI, manage scrollback chunks, or render anything.
- **No voice pipeline.** Phase 6.

---

## Companion phases

- **Phase 0 (Design System) — DONE** (2026-05-09). Imported only by UI phases; Phase 1 doesn't touch it.
- **Phase 2 (Shell + Terminal)** is the first consumer of `OrpheusCore`. The API you produce here is the contract Phase 2 will write against. Design the public surface with that downstream phase in mind.
- **Phase 3 (Self-Drive CLI)** layers a unix-socket daemon on top of the data model. Keep the model APIs *driveable from a separate process* — actor isolation, transactional mutators, an event stream that any subscriber (UI or daemon) can read.

---

## Locked architectural choices (do not propose alternatives)

These are settled in `docs/specs/architecture.md`. Don't relitigate.

- **Single language: Swift.** No Rust↔Swift FFI for the data layer. No Go.
- **Persistence: GRDB.swift over SQLite, with FTS5 enabled.** WAL mode for crash safety.
- **Config: JSON files.** `~/.orpheus/config.json` (global) + `<project-root>/.orpheus/config.json` (per-project). Project overrides global.
- **Session source: `~/.claude/projects/`** with JSONL files. Read header + last line per file (don't tail the whole thing).
- **File watching: FSEvents** via `DispatchSource.makeFileSystemObjectSource` or a small wrapper. No polling.
- **Subprocess: `Foundation.Process`** with stdin/stdout/stderr pipes. No third-party process library.
- **Deployment target: macOS 14+** (matches Phase 0).

Open technical decisions surfaced in the brief — see `tasks.md` "Decisions to lock in this phase" — are yours to resolve. The locked items above are not.
