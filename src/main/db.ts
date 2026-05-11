import Database from 'better-sqlite3'
import { app } from 'electron'
import * as nodePath from 'node:path'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const CURRENT_VERSION = 4

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY NOT NULL,
    path TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    claude_encoded_name TEXT,
    added_at INTEGER NOT NULL,
    last_opened_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    jsonl_path TEXT NOT NULL,
    title TEXT,
    status TEXT NOT NULL DEFAULT 'in_review'
      CHECK (status IN ('in_progress', 'in_review', 'archived')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER,
    model TEXT,
    last_message_role TEXT
  );

  CREATE INDEX IF NOT EXISTS sessions_project_id_idx ON sessions(project_id);
  CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions(status);
  CREATE INDEX IF NOT EXISTS sessions_updated_at_idx ON sessions(updated_at);
`

const WORKSPACES_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    cwd TEXT NOT NULL,
    pinned_at INTEGER,
    created_at INTEGER NOT NULL,
    last_opened_at INTEGER,
    archived_at INTEGER,
    name_is_auto INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS workspaces_project_id_idx ON workspaces(project_id);
  CREATE INDEX IF NOT EXISTS workspaces_pinned_idx ON workspaces(pinned_at);
`

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (_db) return _db

  const dbPath = nodePath.join(app.getPath('userData'), 'orpheus.sqlite')
  const db = new Database(dbPath)

  // WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // Run migrations
  migrate(db)

  _db = db
  return _db
}

function migrate(db: Database.Database): void {
  // Apply base schema (all CREATE IF NOT EXISTS — safe to re-run)
  db.exec(SCHEMA_SQL)

  // Check / set schema version
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number }
    | undefined

  const currentVersion = row?.version ?? 0

  if (!row) {
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(CURRENT_VERSION)
  }

  // Version 2: add projects.pinned_at + workspaces table
  if (currentVersion < 2) {
    db.exec(WORKSPACES_SCHEMA_SQL)

    // ALTER TABLE ADD COLUMN is safe to run once — guard with version check
    try {
      db.exec('ALTER TABLE projects ADD COLUMN pinned_at INTEGER')
    } catch {
      // Column may already exist if DB was created fresh with an older version check missed
    }

    if (row) {
      db.prepare('UPDATE schema_version SET version = ?').run(2)
    }
  }

  // Version 3: drop projects.archived_at + add workspaces.name_is_auto
  if (currentVersion < 3) {
    try {
      db.exec('ALTER TABLE projects DROP COLUMN archived_at')
    } catch {
      // Column may already be absent on a fresh DB or previous partial migration
    }

    try {
      db.exec('ALTER TABLE workspaces ADD COLUMN name_is_auto INTEGER NOT NULL DEFAULT 1')
    } catch {
      // Column may already exist if this migration ran partially
    }

    if (row) {
      db.prepare('UPDATE schema_version SET version = ?').run(3)
    }
  }

  // Version 4: drop projects.pinned_at
  if (currentVersion < 4) {
    try {
      db.exec('ALTER TABLE projects DROP COLUMN pinned_at')
    } catch {
      // Already gone
    }
    if (row) {
      db.prepare('UPDATE schema_version SET version = ?').run(4)
    }
  }
}
