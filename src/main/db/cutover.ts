import type { DbLike } from './types'
import type { PlanOp } from './diff'
import { sync, planSync } from './engine'
import { schema } from './schema'
import { ensureLedger, seedLedgerFromLegacy, runDataSteps } from './data-steps'
import { onCleanBoot, sweepOrphans } from './backup'

// ---------------------------------------------------------------------------
// First-boot cutover: the single ordered entry point that takes ANY DB —
// fresh install, or a legacy DB stuck anywhere in the old db.ts `migrate()`
// ladder (schema_version 2–63) — and reconciles it to the declarative
// `schema.ts` desired state.
//
// ORDERING IS LOAD-BEARING. A review of this plan caught a real hazard: if
// the engine's schema sync (step 4) tightens a CHECK constraint (e.g.
// workspaces.status dropping legacy 'in_review') BEFORE the data steps that
// normalize legacy values into the new enum have run, a preRebuild data step
// that WRITES a value the *live, not-yet-widened* CHECK doesn't accept yet
// (e.g. workspace-status-remap writing 'awaiting_input' against the old v21
// CHECK, which only knew about 'in_progress'/'in_review'/'completed'/
// 'archived') would itself fail with a CHECK violation.
//
// This mirrors the real legacy system exactly: `healWorkspacesCheck` in the
// old db.ts ran UNCONDITIONALLY on every boot, before any version-gated
// block, so by the time the real v28 remap ran, the CHECK had already been
// widened by the heal. The declarative engine's rebuild (driven by sync(),
// step 4) is what plays the role of that heal. So a preRebuild data step can
// legitimately fail here — it's racing a not-yet-widened CHECK — and that
// failure must NOT abort the cutover: `normalizeOnRebuild` on the table
// being rebuilt is the guaranteed backstop (it coerces any value the new
// CHECK doesn't recognize, e.g. legacy 'in_review', down to a safe default
// like 'idle'). So step 3 tolerates a CHECK-constraint failure and lets sync
// (step 4) widen the schema; then step 3 data steps are retried once more
// after sync (still ordered before step 5's non-preRebuild steps), so a step
// whose write only failed because of the stale CHECK gets a chance to
// complete now that the CHECK has caught up, and gets recorded in the
// ledger. This ordering is exercised end-to-end by the 'cutover' harness
// section below (a pre-v28 DB with an 'in_review' row).
// ---------------------------------------------------------------------------

function isCheckConstraintError(err: unknown): boolean {
  return err instanceof Error && /CHECK constraint failed/i.test(err.message)
}

/**
 * Detects the legacy `schema_version` a pre-existing DB is stuck at, or 0 for
 * a fresh install / a DB that never had a schema_version table.
 */
function detectLegacyVersion(db: DbLike): number {
  const tableRow = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
    .get()
  if (!tableRow) return 0

  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number }
    | undefined
  return row?.version ?? 0
}

/**
 * Runs the full ordered cutover against `db`. Idempotent: running it again
 * against an already-converged DB is a no-op (planSync comes back empty, no
 * data step re-runs because the ledger already has every step recorded).
 */
function runMigrations(db: DbLike, opts: { dbPath: string }): void {
  // 1. Detect the legacy version this DB is stuck at (0 = fresh install or
  //    already-cutover DB with no schema_version table).
  const legacyVersion = detectLegacyVersion(db)

  // 2. Ensure the data-step ledger exists and pre-mark steps the legacy
  //    schema_version proves already ran, so they aren't re-applied.
  ensureLedger(db)
  seedLedgerFromLegacy(db, legacyVersion)

  // 3. Normalize legacy values BEFORE any CHECK-tightening rebuild runs —
  //    this is the ordering the pre-v28 in_review hazard depends on. A step
  //    can legitimately fail here with a CHECK-constraint error if it writes
  //    a value the live (not-yet-widened) CHECK doesn't accept yet; that's
  //    tolerated (LOGGED, not silently swallowed) because sync()'s rebuild +
  //    normalizeOnRebuild (step 4) is the guaranteed backstop, and step 4b
  //    below retries this exact step once the CHECK has widened. Any other
  //    failure is a real bug — rethrow immediately.
  //
  //    The tolerance here is deliberately narrow: it only prevents a
  //    known-benign CHECK failure from aborting the cutover early. It does
  //    NOT mean the failure is invisible — it's logged so a genuine bug
  //    hiding behind a CHECK error isn't silently lost. And if the retry in
  //    step 4b fails AGAIN with the same step, THAT failure is not caught
  //    here at all — it propagates out of runDataSteps(), because a step
  //    that still can't write after the CHECK was widened is a real bug, not
  //    the known hazard.
  try {
    runDataSteps(db, { preRebuild: true })
  } catch (err) {
    if (!isCheckConstraintError(err)) throw err
    console.warn(
      '[db/cutover] preRebuild data step hit a CHECK constraint failure before sync() widened the schema — tolerating and retrying after sync (step 4b). If this step fails again post-sync, that error will propagate.',
      err instanceof Error ? err.message : err
    )
  }

  // 4. Converge the schema structurally (create/add/rebuild/index ops).
  //    `log` is a structural-only no-op collector for now — the real
  //    diagnostics wiring lands in Task 11; this must simply not crash.
  sync(db, schema, {
    dbPath: opts.dbPath,
    legacyVersion,
    log: (): void => {}
  })

  // 4b. Retry any preRebuild steps that failed above — the CHECK they were
  //     racing has now been widened by sync()'s rebuild, so a step that only
  //     failed because of the stale CHECK can complete and record itself in
  //     the ledger. Steps that already succeeded above are no-ops here (the
  //     ledger already has them). Still ordered strictly before step 5.
  runDataSteps(db, { preRebuild: true })

  // 5. Run the remaining (non-preRebuild) data transforms.
  runDataSteps(db, { preRebuild: false })

  // 6. Retire the legacy version table — the declarative engine + ledger are
  //    now the sole source of truth for migration state.
  db.exec('DROP TABLE IF EXISTS schema_version')

  // 7. Clean-boot housekeeping: only sweep backup files once convergence is
  //    verified, and only when there's a real file on disk to sweep.
  if (opts.dbPath !== ':memory:') {
    const remaining: PlanOp[] = planSync(db, schema)
    if (remaining.length === 0) {
      onCleanBoot(opts.dbPath)
      sweepOrphans(opts.dbPath)
    }
  }
}

export { runMigrations }
