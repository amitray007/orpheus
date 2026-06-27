/**
 * DB migration smoke test — guards against index-on-missing-column regressions.
 *
 * Rationale: better-sqlite3 is compiled against Electron's ABI, so this script
 * must run under Electron's Node runtime, not system Node. Procedure:
 *
 *   # 1. Build the main bundle first (needed for module resolution):
 *   #    bun run build:native && bun run build
 *
 *   # 2. Compile this script (esbuild is available as a dev dep via electron-vite):
 *   bunx esbuild scripts/smoke-db-migrations.ts \
 *     --bundle --platform=node --format=cjs \
 *     --external:better-sqlite3 --external:electron \
 *     --outfile=out/smoke-db-migrations.cjs
 *
 *   # 3. Run under Electron's Node runtime:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron out/smoke-db-migrations.cjs
 *
 * This script imports migrate() directly from src/main/db.ts so any regression
 * in the migration SQL will cause this test to fail before the dmg is published.
 */

import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { migrate, CURRENT_VERSION } from '../src/main/db'

// Old diagnostics_events schema (v59 install — without trace columns)
const OLD_DIAGNOSTICS_SQL = `
  CREATE TABLE diagnostics_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    process      TEXT NOT NULL,
    category     TEXT NOT NULL,
    level        TEXT NOT NULL,
    event        TEXT NOT NULL,
    workspace_id TEXT,
    session_id   TEXT,
    duration_ms  INTEGER,
    message      TEXT,
    data         TEXT,
    seq          INTEGER NOT NULL
  );
`

let tmpDir: string | null = null

try {
  // Create a temp directory for the fixture DB
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orpheus-smoke-'))
  const dbPath = path.join(tmpDir, 'fixture.sqlite')

  console.log('[smoke] Creating fixture DB at', dbPath)

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // Set up a v59 "old install" fixture:
  // 1. schema_version table with version=59
  db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL);')
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(59)

  // 2. diagnostics_events WITHOUT trace columns (reproduces the regression)
  db.exec(OLD_DIAGNOSTICS_SQL)

  // Verify pre-migration state: trace_id column must NOT exist yet
  const colsBefore = db
    .prepare("SELECT name FROM pragma_table_info('diagnostics_events')")
    .all() as Array<{ name: string }>
  const colNamesBefore = colsBefore.map((c) => c.name)

  if (colNamesBefore.includes('trace_id')) {
    console.error('[smoke] FAIL: trace_id already present before migration — fixture is wrong')
    process.exit(1)
  }
  console.log('[smoke] Pre-migration check passed: trace_id absent in fixture')

  // Run the real migrate() from src/main/db.ts
  console.log(`[smoke] Running migrate() from schema_version=59 → expected ${CURRENT_VERSION}`)
  migrate(db)

  // Assert 1: schema_version must equal CURRENT_VERSION
  const versionRow = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number }
    | undefined

  if (!versionRow) {
    console.error('[smoke] FAIL: schema_version row missing after migration')
    process.exit(1)
  }

  if (versionRow.version !== CURRENT_VERSION) {
    console.error(
      `[smoke] FAIL: schema_version=${versionRow.version} after migration, expected ${CURRENT_VERSION}`
    )
    process.exit(1)
  }
  console.log(`[smoke] Assert 1 passed: schema_version=${versionRow.version}`)

  // Assert 2: trace_id column must exist in diagnostics_events
  const colsAfter = db
    .prepare("SELECT name FROM pragma_table_info('diagnostics_events')")
    .all() as Array<{ name: string }>
  const colNamesAfter = colsAfter.map((c) => c.name)

  const traceColumns = ['trace_id', 'span_id', 'parent_span_id', 'name', 'kind']
  const missingCols = traceColumns.filter((col) => !colNamesAfter.includes(col))

  if (missingCols.length > 0) {
    console.error(
      `[smoke] FAIL: diagnostics_events missing columns after migration: ${missingCols.join(', ')}`
    )
    process.exit(1)
  }
  console.log(
    `[smoke] Assert 2 passed: trace columns present in diagnostics_events (${traceColumns.join(', ')})`
  )

  db.close()

  console.log('[smoke] All assertions passed.')
  process.exit(0)
} catch (err) {
  console.error('[smoke] FAIL: unexpected error during smoke test:', err)
  process.exit(1)
} finally {
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
}
