import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import type { DbLike } from './types'

// ---------------------------------------------------------------------------
// Named, run-once data transforms + ledger.
//
// Each entry in `dataSteps` is a legacy imperative-migration data transform
// (verbatim from docs/superpowers/plans/_db-surface.md `## DataTransforms`),
// ported to run against a schema that the declarative engine (schema.ts +
// engine.ts) has already reconciled structurally. These steps mutate ROWS,
// never DDL — column/table shape changes are handled declaratively by the
// schema differ, not here.
//
// `legacyThroughVersion` is the old db.ts `if (currentVersion < N)` version
// the transform originally ran under. On first boot against a pre-existing
// legacy DB, `seedLedgerFromLegacy` uses it to mark a step as already-applied
// when the legacy schema_version proves the transform already ran, so the
// engine never re-runs it.
// ---------------------------------------------------------------------------

interface DataStep {
  name: string
  /**
   * The legacy `db.ts` version this transform originally shipped under.
   * Used by seedLedgerFromLegacy to decide whether a pre-existing legacy DB
   * already had this transform applied.
   */
  legacyThroughVersion: number
  /** Run before schema.sync() — i.e. before any CHECK-tightening rebuild. */
  preRebuild?: boolean
  /**
   * Steps that must run even on a brand-new (fresh install, legacyVersion 0)
   * DB — e.g. seed data that a fresh schema still needs inserted. Fresh
   * installs mark every OTHER (non-alwaysRun) step as pre-applied, because a
   * fresh schema is already structurally correct and has no legacy rows to
   * fix. alwaysRun steps are the deliberate exception: seedLedgerFromLegacy
   * never pre-marks them, so runDataSteps always executes them at least once
   * (on both fresh installs and legacy upgrades), and the ledger then
   * prevents them from re-running on every subsequent boot.
   */
  alwaysRun?: boolean
  run: (db: DbLike) => void
}

const dataSteps: DataStep[] = [
  // -------------------------------------------------------------------------
  // 1. v16 — clear the encrypted auth blob (plaintext auth columns replace
  //    the old safeStorage-encrypted blob; the blob can't be decrypted
  //    without the original signing identity, so it's just cleared).
  //    NOTE: only the data UPDATE is ported here — the ADD COLUMN statements
  //    for auth_api_key/auth_token/auth_base_url are schema and now handled
  //    declaratively by schema.ts.
  // -------------------------------------------------------------------------
  {
    name: 'blob-clear',
    legacyThroughVersion: 16,
    run: (db) => {
      db.prepare('UPDATE claude_global_settings SET auth_encrypted_blob = NULL WHERE id = 1').run()
    }
  },

  // -------------------------------------------------------------------------
  // 2. v21 — backfill archived workspace status. Must run BEFORE the
  //    workspaces CHECK is tightened by a rebuild (preRebuild: true) so the
  //    backfill sees the legacy status values it expects to normalize.
  // -------------------------------------------------------------------------
  {
    name: 'workspace-status-backfill',
    legacyThroughVersion: 21,
    preRebuild: true,
    run: (db) => {
      db.prepare(
        "UPDATE workspaces SET status = 'archived' WHERE archived_at IS NOT NULL AND status != 'archived'"
      ).run()
    }
  },

  // -------------------------------------------------------------------------
  // 3. v28 — remap in_review/completed → awaiting_input. Also preRebuild:
  //    true — this is the exact ordering hazard the engine's cutover exists
  //    to protect (Task 10): normalize legacy values before any CHECK that
  //    would reject them gets tightened.
  // -------------------------------------------------------------------------
  {
    name: 'workspace-status-remap',
    legacyThroughVersion: 28,
    preRebuild: true,
    run: (db) => {
      db.prepare(
        "UPDATE workspaces SET status = 'awaiting_input' WHERE status IN ('in_review', 'completed')"
      ).run()
    }
  },

  // -------------------------------------------------------------------------
  // 4. v45 — Lucide → Phosphor icon rename for the 6 default footer action
  //    seeds. Matches on both icon AND label to avoid touching
  //    user-customised rows.
  // -------------------------------------------------------------------------
  {
    name: 'footer-icon-phosphor-rename',
    legacyThroughVersion: 45,
    run: (db) => {
      const ICON_MIGRATIONS: Array<[string, string, string]> = [
        // [oldIcon, newIcon, label]
        ['git-fork', 'GitFork', 'Fork'],
        ['clipboard', 'Clipboard', '/copy'],
        ['brain', 'Brain', '/context'],
        ['eraser', 'Eraser', '/clear'],
        ['gauge', 'Gauge', 'Context'],
        ['activity', 'Pulse', 'Status']
      ]
      const updateIcon = db.prepare(
        'UPDATE footer_actions_global SET icon = ? WHERE icon = ? AND label = ?'
      )
      for (const [oldIcon, newIcon, label] of ICON_MIGRATIONS) {
        updateIcon.run(newIcon, oldIcon, label)
      }
    }
  },

  // -------------------------------------------------------------------------
  // 5. v46-v49 — footer seed reconciliation. Four discrete legacy version
  //    blocks collapsed into one data step (their DDL parts — prompts_json
  //    ADD COLUMN — are now handled declaratively by schema.ts).
  // -------------------------------------------------------------------------
  {
    name: 'footer-seed-reconcile',
    legacyThroughVersion: 49,
    run: (db) => {
      // v46(a): migrate the three slash-command chips from '\r'-embedded
      // text to the { text, submit: true } params shape.
      const updateSlash = db.prepare(
        `UPDATE footer_actions_global
         SET params_json = ?, updated_at = ?
         WHERE label = ? AND action_id = 'terminal.sendInput' AND params_json = ?`
      )
      const now = Date.now()
      updateSlash.run(
        JSON.stringify({ text: '/copy', submit: true }),
        now,
        '/copy',
        JSON.stringify({ text: '/copy\r' })
      )
      updateSlash.run(
        JSON.stringify({ text: '/context', submit: true }),
        now,
        '/context',
        JSON.stringify({ text: '/context\r' })
      )
      updateSlash.run(
        JSON.stringify({ text: '/clear', submit: true }),
        now,
        '/clear',
        JSON.stringify({ text: '/clear\r' })
      )

      // v46(b): remove the default Status chip; preserve user-created rows
      // with the same label but a different icon/action_id.
      db.prepare(
        `DELETE FROM footer_actions_global
         WHERE label = 'Status' AND icon = 'Pulse' AND action_id = 'workspace.getActivityStatus'`
      ).run()

      // v47: scrub Archive and Rename rows seeded by intermediate dev
      // builds before the phase 3a clean seed. Unconditional (no default-set
      // guard) — matches on label + action_id only.
      db.prepare(
        `DELETE FROM footer_actions_global
         WHERE label = 'Archive' AND action_id = 'workspace.archive'`
      ).run()
      db.prepare(
        `DELETE FROM footer_actions_global
         WHERE label = 'Rename' AND action_id = 'workspace.rename'`
      ).run()

      // v48: seed /compact, /cost, /model — only if the table still matches
      // the previous default set exactly (5 rows: Fork, /copy, /context,
      // /clear, Context, in that order). Skip silently if customised.
      {
        const rows = db
          .prepare('SELECT label FROM footer_actions_global ORDER BY position ASC')
          .all() as { label: string }[]
        const labels = rows.map((r) => r.label)
        const PREV_DEFAULT_LABELS = ['Fork', '/copy', '/context', '/clear', 'Context']
        const matchesPrevDefault =
          labels.length === PREV_DEFAULT_LABELS.length &&
          PREV_DEFAULT_LABELS.every((lbl, i) => labels[i] === lbl)

        if (matchesPrevDefault) {
          const seedNow = Date.now()
          // Shift 'Context' to position 7 to make room for the 3 new chips.
          db.prepare(
            `UPDATE footer_actions_global SET position = 7 WHERE label = 'Context' AND action_id = 'session.getUsage'`
          ).run()

          const insertSeed = db.prepare(`
            INSERT INTO footer_actions_global
              (id, label, icon, action_id, params_json, visible_when, position, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)

          insertSeed.run(
            randomUUID(),
            '/compact',
            'ArrowsInLineHorizontal',
            'terminal.sendInput',
            JSON.stringify({ text: '/compact', submit: true }),
            'idle',
            4,
            seedNow,
            seedNow
          )
          insertSeed.run(
            randomUUID(),
            '/cost',
            'CurrencyDollar',
            'terminal.sendInput',
            JSON.stringify({ text: '/cost', submit: true }),
            'always',
            5,
            seedNow,
            seedNow
          )
          insertSeed.run(
            randomUUID(),
            '/model',
            'Robot',
            'terminal.sendInput',
            JSON.stringify({ text: '/model', submit: true }),
            'always',
            6,
            seedNow,
            seedNow
          )
        }
      }

      // v49(b): seed Archive + Rename — only if the table still matches the
      // v48 default set exactly (8 rows, in order). prompts_json ADD COLUMN
      // (v49(a)) is schema, handled declaratively by schema.ts.
      {
        const rows = db
          .prepare('SELECT label, position FROM footer_actions_global ORDER BY position ASC')
          .all() as { label: string; position: number }[]
        const labels = rows.map((r) => r.label)
        const V48_DEFAULT_LABELS = [
          'Fork',
          '/copy',
          '/context',
          '/clear',
          '/compact',
          '/cost',
          '/model',
          'Context'
        ]
        const matchesV48Default =
          labels.length === V48_DEFAULT_LABELS.length &&
          V48_DEFAULT_LABELS.every((lbl, i) => labels[i] === lbl)

        if (matchesV48Default) {
          const seedNow = Date.now()
          // Archive and Rename go between /model (position 6) and Context
          // (position 7). Shift Context from 7 → 9.
          db.prepare(
            `UPDATE footer_actions_global SET position = 9 WHERE label = 'Context' AND action_id = 'session.getUsage'`
          ).run()

          const insertSeed = db.prepare(`
            INSERT INTO footer_actions_global
              (id, label, icon, action_id, params_json, visible_when, position, created_at, updated_at, prompts_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)

          const renamePrompts = JSON.stringify([
            {
              key: 'name',
              label: 'New name',
              placeholder: 'Workspace name',
              default: '{workspaceName}'
            }
          ])

          insertSeed.run(
            randomUUID(),
            'Archive',
            'Archive',
            'workspace.archive',
            JSON.stringify({}),
            'idle',
            7,
            seedNow,
            seedNow,
            null
          )
          insertSeed.run(
            randomUUID(),
            'Rename',
            'PencilSimple',
            'workspace.rename',
            JSON.stringify({}),
            'idle',
            8,
            seedNow,
            seedNow,
            renamePrompts
          )
        }
      }
    }
  },

  // -------------------------------------------------------------------------
  // 6. keep_awake_settings default row seed (Task 7 deferred this here: the
  //    v62 KEEP_AWAKE_SCHEMA_SQL constant bundled `INSERT OR IGNORE` alongside
  //    its CREATE TABLE — schema.ts renders structure only, this data step
  //    supplies the seed).
  //
  //    legacyThroughVersion is a nominal 0 here (a "fresh install" already
  //    has the correct schema/no legacy rows to fix — the usual reason
  //    seedLedgerFromLegacy would pre-mark a step applied on legacyVersion 0),
  //    but that is exactly the boundary this step must NOT honor: a fresh
  //    install still needs the default row inserted. alwaysRun: true is the
  //    escape hatch — seedLedgerFromLegacy skips alwaysRun steps entirely
  //    (never pre-marks them applied, on fresh OR legacy installs), so
  //    runDataSteps always executes this step at least once. After that
  //    first run, the ledger records it and it won't run again.
  // -------------------------------------------------------------------------
  {
    name: 'keep-awake-seed',
    legacyThroughVersion: 0,
    alwaysRun: true,
    run: (db) => {
      db.prepare(
        `INSERT OR IGNORE INTO keep_awake_settings (id, mode, display_on, timer_minutes)
         VALUES (1, 'auto', 0, 120)`
      ).run()
    }
  }
]

function ensureLedger(db: DbLike): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS applied_data_steps (name TEXT PRIMARY KEY, hash TEXT, applied_at INTEGER)'
  )
}

function stepHash(step: DataStep): string {
  return createHash('sha256').update(step.run.toString()).digest('hex')
}

/**
 * Pre-marks steps as already-applied based on the legacy schema_version a
 * pre-existing DB is stuck at, so the engine never re-runs a transform that
 * already ran under the old imperative migrate().
 *
 * - alwaysRun steps are NEVER pre-marked, on fresh (legacyVersion 0) or
 *   legacy (legacyVersion > 0) installs alike — they always get a real
 *   runDataSteps() pass.
 * - Fresh installs (legacyVersion 0): every OTHER step is pre-marked applied.
 *   A fresh schema is already structurally correct and has no legacy rows to
 *   fix, so these legacy data transforms are moot on a brand-new DB.
 * - Legacy installs (legacyVersion > 0): a step is pre-marked applied iff
 *   legacyVersion >= step.legacyThroughVersion (the old migrate() would have
 *   already run that version block).
 */
function seedLedgerFromLegacy(db: DbLike, legacyVersion: number): void {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO applied_data_steps (name, hash, applied_at) VALUES (?, ?, ?)'
  )
  const now = Date.now()
  for (const step of dataSteps) {
    if (step.alwaysRun) continue
    const alreadyApplied = legacyVersion === 0 || legacyVersion >= step.legacyThroughVersion
    if (alreadyApplied) {
      insert.run(step.name, stepHash(step), now)
    }
  }
}

/**
 * Runs unapplied steps matching the `preRebuild` filter, each independently
 * transaction-wrapped (node:sqlite's DatabaseSync has no `.transaction()`
 * helper like better-sqlite3, so BEGIN/COMMIT/ROLLBACK are issued directly).
 * Records name+hash+applied_at into the ledger on success.
 */
function runDataSteps(db: DbLike, opts: { preRebuild: boolean }): void {
  ensureLedger(db)
  const record = db.prepare(
    'INSERT OR REPLACE INTO applied_data_steps (name, hash, applied_at) VALUES (?, ?, ?)'
  )
  for (const step of dataSteps) {
    if ((step.preRebuild ?? false) !== opts.preRebuild) continue
    const applied = db.prepare('SELECT 1 FROM applied_data_steps WHERE name = ?').get(step.name)
    if (applied) continue

    db.exec('BEGIN')
    try {
      step.run(db)
      record.run(step.name, stepHash(step), Date.now())
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}

export type { DataStep }
export { dataSteps, ensureLedger, seedLedgerFromLegacy, runDataSteps }
