import fs from 'node:fs'
import path from 'node:path'
import type { DbLike } from './types'

// Idempotency guard: within a single process run, never re-run VACUUM INTO
// for a path we've already backed up (e.g. if backupBefore is called more
// than once for the same legacy version during a single migration pass).
const backedUpThisRun = new Set<string>()

// Synchronously snapshot the live DB to `${dbPath}.bak-${legacyVersion}` via
// VACUUM INTO before running a migration away from `legacyVersion`, so a
// failed/aborted migration can be recovered from a known-good pre-migration
// copy. Runs on the main thread deliberately — migrations must not proceed
// until the backup is durably on disk.
function backupBefore(db: DbLike, dbPath: string, legacyVersion: number): string {
  const backupPath = `${dbPath}.bak-${legacyVersion}`

  if (backedUpThisRun.has(backupPath)) {
    return backupPath
  }

  // Write to a temp path first and only rename over `backupPath` once VACUUM
  // INTO has succeeded. This guarantees a stale-but-good backup from a prior
  // crashed migration is never destroyed before a new one is durably on
  // disk: if VACUUM INTO fails partway (disk full, EIO, ...), the rename is
  // never reached and the old `.bak-*` — the only recovery point — survives
  // untouched. renameSync atomically replaces any existing file at
  // `backupPath` on POSIX, so this also subsumes the old up-front
  // fs.rmSync(backupPath) cleanup.
  const tmpPath = `${backupPath}.tmp-${process.pid}`

  // VACUUM INTO throws "output file already exists" if the target is
  // already on disk. A stray tmp file here would only come from a prior
  // crash mid-VACUUM under the same pid (rare, but possible after a pid
  // wraparound) — safe to discard since we're about to write a fresh one.
  if (fs.existsSync(tmpPath)) {
    fs.rmSync(tmpPath, { force: true })
  }

  const escapedTmpPath = tmpPath.replace(/'/g, "''")
  db.exec(`VACUUM INTO '${escapedTmpPath}'`)

  fs.renameSync(tmpPath, backupPath)

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
