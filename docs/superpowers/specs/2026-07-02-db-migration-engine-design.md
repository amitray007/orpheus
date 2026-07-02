# Declarative DB Migration Engine — Design

**Date:** 2026-07-02
**Status:** Design (awaiting user review before planning)
**Area:** `src/main/db.ts` → `src/main/db/*`

## Problem

All schema lives in one ~2500-line imperative file (`src/main/db.ts`) driven by a
hand-rolled `schema_version` table and a linear `if (currentVersion < N) { … }`
ladder of 62 blocks. `CURRENT_VERSION` is 63 (highest block is `if (currentVersion < 63)`).
The model has six concrete failures:

1. **Double declaration.** Every column is declared twice — once in a
   `CREATE TABLE … IF NOT EXISTS` constant (for fresh installs) and once in an
   `ALTER TABLE … ADD COLUMN` block (for existing installs) — kept in sync by hand.
2. **Idempotency via `catch {}`.** Duplicate-column errors are swallowed, but so is
   *any other* error — a typo silently leaves a column missing.
3. **Integer versions are collision-prone under parallel branches.** Two branches that
   both add a migration under the same `if (currentVersion < N)` block will conflict on
   merge: whichever `CURRENT_VERSION` bump lands first makes the other block a no-op for
   any DB that already advanced past `N`, so its ALTERs never run. Recovering requires a
   later "convergence" block that re-applies both branches' ALTERs defensively. *(This is a
   structural hazard of monotonic-integer versioning, not a recorded incident — no such
   collision currently exists in `db.ts`; see "Correction" note below.)*
4. **Destructive DROPs need runtime healers.** `projects.archived_at` was dropped at v3
   but is still queried, so `healProjectsArchivedAt()` re-adds it on *every* boot,
   outside the version system.
5. **CHECK constraints can't evolve.** The `workspaces.status` CHECK silently drifted
   from the `WorkspaceStatus` enum, causing swallowed "CHECK constraint failed" errors.
   `healWorkspacesCheck()` fixes it with a hand-written table rebuild on every boot.
6. **No-op version bumps, inconsistent fresh-install guards, and general ~2500-line sprawl.**

> **Correction (post-review).** An earlier draft asserted `CURRENT_VERSION = 65`, a
> "64-block ladder", and a concrete "v64 parallel-branch collision → v65 convergence
> block" as a shipped incident. Verified against the source, the real file has
> `CURRENT_VERSION = 63`, 62 version blocks (highest `if (currentVersion < 63)`), and
> **no v64/v65 and no convergence block** — that narrative was a grounding error and has
> been corrected above. Failure #3 is retained as a genuine *structural* hazard of
> integer versioning, not as a recorded event. Both healers (`healProjectsArchivedAt`,
> `healWorkspacesCheck`) and the double-declaration / defensive-ALTER pattern **are** real
> and confirmed in the source.

## Goals

- **One source of truth per table.** No CREATE-constant + ALTER-block duplication.
- **No `catch {}` idempotency.** Errors are loud.
- **Collision-proof under parallel branches.** No integer version to collide.
- **Auto-heal drift** (CHECK changes, type changes, dropped/re-added columns) with a
  safe, automatic table rebuild — retiring both hand-written healers.
- **Adopt existing user DBs** (currently at `schema_version` 2–63) without data loss.

## Non-goals

- No new test runner (repo has none; CLAUDE.md forbids inventing one).
- No change to DB location, pragmas (WAL/foreign_keys/etc.), or the `getDb()` singleton lifecycle.
- No ORM. Plain `better-sqlite3` + structured table definitions.

## Decisions (from brainstorming)

| Choice | Decision |
| --- | --- |
| Core model | **Hybrid**: declarative schema auto-diff + ordered, tracked data steps. |
| SQLite-hard changes (CHECK/type/NOT NULL) | **Auto table-rebuild (full power)** — engine does the 12-step rebuild itself. |
| Cutover from old engine | **Full replace** — delete the 62-block ladder; engine diffs from any state. |
| Data-transform history (icon rename, JSON munging, seeds) | **Synthesis** *(recommended; user was away — veto at review)*: port the real data transforms into named data steps; seed the ledger from the old `schema_version` so ancient DBs still run the ones they missed. |
| Schema format | **Structured columns** *(recommended; user was away — veto at review)* with a raw-SQL escape hatch, so `enumCheck` and clean drift-detection work. |
| Safety rails | **Auto-backup before rebuild**, **transaction-wrap + verify row counts**, **dry-run diff logging to diagnostics**. Auto-drop of removed columns is **not allowed** *(changed post-review)*: a live column absent from `schema.ts` is left in place by default (FYI-logged); it is only dropped when explicitly listed in a table's `dropColumns: [...]` array. Silent auto-DROP was flagged as pure downside — a `schema.ts` typo would otherwise cause silent data loss (only 2 DROPs occurred across 62 historical versions). |

## Scope & alternatives considered

**Do-nothing / minimal-fix baseline.** The current imperative system works today, but
it's fragile: it can break on any future schema change that needs a CHECK or type
evolution, and the healer pattern (`healProjectsArchivedAt`, `healWorkspacesCheck`) is
reactive — each healer was added only after a break was observed in production, not
ahead of it. The declarative engine is chosen to make that whole class of break
structurally impossible, not merely to reduce line count. This is the user's stated
rationale: "the current one works but can break at any point."

**Full rewrite vs. freezing a v63 baseline.** Full-replace (delete the 62-block ladder,
diff from any state) was chosen over freezing a v63 baseline and building forward from
there, because the double-declaration and `catch{}`-idempotency problems live in the
*fresh-install* `CREATE TABLE` path too — a baseline-freeze would leave the fresh-install
path exactly as fragile as it is today, so it wouldn't actually fix failures #1 and #2.

**Build vs. use.** Off-the-shelf better-sqlite3 migration/declarative-diff libraries have
**not** yet been formally evaluated. This is flagged as an open item to resolve during
planning: does an existing library deliver declarative diff + auto-rebuild +
versionless ordering with less bespoke code than the hand-built normalized-SQL differ
described here? No conclusion is asserted either way — this is recorded as a deliberate
open question so the build-vs-use choice is a decision, not a default.

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
     Live-but-not-desired → **left in place by default** (logged as an FYI in the plan,
     not dropped); dropped **only** when the table def explicitly lists the column in a
     `dropColumns: [...]` array (then guarded by backup + verify, same as any other
     destructive op). A column absent from `schema.ts` is never inferred to mean "drop
     it" — that would turn a `schema.ts` typo into silent data loss.
   - Compare **normalized table SQL** (constraints, CHECKs, NOT NULL, PK, FKs). If it
     differs in a way `ADD COLUMN` cannot express → **`rebuildTable`** (below).
   - Reconcile indexes (`PRAGMA index_list`): create missing, drop our extras (skip
     auto/PK indexes).
3. Each table's reconciliation runs in a transaction; row counts verified across rebuilds.

**Normalized comparison:** SQLite reformats stored SQL, so drift-detection compares a
*normalized* rendering (whitespace/quoting/case-insensitive on keywords) of the live
`sqlite_master.sql` against a normalized render of the desired def — not a raw string match.
Prefer **structural** comparison where practical — diffing `PRAGMA table_info`
(name/type/notnull/dflt_value/pk) plus parsed CHECK/FK metadata — over raw
normalized-string comparison, because SQLite stores `CREATE` text verbatim and
semantically-equal definitions can render differently (`INTEGER` vs `INT`, inline vs
table-level FK, CHECK parenthesization); a pure string normalizer risks false-positive
rebuilds every boot, reintroducing the healer-on-every-boot pattern.

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
their default; dropped columns (only those explicitly listed in `dropColumns`) are left
behind. This handles the `archived_at` drop/re-add mess and any CHECK/type change
automatically. If a dropped column participates in an index or CHECK constraint, the
dependent index/constraint must be dropped **before** the column — `dropIndex` ordered
ahead of `dropColumn` in the rebuild's generated plan.

**Rebuild data-safety contract:**

- A newly-added column that is `NOT NULL` with no `DEFAULT` is **rejected at
  schema-definition load time** (the engine throws a clear authoring error) — it must
  carry either a `default` or a named backfill expression, because the intersection-copy
  `INSERT` would otherwise populate it with NULL and SQLite throws
  `NOT NULL constraint failed`.
- When a rebuild is triggered by a **tightened CHECK** (or any constraint existing rows
  may violate), the table def may declare a per-table `normalizeOnRebuild` SQL expression
  (a `CASE`/coalesce mapping) that the rebuild applies in the `SELECT`, coercing legacy
  values to valid ones **before** they hit the new CHECK — mirroring exactly what
  `healWorkspacesCheck` does inline today (unknown legacy `status` values map to `idle`,
  archived stays archived). Without this, the auto-rebuild would throw
  `CHECK constraint failed` on the very drift it exists to fix.

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
  No integer to collide → the integer-version collision hazard (failure #3) cannot recur.

### 4. Cutover (full replace)

First boot on the new engine. Value-normalizing data steps that must precede a
CHECK-tightening rebuild are tagged `preRebuild: true` and run **before**
`engine.sync(db)` tightens the relevant table — otherwise the rebuild's new CHECK
rejects the very legacy rows the data step exists to fix:

1. Detect legacy state: read the old `schema_version` row if the table exists
   (`legacyVersion`), else treat as fresh.
2. **Seed the data-step ledger:** for each data step, if `legacyVersion >=
   step.legacyThroughVersion`, mark it already-applied (that transform ran under the old
   ladder); otherwise leave it unapplied so `runDataSteps` runs it. Fresh installs
   (`legacyVersion` absent) mark **all** legacy steps applied (fresh schema already correct).
3. **Run unapplied `preRebuild` data steps.** Canonical case: `legacy-status-remap`
   (`in_review`→`awaiting_input`) must run before the `workspaces.status` CHECK
   tightens, or the rebuild rejects pre-v28 rows.
4. `engine.sync(db)` — converge the schema by diff from whatever shape the DB has.
5. `runDataSteps(db)` — run whatever remains unapplied (the non-`preRebuild` steps).
6. Drop the `schema_version` table. Delete both healers (`healProjectsArchivedAt`,
   `healWorkspacesCheck`) — their jobs are now the reconciler's.

## Safety rails

- **Backup before first rebuild in a run:** snapshot `orpheus.sqlite` →
  `orpheus.sqlite.bak-<legacyVersion>` via `VACUUM INTO '<backup-path>'` — a single
  **synchronous** statement that safely snapshots a live WAL database — before any
  destructive op. `getDb()`/`migrate()` run synchronously at startup (no `await` is
  possible on that path), so better-sqlite3's `.backup()` is **rejected**: it returns a
  `Promise` and cannot be used here. `fs.copyFileSync` is also rejected — it's unsafe on
  a live WAL database (uncheckpointed `-wal` frames would be missing from the copy).
- **Backup lifetime + cleanup:** the `.bak-*` file contains **plaintext auth secrets**
  (`auth_api_key`, `auth_token`, etc. in `claude_global_settings`), so its lifetime is
  explicitly bounded. Define a **clean boot** as `engine.sync()` completing with an
  empty second-pass plan and no error. On a clean boot, delete the prior run's `.bak-*`
  file(s). Additionally, run a startup sweep that removes any orphaned `.bak-*` older
  than a small bound (e.g. 3 boots or 7 days) regardless of crash history, so a
  repeatedly-failing boot cannot leave secrets on disk forever.
- **Transaction-wrap + verify:** every table reconciliation and every data step runs in a
  transaction; rebuilds assert pre/post row-count equality and roll back on mismatch.
- **Dry-run diff logging:** the computed plan (ordered list of ops: addColumn / dropColumn /
  addIndex / dropIndex / createTable / rebuildTable / dataStep) is written to
  `diagnostics_events` (category `db.migrate`) **before** execution, every boot. Logged
  ops contain **only structural metadata** — `{ table, kind, columns[], rowCount }` —
  **never** cell/column values, so plaintext secrets from `claude_global_settings` can't
  land in the long-retained `diagnostics_events` table. This follows the repo's existing
  precedent of redacting secrets from log lines (`SECRET_KEYS` in `terminal:mount`).
- **Column drops are explicit, never automatic:** a live column absent from the desired
  schema is **left in place by default** (logged as an FYI in the plan) and is only
  dropped when the table def explicitly lists it in a `dropColumns: [...]` array — see
  the `engine.ts` reconciler section above.
- **No `catch {}`:** errors propagate and fail loud.

## Error handling

- Any reconciliation or data-step error throws; its transaction rolls back; the backup
  (if a rebuild had started) remains on disk for recovery.
- A second `engine.sync()` in the same boot must produce an **empty plan** (idempotency
  invariant) — asserted by the verification harness.

## Verification (no shipped tests)

A throwaway harness under `scripts/` (run via `bun`/node against `better-sqlite3`
directly, **not** the app, **not** shipped):

1. Build synthetic DBs at several **real** historical shapes — fresh, v21, v28, v45, v55,
   v63 — run the engine, assert each converges to an **identical** final normalized schema.
   (These are actual shipped `schema_version` values; there is no v64/v65.)
2. Assert the second run's computed plan is **empty** (idempotency).
3. Assert legacy data steps run exactly on the DBs that missed them (e.g. a v28+ DB gets
   `legacy-status-remap` skipped but a v21 DB runs it).

## Implementation note (orchestration)

Per `CLAUDE.md`, the top-level agent orchestrates only. All code for `schema.ts`,
`engine.ts`, `data-steps.ts`, `index.ts`, and the verification harness is delegated to
**Sonnet** subagents; the orchestrator plans, reviews, and integrates.

## Open items for user review

1. **Synthesis vs. pure replace** (legacy data transforms) and **structured columns vs.
   raw-SQL-only** (schema format) are both **confirmed** by the user — keep synthesis
   (ledger backfill from `schema_version`), keep structured columns with the raw-SQL
   escape hatch. No longer open.
2. **Build vs. use** (§ Scope & alternatives considered): formally evaluate off-the-shelf
   migration/declarative-diff libraries for `better-sqlite3` during planning, before
   committing to the hand-built normalized-SQL differ.
