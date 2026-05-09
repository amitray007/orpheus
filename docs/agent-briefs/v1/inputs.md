# Phase 1 — Inputs to read before writing any code

All paths are relative to the Orpheus code repo root: `/Users/maverick/code/projects/orpheus/`.

## Primary sources of truth (LOCKED — treat as contract)

### `docs/specs/architecture.md`
**LOCKED.** The technical spec. Phase-1-relevant sections in priority order:

1. **§ "4. Core — Swift"** — names every Phase 1 module: `SessionRegistry`, `JSONLWatcher`, `SubprocessManager`, `Persistence`, `Settings`, `SelfDriveDaemon` (deferred to Phase 3).
2. **§ "7. Persistence"** — config-file paths, SQLite tables and columns, auto-restore behaviour, scrollback chunking strategy.
3. **§ "8. Design system"** — read for context only. Phase 1 does not depend on it.
4. **§ "Key data flows"** — flows 1, 4, 5 are core-driven; flow 2 (quick action) is Phase 4; flow 3 (self-drive) is Phase 3. Knowing the flows sharpens API design.
5. **§ "Decisions with rationale"** — supports the locked-in choices in `README.md`.

### `docs/plan.md` → Phase 1 section
**LOCKED.** Official deliverables, open technical decisions, and gate criteria. Read verbatim. `tasks.md` expands on it — anything in Phase 1 of `plan.md` not in `tasks.md` is an oversight, raise it.

### `docs/plan.md` → Phase 2 section
**Read for context.** Phase 2 is the first UI consumer of `OrpheusCore`. Skim its deliverables and gate criteria so the API surface you design here can satisfy them without churn:
- Phase 2 needs to render `Project ▸ Space ▸ Terminal` as a sidebar.
- Phase 2 needs to spawn `claude` per terminal and re-attach to existing sessions on relaunch.
- Phase 2 needs auto-restore of every open terminal at last-close time.

### `docs/specs/design-principles.md`
**LOCKED.** Not a Phase 1 input — listed only to confirm you should **not** import it. The 8 discipline rules apply to UI; Phase 1 is non-UI.

## Reference — what the data model must ultimately power

### `docs/wireframes/wireframes-v0.5.md`
**LOCKED.** 22 wireframes. You are not building any of them. Skim only:
- **W1, W2** (dashboard) — the sidebar tree the data model must vend.
- **W4** (chat viewer) — what the `JSONLWatcher` event stream feeds.
- **W5** (sessions browser) — what the FTS5 sessions index powers.
- **W14, W15** (settings) — the shape of the settings JSON the merging engine handles.

You can answer "is this property real?" by checking whether a wireframe surface needs it.

### `docs/future-scope.md`
**Read once.** Anything in here is **not Phase 1**. Useful for answering "is this my scope?" — if a feature appears in `future-scope.md`, defer it.

## Companion specs (skim)

### `docs/specs/quick-actions.md`
Quick Actions are Phase 4. Phase 1 does not implement them. The data model should have a *place to put* per-project quick-action definitions in the settings JSON, but the execution machinery is later.

## Existing code to read

### `packages/OrpheusDesign/`
Phase 0's deliverable. **Don't import it from `OrpheusCore`.** Read its `Package.swift` and `AGENTS.md` to mirror conventions: zero-dependency-by-default, `swift build` clean, tests written before implementation, smoke executable target.

## External references (consult as needed)

- **GRDB.swift** — https://github.com/groue/GRDB.swift. Use the latest 6.x release. Read the FTS5 docs (https://swiftpackageindex.com/groue/grdb.swift/main/documentation/grdb/fullTextSearch).
- **Apple `Foundation.Process`** — `Process` + `Pipe` for subprocess management. No third-party library.
- **Apple FSEvents / `DispatchSource`** — for filesystem watching. Prefer `DispatchSource.makeFileSystemObjectSource` for single-file watches; fall back to FSEvents only if a directory tree must be observed (e.g. `~/.claude/projects/`).
- **Claude Code CLI** — `claude --help`. Verify available flags before encoding `--session-id`, `--resume`, `--fork-session`, `--bare`, `--output-format` etc. The set may have shifted since the architecture spec was written.

## Not inputs for this phase

- libghostty / `OrpheusTerminal` — Phase 2.
- Self-drive daemon and CLI — Phase 3.
- Rich-content components — Phase 3.
- Voice pipeline — Phase 6.
- Logotype / icon catalog — Phase 7.
