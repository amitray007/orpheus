import Database from 'better-sqlite3'
import { app } from 'electron'
import * as nodePath from 'node:path'
import { runMigrations } from './cutover'

// ---------------------------------------------------------------------------
// getDb() singleton — same public surface + pragmas as the legacy db.ts, but
// migration is now delegated to the declarative engine's cutover entry point
// (runMigrations) instead of the old imperative version-ladder migrate().
// ---------------------------------------------------------------------------

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (_db) return _db

  const dbPath = nodePath.join(app.getPath('userData'), 'orpheus.sqlite')
  const db = new Database(dbPath)

  // WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL') // safe under WAL; eliminates fsync per commit
  db.pragma('cache_size = -8000') // 8 MB page cache (negative = KB)
  db.pragma('mmap_size = 268435456') // 256 MB memory-mapped IO
  db.pragma('temp_store = MEMORY') // temp tables in RAM

  // Run migrations via the declarative engine's cutover entry point. Pass the
  // dbPath already computed above so migrate() doesn't need to recompute it.
  migrate(db, dbPath)

  _db = db
  return _db
}

// Retained as a thin public wrapper around runMigrations for any external
// caller that invokes migrate(db) directly (backward-compatible signature:
// dbPath is optional and defaults to the real on-disk path so existing
// single-argument call sites keep working unchanged).
//
// TODO(Task 13/diagnostics): wire structural-only db.migrate event — for now
// runMigrations' internal sync() log callback is a no-op (see cutover.ts),
// which already satisfies the security invariant of never logging cell
// values since nothing is logged yet.
export function migrate(db: Database.Database, dbPath?: string): void {
  const resolvedPath = dbPath ?? nodePath.join(app.getPath('userData'), 'orpheus.sqlite')
  runMigrations(db, { dbPath: resolvedPath })
}
