import Database from 'better-sqlite3'
import { app } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { isNightly } from '../appMode'
import { schema } from './schema'
import { dataSteps } from './data-steps'
import { listTables } from './introspect'
import { closeDb, getDb, getDbPath } from './index'
import type { ProdImportPreflight, ProdImportResult } from '../../shared/types'

// ---------------------------------------------------------------------------
// "Import data from production Orpheus" — nightly-only, strictly one-way
// (production → nightly, never the reverse). Nightly ships with an empty DB,
// which makes it useless for real-world testing; this lets a nightly build
// pull in a read-only snapshot of the user's real production data so nightly
// testing exercises real projects/workspaces/sessions.
//
// Hard invariants (see the feature's plan for the full rationale):
//   1. Every entry point in this module gates on isNightly FIRST, before any
//      filesystem work — even though the IPC layer also checks. Never write
//      to the production DB file — production is opened { readonly: true }
//      and the only write op ever issued against it is none: VACUUM INTO
//      writes to the DESTINATION path, not the source connection.
//   2. Snapshot production via VACUUM INTO against a readonly handle. This
//      collapses any pending WAL frames into the snapshot correctly (unlike
//      a raw file copy, which could miss data still sitting in
//      `-wal`/`-shm` and never see it reflected in the copied `.sqlite`).
//   3. Back up nightly's current DB (via VACUUM INTO on the live, open
//      connection — same primitive backup.ts's backupBefore() uses for
//      migration backups) before replacing it, using the same
//      write-to-tmp-then-rename pattern so a crash mid-VACUUM never leaves a
//      half-written file at the final backup path.
//   4. Refuse if production's schema looks NEWER than this nightly build's
//      compiled-in schema (see isProdSchemaNewer's doc comment).
//   5. The live DB connection is closed, the file is swapped, and the app is
//      force-relaunched immediately — nothing continues running against the
//      old (or a half-swapped) connection.
// ---------------------------------------------------------------------------

/** Production's userData dir is a sibling of nightly's: both are children of
 *  `~/Library/Application Support/`, differing only in the app-name segment
 *  Electron derives userData from (`Orpheus` vs `Orpheus Nightly` — see
 *  appMode.ts / index.ts's app.setName(APP_NAME) call). Deriving it this way
 *  (rather than hardcoding `~/Library/Application Support/Orpheus`) keeps
 *  this working under any future rename and avoids a second hardcoded path
 *  literal for the same directory tree. */
function getProdUserDataDir(): string {
  const nightlyUserDataDir = app.getPath('userData')
  return path.join(path.dirname(nightlyUserDataDir), 'Orpheus')
}

function getProdDbPath(): string {
  return path.join(getProdUserDataDir(), 'orpheus.sqlite')
}

/** Guard shared by every exported entry point. Throws rather than returning
 *  a typed error because reaching this in a non-nightly build indicates a
 *  caller bug (the IPC handler must gate too, before calling in) — this is
 *  strictly defense in depth, not the primary refusal path. */
function assertNightly(): void {
  if (!isNightly) {
    throw new Error('Import from production is only available in nightly builds')
  }
}

/**
 * Schema-newer refusal check.
 *
 * Choice: compare NAMED, MONOTONIC identifiers rather than any numeric
 * version counter. This repo retired the old integer `schema_version`
 * ladder in favor of two append-only sources of truth declared directly in
 * source (schema.ts's table map, data-steps.ts's named `dataSteps` array,
 * recorded into the `applied_data_steps` ledger table). Both are strictly
 * additive over time by convention (see cutover.ts's header comment and
 * data-steps.ts's DataStep doc comment) — nothing in this codebase ever
 * removes a table from schema.ts or a step from dataSteps; only
 * `dropColumns` removes individual columns, which this check doesn't need
 * to reason about.
 *
 * So: if production's live DB contains a table this nightly build's
 * schema.ts doesn't know about, OR an applied_data_steps row naming a step
 * this nightly build's data-steps.ts doesn't know about, that is direct
 * evidence production was migrated by build newer than this one — refuse.
 * This is a conservative (never silently truncates newer production data
 * into an older nightly schema) and cheap (two set differences, no version
 * arithmetic to keep in sync by hand) check that piggybacks entirely on
 * infrastructure the migration engine already maintains.
 */
function isProdSchemaNewer(prodDb: InstanceType<typeof Database>): boolean {
  const knownTables = new Set(Object.keys(schema))
  const prodTables = listTables(prodDb)
  for (const t of prodTables) {
    if (t === 'applied_data_steps' || t === 'schema_version') continue
    if (!knownTables.has(t)) return true
  }

  const knownSteps = new Set(dataSteps.map((s) => s.name))
  const hasLedger = prodDb
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='applied_data_steps'")
    .get()
  if (hasLedger) {
    const appliedRows = prodDb.prepare('SELECT name FROM applied_data_steps').all() as {
      name: string
    }[]
    for (const row of appliedRows) {
      if (!knownSteps.has(row.name)) return true
    }
  }

  return false
}

/**
 * Read-only inspection used by the Settings UI to render the confirmation
 * card before the user commits: does a production DB exist at all, and (if
 * so) does it look importable. Never mutates anything on disk. Safe to call
 * repeatedly (e.g. re-checked every time the section mounts).
 */
export function preflightProdImport(): ProdImportPreflight {
  assertNightly()

  const prodDbPath = getProdDbPath()
  if (!fs.existsSync(prodDbPath)) {
    return { prodDbPath, prodFound: false, schemaNewer: false }
  }

  let prodDb: InstanceType<typeof Database> | null = null
  try {
    prodDb = new Database(prodDbPath, { readonly: true })
    const schemaNewer = isProdSchemaNewer(prodDb)
    return { prodDbPath, prodFound: true, schemaNewer }
  } finally {
    prodDb?.close()
  }
}

const STAGED_SUFFIX = '.import-staged'

/** Same tmp-then-rename discipline as db/backup.ts's backupBefore(): VACUUM
 *  INTO refuses to write over an existing file, and only renaming after a
 *  successful VACUUM guarantees a half-written file is never mistaken for a
 *  complete snapshot/backup. */
function vacuumIntoAtomic(db: { exec(sql: string): unknown }, finalPath: string): void {
  const tmpPath = `${finalPath}.tmp-${process.pid}`
  if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true })
  const escaped = tmpPath.replace(/'/g, "''")
  db.exec(`VACUUM INTO '${escaped}'`)
  fs.renameSync(tmpPath, finalPath)
}

/** Removes any `-wal`/`-shm` sidecars for `dbPath`, if present. Called only
 *  on the OLD nightly file right after it has been safely backed up and is
 *  about to be replaced — a fresh VACUUM INTO snapshot never itself has
 *  sidecars (VACUUM INTO always writes a complete, checkpointed file). */
function removeWalSidecars(dbPath: string): void {
  for (const suffix of ['-wal', '-shm']) {
    const p = `${dbPath}${suffix}`
    if (fs.existsSync(p)) fs.rmSync(p, { force: true })
  }
}

/**
 * Runs the full one-way import: refuse checks, snapshot production,
 * back up nightly's current DB, close nightly's live connection, swap the
 * file, and force a relaunch so the next boot opens the freshly-imported
 * DB. Never returns normally on success — the process exits via
 * app.relaunch() + app.exit(0), matching updates.ts's relaunchApp(). On any
 * refusal or failure, returns a typed error result and leaves both
 * databases exactly as they were (nightly's live connection is only closed
 * once every prior step has already succeeded).
 */
export function runProdImport(): ProdImportResult {
  assertNightly()

  const prodDbPath = getProdDbPath()
  if (!fs.existsSync(prodDbPath)) {
    return { ok: false, error: 'not_found' }
  }

  const nightlyDbPath = getDbPath()

  let prodDb: InstanceType<typeof Database> | null = null
  try {
    prodDb = new Database(prodDbPath, { readonly: true })

    if (isProdSchemaNewer(prodDb)) {
      return { ok: false, error: 'schema_newer' }
    }

    // Stage the production snapshot next to nightly's real DB file, NOT
    // over it yet — if anything below fails, the real nightly DB (and its
    // live connection) is untouched.
    const stagedPath = `${nightlyDbPath}${STAGED_SUFFIX}`
    if (fs.existsSync(stagedPath)) fs.rmSync(stagedPath, { force: true })
    vacuumIntoAtomic(prodDb, stagedPath)
  } catch (err) {
    return { ok: false, error: 'snapshot_failed', message: errMessage(err) }
  } finally {
    prodDb?.close()
  }

  const stagedPath = `${nightlyDbPath}${STAGED_SUFFIX}`
  const backupPath = `${nightlyDbPath}.bak-prod-import-${Date.now()}`

  try {
    // Back up nightly's CURRENT data before it's replaced. Uses the live,
    // already-open connection (same primitive db/backup.ts's
    // backupBefore() uses) — closeDb() only happens after this succeeds.
    const liveDb = getDb()
    vacuumIntoAtomic(liveDb, backupPath)
  } catch (err) {
    fs.rmSync(stagedPath, { force: true })
    return { ok: false, error: 'backup_failed', message: errMessage(err) }
  }

  try {
    // Everything that can fail has now succeeded. Close nightly's live
    // connection before touching the file on disk.
    closeDb()
    removeWalSidecars(nightlyDbPath)
    fs.renameSync(stagedPath, nightlyDbPath)
  } catch (err) {
    // The backup already exists on disk even if the swap itself fails
    // partway, so recovery is possible, but report distinctly so the UI
    // doesn't claim success.
    return { ok: false, error: 'swap_failed', message: errMessage(err) }
  }

  app.relaunch()
  app.exit(0)
  // Unreachable in practice (app.exit terminates the process), but keeps
  // the function's return type total for callers/tests that stub Electron.
  return { ok: true }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
