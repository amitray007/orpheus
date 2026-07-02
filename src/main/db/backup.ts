import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'

// Idempotency guard: within a single process run, never re-run VACUUM INTO
// for a path we've already backed up (e.g. if backupBefore is called more
// than once for the same legacy version during a single migration pass).
const backedUpThisRun = new Set<string>()

// Synchronously snapshot the live DB to `${dbPath}.bak-${legacyVersion}` via
// VACUUM INTO before running a migration away from `legacyVersion`, so a
// failed/aborted migration can be recovered from a known-good pre-migration
// copy. Runs on the main thread deliberately — migrations must not proceed
// until the backup is durably on disk.
function backupBefore(db: Database.Database, dbPath: string, legacyVersion: number): string {
  const backupPath = `${dbPath}.bak-${legacyVersion}`

  if (backedUpThisRun.has(backupPath)) {
    return backupPath
  }

  // VACUUM INTO throws "output file already exists" if the target is already
  // on disk. A stray file here means a prior migration attempt crashed after
  // taking this exact backup but before reaching convergence (the cleanup in
  // onCleanBoot/sweepOrphans only runs post-convergence, so it never got a
  // chance to sweep this one) — on the next boot we'd recompute this same
  // path and VACUUM INTO would throw forever, boot-crash-looping. It's safe
  // to discard: we're about to write a fresh backup of the current
  // pre-migration state anyway.
  if (fs.existsSync(backupPath)) {
    fs.rmSync(backupPath, { force: true })
  }

  const escapedPath = backupPath.replace(/'/g, "''")
  db.exec(`VACUUM INTO '${escapedPath}'`)

  backedUpThisRun.add(backupPath)
  return backupPath
}

// Called on a clean boot (no crash/interrupted migration to recover from) to
// clear out backup files left behind by the previous run, so `.bak-*` files
// don't accumulate indefinitely across normal restarts.
function onCleanBoot(dbPath: string): void {
  const dir = path.dirname(dbPath)
  const base = path.basename(dbPath)
  const prefix = `${base}.bak-`

  for (const entry of fs.readdirSync(dir)) {
    if (!entry.startsWith(prefix)) continue
    fs.rmSync(path.join(dir, entry))
  }
}

// Best-effort sweep for stray backup files older than `maxAgeDays`, in case
// onCleanBoot was never reached (e.g. repeated crashes). Age is based on
// mtime rather than filename parsing so it's robust to any legacyVersion
// scheme.
function sweepOrphans(dbPath: string, maxAgeDays = 7): void {
  const dir = path.dirname(dbPath)
  const base = path.basename(dbPath)
  const prefix = `${base}.bak-`
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000

  for (const entry of fs.readdirSync(dir)) {
    if (!entry.startsWith(prefix)) continue
    const fullPath = path.join(dir, entry)
    const { mtimeMs } = fs.statSync(fullPath)
    if (Date.now() - mtimeMs > maxAgeMs) {
      fs.rmSync(fullPath)
    }
  }
}

export { backupBefore, onCleanBoot, sweepOrphans }
