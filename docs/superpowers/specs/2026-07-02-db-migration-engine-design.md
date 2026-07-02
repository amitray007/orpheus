# Declarative DB Migration Engine — Design

**Date:** 2026-07-02
**Status:** Design (awaiting user review before planning)
**Area:** `src/main/db.ts` → `src/main/db/*`

## Problem

All schema lives in one 2500-line imperative file (`src/main/db.ts`) driven by a
hand-rolled `schema_version` table and a linear `if (currentVersion < N) { … }`
ladder of 64 blocks. `CURRENT_VERSION` is 65. The model has six concrete failures:

1. **Double declaration.** Every column is declared twice — once in a
   `CREATE TABLE … IF NOT EXISTS` constant (for fresh installs) and once in an
   `ALTER TABLE … ADD COLUMN` block (for existing installs) — kept in sync by hand.
2. **Idempotency via `catch {}`.** Duplicate-column errors are swallowed, but so is
   *any other* error — a typo silently leaves a column missing.
3. **Integer versions collide under parallel branches.** Two branches each shipped a
   different migration under `if (currentVersion < 64)`; the merged block never
   re-runs, forcing a v65 "convergence" block that re-applies five ALTERs defensively.
4. **Destructive DROPs need runtime healers.** `projects.archived_at` was dropped at v3
   but is still queried, so `healProjectsArchivedAt()` re-adds it on *every* boot,
   outside the version system.
5. **CHECK constraints can't evolve.** The `workspaces.status` CHECK silently drifted
   from the `WorkspaceStatus` enum, causing swallowed "CHECK constraint failed" errors.
   `healWorkspacesCheck()` fixes it with a hand-written table rebuild on every boot.
6. **No-op version bumps, inconsistent fresh-install guards, and general 2500-line sprawl.**

## Goals

- **One source of truth per table.** No CREATE-constant + ALTER-block duplication.
- **No `catch {}` idempotency.** Errors are loud.
- **Collision-proof under parallel branches.** No integer version to collide.
- **Auto-heal drift** (CHECK changes, type changes, dropped/re-added columns) with a
  safe, automatic table rebuild — retiring both hand-written healers.
- **Adopt existing user DBs** (currently at `schema_version` 2–65) without data loss.

## Non-goals

- No new test runner (repo has none; CLAUDE.md forbids inventing one).
- No change to DB location, pragmas (WAL/foreign_keys/etc.), or the `getDb()` singleton lifecycle.
- No ORM. Plain `better-sqlite3` + structured table definitions.

## Decisions (from brainstorming)

| Choice | Decision |
| --- | --- |
| Core model | **Hybrid**: declarative schema auto-diff + ordered, tracked data steps. |
| SQLite-hard changes (CHECK/type/NOT NULL) | **Auto table-rebuild (full power)** — engine does the 12-step rebuild itself. |
| Cutover from old engine | **Full replace** — delete the 64-block ladder; engine diffs from any state. |
| Data-transform history (icon rename, JSON munging, seeds) | **Synthesis** *(recommended; user was away — veto at review)*: port the real data transforms into named data steps; seed the ledger from the old `schema_version` so ancient DBs still run the ones they missed. |
| Schema format | **Structured columns** *(recommended; user was away — veto at review)* with a raw-SQL escape hatch, so `enumCheck` and clean drift-detection work. |
| Safety rails | **Auto-backup before rebuild**, **transaction-wrap + verify row counts**, **dry-run diff logging to diagnostics**. Auto-drop of removed columns is **allowed** (guarded by backup+verify). |

## Architecture

Replace the monolith with a `src/main/db/` directory:

```
src/main/db/
  index.ts        # getDb() singleton, pragmas, calls engine.sync() + runDataSteps()
  schema.ts       # desired state — every table declared once (SchemaDef)
  engine.ts       # reconciler: introspect → diff → plan → execute (incl. 12-step rebuild)
  data-steps.ts   # ordered, named, run-once data transforms + ledger
```

`getDb()` keeps its current behavior (lazy singleton, same pragmas: `journal_mode=WAL`,
`foreign_keys=ON`, `synchronous=NORMAL`, `cache_size=-8000`, `mmap_size=268435456`,
`temp_store=MEMORY`) and is still called once at startup from `src/main/index.ts`
before any IPC fires. Only the migration internals change. `CURRENT_VERSION` and the
`schema_version` table are removed after cutover.

### 1. `schema.ts` — declarative desired state

Each table is a plain object. Enums are TS `as const` arrays shared with app code, so
the CHECK constraint and the app validator can never drift.

```ts
export const WORKSPACE_STATUS =
  ['in_progress','awaiting_input','attention','idle','archived'] as const

export const schema: SchemaDef = {
  workspaces: {
    columns: {
      id:              'TEXT PRIMARY KEY',
      project_id:      'TEXT NOT NULL',
      status:          { type: 'TEXT', notNull: true, check: enumCheck('status', WORKSPACE_STATUS) },
      worktree_branch: 'TEXT',
      // …every column, once
    },
    foreignKeys: [{ columns: ['project_id'], ref: 'projects(id)', onDelete: 'CASCADE' }],
    indexes: {
      idx_workspaces_project: ['project_id'],
      idx_workspaces_pinned:  { columns: ['pinned_at'], where: 'pinned_at IS NOT NULL' },
    },
  },
  // …every table (projects, sessions, claude_global_settings, app_ui_state, etc.)
}
```

- A column value is a **raw SQL string** (escape hatch for exotic definitions) **or** a
  structured `{ type, notNull?, default?, check?, primaryKey? }`.
- `enumCheck(col, values)` renders `CHECK (col IN ('a','b',…))` from the shared array.
- The canonical `CREATE TABLE` text is deterministically rendered from the def, so the
  engine can compare live-vs-desired.

### 2. `engine.ts` — the reconciler

`engine.sync(db)` reconciles each desired table:

1. **Missing table** → `CREATE TABLE` from rendered def + create its indexes. Done.
2. **Existing table:**
   - Compare columns (`PRAGMA table_info`). Desired-but-missing → `ADD COLUMN`.
     Live-but-not-desired → `DROP COLUMN` (allowed; guarded by backup + verify).
   - Compare **normalized table SQL** (constraints, CHECKs, NOT NULL, PK, FKs). If it
     differs in a way `ADD COLUMN` cannot express → **`rebuildTable`** (below).
   - Reconcile indexes (`PRAGMA index_list`): create missing, drop our extras (skip
     auto/PK indexes).
3. Each table's reconciliation runs in a transaction; row counts verified across rebuilds.

**Normalized comparison:** SQLite reformats stored SQL, so drift-detection compares a
*normalized* rendering (whitespace/quoting/case-insensitive on keywords) of the live
`sqlite_master.sql` against a normalized render of the desired def — not a raw string match.

**The 12-step rebuild** (retires `healWorkspacesCheck`):

```
PRAGMA foreign_keys = OFF
BEGIN
  CREATE TABLE t__new ( …desired def… )
  INSERT INTO t__new (shared) SELECT (shared) FROM t   -- shared = live ∩ desired columns
  assert count(t__new) == count(t)                      -- verify; mismatch → throw → rollback
  DROP TABLE t
  ALTER TABLE t__new RENAME TO t
  recreate all indexes for t
COMMIT
PRAGMA foreign_keys = ON
```

Column mapping is the **intersection** of live and desired columns. New columns take
their default; dropped columns are left behind. This handles the `archived_at`
drop/re-add mess and any CHECK/type change automatically.

### 3. `data-steps.ts` — ordered, tracked data transforms

```ts
export const dataSteps: DataStep[] = [
  { name: 'legacy-icon-rename',  legacyThroughVersion: 45, run: (db) => { /* Lucide→Phosphor */ } },
  { name: 'legacy-status-remap', legacyThroughVersion: 28, run: (db) => { /* in_review→awaiting_input */ } },
  // …the other real legacy transforms (v16 blob clear, v21 backfill, v46 JSON munge,
  //   v47/v48/v49 footer seed reconciliation)
  // new transforms appended here forever, by name
]
```

- Ledger table: `applied_data_steps(name TEXT PRIMARY KEY, hash TEXT, applied_at INTEGER)`.
- `runDataSteps(db)`: skip any step already in the ledger; run the rest **in array order**,
  each in its own transaction; record `name` + `hash` on success.
- **Collision-proof:** parallel branches append differently-named steps; a merge runs both.
  No integer to collide → the v64→v65 hack cannot recur.

### 4. Cutover (full replace)

First boot on the new engine:

1. Detect legacy state: read the old `schema_version` row if the table exists
   (`legacyVersion`), else treat as fresh.
2. `engine.sync(db)` — converge the schema by diff from whatever shape the DB has.
3. **Seed the data-step ledger:** for each data step, if `legacyVersion >=
   step.legacyThroughVersion`, mark it already-applied (that transform ran under the old
   ladder); otherwise leave it unapplied so `runDataSteps` runs it. Fresh installs
   (`legacyVersion` absent) mark **all** legacy steps applied (fresh schema already correct).
4. `runDataSteps(db)` — run whatever remains unapplied.
5. Drop the `schema_version` table. Delete both healers (`healProjectsArchivedAt`,
   `healWorkspacesCheck`) — their jobs are now the reconciler's.

## Safety rails

- **Backup before first rebuild in a run:** copy `orpheus.sqlite` →
  `orpheus.sqlite.bak-<legacyVersion>` via better-sqlite3 `.backup()`, before any
  destructive op. Retained until the next clean boot.
- **Transaction-wrap + verify:** every table reconciliation and every data step runs in a
  transaction; rebuilds assert pre/post row-count equality and roll back on mismatch.
- **Dry-run diff logging:** the computed plan (ordered list of ops: addColumn / dropColumn /
  addIndex / dropIndex / createTable / rebuildTable / dataStep) is written to
  `diagnostics_events` (category `db.migrate`) **before** execution, every boot.
- **No `catch {}`:** errors propagate and fail loud.

## Error handling

- Any reconciliation or data-step error throws; its transaction rolls back; the backup
  (if a rebuild had started) remains on disk for recovery.
- A second `engine.sync()` in the same boot must produce an **empty plan** (idempotency
  invariant) — asserted by the verification harness.

## Verification (no shipped tests)

A throwaway harness under `scripts/` (run via `bun`/node against `better-sqlite3`
directly, **not** the app, **not** shipped):

1. Build synthetic DBs at several historical shapes — fresh, v21, v45, v64-branch-A,
   v64-branch-B, v65 — run the engine, assert each converges to an **identical** final
   normalized schema.
2. Assert the second run's computed plan is **empty** (idempotency).
3. Assert legacy data steps run exactly on the DBs that missed them (e.g. a v21 DB gets
   `legacy-status-remap` skipped but a v10 DB runs it).

## Implementation note (orchestration)

Per `CLAUDE.md`, the top-level agent orchestrates only. All code for `schema.ts`,
`engine.ts`, `data-steps.ts`, `index.ts`, and the verification harness is delegated to
**Sonnet** subagents; the orchestrator plans, reviews, and integrates.

## Open items for user review

1. **Synthesis vs. pure replace** for legacy data transforms (§ Decisions) — chosen
   synthesis while user was away; confirm or drop the ledger backfill.
2. **Structured columns vs. raw-SQL-only** schema format — chose structured; confirm.
