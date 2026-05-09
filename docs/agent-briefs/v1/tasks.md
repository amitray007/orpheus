# Phase 1 — Task breakdown

Concrete tasks derived from `docs/plan.md` Phase 1 deliverables + gate criteria. Work them roughly top-to-bottom; the groups labelled "parallelisable" are independent of each other once the scaffold lands.

## Group 1 — Scaffold

1. **Init the `OrpheusCore` Swift Package.**
   - Location: `packages/OrpheusCore/` (sibling of `packages/OrpheusDesign/`).
   - `Package.swift` with these products:
     - library `OrpheusCore` — the public surface.
     - executable `OrpheusCoreSmoke` — the smoke-test reporter (Phase 1's catalog equivalent).
   - Targets:
     - `OrpheusCore`
     - `OrpheusCoreSmoke` (depends on `OrpheusCore`)
     - `OrpheusCoreTests` (depends on `OrpheusCore`)
   - External dependencies (the only ones approved for Phase 1):
     - **GRDB.swift** (`https://github.com/groue/GRDB.swift`) — pin to the latest 6.x.
   - Anything else needs to be flagged in handoff before adding.
   - Deployment target: `.macOS(.v14)` — match Phase 0.
   - Directory layout:
     - `Sources/OrpheusCore/Model/` — `Project`, `Space`, `Terminal`, IDs, types, errors.
     - `Sources/OrpheusCore/Persistence/` — GRDB schema, migrations, repositories, db-pool wrapper.
     - `Sources/OrpheusCore/Settings/` — config types, JSON encoding, merging engine, hot-reload watcher.
     - `Sources/OrpheusCore/Sessions/` — `SessionRegistry`, JSONL parser, project-cwd index.
     - `Sources/OrpheusCore/Watchers/` — FSEvents wrappers (one for `~/.claude/projects/`, one for settings files).
     - `Sources/OrpheusCore/Subprocess/` — `SubprocessManager`, `ClaudeProcess`, lifecycle.
     - `Sources/OrpheusCore/Internal/` — anything genuinely internal (file-system helpers, time helpers).
     - `Sources/OrpheusCoreSmoke/` — entry point + report generator.
     - `Tests/OrpheusCoreTests/Model/`, `…/Persistence/`, `…/Settings/`, `…/Sessions/`, `…/Subprocess/`.

## Group 2 — Data model (parallelisable after Group 1)

2. **Stable IDs and entity types.** `ProjectID`, `SpaceID`, `TerminalID`, `SessionID` as opaque strongly-typed structs wrapping `String` (UUID-shaped). Conform `Sendable`, `Hashable`, `Codable`, `CustomStringConvertible`. Compare-by-value, generate via `UUID().uuidString`.
3. **`Project`, `Space`, `Terminal` value types.** Plain Swift structs that are `Codable` + `Sendable`. Match the SQLite columns from `docs/specs/architecture.md` "Persistence" section. Use `Date` (Foundation) for timestamps; use enums for `lifecycle_state`.
4. **`LifecycleState` enum.** Cases per `architecture.md`: `active`, `paused`, `archived`, `pinned`. Stored as `String`-rawvalues for SQLite legibility.
5. **`LayoutSpec` value type.** JSON-encoded layout description for a space. Don't over-design — a recursive enum (`leaf(TerminalID)` / `split(axis, lhs, rhs, fraction)` / `canvas([(TerminalID, CGRect)])`) is enough. Codable. The interpretation lives in Phase 2.
6. **Domain errors.** `OrpheusCoreError: Error` covering `notFound(id:kind:)`, `invalidParent`, `migrationFailed(reason:)`, `subprocessSpawn(reason:)`, `corruptJSONL(path:line:)`, `settingsMergeConflict(key:)`, etc. Add cases as concrete code drives them; don't pre-invent.

## Group 3 — Persistence (parallelisable after Group 2)

7. **`Database` actor.** Thin wrapper around a `DatabasePool`. WAL mode, foreign-keys ON, `.minimumActiveReadConnections = 1`. Owns the migration registry. Path injectable via init for tests.
8. **Schema migrations** as a registered `DatabaseMigrator`. Tables required (per `architecture.md`):
   - `projects(id PK, name, root_path, lifecycle_state, tags JSON, created_at, updated_at)`
   - `spaces(id PK, project_id FK, name, description, layout_spec JSON, ord, lifecycle_state, created_at, updated_at)`
   - `terminals(id PK, space_id FK, cwd, command, status, cc_session_id, layout_position JSON, created_at)`
   - `terminal_scrollback(terminal_id FK, chunk_index, bytes BLOB, PRIMARY KEY(terminal_id, chunk_index))`
   - `sessions_index` — virtual FTS5 table over `(cwd, name, git_branch, last_updated)`. External-content table backing optional; pure-FTS5 is fine for v0.
   - `app_state(key PK, value)` — key-value store for window geometry, last-open layout, etc.
   - All FKs `ON DELETE CASCADE` unless a referenced row should outlive the child (decide per table; document the choice).
9. **Repository types**, one per aggregate. `ProjectRepository`, `SpaceRepository`, `TerminalRepository`, `ScrollbackRepository`, `SessionsIndexRepository`, `AppStateRepository`. Each is an actor or `Sendable` struct holding a `DatabaseWriter`. CRUD + a `read` / `observe` API:
   - **read** — `try await fetchAll()`, `fetch(id:)`, `fetchByProject(_:)`, etc.
   - **observe** — `AsyncStream<[Project]>` (or `[Space]`, etc.) emitting on change. Implement via GRDB's `ValueObservation`.
10. **Crash-safe write strategy.** All writes go through small transactions; the actor wrapping the DB serialises writes. For scrollback, batch chunk writes into 64 KiB buffers and flush at most every 250 ms.
11. **Migration tests.** For every shipped migration, a test that:
    - Builds the prior schema in-memory.
    - Inserts representative rows.
    - Applies the migration.
    - Asserts old rows survived + new columns / tables exist.

## Group 4 — Settings (parallelisable after Group 1)

12. **`OrpheusSettings` value type.** Pure `Codable`/`Sendable` struct mirroring the JSON shape. Do **not** make it a flat dictionary — type each section. Sections (initial; expandable):
    - `general`: `theme: ThemePreference` (.system / .dark / .light), `density`, …
    - `terminal`: `defaultShell: String?`, `scrollbackLines: Int`, `colorScheme: String`, …
    - `claude`: `binaryPath: String?` (for non-PATH installs), `defaultFlags: [String]`, …
    - `quickActions`: `[QuickActionDef]` (data only — execution is Phase 4)
    - Allow forward-compat via an `extra: JSONValue` catch-all.
13. **`SettingsLoader`.** Reads + decodes the global JSON file (`~/.orpheus/config.json`). Per-project loading reads `<root>/.orpheus/config.json`. Both can be missing; default values fill in.
14. **`SettingsMerger`.** Combines a global + project `OrpheusSettings` into a single resolved view. Rule from `plan.md`: project overrides global, field by field. Implement with a generic deep-merge that respects `nil` (only overrides when present). Tests cover every section.
15. **Hot reload.** A `SettingsWatcher` (built on `DispatchSource.makeFileSystemObjectSource`) republishes the merged view as an `AsyncStream<OrpheusSettings>` whenever either file changes. Debounce file events 250 ms (decision lock — see "Decisions to lock in this phase" below).
16. **Atomic writes.** All settings writes go via "write-temp + rename" so a crash mid-write never leaves a half-file.

## Group 5 — Session registry + JSONL watcher (parallelisable after Group 1)

17. **`JSONLLineParser`.** Parses Claude Code session metadata: header line + last line per file. Header carries `cwd`, `gitBranch`, `sessionId`, `name?`. Last line carries `lastUpdated` and the latest message kind. Skip middle lines — they're chat history, irrelevant for indexing. Tolerate malformed lines (log + continue).
18. **`SessionRegistry`.** On startup, scans `~/.claude/projects/` (or the path injected for tests). Builds an in-memory `[ProjectCWD: [SessionMetadata]]` index. Exposes `sessions(forCWD:)`, `recent(limit:)`, `search(_:)` (the search method goes through the FTS5 index).
19. **`SessionsIndexer`.** Writes session metadata into the `sessions_index` FTS5 table whenever the in-memory registry changes. Idempotent — re-indexing the same session is a no-op.
20. **`JSONLWatcher`.** FSEvents on `~/.claude/projects/`. When a session file is created / modified / deleted:
    - Re-parse the header + last line of the affected file.
    - Update the in-memory registry.
    - Update the FTS5 index.
    - Emit `SessionUpdate` on an `AsyncStream<SessionUpdate>` (cases: `.added(SessionMetadata)`, `.updated(SessionMetadata)`, `.removed(SessionID)`).
   Debounce: 100 ms per file.
21. **Initial-load + reactive merge.** Make sure starting the registry vs. observing it concurrently doesn't double-emit. The pattern is: subscribe first, then call `start()` which emits the snapshot, then watcher events flow.

## Group 6 — Subprocess manager (parallelisable after Group 1)

22. **`ClaudeProcess`** — value type representing a spawned `claude` invocation. Holds `pid`, the underlying `Foundation.Process`, the `Pipe`s, an `AsyncStream<ProcessEvent>` of lifecycle events.
23. **`SubprocessManager`** actor. Methods:
    - `spawnClaude(cwd:flags:env:)` returning `ClaudeProcess`.
    - `terminate(_ process: ClaudeProcess, timeout:)` — graceful (SIGTERM) → forced (SIGKILL) fall-back.
    - `processes` — current snapshot of live `ClaudeProcess` records.
    Track every spawned process; clean up records on termination.
24. **Flag combination contract.** A `ClaudeFlags` builder type that produces the argv array. Encode the supported combinations:
    - Fresh session: no `--session-id` / `--resume`.
    - Resume: `--resume <id>`.
    - Fork: `--resume <id> --fork-session`.
    - Headless / batch: `--output-format stream-json` (Phase 3 will lean on this; Phase 1 just exposes it).
    - Bare mode: `--bare`.
    Run `claude --help` (or check the Claude Code repo) to verify the flag set is current. If a flag is gone, flag it.
25. **Stdout/stderr piping.** Both pipes drained on background readers. Stdout chunks go to an `AsyncStream<Data>`; stderr similarly. The streams must be drainable concurrently or the process blocks. Use `FileHandle.readabilityHandler`.
26. **Exit-code handling.** A `ProcessExited` event carries the termination status (`.exit(Int32)`, `.signal(Int32)`, `.uncaughtException`).
27. **Resolution of `claude` binary.** Use the path from `OrpheusSettings.claude.binaryPath` when set; otherwise look up via `which claude` semantics. Never bake `/usr/local/bin/claude`.
28. **No PTY in Phase 1.** The actual terminal embedding (PTY → libghostty) is Phase 2. The `SubprocessManager` here just `Process`-spawns; PTY wrapping happens later. Document this clearly in the source so a Phase 2 reader knows what's missing.

## Group 7 — Smoke executable

29. **`OrpheusCoreSmoke` reporter.** `swift run OrpheusCoreSmoke` from the package root must:
    - Create a temp directory `./.smoke/<timestamp>/` (gitignored).
    - Open a fresh `Database` against `<tmp>/orpheus.db`.
    - Insert 1 project, 2 spaces, 3 terminals; print them back via the repositories' `fetchAll`.
    - Write a settings JSON to `<tmp>/global.json`, override one key in `<tmp>/project.json`, load + merge, print the resolved value.
    - Drop a fixture session JSONL into `<tmp>/.claude/projects/<cwd-encoded>/<sid>.jsonl`, point `SessionRegistry` at the fixture root, print discovered sessions, then write a second JSONL while the watcher is live and print the resulting `SessionUpdate` event.
    - Spawn `/bin/echo "hello"` through `SubprocessManager` (NOT `claude` — keeps the smoke runnable without Claude Code installed). Print captured stdout + exit code. If `claude` is on PATH **and** `--ORPHEUS_RUN_CLAUDE=1` env var is set, additionally spawn `claude --version` and print its output.
    - Exit with code 0 on success; non-zero with a labelled failure on the first stage that throws.
   The output should be a single readable page — think "phase-completion postcard."

## Group 8 — Tests

30. **Unit tests for the model and migrations.** Token-precise assertions on column names, FK directions, default values.
31. **Integration tests for repositories.** Spin up a temp `Database`, run the full CRUD + observation cycle for each aggregate. Includes a test that `ValueObservation` emits on insert / update / delete.
32. **Settings tests.** Round-trip every section through JSON. Merge tests for every "project overrides global" expectation. Hot-reload test: write a file, observe the stream, confirm the new value.
33. **JSONL parser tests.** Fixtures for typical / malformed / empty / partial-write files. Confirm the parser tolerates each.
34. **Session registry tests.** Built-in fixture directory. Confirm initial scan + reactive update path. Confirm de-dup on update events.
35. **Subprocess tests.** Spawn `/bin/echo`, `/usr/bin/true`, `/bin/cat` (with stdin pipe) — verify event ordering and stdio drain. Time-boxed (max 5 s per test) to avoid hanging the suite.
36. **Concurrency tests.** Hammer the `Database` actor from multiple tasks; verify no data races, no `EXC_BAD_ACCESS`, transaction integrity.

## Group 9 — Documentation + lint

37. **`packages/OrpheusCore/README.md`** — module-by-module summary, public-API cheatsheet, "how to consume from a UI module" snippet, footnote on the smoke executable.
38. **`packages/OrpheusCore/AGENTS.md`** — backend-flavoured analogue of `OrpheusDesign/AGENTS.md`. Spell out the actor-isolation rules, the "no UI imports here" rule, the "external deps must be flagged" rule, and the migration-discipline rules (additive first, never edit a shipped migration).
39. **A `DisciplineLintTests` test target** mirroring Phase 0's. Scans `Sources/OrpheusCore/` for forbidden patterns:
    - `import OrpheusDesign` — forbidden.
    - `import SwiftUI` / `import AppKit` — forbidden (UI is later).
    - `print(` — only inside `OrpheusCoreSmoke/`. Use a thin internal `Logger` everywhere else.
    - `URL(fileURLWithPath: "/Users/")` — no hardcoded user paths; always parameterise.
    - Allow markers via `// orpheus-allow:<rule>` (same convention as Phase 0).

## Decisions to lock in this phase

These are open per `docs/plan.md`. Pick one in code, document the choice in `packages/OrpheusCore/README.md`, surface in handoff:

- **SQLite migration strategy.** Recommended default: GRDB's built-in `DatabaseMigrator`, registered in code. No external tool. Reasoning: zero-friction, one-language, easy to ship a new migration in a PR.
- **Scrollback chunk size and ring-buffer bounds.** Recommended default: 64 KiB chunks, ring of 256 chunks per terminal (~16 MiB ceiling per terminal). Raise the ceiling per project via settings.
- **Settings hot-reload debounce.** Recommended default: 250 ms after the last FS event.

If you make a different call than the recommendation above, justify it in the handoff. If you make the recommended call, just confirm it.

---

## Out of scope (flag if you hit them)

- libghostty integration / PTY wrapping — Phase 2.
- Self-drive daemon / unix socket / JSON-RPC — Phase 3.
- Rich-content rendering (Markdown / Code / Diff / Charts / Heatmap) — Phase 3+.
- Quick-actions execution machinery — Phase 4.
- Voice pipeline — Phase 6.
- Custom-drawn icons or any UI assets — Phase 7.

If a task in this list can't be completed without touching out-of-scope code, **stop and flag it in your handoff report**.
