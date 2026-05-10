# OrpheusCore

Headless data + plumbing layer for Orpheus.

Every UI module in the project — Phase 2 onward — imports `OrpheusCore` and
builds on top of its repositories, settings engine, session registry, and
subprocess manager. This package has no UI dependency and never will.

See [AGENTS.md](AGENTS.md) for discipline rules that govern contributions.

---

## Modules

### Model

Stable value types and IDs shared across all other modules.

Strongly-typed IDs (`ProjectID`, `SpaceID`, `TerminalID`, `SessionID`) wrap a
UUID string and conform to `Sendable`, `Hashable`, `Codable`, and
`CustomStringConvertible`.

Entity structs (`Project`, `Space`, `Terminal`) are plain `Codable` + `Sendable`
structs whose fields match the SQLite columns verbatim. `LifecycleState` (`.active`,
`.paused`, `.archived`, `.pinned`) is stored as a String raw-value for SQLite
legibility. `LayoutSpec` is a recursive enum (`leaf`, `split`, `canvas`) that
describes a space's pane arrangement; interpretation lives in Phase 2.

Domain errors live in `OrpheusCoreError` — a typed enum conforming to
`LocalizedError` covering `notFound`, `invalidParent`, `migrationFailed`,
`subprocessSpawn`, `corruptJSONL`, `settingsMergeConflict`, and their siblings.

### Persistence

GRDB-backed SQLite with WAL mode, foreign keys, and atomic writes.

Main types: `Database`, `ProjectRepository`, `SpaceRepository`,
`TerminalRepository`, `ScrollbackRepository`, `SessionsIndexRepository`,
`AppStateRepository`.

`Database` is an `actor` that wraps a `DatabasePool` (file-backed) or
`DatabaseQueue` (in-memory, used by tests). All repository reads and writes go
through this actor. Migrations are registered in `Migrations.makeMigrator()` and
applied at init time.

Each repository exposes:
- `fetchAll()` / `fetch(id:)` / `fetchByProject(_:)` — one-shot async reads.
- `observeAll()` — `AsyncStream` that emits a fresh snapshot on every change,
  powered by GRDB `ValueObservation`.

Scrollback is chunked at 64 KiB per entry; up to 256 chunks per terminal
(~16 MiB ceiling). `AppStateRepository` is a key-value store for window geometry
and last-open layout.

### Settings

JSON config files, field-level merging, and live hot-reload.

`OrpheusSettings` is a `Codable` + `Sendable` struct with typed sections:
`general` (theme, density), `terminal` (shell, scrollback, color scheme),
`claude` (binary path, default flags), and `quickActions`. An `extra: JSONValue`
catch-all preserves unknown keys for forward compatibility.

`SettingsLoader` reads the global config (`~/.orpheus/config.json`) and an
optional per-project override (`<root>/.orpheus/config.json`). Missing files
yield `OrpheusSettings.defaultValue` — never an error.

`SettingsMerger` combines global + project settings field by field: a non-nil
project value wins; a nil project field falls through to the global value.

`SettingsWatcher` is an `actor` built on `DispatchSource.makeFileSystemObjectSource`.
It emits the current merged view immediately on `start()`, then re-emits after
every filesystem event, debounced by `SettingsConstants.settingsDebounceInterval`
(250 ms). All settings writes go through a write-temp + rename strategy so a
crash mid-write never leaves a partial file.

### Sessions

Claude Code session JSONL discovery, indexing, and live watching.

`JSONLLineParser` reads only the header line and the last line of each `.jsonl`
file — enough to extract `sessionId`, `cwd`, `gitBranch`, `name`, and
`lastUpdated`. Middle lines (chat history) are skipped; malformed lines are
logged and skipped.

`SessionRegistry` is an `actor` that scans `~/.claude/projects/` (or an injected
path for tests), builds an in-memory `[cwd: [SessionMetadata]]` index, and
exposes `sessions(forCWD:)`, `recent(limit:)`, and `search(_:)`.

`SessionsIndexer` writes metadata into a FTS5 `sessions_index` table for
full-text search. Re-indexing an unchanged session is a no-op.

`JSONLWatcher` wraps `DirectoryWatcher` (FSEvents) to detect created, modified,
and deleted session files. It emits `SessionUpdate` events (`.added`,
`.updated`, `.removed`) on an `AsyncStream`. Per-file debounce: 100 ms.

### Watchers

Low-level FSEvents primitives used by `SettingsWatcher` and `JSONLWatcher`.

`FileChangeWatcher` monitors a single file path and emits on a debounced
`AsyncStream<Void>`. `DirectoryWatcher` monitors a directory subtree and emits
`(URL, eventFlags)` tuples.

### Subprocess

Foundation.Process wrapper with actor isolation and typed lifecycle events.

`SubprocessManager` is an `actor` that spawns binaries, tracks live processes,
and handles SIGTERM → SIGKILL escalation. `ClaudeProcess` is a value-type
snapshot of a spawned process (pid, command, cwd, start time). `SpawnResult`
bundles the snapshot with `AsyncStream<Data>` streams for stdout and stderr, an
`AsyncStream<ProcessEvent>` for lifecycle events (`.spawned`, `.exited`), and a
`StdinHandle` actor for writing to stdin.

`ClaudeFlags` is a builder that produces the argv array for `claude` invocations
(fresh session, `--resume`, `--fork-session`, `--output-format stream-json`).
`ClaudeBinaryResolver` resolves the `claude` binary via settings or `PATH`. No
hardcoded paths.

Note: Phase 1 uses `Foundation.Process` with `Pipe`-based stdio. PTY wrapping
via libghostty is Phase 2.

---

## Public-API cheatsheet

Open a database, insert a project, and observe changes:

```swift
let db = try await Database(path: "/path/to/orpheus.db")
let projects = ProjectRepository(database: db)

try await projects.create(Project(name: "My Project", rootPath: "/Users/me/myproject"))

for await snapshot in projects.observeAll() {
    print(snapshot.count, "projects")
}
```

---

## Consuming from a UI module

Phase 2 opens the database and wires up each subsystem at app startup:

```swift
// 1. Open the database (call once; pass the actor around via dependency injection).
let db = try await Database(path: appDatabasePath)

// 2. Watch settings — first emission is immediate; subsequent ones arrive
//    within 250 ms of a file change.
let globalURL  = homeDirectory.appendingPathComponent(".orpheus/config.json")
let projectURL = projectRoot.appendingPathComponent(".orpheus/config.json")
let watcher    = SettingsWatcher(globalURL: globalURL, projectURL: projectURL)

Task {
    for await settings in await watcher.start() {
        applySettings(settings)
    }
}

// 3. List sessions for the current project directory.
let registry = SessionRegistry(rootURL: claudeProjectsURL)
let updates  = await registry.updates()
try await registry.start()

Task {
    for await update in updates {
        switch update {
        case .added(let m):   insertSession(m)
        case .updated(let m): refreshSession(m)
        case .removed(let id): removeSession(id)
        }
    }
}

// 4. Spawn a subprocess (echo; swap in claudePath for real use).
let manager = SubprocessManager()
let result  = try await manager.spawn(
    binaryPath: "/bin/echo",
    arguments:  ["hello"],
    cwd:        projectRoot
)
Task {
    for await chunk in result.stdout where !chunk.isEmpty {
        handleOutput(chunk)
    }
}
```

---

## Running the smoke executable

```bash
cd packages/OrpheusCore
swift run OrpheusCoreSmoke
```

The smoke executable runs five stages in sequence against a fresh temp directory
at `.smoke/<unix-timestamp>/`:

| Stage | What it tests |
|---|---|
| 1/5 Persistence | Opens a real SQLite file, inserts 1 project + 2 spaces + 3 terminals, reads them back via the repositories. |
| 2/5 Settings | Writes global + project JSON overrides, merges them, prints the resolved values. |
| 3/5 Sessions | Drops a fixture JSONL, starts `SessionRegistry`, confirms initial-scan emission, drops a second JSONL while the watcher is live, waits for the `SessionUpdate` event. |
| 4/5 Subprocess | Spawns `/bin/echo "hello orpheus"` via `SubprocessManager`, drains stdout, prints exit status. |
| 5/5 Cleanup | Reports the temp dir path; the directory is kept for inspection. |

The temp directory is gitignored (`.smoke/` in the package root).

Exit code 0 means all stages passed. A non-zero exit code is labeled with the
failing stage number (2 = persistence failed, 3 = settings, etc.).

**Optional: test with `claude` on PATH**

```bash
ORPHEUS_RUN_CLAUDE=1 swift run OrpheusCoreSmoke
```

When `ORPHEUS_RUN_CLAUDE=1` is set and `claude` is available on `PATH`, Stage
4 additionally spawns `claude --version` and prints its first output line.
Without the flag, Stage 4 skips this and prints a one-line note.

---

## Decisions locked in Phase 1

**SQLite migration strategy.** GRDB's built-in `DatabaseMigrator`, registered in
code in `Persistence/Migrations.swift`. Migrations have timestamped string IDs
(e.g. `"2026-05-10-create-projects"`). They are additive-only once shipped. To
add a column or table, register a new migration — never edit a shipped one.

**Scrollback chunk size and ring-buffer bounds.** 64 KiB per chunk, 256 chunks
maximum per terminal, giving a ~16 MiB ceiling per terminal. Controlled by
`PersistenceConstants` in `Persistence/Constants.swift`.

**Settings hot-reload debounce.** 250 ms, locked in
`SettingsConstants.settingsDebounceInterval`. This value is used by both
`FileChangeWatcher` (per-file debounce) and `SettingsWatcher` (coalescing layer
that merges simultaneous global + project file events into one reload).

**Date encoding.** `timeIntervalSinceReferenceDate` REAL columns in SQLite.
In-memory `Codable` round-trips use `.deferredToDate`.

**GRDB pool config.** `persistentReadOnlyConnections = true`. The Phase 1 brief
named `minimumActiveReadConnections = 1`, but that property does not exist in
GRDB 6.x; `persistentReadOnlyConnections` is the semantic equivalent — reader
connections are kept alive across `releaseMemory()` calls, avoiding first-read
latency on idle pools.

---

## Known v0 gaps

These cases are documented with `XCTSkipIf` in the test suite. Neither is
critical for the Phase 2 use-cases.

- **DirectoryWatcher — late-appearing root.** When the watched directory
  doesn't exist at `start()` time and appears later, the watcher doesn't
  replay any files already present in it. In practice `~/.claude/projects/`
  is always present when Orpheus starts, so this path is not exercised.

- **JSONLWatcher — mid-watch file deletion.** A `.jsonl` file that exists at
  watch-start time and is deleted while the watcher is running does not
  reliably emit `.removed`. The `SessionRegistry` initial scan covers the
  typical case; re-starts of the registry catch deletions that happened
  while it was stopped.
