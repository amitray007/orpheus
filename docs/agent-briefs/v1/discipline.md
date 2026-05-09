# Phase 1 — Discipline rules + common pitfalls

These rules come directly from `docs/specs/architecture.md` and Phase 0's hard-won conventions, adapted for a backend Swift Package. They exist so Phase 2+ can build a UI on top of `OrpheusCore` without paying for a leaky core.

## Hard rules

### 1. No UI imports in `OrpheusCore`
Forbidden in `Sources/OrpheusCore/`:
- `import SwiftUI`
- `import AppKit`
- `import OrpheusDesign`
- `import Cocoa`
- Any reference to `View`, `NSView`, `NSWindow`, `Image`, `Color`, `Font` types.

`OrpheusCore` is a headless library. UI phases compose **on top** of it; the core never reaches up.

### 2. No third-party dependencies beyond GRDB.swift
The only approved external dependency is **GRDB.swift** (latest 6.x). Everything else uses `Foundation` and Apple frameworks.

If you genuinely need another dependency:
- Stop.
- Document the need in `handoff.md`'s "External-reference issues" section.
- Wait for an explicit user decision before adding.

Tempting candidates that you should **not** reach for in v0:
- Logging frameworks → use a small internal `Logger` enum that wraps `os.Logger`.
- JSON helpers → `JSONEncoder` / `JSONDecoder` are sufficient.
- File-watching libraries → `DispatchSource.makeFileSystemObjectSource` and FSEvents are sufficient.
- Subprocess libraries → `Foundation.Process` + `Pipe` are sufficient.

### 3. Actor isolation around mutable state
- The SQLite database is wrapped in a single `Database` actor that owns the `DatabaseWriter`. All writes go through it.
- The session registry is an actor (or holds an actor-isolated cache).
- The settings watcher is an actor or wraps a `Mutex` over a value.

Don't use `static var` mutable state, ad-hoc `DispatchQueue` patterns, or `@unchecked Sendable` to sidestep the rules. If you genuinely need it (e.g. inside a tightly scoped C-API wrapper), justify it in code with a one-line comment.

### 4. No `print(...)` outside `OrpheusCoreSmoke`
- In library code, log via a thin internal `Logger` (a wrapper around `os.Logger` from `OSLog`) so log levels and subsystems are usable.
- In tests, prefer assertions over `print`. If you really need to look at a value, use `XCTContext.runActivity` or a debug-only print and remove it before commit.
- Only `Sources/OrpheusCoreSmoke/` may use `print(...)` — that target's job is to print a human-readable report.

### 5. No hardcoded user paths
- Never write `URL(fileURLWithPath: "/Users/...")` or any literal home path.
- Always derive paths via `FileManager.default.homeDirectoryForCurrentUser` (or accept the path via dependency injection from a caller / test).
- The test suite must run cleanly under any user account.

### 6. Migrations are additive
- Once a migration ships in a release, **never edit it.** Add a new migration that fixes the previous one.
- Every migration has a unique identifier (timestamped string is fine: `"2026-05-10-create-projects"`).
- Document the migrator in `README.md` so a new contributor can add a migration without spelunking.
- Migrations are tested individually (Group 8 task 30).

### 7. No I/O on the main thread
- Disk reads, file watches, subprocess spawns, and SQLite operations are all `async` or run on a background queue. They never block a caller's main thread.
- Public APIs that perform I/O are `async throws`.
- Convenience non-throwing accessors (e.g. cached snapshots) are fine for callers who can read stale data; document the staleness window.

### 8. Errors are typed, not strings
- Don't throw `NSError` or stringly-typed errors.
- Use `OrpheusCoreError` (or a sub-error owned by a module) with explicit cases.
- Conform errors to `LocalizedError` with a `errorDescription` so the UI can render them without a switch.

### 9. Crash-safety over speed
- Writes use small transactions.
- Settings writes are atomic (write-temp + rename).
- WAL mode is on; we accept the WAL-shm overhead in exchange for crash safety.

### 10. Phase 1 is parallel-safe with Phase 0
- Don't touch `packages/OrpheusDesign/`. The two packages live side-by-side; touching the design layer from a core PR signals scope drift.
- Don't touch `docs/specs/*` or `docs/wireframes/*`. They are LOCKED.

## Common pitfalls

### GRDB `ValueObservation` and concurrency
`ValueObservation.observe(_:)` with the default scheduler emits on a background queue. Wrap the stream in a SwiftConcurrency-friendly `AsyncStream` so callers don't need to hop. Test that emissions arrive in order under contention.

### `Foundation.Process` and stdio deadlocks
A `Process` will block if its stdout/stderr pipes fill and nothing is reading them. Always set `readabilityHandler` on the read ends *before* calling `run()`. Drain in fixed-size chunks; do not collect into an unbounded buffer for long-running processes.

### FSEvents debouncing
Filesystem events on macOS often fire multiple times for one logical save (editor's atomic save = remove + rename + chmod). Debounce all watcher streams; the recommended default is 100 ms for JSONL events and 250 ms for settings events. Lock-and-document the debounce window in code.

### JSONL files are append-mostly but not always
Claude Code can rewrite a JSONL on session resume, can truncate, can be partial during a streaming write. The parser tolerates each:
- Empty file → `nil` metadata.
- Header-only → `nil` last-line, but valid `cwd` / `sessionId`.
- Trailing partial line → ignore the trailing partial; use the previous complete line as "last".

### Settings forward-compatibility
Don't hard-fail on unknown JSON keys. Add an `extra: JSONValue` catch-all so a future Orpheus release that knows about new keys can drop into a folder where an older release wrote settings — and vice versa. Test this round-trip explicitly.

### `claude` flag drift
The architecture spec was written 2026-04-18. If the Claude Code CLI changed its flag set between then and now, **don't paper over it**. Run `claude --help`, capture the current flags, and either:
- Update the `ClaudeFlags` builder to match.
- Or, if a flag the spec assumed is gone, raise it in handoff and propose a path forward.

### Don't actor-wrap pure-data types
`OrpheusSettings`, `Project`, `Space`, `Terminal` are value types. They don't need actors. Actors wrap *mutable shared state* — the database, the live registry, the watcher. Plain values stay plain.

### Avoid premature schema design
The wireframes need a usable schema, not the perfect one. Ship the v0 schema in one or two migrations. Phase 2's actual UI use will surface the next iteration. Don't try to anticipate every column you might want.

## When to break a rule

Same as Phase 0: don't, in this phase. If a rule genuinely blocks you, it's a spec gap or an architectural question — stop, flag in handoff, wait for resolution. Phase 1 is foundational; bending rules here compounds across every later phase.
