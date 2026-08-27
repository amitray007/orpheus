// ---------------------------------------------------------------------------
// src/main/harness/codex/threadDb.ts
//
// support-multi-harness — read-only accessor for Codex's OWN state database,
// ~/.codex/thread_history_1.sqlite. This REPLACES the previous reverse-
// engineered signal pair (rollout-JSONL turn-lifecycle scan + a
// thread-writer-lock existence/liveness probe) as the source of TURN
// STATUS and FIRST-PROMPT TEXT — Codex already computes and persists both
// facts itself, in a structured, indexed table, so reading them directly is
// both simpler and more accurate than re-deriving them from an append-only
// event log.
//
// SCHEMA (verified directly against a real ~/.codex/thread_history_1.sqlite
// on this machine, `_sqlx_migrations` at v1..v4 as of writing):
//
//   thread_turns(thread_id, turn_id, rollout_ordinal, status, error_json,
//                started_at, completed_at, duration_ms, first_user_item_id,
//                final_agent_item_id, rollout_byte_offset, rollout_end_ordinal,
//                rollout_end_byte_offset)
//     - PRIMARY KEY (thread_id, turn_id) — a thread has MANY turns.
//     - thread_id IDENTICAL to workspaces.claude_session_id for a Codex
//       workspace (verified: both are the rollout's own `session_meta.id`,
//       what session.ts's findCodexUserRolloutId/findCodexRolloutFileById
//       already resolve and bind) — no new discovery/binding mechanism
//       needed, this module is a pure second reader keyed on the SAME id.
//     - status: 'inProgress' | 'completed' | 'failed' | 'interrupted'
//       (verified: exactly these four distinct values on a real DB with
//       tens of thousands of rows — no other value observed).
//     - started_at / completed_at: epoch SECONDS (verified against a real
//       row's magnitude — NOT epoch ms, unlike created_at_ms below).
//     - rollout_ordinal: monotonically increasing within a thread — the
//       correct "latest turn" ordering key (verified: a thread with 82
//       turns has strictly increasing rollout_ordinal across all of them).
//     - first_user_item_id CAN BE NULL even on a real, non-first turn
//       (verified: a continuation turn with no attached user message of its
//       own) — so "the latest turn's first_user_item_id" is NOT how to find
//       a thread's opening prompt; see latestNonNullFirstUserItemId below.
//
//   thread_items(thread_id, turn_id, item_id, rollout_ordinal, created_at_ms,
//                item_json, item_type, updated_at_ordinal)
//     - PRIMARY KEY (thread_id, turn_id, item_id).
//     - item_json for a `userMessage` item_type is a clean, structured
//       record: {type:'userMessage', id, clientId, content:[{type:'text',
//       text, text_elements}, ...]}. content CAN contain non-text parts
//       interleaved (verified: `localImage` parts alongside `text` parts in
//       real multi-part messages, e.g. a pasted screenshot plus a caption) —
//       readFirstPromptText below filters to type==='text' parts only and
//       concatenates them, exactly matching the task brief's instruction,
//       rather than assuming array position or a single part.
//
// WHY node:sqlite, NOT better-sqlite3 — better-sqlite3 hard-crashes under
// bun in this repo (see CLAUDE.md's test:db / verify-* harness discipline
// and every other harness's own comment on this exact constraint, e.g.
// scripts/verify-harness-claude-launch.ts). node:sqlite's DatabaseSync has
// no such issue and is already the established pattern for a REAL on-disk
// SQLite read in this codebase's verify scripts (verify-migration-engine.ts
// opens a real backup file read-only via `new DatabaseSync(path, { readOnly
// : true })` — the exact shape used here).
//
// WHY OPEN-QUERY-CLOSE PER CALL, NOT A POOLED/LONG-LIVED HANDLE — measured
// on this machine: ~0.45ms per open+query+close against the real 68MB+ file.
// At that cost, holding a long-lived handle buys nothing and adds a real
// risk: Codex itself owns this file and can migrate its schema
// (`_sqlx_migrations`) or, in principle, replace/vacuum the file out from
// under a held fd across an Orpheus session that outlives many Codex
// version upgrades. A fresh open on every call can never observe a stale
// schema or a stale fd; the cost of re-opening is negligible next to the
// value of never needing to detect and recover from that staleness.
//
// FAILS TO null ON EVERY ERROR, NEVER THROWS. Every exported function here
// wraps its entire body in try/catch and returns null (or an empty array,
// where the return type is a list) on ANY failure: the file doesn't exist
// (a user who has only ever run Codex non-interactively, or never run it at
// all), a permissions error, a torn/mid-write read, a table/column that
// doesn't exist (schema drift from a future Codex version), or a row shape
// that doesn't match what's expected. This mirrors every other Codex data
// source in this directory (statusMap.ts's isLockHeld/findLastCodexTaskEvent,
// session.ts's readSessionMeta) — a reverse-engineered external data source
// must never be allowed to crash Orpheus's own reconcile/title loops.
//
// SCHEMA VERSION TOLERANCE — this module reads `_sqlx_migrations` once per
// call (cheap: a handful of rows) purely to log an UNRECOGNIZED max version
// at debug level, once per process, as an early-warning signal for a human
// investigating a future regression. It never gates behavior on the version
// number itself: the actual contract this module depends on is "do the
// specific columns this module SELECTs exist and parse as expected" — which
// the wrapping try/catch (a SQLite "no such column" error, or a row field
// that isn't the expected type) already answers correctly on its own,
// without needing to hard-pin or branch on a version number.
// ---------------------------------------------------------------------------

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'

// DEFERRED node:sqlite RESOLUTION — load-bearing for testability, similar
// motivation to tmuxHost.ts's loadElectronApp (see that file's own
// "ELECTRON-IMPORT DISCIPLINE" header comment for the general pattern this
// is closest to), but a DIFFERENT mechanism: `createRequire(__filename)`
// (tmuxHost.ts's own choice) does NOT work here, because `__filename` is a
// CommonJS-only global and this module is also loaded under plain ESM (see
// below) where it is `undefined` — verified directly: an earlier version of
// this function used createRequire(__filename) and it silently broke every
// real read under `node --experimental-strip-types` (ESM), returning null
// from withReadOnlyDb's catch instead of throwing loudly. `process.
// getBuiltinModule('node:sqlite')` (stable since Node 22.3.0, well under
// this repo's package.json#engines "node": ">=22.13.0" floor) sidesteps the
// whole CJS/ESM require-vs-import distinction entirely — it's a plain
// `process` method, identical call in both module systems.
//
// A handful of scripts/verify-*.ts harnesses run under PLAIN `bun run` (not
// `node --experimental-strip-types`) and transitively import this module
// through src/main/harness/registry.ts -> codex/launch.ts ->
// codex/titleGeneration.ts, without ever actually CALLING
// getLatestTurn/getFirstUserPromptText (they stub the surrounding
// getWorkspace/DB layer and only exercise pure registry-lookup logic) — see
// scripts/verify-harness-registry.ts, verify-doctor.ts, verify-harness-
// launch.ts. Bun 1.3.10 has NO node:sqlite implementation at all ("No such
// built-in module: node:sqlite"), so a STATIC `import { DatabaseSync } from
// 'node:sqlite'` at this file's top level would fail those scripts at
// module-LINK time, before any of their own code runs — even though none of
// them ever needs this module's actual DB-reading behavior. Deferring the
// resolution to INSIDE withReadOnlyDb (below), reached only once
// fs.existsSync has already confirmed a real DB file is present, means
// importing threadDb.ts itself never evaluates 'node:sqlite'. The REAL
// Electron/Node runtime this module ships in (CJS main-process build), and
// every verify script that DOES exercise a real read (scripts/verify-codex-
// status.ts, verify-codex-title-generation.ts — both dispatched via `node
// --experimental-strip-types`, ESM, which DOES have node:sqlite), are
// unaffected: process.getBuiltinModule works identically in both.
function loadDatabaseSync(): typeof DatabaseSyncType {
  const sqliteModule = process.getBuiltinModule('node:sqlite') as
    | typeof import('node:sqlite')
    | undefined
  if (!sqliteModule) {
    throw new Error('node:sqlite is not available in this runtime')
  }
  return sqliteModule.DatabaseSync
}

/** Resolves Codex's state-dir root — same $CODEX_HOME-aware resolution as
 *  session.ts's codexHomeDir/codexSessionsRoot and statusState.ts's
 *  locksDir, duplicated here (not imported) so this module has zero
 *  dependency on any other codex/ module and can be exercised in total
 *  isolation by its own verify script — this file's only dependency is
 *  node:fs/os/path/sqlite. */
function codexHomeDir(): string {
  const codexHome = process.env['CODEX_HOME']?.trim()
  return codexHome && codexHome.length > 0 ? codexHome : path.join(os.homedir(), '.codex')
}

/** Overridable purely for testing — scripts/verify-codex-status.ts and
 *  scripts/verify-codex-title-generation.ts point this at a fabricated
 *  fixture DB instead of the real ~/.codex/thread_history_1.sqlite. Real
 *  callers (statusState.ts, titleGeneration.ts) never pass an argument. */
export function threadHistoryDbPath(codexHome: string = codexHomeDir()): string {
  return path.join(codexHome, 'thread_history_1.sqlite')
}

// Logged at most once per process — see this file's header on why schema
// version is observability, not a behavior gate.
let loggedUnknownVersion = false
const KNOWN_MAX_MIGRATION_VERSION = 4

/**
 * Opens the thread-history DB read-only, runs `fn` against it, and closes it
 * — the one place every exported function below routes through, so the
 * open/query/close discipline (and the try/catch-to-null contract) is
 * implemented exactly once. Returns null if the file doesn't exist, can't be
 * opened, or `fn` itself throws for any reason (a missing table/column, a
 * malformed row, or any other unexpected shape).
 */
function withReadOnlyDb<T>(fn: (db: DatabaseSyncType) => T): T | null {
  const dbPath = threadHistoryDbPath()
  if (!fs.existsSync(dbPath)) return null

  let db: DatabaseSyncType
  try {
    const DatabaseSync = loadDatabaseSync()
    db = new DatabaseSync(dbPath, { readOnly: true, open: true })
  } catch {
    // File exists but couldn't be opened (permissions, a torn/mid-write
    // SQLite header, or a concurrent schema migration mid-flight) —
    // degrade to "no data" rather than throw.
    return null
  }

  try {
    logUnknownSchemaVersionOnce(db)
    return fn(db)
  } catch {
    return null
  } finally {
    try {
      db.close()
    } catch {
      // Already closed or a close-time error — nothing further to do; the
      // fd will be reclaimed on process exit regardless.
    }
  }
}

/** Best-effort, log-only schema-version observability — see this file's
 *  header. Never throws, never affects the return value of its caller. */
function logUnknownSchemaVersionOnce(db: DatabaseSyncType): void {
  if (loggedUnknownVersion) return
  try {
    const row = db.prepare('SELECT MAX(version) AS v FROM _sqlx_migrations').get() as
      | { v: number | null }
      | undefined
    const maxVersion = row?.v
    if (typeof maxVersion === 'number' && maxVersion > KNOWN_MAX_MIGRATION_VERSION) {
      loggedUnknownVersion = true
      console.debug(
        `[codexThreadDb] thread_history_1.sqlite schema version ${maxVersion} is newer than the ` +
          `${KNOWN_MAX_MIGRATION_VERSION} this module was verified against — continuing, since the ` +
          "columns this module reads are checked independently on every query (see this file's header)."
      )
    }
  } catch {
    // _sqlx_migrations missing/unreadable — not fatal, just means this
    // early-warning log never fires; the per-query try/catch is still the
    // real safety net.
  }
}

// ---------------------------------------------------------------------------
// Latest turn (status source)
// ---------------------------------------------------------------------------

export type CodexTurnStatus = 'inProgress' | 'completed' | 'failed' | 'interrupted'

/** One thread's most recent turn, exactly as needed by statusState.ts's
 *  reconciler: which status Codex itself recorded, and when that turn
 *  started/completed (epoch ms — converted from the DB's epoch-SECONDS
 *  columns here, at the boundary, so every caller downstream only ever
 *  handles milliseconds like the rest of this codebase). `completedAtMs` is
 *  null for an in-progress turn (no completion yet) or if the DB's own
 *  completed_at was null/absent. */
export interface CodexLatestTurn {
  status: CodexTurnStatus
  startedAtMs: number | null
  completedAtMs: number | null
}

const KNOWN_STATUSES = new Set<string>(['inProgress', 'completed', 'failed', 'interrupted'])

/**
 * Returns the latest turn (by `rollout_ordinal`, the verified-monotonic
 * within-thread ordering column) for `threadId`, or null if the DB is
 * unavailable, the thread has no turns at all, or the row's `status` isn't
 * one of the four values this module recognizes (schema drift — degrade to
 * null rather than pass an unrecognized string on to the caller's mapping
 * logic, which would otherwise need its own defensive default).
 */
export function getLatestTurn(threadId: string): CodexLatestTurn | null {
  return withReadOnlyDb((db) => {
    const row = db
      .prepare(
        `SELECT status, started_at, completed_at
         FROM thread_turns
         WHERE thread_id = ?
         ORDER BY rollout_ordinal DESC
         LIMIT 1`
      )
      .get(threadId) as { status: unknown; started_at: unknown; completed_at: unknown } | undefined

    if (!row) return null
    if (typeof row.status !== 'string' || !KNOWN_STATUSES.has(row.status)) return null

    return {
      status: row.status as CodexTurnStatus,
      startedAtMs: secondsToMs(row.started_at),
      completedAtMs: secondsToMs(row.completed_at)
    }
  })
}

function secondsToMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value * 1000 : null
}

// ---------------------------------------------------------------------------
// First user prompt (title-generation source)
// ---------------------------------------------------------------------------

type ThreadItemContentPart = { type?: unknown; text?: unknown }

/** Concatenates every `type === 'text'` part's `.text` from a `content`
 *  array, in array order, space-joined. Non-text parts (e.g. `localImage`)
 *  are skipped entirely, never counted or represented — matches the task
 *  brief's instruction to "concatenate content[] text parts". Returns null
 *  if no text part yields any usable text at all. */
function joinTextParts(content: unknown): string | null {
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const raw of content as ThreadItemContentPart[]) {
    if (typeof raw !== 'object' || raw === null) continue
    if (raw.type !== 'text') continue
    if (typeof raw.text !== 'string') continue
    const trimmed = raw.text.trim()
    if (trimmed) parts.push(trimmed)
  }
  const joined = parts.join(' ').trim()
  return joined || null
}

/**
 * Finds the EARLIEST turn (lowest `rollout_ordinal`) for `threadId` whose
 * `first_user_item_id` is non-null, and returns that id — NOT simply the
 * latest turn's own `first_user_item_id`, which can legitimately be null on
 * a continuation turn that carried no user message of its own (verified: a
 * thread with 76+ turns whose LATEST turn's first_user_item_id was null,
 * while an earlier turn's was populated with the thread's real opening
 * prompt). This is the id genuinely tied to the thread's first human
 * message, independent of how many turns have happened since.
 */
function earliestFirstUserItemId(db: DatabaseSyncType, threadId: string): string | null {
  const row = db
    .prepare(
      `SELECT first_user_item_id
       FROM thread_turns
       WHERE thread_id = ? AND first_user_item_id IS NOT NULL
       ORDER BY rollout_ordinal ASC
       LIMIT 1`
    )
    .get(threadId) as { first_user_item_id: unknown } | undefined
  return typeof row?.first_user_item_id === 'string' ? row.first_user_item_id : null
}

/**
 * Returns the thread's opening human-typed prompt text, or null if the DB
 * is unavailable, the thread has no turn with a first_user_item_id, the
 * referenced item can't be found in thread_items, or the item's JSON
 * doesn't parse into the expected `userMessage`/`content[]` shape.
 *
 * This is the direct replacement for titleGeneration.ts's
 * extractFirstCodexPrompt + its `looksInjected` `#`/`<` heuristic — Codex's
 * own DB records EXACTLY the human-typed userMessage with no injected
 * AGENTS.md/plugin/environment-context contamination mixed in (verified
 * against 8/8 recent real threads, including prompts that themselves start
 * with `#`, which the old rollout-scanning heuristic would have wrongly
 * skipped) — so no injected-shape filtering is needed or applied here.
 */
export function getFirstUserPromptText(threadId: string): string | null {
  return withReadOnlyDb((db) => {
    const itemId = earliestFirstUserItemId(db, threadId)
    if (!itemId) return null

    const item = db
      .prepare(
        `SELECT item_json
         FROM thread_items
         WHERE thread_id = ? AND item_id = ?`
      )
      .get(threadId, itemId) as { item_json: unknown } | undefined
    if (typeof item?.item_json !== 'string') return null

    let parsed: unknown
    try {
      parsed = JSON.parse(item.item_json)
    } catch {
      return null
    }
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (record.type !== 'userMessage') return null

    return joinTextParts(record.content)
  })
}
