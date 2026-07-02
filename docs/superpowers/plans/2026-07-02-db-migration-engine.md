# Declarative DB Migration Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the imperative 2409-line `src/main/db.ts` migration ladder with a declarative, synchronous, in-process migration engine that diffs a single-source-of-truth schema against the live DB and reconciles it (incl. auto table-rebuild), plus a named run-once data-step ledger.

**Architecture:** A new `src/main/db/` directory splits responsibility across `schema.ts` (desired state, one declaration per table), `engine.ts` (introspect → diff → plan → execute reconciler, incl. the SQLite 12-step rebuild), `data-steps.ts` (ordered, named, run-once data transforms + ledger), and `index.ts` (the `getDb()` singleton + pragmas, unchanged in behavior, calling the engine). Cutover is full-replace: the 62-block ladder and both boot-time healers are deleted; the engine converges any DB from `schema_version` 2–63.

**Tech Stack:** TypeScript, `better-sqlite3` v12 (synchronous), Electron 39 main process, `bun` for the verification harness. No ORM, no query builder, no new runtime dependency — the engine is hand-built (see the build-vs-use decision in the spec).

## Global Constraints

- **Source spec (authoritative):** `docs/superpowers/specs/2026-07-02-db-migration-engine-design.md`. Read it before starting.
- **Synchronous only.** The engine runs inside `getDb()` → `migrate()`, called synchronously from `src/main/index.ts:2399` before any IPC fires. No `async`/`await`/Promises anywhere in the boot path. This rules out `db.backup()` (returns a Promise) — use `VACUUM INTO`.
- **better-sqlite3 native ABI.** Built against the installed Electron ABI. The verification harness cannot run under system node; it runs via `bun run` against the Electron-built module, or asserts against a freshly compiled better-sqlite3.
- **`CURRENT_VERSION` is 63.** The real `db.ts` has 62 version blocks (highest `if (currentVersion < 63)`). There is **no v64/v65**. Do not invent versions.
- **Pragmas unchanged:** `journal_mode=WAL`, `foreign_keys=ON`, `synchronous=NORMAL`, `cache_size=-8000`, `mmap_size=268435456`, `temp_store=MEMORY` (`db.ts:398-403`).
- **Plaintext secrets by design.** `claude_global_settings` holds `auth_api_key`/`auth_token`/etc. in plaintext (per CLAUDE.md). Backups and diagnostics logging must respect this: bound backup lifetime, and log **only** structural metadata (`{table, kind, columns[], rowCount}`), never cell values.
- **No shipped tests.** The repo has no test runner. The verification harness lives under `scripts/`, is run manually, and is **not** bundled (verify it's outside `electron-builder.yml`'s `files`).
- **Orchestration rule (CLAUDE.md):** all hands-on code is written by Sonnet subagents; the orchestrator plans, reviews, integrates.
- **Commits:** Conventional Commits, no emoji, no `Co-Authored-By`. Prefix `feat(db):` / `refactor(db):` / `test(db):`.
- **Do not build the app between tasks** unless a task says to. A full `bun run build:unpack` is reserved for the final integration task.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/main/db/types.ts` | Shared engine types: `SchemaDef`, `TableDef`, `ColumnDef`, `IndexDef`, `DataStep`, `PlanOp`. No logic. |
| `src/main/db/render.ts` | Pure functions: render a `TableDef` → canonical `CREATE TABLE` SQL; `enumCheck(col, values)`; render index SQL. No DB access. |
| `src/main/db/introspect.ts` | Read live DB state via `PRAGMA table_info`, `PRAGMA index_list`, `sqlite_master`. Returns structural descriptors. No mutation. |
| `src/main/db/diff.ts` | Pure: given desired `TableDef` + live descriptors, compute the ordered `PlanOp[]` (addColumn / rebuildTable / addIndex / dropIndex / createTable / dropColumn). No DB access. |
| `src/main/db/rebuild.ts` | The SQLite 12-step table rebuild (create `__new`, copy with `normalizeOnRebuild`, drop, rename, recreate indexes), transaction-wrapped + row-count verify. |
| `src/main/db/backup.ts` | `VACUUM INTO` snapshot before first destructive op; clean-boot deletion; orphan sweep. |
| `src/main/db/engine.ts` | `sync(db)`: orchestrates introspect → diff → (backup?) → execute; logs the plan to diagnostics first. |
| `src/main/db/data-steps.ts` | The `dataSteps` array (ported legacy transforms), the `applied_data_steps` ledger, `runDataSteps(db)`, and ledger-seed-from-legacy-version. |
| `src/main/db/schema.ts` | The desired-state `schema: SchemaDef` — every table + index declared once. Derived from the current `db.ts` CREATE blocks. |
| `src/main/db/cutover.ts` | First-boot legacy detection, ordering (`preRebuild` steps → `sync` → remaining steps), `schema_version` drop. |
| `src/main/db/index.ts` | `getDb()` singleton + pragmas + `migrate(db)` entry that calls cutover/engine/data-steps. Replaces the current `db.ts` public surface. |
| `src/main/db.ts` | **Deleted** at cutover (Task 12); its exports re-exported from `src/main/db/index.ts` so importers are unaffected. |
| `scripts/verify-migration-engine.ts` | Throwaway harness: build synthetic DBs at real historical shapes, assert convergence + idempotency + data-step correctness. |

**Import-compatibility rule:** every symbol currently exported from `src/main/db.ts` (notably `getDb`, `migrate`, and any record types) must be re-exported from `src/main/db/index.ts` with identical signatures, so the ~dozen call sites (`workspaces.ts`, `claudeSettings.ts`, `sessions.ts`, `index.ts`, etc.) need zero changes. Task 1 captures the current export surface.

---

## Task 0: Capture the current export + schema surface (no code change)

**Files:**
- Read: `src/main/db.ts` (full)
- Create: `docs/superpowers/plans/_db-surface.md` (scratch reference, committed)

**Interfaces:**
- Produces: `_db-surface.md` — the exact list of (a) every symbol `export`ed from `db.ts`, with its signature; (b) every table name + its full column list copied verbatim from each `CREATE TABLE` block; (c) every `CREATE INDEX` statement verbatim; (d) the exact SQL of the 5 real data transforms (v16 blob clear, v21 status backfill, v28 status remap, v45 icon rename + ICON_MIGRATIONS array, v46–49 footer seed reconciliation).

- [ ] **Step 1: Extract exports**

Run and record every match:
```bash
grep -nE "^export (function|const|type|interface|class)" src/main/db.ts
```
Record each symbol + signature in `_db-surface.md` under `## Exports`.

- [ ] **Step 2: Extract every CREATE TABLE block verbatim**

For each table (`schema_version`, `projects`, `sessions`, `workspaces`, `claude_global_settings`, `claude_project_settings`, `claude_workspace_settings`, `app_ui_state`, `action_audit_log`, `diagnostics_events`, `footer_actions_global`, `footer_actions_project`, `footer_actions_workspace`, `keep_awake_settings`), copy the full `CREATE TABLE IF NOT EXISTS …` text (the fresh-install constant, NOT the ALTER blocks) into `_db-surface.md` under `## Tables`. These constants are the authoritative desired state.

- [ ] **Step 3: Extract every CREATE INDEX verbatim**

```bash
grep -nE "CREATE (UNIQUE )?INDEX" src/main/db.ts
```
Copy each full statement into `## Indexes`.

- [ ] **Step 4: Extract the 5 real data transforms verbatim**

Copy the exact SQL (and surrounding JS, e.g. the `ICON_MIGRATIONS` array at `db.ts:1779` and the footer reconciliation logic in the v46–v49 blocks) into `## DataTransforms`, each labeled with its origin version number. These become the `dataSteps` in Task 9.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/_db-surface.md
git commit -m "docs(db): capture current db.ts export + schema surface for migration engine"
```

---

## Task 1: Engine types + `render.ts` (pure, testable)

**Files:**
- Create: `src/main/db/types.ts`, `src/main/db/render.ts`
- Test: `scripts/verify-migration-engine.ts` (start it here with a `render` test section)

**Interfaces:**
- Produces:
  - `type ColumnDef = string | { type: string; notNull?: boolean; default?: string; check?: string; primaryKey?: boolean }`
  - `type IndexDef = string[] | { columns: string[]; where?: string; unique?: boolean }`
  - `interface TableDef { columns: Record<string, ColumnDef>; foreignKeys?: Array<{ columns: string[]; ref: string; onDelete?: string }>; indexes?: Record<string, IndexDef>; dropColumns?: string[]; normalizeOnRebuild?: Record<string, string> }`
  - `type SchemaDef = Record<string, TableDef>`
  - `function enumCheck(col: string, values: readonly string[]): string` → `CHECK (col IN ('a','b',…))`
  - `function renderCreateTable(name: string, def: TableDef): string`
  - `function renderIndex(table: string, name: string, def: IndexDef): string`

- [ ] **Step 1: Write the failing test** (append to `scripts/verify-migration-engine.ts`)

```ts
import assert from 'node:assert'
import { enumCheck, renderCreateTable } from '../src/main/db/render'

// enumCheck renders a canonical IN(...) clause from a shared array
assert.equal(
  enumCheck('status', ['idle', 'archived'] as const),
  "CHECK (status IN ('idle', 'archived'))",
)

// renderCreateTable produces deterministic SQL from a structured def
const sql = renderCreateTable('workspaces', {
  columns: {
    id: 'TEXT PRIMARY KEY',
    project_id: 'TEXT NOT NULL',
    status: { type: 'TEXT', notNull: true, default: "'idle'", check: enumCheck('status', ['idle', 'archived']) },
  },
  foreignKeys: [{ columns: ['project_id'], ref: 'projects(id)', onDelete: 'CASCADE' }],
})
assert.ok(sql.startsWith('CREATE TABLE workspaces ('), sql)
assert.ok(sql.includes("status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'archived'))"), sql)
assert.ok(sql.includes('FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE'), sql)
console.log('✓ render')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun scripts/verify-migration-engine.ts`
Expected: FAIL — cannot resolve `../src/main/db/render`.

- [ ] **Step 3: Write `types.ts`**

Define the types listed in Interfaces above. Types only, no logic.

- [ ] **Step 4: Write `render.ts`**

Implement `enumCheck`, `renderCreateTable`, `renderIndex`. A structured column renders as `type [NOT NULL] [DEFAULT x] [CHECK (...)]`; a string column renders verbatim. Column order = insertion order of the `columns` object. Foreign keys render as table-level `FOREIGN KEY (...) REFERENCES ...` clauses after the columns. Keep output single-spaced and deterministic (this is the canonical form the differ compares against).

- [ ] **Step 5: Run test to verify it passes**

Run: `bun scripts/verify-migration-engine.ts`
Expected: `✓ render`

- [ ] **Step 6: Commit**

```bash
git add src/main/db/types.ts src/main/db/render.ts scripts/verify-migration-engine.ts
git commit -m "feat(db): engine types + canonical schema rendering"
```

---

## Task 2: `introspect.ts` — read live DB structural state

**Files:**
- Create: `src/main/db/introspect.ts`
- Test: `scripts/verify-migration-engine.ts` (add an `introspect` section)

**Interfaces:**
- Consumes: `better-sqlite3` `Database`.
- Produces:
  - `interface LiveColumn { name: string; type: string; notNull: boolean; dflt: string | null; pk: boolean }`
  - `interface LiveTable { name: string; columns: LiveColumn[]; createSql: string; indexes: LiveIndex[] }`
  - `interface LiveIndex { name: string; sql: string | null; auto: boolean }`
  - `function introspectTable(db, name): LiveTable | null` (null if table absent)
  - `function listTables(db): string[]`

- [ ] **Step 1: Write the failing test**

```ts
import Database from 'better-sqlite3'
import { introspectTable } from '../src/main/db/introspect'

const db = new Database(':memory:')
db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0)")
db.exec("CREATE INDEX t_n_idx ON t(n)")
const live = introspectTable(db, 't')!
assert.equal(live.columns.length, 2)
assert.equal(live.columns[0].name, 'id')
assert.equal(live.columns[0].pk, true)
assert.equal(live.columns[1].notNull, true)
assert.equal(live.columns[1].dflt, '0')
assert.ok(live.indexes.some((i) => i.name === 't_n_idx' && !i.auto))
assert.equal(introspectTable(db, 'missing'), null)
console.log('✓ introspect')
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun scripts/verify-migration-engine.ts`
Expected: FAIL — cannot resolve `introspect`.

- [ ] **Step 3: Implement `introspect.ts`**

`introspectTable` reads `SELECT sql FROM sqlite_master WHERE type='table' AND name=?` (null → return null), `PRAGMA table_info(name)` (map `notnull`→boolean, `dflt_value`→`dflt`, `pk`→boolean), and `PRAGMA index_list(name)` + `SELECT sql FROM sqlite_master WHERE type='index' AND name=?` for each (an index is `auto` when its `origin` from `index_list` is `'pk'` or `'u'`/`'c'` with a null sql, i.e. auto-created; treat `sql === null` as auto). `listTables` = `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`.

- [ ] **Step 4: Run to verify it passes** — Expected: `✓ introspect`

- [ ] **Step 5: Commit**

```bash
git add src/main/db/introspect.ts scripts/verify-migration-engine.ts
git commit -m "feat(db): live-DB structural introspection"
```

---

## Task 3: `diff.ts` — compute the reconciliation plan

**Files:**
- Create: `src/main/db/diff.ts`
- Test: `scripts/verify-migration-engine.ts` (add a `diff` section)

**Interfaces:**
- Consumes: `TableDef` (Task 1), `LiveTable` (Task 2).
- Produces:
  - `type PlanOp = { kind: 'createTable'; table: string } | { kind: 'addColumn'; table: string; column: string } | { kind: 'dropColumn'; table: string; column: string } | { kind: 'rebuildTable'; table: string; reason: string } | { kind: 'addIndex'; table: string; index: string } | { kind: 'dropIndex'; table: string; index: string }`
  - `function diffTable(name: string, desired: TableDef, live: LiveTable | null): PlanOp[]`
  - **Structural comparison** (per spec): compare parsed column sets + normalized CHECK/FK metadata, NOT raw CREATE-text equality. A `rebuildTable` is emitted only when a change can't be expressed by `ADD COLUMN`/`ADD INDEX`: a CHECK/type/NOT-NULL/PK/FK difference on an existing column.
  - **Column-drop rule:** a live column absent from `desired.columns` is emitted as `dropColumn` **only** if it appears in `desired.dropColumns`; otherwise it is NOT dropped (log-only, no op).

- [ ] **Step 1: Write the failing test**

```ts
import { diffTable } from '../src/main/db/diff'

const desired = {
  columns: { id: 'TEXT PRIMARY KEY', n: 'INTEGER', extra: 'TEXT' },
}
// live is missing `extra` → addColumn
const live = {
  name: 't', createSql: 'CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)',
  columns: [
    { name: 'id', type: 'TEXT', notNull: false, dflt: null, pk: true },
    { name: 'n', type: 'INTEGER', notNull: false, dflt: null, pk: false },
  ],
  indexes: [],
}
const ops = diffTable('t', desired, live)
assert.deepEqual(ops, [{ kind: 'addColumn', table: 't', column: 'extra' }])

// missing table → createTable
assert.deepEqual(diffTable('t', desired, null), [{ kind: 'createTable', table: 't' }])

// live has a stray column NOT in dropColumns → no op
const desired2 = { columns: { id: 'TEXT PRIMARY KEY' } }
const live2 = { ...live, columns: [live.columns[0], { name: 'gone', type: 'TEXT', notNull: false, dflt: null, pk: false }] }
assert.deepEqual(diffTable('t', desired2, live2), [])

// same, but with dropColumns → dropColumn op
const desired3 = { columns: { id: 'TEXT PRIMARY KEY' }, dropColumns: ['gone'] }
assert.deepEqual(diffTable('t', desired3, live2), [{ kind: 'dropColumn', table: 't', column: 'gone' }])
console.log('✓ diff')
```

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL, cannot resolve `diff`.

- [ ] **Step 3: Implement `diff.ts`**

`diffTable`: if `live === null` → `[{kind:'createTable',table}]`. Else: for each desired column absent from live → `addColumn`; for each live column absent from desired → `dropColumn` iff in `desired.dropColumns`, else skip. Detect rebuild-triggering drift by comparing, for each shared column, `notNull`/`type`/`pk`, and by comparing normalized CHECK + FK metadata parsed from `live.createSql` vs the desired def — if any differ, emit a single `rebuildTable` with a human `reason` (e.g. `"status CHECK differs"`) and suppress the per-column add/drop ops for that table (the rebuild handles them). Index diff: desired indexes absent from live → `addIndex`; our non-auto live indexes absent from desired → `dropIndex`.

- [ ] **Step 4: Run to verify it passes** — Expected: `✓ diff`

- [ ] **Step 5: Commit**

```bash
git add src/main/db/diff.ts scripts/verify-migration-engine.ts
git commit -m "feat(db): schema diff → reconciliation plan"
```

---

## Task 4: `rebuild.ts` — the SQLite 12-step table rebuild

**Files:**
- Create: `src/main/db/rebuild.ts`
- Test: `scripts/verify-migration-engine.ts` (add a `rebuild` section — this is the load-bearing correctness test)

**Interfaces:**
- Consumes: `Database`, desired `TableDef`, rendered CREATE SQL (Task 1), `LiveTable` (Task 2).
- Produces: `function rebuildTable(db, name: string, desired: TableDef, live: LiveTable): void`
- Behavior mirrors the real `healWorkspacesCheck` (`db.ts:2333`): `foreign_keys=OFF`, transaction, `CREATE <name>__new (...desired...)`, `INSERT INTO __new (shared) SELECT <mapped> FROM <name>`, row-count assert, drop, rename, recreate indexes, `foreign_keys=ON` in `finally`.
- **`normalizeOnRebuild` contract:** for each column with a `desired.normalizeOnRebuild[col]` expression, the `SELECT` uses that expression instead of the bare column (this is how legacy CHECK-violating values are coerced — exactly the `CASE` the healer uses for `status`). Columns without an entry copy verbatim.
- **NOT-NULL guard:** a desired column that is NOT NULL, absent from live, and has no `default` and no `normalizeOnRebuild` entry → throw a clear authoring error BEFORE running (the copy would insert NULL).

- [ ] **Step 1: Write the failing test** (reproduces the real workspaces status case)

```ts
import { rebuildTable } from '../src/main/db/rebuild'
import { introspectTable } from '../src/main/db/introspect'

const db = new Database(':memory:')
db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY)")
db.exec("INSERT INTO projects VALUES ('p1')")
// old workspaces with a legacy CHECK that allows 'in_review'
db.exec(`CREATE TABLE workspaces (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle'
    CHECK (status IN ('in_progress','in_review','idle','archived')))`)
db.exec("INSERT INTO workspaces VALUES ('w1','p1','in_review'), ('w2','p1','idle')")

const desired = {
  columns: {
    id: 'TEXT PRIMARY KEY',
    project_id: 'TEXT NOT NULL',
    status: { type: 'TEXT', notNull: true, default: "'idle'",
      check: "CHECK (status IN ('in_progress','awaiting_input','attention','idle','archived'))" },
  },
  normalizeOnRebuild: {
    // coerce legacy values the new CHECK rejects — mirrors healWorkspacesCheck
    status: "CASE WHEN status IN ('in_progress','awaiting_input','attention','idle','archived') THEN status ELSE 'idle' END",
  },
}
const live = introspectTable(db, 'workspaces')!
rebuildTable(db, 'workspaces', desired, live)

const rows = db.prepare('SELECT id, status FROM workspaces ORDER BY id').all()
assert.deepEqual(rows, [{ id: 'w1', status: 'idle' }, { id: 'w2', status: 'idle' }]) // in_review → idle
assert.equal(db.prepare('SELECT COUNT(*) c FROM workspaces').get().c, 2) // row count preserved
console.log('✓ rebuild')
```

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL, cannot resolve `rebuild`.

- [ ] **Step 3: Implement `rebuild.ts`** per the Interfaces contract. Use `renderCreateTable` (Task 1) to produce the `__new` body (rename `name`→`name__new` in the emitted SQL). Build the `INSERT … SELECT` from the intersection of live+desired columns, substituting `normalizeOnRebuild` expressions. Assert `SELECT COUNT(*)` equality before `DROP`; throw on mismatch (transaction rolls back). Recreate indexes from `desired.indexes`.

- [ ] **Step 4: Run to verify it passes** — Expected: `✓ rebuild`

- [ ] **Step 5: Commit**

```bash
git add src/main/db/rebuild.ts scripts/verify-migration-engine.ts
git commit -m "feat(db): SQLite 12-step table rebuild with normalizeOnRebuild"
```

---

## Task 5: `backup.ts` — synchronous VACUUM INTO + lifetime bound

**Files:**
- Create: `src/main/db/backup.ts`
- Test: `scripts/verify-migration-engine.ts` (add a `backup` section)

**Interfaces:**
- Produces:
  - `function backupBefore(db, dbPath: string, legacyVersion: number): string` — runs `VACUUM INTO '<dbPath>.bak-<legacyVersion>'` (synchronous), returns the backup path. Idempotent within a run (no-op if already taken).
  - `function onCleanBoot(dbPath: string): void` — deletes the prior run's `.bak-*` files.
  - `function sweepOrphans(dbPath: string, maxAgeDays = 7): void` — removes any `.bak-*` older than `maxAgeDays`.
- Rationale (from spec): `.bak` holds plaintext secrets; `db.backup()` is async (rejected); `fs.copyFileSync` is unsafe on live WAL. `VACUUM INTO` is one synchronous statement, WAL-safe.

- [ ] **Step 1: Write the failing test**

```ts
import { backupBefore } from '../src/main/db/backup'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'))
const dbPath = path.join(dir, 'orpheus.sqlite')
const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.exec("CREATE TABLE t (id TEXT); INSERT INTO t VALUES ('x')")
const bak = backupBefore(db, dbPath, 63)
assert.ok(fs.existsSync(bak), 'backup file exists')
const bdb = new Database(bak, { readonly: true })
assert.equal(bdb.prepare('SELECT COUNT(*) c FROM t').get().c, 1) // backup has the row
console.log('✓ backup')
```

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL, cannot resolve `backup`.

- [ ] **Step 3: Implement `backup.ts`.** `backupBefore` builds the path, guards a module-level `Set` of paths already backed up this run, runs `db.exec("VACUUM INTO '" + escaped + "'")` (escape single quotes in the path), returns the path. `onCleanBoot` and `sweepOrphans` use `fs.readdirSync` on the dir, filter by the `.bak-*` prefix, and `fs.rmSync`/mtime-check respectively.

- [ ] **Step 4: Run to verify it passes** — Expected: `✓ backup`

- [ ] **Step 5: Commit**

```bash
git add src/main/db/backup.ts scripts/verify-migration-engine.ts
git commit -m "feat(db): synchronous VACUUM INTO backup with lifetime bound"
```

---

## Task 6: `engine.ts` — sync orchestration + diagnostics logging

**Files:**
- Create: `src/main/db/engine.ts`
- Modify: reference `diagnostics` insert (see `src/main/diagnostics.ts` for the `db.migrate` category convention)
- Test: `scripts/verify-migration-engine.ts` (add an `engine` section)

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces:
  - `function planSync(db, schema: SchemaDef): PlanOp[]` — introspect every desired table, diff, return the concatenated ordered plan (createTable/addColumn first, rebuildTable, then index ops; dropIndex before dropColumn within a table).
  - `function sync(db, schema: SchemaDef, opts: { dbPath: string; legacyVersion: number; log?: (op: PlanOp) => void }): void` — computes the plan, logs each op as structural metadata (`{table, kind}` only — NEVER cell values) via `opts.log`, backs up before the first destructive op (rebuildTable/dropColumn), executes each op in a transaction, verifies rebuilds.
- **Idempotency invariant:** a second `sync` immediately after a first must produce an empty plan (`planSync` returns `[]`).

- [ ] **Step 1: Write the failing test** (idempotency + convergence on a toy schema)

```ts
import { sync, planSync } from '../src/main/db/engine'

const db = new Database(':memory:')
const schema = {
  projects: { columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL' },
    indexes: { projects_name_idx: ['name'] } },
}
sync(db, schema, { dbPath: ':memory:', legacyVersion: 0 })
// table + index now exist
assert.ok(introspectTable(db, 'projects'))
// second plan is empty → idempotent
assert.deepEqual(planSync(db, schema), [])
console.log('✓ engine')
```

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL, cannot resolve `engine`.

- [ ] **Step 3: Implement `engine.ts`** per Interfaces. Skip `backupBefore` when `dbPath === ':memory:'` or `legacyVersion === 0` (fresh). Ordering within `planSync`: group ops so `createTable` and `addColumn` run before `rebuildTable`, and `dropIndex` precedes `dropColumn` for the same table.

- [ ] **Step 4: Run to verify it passes** — Expected: `✓ engine`

- [ ] **Step 5: Commit**

```bash
git add src/main/db/engine.ts scripts/verify-migration-engine.ts
git commit -m "feat(db): reconciler orchestration with structural-only plan logging"
```

---

## Task 7: `schema.ts` — port the full desired state from db.ts

**Files:**
- Create: `src/main/db/schema.ts`
- Read: `docs/superpowers/plans/_db-surface.md` (Task 0), `src/main/db.ts`
- Test: `scripts/verify-migration-engine.ts` (add a `schema-fresh` section)

**Interfaces:**
- Produces: `export const schema: SchemaDef` covering **all** tables from Task 0 (`projects`, `sessions`, `workspaces`, `claude_global_settings`, `claude_project_settings`, `claude_workspace_settings`, `app_ui_state`, `action_audit_log`, `diagnostics_events`, `footer_actions_global/project/workspace`, `keep_awake_settings`). Exclude `schema_version` (retired) and any `__new`/`handles` scratch tables. Shared enum arrays (`WORKSPACE_STATUS`, `SESSION_STATUS`, `KEEP_AWAKE_MODE`, etc.) exported for reuse by app code.
- Each table's columns + indexes are transcribed from its `CREATE TABLE`/`CREATE INDEX` constant in `_db-surface.md`. Enum CHECKs use `enumCheck(...)` from Task 1. Tables that had a CHECK-drift history (`workspaces.status`, `sessions.status`, `keep_awake_settings.mode`) also get a `normalizeOnRebuild` entry coercing legacy→valid (copy the `CASE` shape from `healWorkspacesCheck`).

- [ ] **Step 1: Write the failing test** (fresh-install convergence: engine + schema on an empty DB must reproduce the real fresh schema)

```ts
import { schema } from '../src/main/db/schema'
import { sync, planSync } from '../src/main/db/engine'

const db = new Database(':memory:')
sync(db, schema, { dbPath: ':memory:', legacyVersion: 0 })
// every declared table exists
for (const t of Object.keys(schema)) assert.ok(introspectTable(db, t), `missing ${t}`)
// idempotent on a fresh build
assert.deepEqual(planSync(db, schema), [], 'fresh build must be idempotent')
console.log('✓ schema-fresh')
```

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL, cannot resolve `schema` (or missing tables).

- [ ] **Step 3: Implement `schema.ts`** by transcribing every table from `_db-surface.md`. This is the largest mechanical task (claude_global_settings ~150 columns). Work table-by-table; after each, re-run the test to catch drift early. **Any column whose CHECK the differ would flag against the real fresh table must render identically** — the idempotency assert is the guard.

- [ ] **Step 4: Run to verify it passes** — Expected: `✓ schema-fresh`

- [ ] **Step 5: Commit**

```bash
git add src/main/db/schema.ts scripts/verify-migration-engine.ts
git commit -m "feat(db): declarative desired-state schema ported from db.ts"
```

---

## Task 8: Convergence test against real legacy shapes

**Files:**
- Modify: `scripts/verify-migration-engine.ts` (add a `convergence` section)
- Read: `src/main/db.ts` (to build legacy fixtures using the OLD migrate())

**Interfaces:**
- Consumes: the old `migrate()` (still present until Task 12) to synthesize real historical DBs; the new `sync` + `schema`.
- Produces: a test that builds a DB at each real historical shape and asserts the new engine converges it to the same normalized schema as a fresh build, with an empty second plan.

- [ ] **Step 1: Write the failing/period test**

```ts
// Build a fresh reference schema via the new engine
const ref = new Database(':memory:'); sync(ref, schema, { dbPath: ':memory:', legacyVersion: 0 })
const refShape = normalizedShape(ref) // helper: sorted table_info + index sql for all tables

// For each real legacy version, build a DB stuck at that shape using the OLD migrate(),
// then run the NEW engine and assert convergence.
for (const v of [21, 28, 45, 55, 63]) {
  const d = new Database(':memory:')
  buildLegacyAt(d, v)               // helper: run old migrate() but stop at version v (seed schema_version=v with partial ladder)
  sync(d, schema, { dbPath: ':memory:', legacyVersion: v })
  assert.deepEqual(normalizedShape(d), refShape, `v${v} did not converge`)
  assert.deepEqual(planSync(d, schema), [], `v${v} not idempotent after converge`)
}
console.log('✓ convergence')
```

- [ ] **Step 2: Implement the `normalizedShape` + `buildLegacyAt` helpers** in the harness. `normalizedShape` returns, per table, the sorted `PRAGMA table_info` rows + sorted index `sql` from `sqlite_master`. `buildLegacyAt` imports the old `db.ts` `migrate` and drives it against a DB whose `schema_version` is seeded so only blocks `< v` have run (simplest: run the full old `migrate`, which lands at 63; for lower v, construct the DB by running old migrate then dropping/renaming to simulate — OR, pragmatically, assert convergence only for the terminal v=63 shape plus a hand-built v21 and v28 fixture carrying `in_review` status rows to exercise `normalizeOnRebuild`). Document whichever approach is used.

- [ ] **Step 3: Run** — Expected: `✓ convergence`. If a table fails to converge, the divergence is in `schema.ts` (Task 7) — fix there.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-migration-engine.ts
git commit -m "test(db): convergence from real legacy shapes + normalizeOnRebuild"
```

---

## Task 9: `data-steps.ts` — ledger + ported transforms

**Files:**
- Create: `src/main/db/data-steps.ts`
- Read: `_db-surface.md` `## DataTransforms` (Task 0)
- Test: `scripts/verify-migration-engine.ts` (add a `data-steps` section)

**Interfaces:**
- Produces:
  - `interface DataStep { name: string; legacyThroughVersion: number; preRebuild?: boolean; run: (db: Database) => void }`
  - `export const dataSteps: DataStep[]` — the real transforms, each with its correct origin version as `legacyThroughVersion`: `blob-clear` (v16), `workspace-status-backfill` (v21, `preRebuild: true`), `workspace-status-remap` (v28, `preRebuild: true`), `footer-icon-phosphor-rename` (v45), `footer-seed-reconcile` (v49). Copy each transform's SQL/JS verbatim from `_db-surface.md`.
  - `function ensureLedger(db): void` — `CREATE TABLE IF NOT EXISTS applied_data_steps (name TEXT PRIMARY KEY, hash TEXT, applied_at INTEGER)`.
  - `function seedLedgerFromLegacy(db, legacyVersion: number): void` — for each step, if `legacyVersion >= step.legacyThroughVersion` (or `legacyVersion === 0` fresh), insert its name as already-applied.
  - `function runDataSteps(db, opts: { preRebuild: boolean }): void` — run unapplied steps matching the `preRebuild` filter, each in a transaction, record name+hash on success.

- [ ] **Step 1: Write the failing test**

```ts
import { dataSteps, ensureLedger, seedLedgerFromLegacy, runDataSteps } from '../src/main/db/data-steps'

const db = new Database(':memory:')
ensureLedger(db)
// a v45 DB already ran the v28 remap → seeded as applied, must NOT re-run
seedLedgerFromLegacy(db, 45)
assert.ok(db.prepare("SELECT 1 FROM applied_data_steps WHERE name='workspace-status-remap'").get())
// a v21 DB missed the v28 remap → not seeded → will run
const db2 = new Database(':memory:'); ensureLedger(db2); seedLedgerFromLegacy(db2, 21)
assert.ok(!db2.prepare("SELECT 1 FROM applied_data_steps WHERE name='workspace-status-remap'").get())
console.log('✓ data-steps')
```

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL, cannot resolve `data-steps`.

- [ ] **Step 3: Implement `data-steps.ts`.** Transcribe the 5 transforms verbatim from `_db-surface.md`. `hash` = a cheap stable hash of the step's `run.toString()` (e.g. FNV/`crypto.createHash('sha256')`), recorded for drift visibility (not enforced).

- [ ] **Step 4: Run to verify it passes** — Expected: `✓ data-steps`

- [ ] **Step 5: Commit**

```bash
git add src/main/db/data-steps.ts scripts/verify-migration-engine.ts
git commit -m "feat(db): data-step ledger + ported legacy transforms"
```

---

## Task 10: `cutover.ts` — first-boot ordering

**Files:**
- Create: `src/main/db/cutover.ts`
- Test: `scripts/verify-migration-engine.ts` (add a `cutover` section — exercises the pre-v28 ordering hazard)

**Interfaces:**
- Consumes: `engine.sync`, `data-steps`, `backup`.
- Produces: `function runMigrations(db, opts: { dbPath: string }): void` executing the ordered cutover:
  1. Detect `legacyVersion`: `SELECT version FROM schema_version` if the table exists, else `0`.
  2. `ensureLedger(db)`; `seedLedgerFromLegacy(db, legacyVersion)`.
  3. `runDataSteps(db, { preRebuild: true })` — normalize legacy values BEFORE any CHECK-tightening rebuild.
  4. `sync(db, schema, { dbPath, legacyVersion, log })` — converge schema.
  5. `runDataSteps(db, { preRebuild: false })` — remaining transforms.
  6. `DROP TABLE IF EXISTS schema_version`.
  7. `onCleanBoot` + `sweepOrphans` if the plan came back empty on a verify pass.

- [ ] **Step 1: Write the failing test** (a pre-v28 DB with `in_review` rows must survive cutover — this is the ordering hazard the review caught)

```ts
import { runMigrations } from '../src/main/db/cutover'

const db = new Database(':memory:')
// simulate a real ~v21 DB: schema_version table + workspaces with legacy CHECK + in_review row
db.exec("CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (21)")
db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('p1')")
db.exec(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '', cwd TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('in_progress','in_review','idle','archived')))`)
db.exec("INSERT INTO workspaces (id,project_id,status) VALUES ('w1','p1','in_review')")

runMigrations(db, { dbPath: ':memory:' })

// cutover completed without a CHECK failure; the legacy row was normalized, not rejected
const w = db.prepare("SELECT status FROM workspaces WHERE id='w1'").get()
assert.ok(['awaiting_input', 'idle'].includes(w.status), `unexpected ${w.status}`)
assert.equal(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='schema_version'").get().c, 0)
console.log('✓ cutover')
```

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL, cannot resolve `cutover`.

- [ ] **Step 3: Implement `cutover.ts`** per the ordered steps.

- [ ] **Step 4: Run to verify it passes** — Expected: `✓ cutover`. If it throws `CHECK constraint failed`, the pre-rebuild ordering (step 3 before step 4) or a `normalizeOnRebuild` entry is wrong.

- [ ] **Step 5: Commit**

```bash
git add src/main/db/cutover.ts scripts/verify-migration-engine.ts
git commit -m "feat(db): first-boot cutover with pre-rebuild data-step ordering"
```

---

## Task 11: `index.ts` — getDb() singleton + public surface

**Files:**
- Create: `src/main/db/index.ts`
- Read: `_db-surface.md` `## Exports` (Task 0)

**Interfaces:**
- Produces the **same public surface** as the current `db.ts`: `getDb()`, `migrate(db)`, and every record type / helper listed in Task 0's `## Exports`. `getDb()` opens the DB at `app.getPath('userData')/orpheus.sqlite`, applies the six pragmas verbatim, then calls `runMigrations(db, { dbPath })` (replacing the old `migrate(db)` body), caches the singleton. `migrate(db)` is retained as a thin wrapper delegating to `runMigrations` for any external caller.

- [ ] **Step 1: Write `index.ts`** re-exporting the full surface and wiring `getDb` → pragmas → `runMigrations`. Diagnostics logging: pass a `log` callback that inserts a `db.migrate` diagnostics event with **structural-only** data (`{table, kind}` per op) — reuse the existing diagnostics insert path (see `src/main/diagnostics.ts`).

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck:node`
Expected: PASS (no missing exports; every old importer resolves).

- [ ] **Step 3: Commit**

```bash
git add src/main/db/index.ts
git commit -m "feat(db): getDb singleton + public surface over the new engine"
```

---

## Task 12: Cutover — delete db.ts, rewire imports, integration build

**Files:**
- Delete: `src/main/db.ts`
- Modify: any importer that referenced `./db` needs `./db` to resolve to `./db/index` (Node resolves a directory's `index.ts` automatically, so `import { getDb } from './db'` keeps working — verify).

**Interfaces:**
- Consumes: the complete `src/main/db/index.ts` surface (Task 11).

- [ ] **Step 1: Confirm `db/index.ts` covers every export** used anywhere:

```bash
grep -rn "from '.*db'" src/main | grep -v "db/" 
grep -rn "from '@main/db'\|from '.*/db'" src | head
```
Cross-check each imported symbol against `_db-surface.md` `## Exports`. Add any missing re-export to `db/index.ts`.

- [ ] **Step 2: Delete the monolith**

```bash
git rm src/main/db.ts
```

- [ ] **Step 3: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS. Fix any unresolved import by adding the missing re-export (never by re-adding `db.ts`).

- [ ] **Step 4: Full verification harness**

Run: `bun scripts/verify-migration-engine.ts`
Expected: all sections pass (`✓ render` … `✓ cutover` … `✓ convergence`).

- [ ] **Step 5: Integration build + smoke test**

```bash
osascript -e 'tell application "Orpheus Dev" to quit' 2>/dev/null; sleep 1
pkill -x "Orpheus Dev" 2>/dev/null; true
bun run build:unpack
open "/Applications/Orpheus Dev.app"
```
Then sanity-check the process is up and the DB opened cleanly:
```bash
pgrep -lf "Orpheus Dev.app/Contents/MacOS/Orpheus Dev" | head -1
```
Also copy your real `~/Library/Application Support/Orpheus Dev/orpheus.sqlite` aside first and confirm no `.bak-*` leak remains after a clean boot, and that the app's workspaces/projects load.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(db): delete imperative db.ts monolith; engine is now sole migration path"
```

---

## Task 13: Cleanup + docs

**Files:**
- Modify: `CLAUDE.md` (the "SQLite schema + migrations" section describes the OLD pattern — update it to describe the declarative engine)
- Verify: `scripts/verify-migration-engine.ts` is NOT bundled (check `electron-builder.yml` / `electron-builder-dev.yml` `files` globs).

- [ ] **Step 1: Update CLAUDE.md** — replace the "migrations-as-code / CURRENT_VERSION / defensive ALTER" description with: declarative `src/main/db/schema.ts` is the single source of truth; add a column by editing its `TableDef`; add a data transform by appending a named `DataStep`; the engine reconciles on boot. Remove references to `CURRENT_VERSION` and the defensive-ALTER idiom.

- [ ] **Step 2: Confirm harness is not shipped**

```bash
grep -n "scripts" electron-builder.yml electron-builder-dev.yml
```
Expected: `scripts/` is not in the packaged `files` set.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: describe declarative migration engine; retire migrations-as-code notes"
```

---

## Self-Review

**Spec coverage** — every spec section maps to a task:
- Declarative schema / one source of truth → Task 7 (+ Task 1 render).
- Engine reconciler / introspect→diff→execute → Tasks 2, 3, 6.
- 12-step rebuild + `normalizeOnRebuild` → Task 4.
- Structural (not raw-string) comparison → Task 3.
- Data-steps ledger + `legacyThroughVersion` seeding → Task 9.
- Cutover ordering (preRebuild before CHECK-tightening) → Task 10.
- Backup via `VACUUM INTO` + lifetime bound → Task 5.
- Diagnostics structural-only logging → Tasks 6, 11.
- Explicit `dropColumns` (no silent auto-drop) → Task 3.
- Delete `db.ts` + both healers, drop `schema_version` → Tasks 10, 12.
- Verification harness (real shapes, idempotency, data-step correctness) → Tasks 1–10 (each adds a section) + Task 8.
- Build-vs-use = build → whole plan (no library dependency added).

**Placeholder scan:** the only intentionally deferred detail is the exact 150-column transcription of `claude_global_settings` (Task 7) and the verbatim data-transform SQL (Task 9) — both are explicitly sourced from `_db-surface.md` (Task 0), which captures them verbatim from `db.ts`. No `TBD`/`handle edge cases`/`similar to`.

**Type consistency:** `SchemaDef`/`TableDef`/`ColumnDef`/`IndexDef`/`PlanOp`/`DataStep`/`LiveTable`/`LiveColumn` are defined once (Tasks 1–3, 9) and consumed by name thereafter. `sync`/`planSync`/`rebuildTable`/`runDataSteps`/`runMigrations`/`backupBefore` signatures are declared in their producing task's Interfaces block and used consistently downstream.

**Orchestration note:** per CLAUDE.md, all task implementation is delegated to Sonnet subagents; the orchestrator reviews between tasks.
