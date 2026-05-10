# Backend conventions for OrpheusCore

These rules apply to every file in `Sources/OrpheusCore/`. They make the package
safe to compose from any UI layer and keep the concurrency contract legible across
contributors and phases.

## Public surface shape

- All public types are `public struct`, `public enum`, or `public actor`.
- No public classes. Classes appear only inside tightly-scoped internal helpers
  (e.g. `@unchecked Sendable` lock-protected boxes for C-API bridges — see
  `PipeBox` and `EventsBox` in `Subprocess/SubprocessManager.swift`).
- All I/O is `async throws` (or sync `throws` for one-shot file reads that never
  block a live actor).
- Convenience non-throwing accessors for cached snapshots are allowed; document
  the staleness window in a comment.

## No UI imports

Forbidden anywhere in `Sources/OrpheusCore/`:

- `import SwiftUI`
- `import AppKit`
- `import OrpheusDesign`
- `import Cocoa`

CoreGraphics value types (`CGRect`, `CGPoint`, `CGSize`) are allowed where
`LayoutSpec` or `LayoutPosition` genuinely requires geometry. Everything else that
needs a visual representation lives in a UI-layer package; the core never reaches
up.

## Actor isolation around mutable state

Mutable shared state lives inside actors — never in `static var`, ad-hoc
`DispatchQueue` closures, or unprotected global state.

Canonical actors: `Database`, `SubprocessManager`, `SettingsWatcher`,
`SessionRegistry`. Each owns one domain of mutable state and serialises all
mutations through its actor context.

`@unchecked Sendable` is allowed only when bridging a C-API callback (e.g.
`readabilityHandler`) into an `AsyncStream` continuation. The bridge must be
lock-protected (use `NSLock`) and commented with a one-line WHY.

Value types (`OrpheusSettings`, `Project`, `Space`, `Terminal`) are plain structs.
Don't actor-wrap data that has no shared mutable state.

## No `print(...)` in the library

`print(...)` is forbidden in `Sources/OrpheusCore/`. Use `OrpheusLogger.<category>`:

```swift
OrpheusLogger.persistence.error("…")
OrpheusLogger.settings.info("…")
OrpheusLogger.sessions.debug("…")
OrpheusLogger.subprocess.warning("…")
```

`OrpheusLogger` wraps `os.Logger` with per-subsystem categories, so log level
filtering and Console.app subsystem search work without effort.

Only `Sources/OrpheusCoreSmoke/` may call `print(...)` — that target's job is to
print a human-readable stage report.

## No hardcoded user paths

Never write `URL(fileURLWithPath: "/Users/…")` or any literal home path. Always
derive paths via `FileManager.default.homeDirectoryForCurrentUser` or accept the
path via dependency injection so the test suite runs cleanly under any account.

## Migrations are additive

Once a migration ships in a release, never edit it. Add a new migration that
corrects the previous one. Each migration has a unique timestamped ID (e.g.
`"2026-05-10-create-projects"`). Pre-release editing is fine — do it before the
migration appears in a tagged release.

Register all migrations in `Persistence/Migrations.swift` via
`DatabaseMigrator`. Tests in `OrpheusCoreTests/Persistence/` verify each
migration individually by building the prior schema, inserting rows, applying
the migration, and asserting the result.

## Errors are typed

All errors are `OrpheusCoreError` cases (or a sub-error owned by a specific module
if that module genuinely warrants its own type). Add new cases when concrete code
drives them; don't pre-invent.

Every error conforms to `LocalizedError` with a non-empty `errorDescription` so
UI layers can render errors without a switch statement. Don't throw `NSError` or
stringly-typed errors.

## Crash-safety over speed

- Write transactions are small and explicit — don't accumulate writes in memory
  and flush in one giant transaction.
- Settings writes use write-temp + rename so a crash mid-write never leaves a
  partial file.
- WAL mode is on; we accept the WAL-shm overhead.
- Scrollback is chunked (64 KiB) and ring-bounded (256 chunks per terminal).

## Test discipline

- Bound `AsyncStream` consumption with `withTaskGroup` + a sleep-timeout child
  task, not an in-body deadline check inside `for await`. An in-body check hangs
  when the stream emits nothing; `withTaskGroup` cancels the drain task cleanly.
- `AsyncStream` is single-consumer. Don't call `updates()` or `start()` on a
  shared registry from two helpers and expect both to receive the same events.
- Time-box subprocess tests (5 s maximum) via the `withTaskGroup` pattern above.
- Prefer assertions over `print`. If inspection is needed during debugging, use
  `XCTContext.runActivity` and remove before committing.

## External dependencies

Only `GRDB.swift` (pinned 6.x). Foundation and the Apple system frameworks are
always available. If a new dependency looks genuinely necessary:

1. Stop — don't add it yet.
2. Document the need in the handoff notes.
3. Wait for an explicit decision before adding.

Tempting candidates that are not needed: logging frameworks (use `os.Logger`),
JSON helpers (use `JSONEncoder`/`JSONDecoder`), file-watching libraries (use
`DispatchSource.makeFileSystemObjectSource`), subprocess libraries (use
`Foundation.Process`).

## Comments

Default to writing none. Add a single-line WHY-only comment for:
- Non-obvious invariants.
- Workarounds for framework bugs.
- Load-bearing constraints that would surprise a reader.

No "what this method does" docstrings — names should explain that.

## Reference files

Mirror these four files when implementing new actors or repositories:

- `Persistence/Database.swift` — actor wrapping a `DatabaseWriter`, pool config.
- `Settings/SettingsWatcher.swift` — actor lifecycle, debounce, merged-stream pattern.
- `Sessions/SessionRegistry.swift` — subscribe-before-start ordering, in-memory index.
- `Subprocess/SubprocessManager.swift` — `@unchecked Sendable` boxes, pipe drain pattern.
