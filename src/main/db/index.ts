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

// Single source of truth for the on-disk path of THIS process's own DB
// (nightly's, dev's, prod's — whichever variant is currently running). Never
// hardcode 'orpheus.sqlite' + userData elsewhere; import this instead.
export function getDbPath(): string {
  return nodePath.join(app.getPath('userData'), 'orpheus.sqlite')
}

export function getDb(): Database.Database {
  if (_db) return _db

  const dbPath = getDbPath()
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
  // If migration throws, close the handle before rethrowing — otherwise a
  // subsequent getDb() call would open a second connection to the same file,
  // leaking the first (never cached, never closed).
  try {
    migrate(db, dbPath)
  } catch (err) {
    db.close()
    throw err
  }

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
  const resolvedPath = dbPath ?? getDbPath()
  runMigrations(db, { dbPath: resolvedPath })
}

// Closes the cached singleton connection, if open, and clears it so a
// subsequent getDb() call reopens fresh. Used only by the one-way
// production→nightly import (importProdData.ts): the DB file must be closed
// before it can be safely replaced on disk, and the app is relaunched
// immediately after so a fresh getDb() reopens the just-imported file.
// Never call this in any other flow — every other code path assumes the
// singleton stays open for the life of the process.
export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}
