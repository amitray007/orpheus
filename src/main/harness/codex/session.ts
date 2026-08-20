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
// ACCEPTED RISK — a bound id that Codex later can't resume. `codex archive`
// and `codex delete` (both real subcommands, per `codex --help`) can remove
// a session Orpheus has already bound. What `codex resume <id>` does for a
// valid-shaped-but-gone id was deliberately NOT tested against a real
// session (this unit is static-verification-only — no live Codex process,
// per its own test discipline). If that hard-errors instead of falling back
// to a fresh session, a workspace with a since-deleted binding would fail to
// launch rather than degrade — this codebase's launch composition
// (composeCodexHarnessLaunch) is synchronous and pre-spawn, with no
// visibility into what the spawned process actually does, so it cannot
// detect or recover from that at this layer. The window is narrow (the
// bound id always comes from a rollout Codex itself just wrote for this
// exact workspace; reaching this state requires the user to separately
// archive/delete that specific session between mounts) and accepted for v1.
// A future unit could mitigate by re-running discovery and clearing a stale
// binding when the corresponding rollout is confirmed gone, but that needs
// a verified read on Codex's actual resume-of-deleted-session behavior
// first — do not guess at recovery logic without that.
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
 *      session that predates this mount (including one from a user running
 *      `codex` by hand in the same cwd before Orpheus ever launched it).
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

function codexSessionsRoot(): string {
  return nodePath.join(os.homedir(), '.codex', 'sessions')
}

/**
 * Runs discovery for one workspace against the real filesystem/DB and, if a
 * binding is found, persists it via setWorkspaceClaudeSessionId — the same
 * storage Claude's session-id lives in (harness-agnostic in practice despite
 * the Claude-branded column name; see workspaces.ts's own note on this and
 * the C5 task brief's finding that renaming it is a deliberately deferred,
 * separate change). Reusing it means codexSessionArgs and every existing
 * transcript/session-id reader downstream needs zero new plumbing.
 *
 * READ/WRITE DEFENSIVELY — this runs on a timer after launch, well outside
 * any request/response cycle a caller could handle an exception from.
 * Never throws; a failure here must never surface anywhere but silently
 * leaving the workspace unbound (falls back to a fresh session next mount,
 * exactly like "discovery found nothing").
 */
export function discoverAndBindCodexSession(workspaceId: string, mountFloorMs: number): void {
  try {
    const ws = getWorkspace(workspaceId)
    if (!ws) return
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
 * mountFloorMs is captured by the CALLER at composition time (i.e. "now",
 * before the process is even spawned) — see this file's header on the
 * mount-time floor's purpose. Passing it in rather than reading Date.now()
 * inside each retry keeps the floor fixed to when THIS launch was
 * requested, not when a given retry happens to fire.
 *
 * Uses unref'd timers so a pending discovery attempt can never keep the
 * main process alive on its own (mirrors the discipline every other
 * interval/timeout in this codebase follows for backstop timers).
 */
export function scheduleCodexSessionDiscovery(workspaceId: string, mountFloorMs: number): void {
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
      discoverAndBindCodexSession(workspaceId, mountFloorMs)
    }, delayMs)
    timer.unref?.()
  }
}

// ---------------------------------------------------------------------------
// Resume argv
// ---------------------------------------------------------------------------

/**
 * Composes the session-continuity argv tokens for a Codex workspace —
 * `['resume', <id>]` as the LEADING tokens (subcommand-first; see this
 * file's header on why order is load-bearing), or `[]` for a fresh launch.
 *
 * CAPABILITY GATING — same discipline as claudeSessionArgs:
 * capabilities.resume === false short-circuits to [] before touching the DB.
 *
 * Returns [] (never throws) when workspaceId is undefined, the workspace
 * can't be found, the DB read itself throws (see the try/catch — this keeps
 * a caller with no `workspaces` table, e.g. a narrower test fixture, from
 * crashing rather than degrading to "no binding"), or it has no bound
 * session id yet — matching claudeSessionArgs's early-return shape.
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

  return ['resume', ws.claudeSessionId]
}
