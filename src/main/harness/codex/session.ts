// ---------------------------------------------------------------------------
// src/main/harness/codex/session.ts
//
// C5 of the multi-harness migration plan — binds a Codex workspace to its
// Codex session so reopening RESUMES the conversation instead of starting
// fresh. Read src/main/harness/claude/session.ts's header first: this file
// is Codex's analogue to claudeSessionArgs, but the underlying mechanism is
// the OPPOSITE shape.
//
// THE CORE ASYMMETRY. Claude: Orpheus MINTS the session id up front
// (crypto.randomUUID() in workspaces.ts's createWorkspace) and passes
// `--session-id <uuid>` — binding is known BEFORE launch. Codex: Codex mints
// its OWN id. There is no flag to pre-assign one (checked `codex --help`,
// `codex exec --help`, `codex resume --help` on codex-cli 0.148.0 — none
// expose an equivalent of Claude's `--session-id`). Binding must be
// DISCOVERED AFTER launch, by reading what Codex itself wrote to disk.
//
// WHERE CODEX WRITES ITS TRANSCRIPT ("rollout"). DATE-sharded, not
// cwd-sharded like Claude's ~/.claude/projects/<encoded-cwd>/:
//   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<YYYY-MM-DD>T<HH-MM-SS>-<uuid>.jsonl
// Line 1 of every rollout is a `session_meta` record:
//   {"timestamp": <ISO8601>, "type": "session_meta", "payload": {...}}
// with payload keys including `id`, `session_id`, `cwd`, `thread_source`.
//
// THE CRITICAL TRAP — id !== session_id, and this is the single most
// important fact this module is built around. Verified against real rollout
// files on a dev machine: a Codex run that spawns subagents produces ONE
// rollout file per subagent turn, each written under the PARENT's
// session_id but with the SUBAGENT's own id:
//   id=<root>      session_id=<root>      thread_source="user"      <- root
//   id=<subagent1> session_id=<root>      thread_source="subagent" <- child
//   id=<subagent2> session_id=<root>      thread_source="subagent" <- child
// (subagent rows additionally carry
// payload.source.subagent.thread_spawn.parent_thread_id). So `id` is a
// given thread's OWN id (matches the filename uuid); `session_id` is the
// ROOT session's id shared by every subagent spawned under it. Matching on
// session_id alone returns N files, mostly subagents, and `codex resume`
// wants the ROOT session's own id (which, for the root row, id ===
// session_id) — so discovery MUST filter to `thread_source === 'user'`.
// Every subagent row must be excluded, not merely deprioritized.
//
// RESUME ARGV SHAPE. `codex resume <SESSION_ID>` — `resume` is a SUBCOMMAND
// (verified: `codex --help` lists `resume` alongside `exec`/`review`/etc as
// one of codex's top-level Commands; `codex resume --help` shows
// `Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]`), so it MUST be the
// FIRST argv token(s) this harness emits — before -m/-c/any flag — or the
// CLI's arg parser won't recognise it as the subcommand at all. Deliberately
// NOT `codex resume --last`: --last is not workspace-scoped (it resumes
// whatever session was most recently active machine-wide, which could
// belong to a different project entirely) — Orpheus always resumes an
// EXPLICIT, previously-discovered id for THIS workspace.
//
// FAIL SOFT, ALWAYS. Codex's rollout layout is ACTIVELY MIGRATING (a
// `migrate-rollouts` subcommand and a `background_paginated_rollout_
// migration` feature flag both exist in 0.148.0's own command list) and
// `--ephemeral`-style invocations can suppress rollout persistence entirely.
// If discovery finds nothing, or the shape is unrecognized, or the
// filesystem throws, the workspace must still work — a fresh session, never
// a crash or a blocked mount. Every function below is written so a missing
// dir, a malformed line, or a throwing fs call degrades to "no binding"
// rather than propagating.
//
// THE MOUNT-TIME FLOOR — anchored to WORKSPACE CREATION, not "now". An
// earlier version of this module computed the floor as `Date.now()` at
// every `composeCodexHarnessLaunch` call (i.e. at every mount/remount) and
// passed that value all the way down to findCodexUserRolloutId's
// `mountFloorMs` parameter. That was broken: a rollout's `timestamp` is
// when Codex STARTED WRITING it — roughly when the Codex process for a
// workspace first launched — so on every REMOUNT of an already-used
// workspace, "now" (this remount's time) is always LATER than the
// workspace's own prior rollout's timestamp, and `timestampMs <
// mountFloorMs` rejected it unconditionally. Discovery could never
// rebind a returning workspace to its own session; only a same-second
// first-mount ever had a chance of passing.
//
// THE FIX: the floor is derived from the WORKSPACE'S OWN `createdAt` (see
// discoverAndBindCodexSession below), not from wall-clock "now" at mount
// time. `createdAt` is set exactly once, in workspaces.ts's
// createWorkspace(), and never updated again — so it is stable across
// every remount for that workspace's entire lifetime. It still
// discriminates correctly against the case the floor exists to guard
// against (a genuinely unrelated `codex` session the user ran BY HAND in
// the same cwd before Orpheus ever created this workspace): a workspace
// row must exist before Orpheus can launch Codex into it, so THIS
// workspace's own rollout can only ever be timestamped AT OR AFTER its
// `createdAt`, while a pre-existing manual session's rollout predates
// `createdAt` and is correctly excluded.
//
// MOUNT_FLOOR_GRACE_MS backs the floor off by a few minutes to absorb
// ordinary clock skew between the moment the workspace row is inserted
// (DB/Orpheus process clock) and the moment Codex's own process clock
// stamps its rollout's `session_meta.timestamp` — without materially
// reopening the door to a manual pre-existing session (see the constant's
// own comment below for the exact residual risk this accepts).
//
// findCodexUserRolloutId ITSELF is unchanged: it remains a pure function
// over an explicit `mountFloorMs` value supplied by its caller — only WHAT
// value discoverAndBindCodexSession computes and passes as that argument
// changed. This keeps findCodexUserRolloutId's own signature/tests (which
// exercise the floor logic directly, independent of where the floor comes
// from) stable.
//
// FIXED — a bound id that Codex later can't resume (was ACCEPTED RISK,
// v1). `codex archive`/`codex delete` (real subcommands per `codex --help`),
// a moved/reset CODEX_HOME, or an in-progress rollout-layout migration can
// all remove the rollout a bound id points at, and what `codex resume <id>`
// does for a valid-shaped-but-gone id was never verified against a real
// process (this unit stays static-verification-only — no live Codex, per
// its own test discipline) and was NOT worth the risk of finding out live:
// this codebase's launch composition (composeCodexHarnessLaunch) is
// synchronous and pre-spawn, with no visibility into what the spawned
// process actually does, so a hard error there could not be detected or
// recovered from at this layer. codexSessionArgs (below) now mirrors
// Claude's sessionJsonlExists discipline exactly: before emitting `resume`,
// it confirms the bound id's rollout can still be found on disk
// (codexRolloutExists, reusing findCodexRolloutFileById — the same "given an
// id, find its file right now" scan the usage/cost reader already needed),
// and degrades to a FRESH session ([]) rather than a hard error when it
// cannot. This closes the asymmetry with Claude's session.ts, which has
// always gated its own --resume emission the same way.
// ---------------------------------------------------------------------------

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { getWorkspace, setWorkspaceClaudeSessionId } from '../../workspaces'
import { CODEX_CAPABILITIES } from './curated'

// ---------------------------------------------------------------------------
// Pure discovery over an explicit sessions-root directory
// ---------------------------------------------------------------------------

/** One shard day's worth of candidate rollout file paths, or `[]` if the
 *  shard dir doesn't exist / can't be read — never throws. `date` identifies
 *  the shard by LOCAL calendar date (matches how codex names the dirs: the
 *  wall-clock date the process was on when it started writing). */
function listShardRolloutFiles(sessionsRoot: string, date: Date): string[] {
  const yyyy = String(date.getFullYear())
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const dir = nodePath.join(sessionsRoot, yyyy, mm, dd)
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.startsWith('rollout-') && name.endsWith('.jsonl'))
      .map((name) => nodePath.join(dir, name))
  } catch {
    // Shard dir doesn't exist (no Codex activity that day) or isn't
    // readable — both are "no candidates here", not an error.
    return []
  }
}

type SessionMetaPayload = {
  id?: unknown
  session_id?: unknown
  cwd?: unknown
  thread_source?: unknown
}

/** Reads and parses line 1 of a rollout file as a session_meta payload.
 *  Returns null for anything that doesn't parse as expected — a truncated
 *  write (Codex was killed mid-line), a non-JSON first line, a JSON value
 *  that isn't an object, or a read error (permissions, file removed between
 *  listing and reading) — never throws. */
function readSessionMeta(
  filePath: string
): { timestamp: string; payload: SessionMetaPayload } | null {
  let firstLine: string
  try {
    const contents = fs.readFileSync(filePath, 'utf8')
    const newlineIndex = contents.indexOf('\n')
    firstLine = newlineIndex === -1 ? contents : contents.slice(0, newlineIndex)
  } catch {
    return null
  }
  if (!firstLine.trim()) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(firstLine)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (record.type !== 'session_meta') return null
  if (typeof record.timestamp !== 'string') return null
  const payload: SessionMetaPayload | undefined = record.payload as SessionMetaPayload | undefined
  if (typeof payload !== 'object' || payload === null) return null
  return { timestamp: record.timestamp, payload }
}

/**
 * PURE discoverer (aside from the fs reads themselves — no DB, no
 * getWorkspace, no wall-clock `Date.now()` call inside): given the Codex
 * sessions root, a workspace cwd, and a `now`/`mountFloorMs` pair supplied
 * by the caller, returns the bound-worthy session id or null.
 *
 * `mountFloorMs` is an opaque cutoff to this function — it doesn't know or
 * care whether the caller derived it from wall-clock "now" or (as
 * discoverAndBindCodexSession now does — see this file's header) from the
 * workspace's own `createdAt`. This function's contract is purely "exclude
 * anything timestamped before this value"; where that value comes from is
 * entirely the caller's concern.
 *
 * MATCHING RULE (the whole point of this unit):
 *   1. Only files whose shard day is `now`'s calendar date OR the day
 *      before (the midnight-boundary case: a workspace mounted at 00:02
 *      must still find a rollout written at 23:58 the prior day if the
 *      Codex process itself started before midnight).
 *   2. Only rows where `payload.thread_source === 'user'` — excludes every
 *      subagent row unconditionally, even though subagent rows share the
 *      real session's session_id (see this file's header).
 *   3. Only rows where `payload.cwd === cwd` (exact string match — no
 *      normalization, matching how Claude's own sessionJsonlExists keys on
 *      an exact cwd string today).
 *   4. Only rows whose `timestamp` is >= `mountFloorMs` — excludes a stale
 *      session that predates the floor (including one from a user running
 *      `codex` by hand in the same cwd before Orpheus ever created this
 *      workspace).
 *   5. Among survivors, the NEWEST by timestamp wins; its `payload.id` (the
 *      thread's own id, not `session_id`) is returned.
 * Malformed/missing files, empty shard dirs, and an all-excluded candidate
 * set all fall through to `null` — never throw.
 */
export function findCodexUserRolloutId(
  sessionsRoot: string,
  cwd: string,
  mountFloorMs: number,
  now: Date = new Date()
): string | null {
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const candidateFiles = [
    ...listShardRolloutFiles(sessionsRoot, yesterday),
    ...listShardRolloutFiles(sessionsRoot, now)
  ]

  let best: { id: string; timestampMs: number } | null = null
  for (const filePath of candidateFiles) {
    const meta = readSessionMeta(filePath)
    if (!meta) continue
    const { payload } = meta
    if (payload.thread_source !== 'user') continue
    if (payload.cwd !== cwd) continue
    if (typeof payload.id !== 'string' || !payload.id) continue
    const timestampMs = Date.parse(meta.timestamp)
    if (!Number.isFinite(timestampMs)) continue
    if (timestampMs < mountFloorMs) continue
    if (best === null || timestampMs > best.timestampMs) {
      best = { id: payload.id, timestampMs }
    }
  }
  return best?.id ?? null
}

// ---------------------------------------------------------------------------
// Impure wiring — resolving the real sessions root, the real workspace, and
// persisting the result
// ---------------------------------------------------------------------------

export function codexSessionsRoot(): string {
  // $CODEX_HOME relocates Codex's entire state dir — it is a real, documented
  // knob (`codex -p/--profile`'s own help refers to
  // "$CODEX_HOME/<name>.config.toml"). Honouring it matters because the
  // failure mode is SILENT: scanning ~/.codex when Codex is writing rollouts
  // elsewhere finds no candidates, so discovery just never binds and every
  // reopen starts a fresh session with no error anywhere.
  const codexHome = process.env['CODEX_HOME']?.trim()
  const home = codexHome && codexHome.length > 0 ? codexHome : nodePath.join(os.homedir(), '.codex')
  return nodePath.join(home, 'sessions')
}

// Backward grace subtracted from a workspace's own `createdAt` before it is
// used as the discovery floor. Absorbs ordinary clock skew between the
// moment the workspace row is inserted (Orpheus's DB/process clock) and the
// moment Codex's own process clock stamps its rollout's
// `session_meta.timestamp` for the very first turn of that same workspace —
// without materially reopening the door to the case the floor exists to
// exclude (a genuinely unrelated `codex` session the user ran by hand in
// the same cwd before Orpheus ever created this workspace).
//
// ACCEPTED RESIDUAL RISK: a manual `codex` session started in the exact same
// cwd within this window (5 minutes) IMMEDIATELY BEFORE Orpheus creates the
// workspace would still be found and bound — this is a strictly narrower
// window than "no floor at all" but is not zero. Widening the grace only
// widens this window further, so 5 minutes was chosen as generous enough to
// absorb realistic clock skew (seconds, not minutes, in practice) while
// keeping the false-positive window small.
const MOUNT_FLOOR_GRACE_MS = 5 * 60 * 1000

/**
 * Runs discovery for one workspace against the real filesystem/DB and, if a
 * binding is found, persists it via setWorkspaceClaudeSessionId — the same
 * storage Claude's session-id lives in (harness-agnostic in practice despite
 * the Claude-branded column name; see workspaces.ts's own note on this and
 * the C5 task brief's finding that renaming it is a deliberately deferred,
 * separate change). Reusing it means codexSessionArgs and every existing
 * transcript/session-id reader downstream needs zero new plumbing.
 *
 * THE FLOOR IS COMPUTED HERE, from the workspace's own `createdAt` (minus
 * MOUNT_FLOOR_GRACE_MS) — NOT passed in by the caller. This is the fix for
 * the remount-never-binds bug this file's header describes: `createdAt` is
 * set once at workspace creation and never changes, so unlike a
 * `Date.now()`-at-mount-time floor, this value doesn't move forward on
 * every remount, while still excluding a rollout that predates this
 * workspace's own existence.
 *
 * READ/WRITE DEFENSIVELY — this runs on a timer after launch, well outside
 * any request/response cycle a caller could handle an exception from.
 * Never throws; a failure here must never surface anywhere but silently
 * leaving the workspace unbound (falls back to a fresh session next mount,
 * exactly like "discovery found nothing").
 */
export function discoverAndBindCodexSession(workspaceId: string): void {
  try {
    const ws = getWorkspace(workspaceId)
    if (!ws) return
    const mountFloorMs = ws.createdAt - MOUNT_FLOOR_GRACE_MS
    const foundId = findCodexUserRolloutId(codexSessionsRoot(), ws.cwd, mountFloorMs)
    if (!foundId) return
    setWorkspaceClaudeSessionId(workspaceId, foundId)
  } catch {
    // Filesystem or DB hiccup — leave the workspace unbound rather than
    // crash whatever timer invoked this.
  }
}

// Discovery delay + retry schedule. A rollout file doesn't necessarily exist
// the instant `codex` is exec'd (process startup, auth, first-turn
// buffering before the session_meta line is flushed), so a single
// immediate check would race the write. Multiple short-interval attempts
// give the common case (session_meta written within the first second or two)
// a real chance without polling indefinitely for the uncommon case (Codex
// never got far enough to write one — e.g. exited immediately with an auth
// error) which is exactly the "fail soft" case this module must not spin on.
const DISCOVERY_RETRY_DELAYS_MS = [1500, 4000, 10000]

/**
 * Fire-and-forget: schedules discoverAndBindCodexSession at increasing
 * delays after a Codex launch, stopping early once a binding is found.
 * Called from launch.ts on every composeCodexHarnessLaunch invocation — see
 * that file for why launch-time (not a dedicated post-mount hook this unit
 * doesn't own a call site for) is the trigger point.
 *
 * NO TIME ARGUMENT — the discovery floor is no longer a "now, at compose
 * time" value the caller computes and threads through. discoverAndBind-
 * CodexSession derives its own floor from the workspace's own `createdAt`
 * (see that function's doc comment and this file's header), which is
 * already stable across retries/remounts, so there is nothing time-related
 * for this function or launch.ts to compute or pass anymore.
 *
 * Uses unref'd timers so a pending discovery attempt can never keep the
 * main process alive on its own (mirrors the discipline every other
 * interval/timeout in this codebase follows for backstop timers).
 */
export function scheduleCodexSessionDiscovery(workspaceId: string): void {
  for (const delayMs of DISCOVERY_RETRY_DELAYS_MS) {
    const timer = setTimeout(() => {
      try {
        const ws = getWorkspace(workspaceId)
        // Stop retrying once bound (this mount's own discovery already
        // wrote a fresh id) or once the workspace is gone.
        if (!ws || ws.claudeSessionId) return
      } catch {
        return
      }
      discoverAndBindCodexSession(workspaceId)
    }, delayMs)
    timer.unref?.()
  }
}

// ---------------------------------------------------------------------------
// Resume argv
// ---------------------------------------------------------------------------

// One-way-true cache for "does a rollout file for this bound id still exist"
// checks — same shape and same reasoning as Claude's session.ts
// sessionJsonlExistsCache: a rollout, once confirmed present, is never
// deleted mid-session by ordinary use, but a not-yet-flushed rollout can
// legitimately appear absent on an earlier check and present on a later one,
// so only the TRUE result is safe to cache. Keyed on the id alone (unlike
// Claude's `${cwd}:${sessionId}` key) because findCodexRolloutFileById's own
// contract is id-only — it does not take or filter on cwd (see that
// function's doc comment).
const codexRolloutExistsCache = new Map<string, true>()

/**
 * Returns true if a rollout file for this bound Codex session id can still
 * be found on disk. THE FIX for the bug this module's header now documents:
 * codexSessionArgs used to emit `['resume', id]` for ANY non-null bound id,
 * with no check that Codex could actually resume it. A rollout can vanish
 * out from under a bound id — `codex archive`/`codex delete` (real
 * subcommands per `codex --help`), a moved/reset CODEX_HOME, or an
 * in-progress rollout-layout migration (`migrate-rollouts` — see this
 * module's header) — and `codex resume <gone-id>` was never verified to
 * degrade gracefully; per the header's "ACCEPTED RISK" note, the safer
 * choice is to never ask Codex to resume an id this process cannot itself
 * confirm still has a transcript, and fall back to a fresh session instead.
 *
 * Reuses findCodexRolloutFileById (below) rather than re-implementing a scan
 * — that function already answers exactly this question ("given a bound id,
 * which file holds its data right now") for the usage/cost reader; a
 * from-scratch existence check here would be the same scan maintained twice.
 *
 * Read defensively: findCodexRolloutFileById already never throws (its own
 * doc comment), so nothing further to catch here.
 */
function codexRolloutExists(sessionId: string): boolean {
  if (codexRolloutExistsCache.has(sessionId)) return true
  const found = findCodexRolloutFileById(codexSessionsRoot(), sessionId) !== null
  if (found) codexRolloutExistsCache.set(sessionId, true)
  return found
}

/**
 * Composes the session-continuity argv tokens for a Codex workspace —
 * `['resume', <id>]` as the LEADING tokens (subcommand-first; see this
 * file's header on why order is load-bearing), or `[]` for a fresh launch.
 *
 * CAPABILITY GATING — same discipline as claudeSessionArgs:
 * capabilities.resume === false short-circuits to [] before touching the DB.
 *
 * EXISTENCE-GATED — mirrors claudeSessionArgs's sessionJsonlExists check:
 * a bound id whose rollout is no longer found on disk degrades to a FRESH
 * session ([]) rather than emitting `resume` against an id Codex itself may
 * no longer be able to resume. See codexRolloutExists's doc comment for why
 * this exists and what it guards against.
 *
 * Returns [] (never throws) when workspaceId is undefined, the workspace
 * can't be found, the DB read itself throws (see the try/catch — this keeps
 * a caller with no `workspaces` table, e.g. a narrower test fixture, from
 * crashing rather than degrading to "no binding"), it has no bound session
 * id yet, or the bound id's rollout can no longer be found — matching
 * claudeSessionArgs's early-return shape.
 */
export function codexSessionArgs(workspaceId?: string): string[] {
  const capabilities = CODEX_CAPABILITIES
  if (!capabilities.resume) return []
  if (!workspaceId) return []

  let ws: ReturnType<typeof getWorkspace>
  try {
    ws = getWorkspace(workspaceId)
  } catch {
    return []
  }
  if (!ws?.claudeSessionId) return []
  if (!codexRolloutExists(ws.claudeSessionId)) return []

  return ['resume', ws.claudeSessionId]
}

// ---------------------------------------------------------------------------
// Id -> rollout file path (title-bar usage/cost seam, support-multi-harness
// Phase 1)
//
// findCodexUserRolloutId (above) answers "what id should this workspace
// bind to at mount time" — it is a DISCOVERY function, run once per launch,
// that never needs to go back further than yesterday's shard (a workspace
// mounts, at most, a day or so after Codex last wrote to it before this
// runs). The usage/cost reader has a DIFFERENT question: "given an id THIS
// WORKSPACE ALREADY BOUND, possibly weeks ago, which file holds its
// token_count/rate_limits data RIGHT NOW". A long-lived workspace can sit
// unopened for a long time — the bound id doesn't expire, so limiting this
// scan to yesterday/today would silently stop finding usage data for any
// workspace not opened within a day of its last Codex turn.
//
// SCAN WINDOW — bounded, not unbounded. Walking every year/month/day
// directory under sessionsRoot to find one id would be an unbounded
// filesystem walk that gets slower the longer a user has been running
// Codex; that cost is paid on every title-bar usage/cost fetch, not just
// once at mount. ROLLOUT_ID_LOOKBACK_DAYS below caps it to a fixed, cheap
// number of shard-day directory listings — generous enough to cover a
// workspace reopened well after its last Codex activity, without scanning
// the user's entire Codex history on every poll. A workspace older than the
// window degrades to "usage unavailable" (see the reader module), which is
// the correct honest answer for data this function genuinely can't find
// cheaply — not a crash, not a fabricated number.
const ROLLOUT_ID_LOOKBACK_DAYS = 60

/**
 * Finds the rollout file whose `session_meta.payload.id` equals `sessionId`,
 * scanning shard days backward from `now` (inclusive) for up to
 * ROLLOUT_ID_LOOKBACK_DAYS days. Returns the file path, or null if no shard
 * day in the window contains a matching `session_meta` line — never throws
 * (mirrors every other function in this module's fail-soft discipline;
 * listShardRolloutFiles/readSessionMeta already swallow their own I/O
 * errors, so this function's own body has nothing further to catch).
 *
 * Unlike findCodexUserRolloutId, this does NOT filter on `thread_source` or
 * `cwd` — the caller already knows the exact id it's looking for (it came
 * from this workspace's own persisted binding), so there is no ambiguity to
 * resolve by cwd/thread-source matching; the id itself is the sole key.
 */
export function findCodexRolloutFileById(
  sessionsRoot: string,
  sessionId: string,
  now: Date = new Date()
): string | null {
  for (let dayOffset = 0; dayOffset < ROLLOUT_ID_LOOKBACK_DAYS; dayOffset++) {
    const day = new Date(now.getTime() - dayOffset * 24 * 60 * 60 * 1000)
    const candidateFiles = listShardRolloutFiles(sessionsRoot, day)
    for (const filePath of candidateFiles) {
      const meta = readSessionMeta(filePath)
      if (!meta) continue
      if (meta.payload.id === sessionId) return filePath
    }
  }
  return null
}
