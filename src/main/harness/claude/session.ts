// ---------------------------------------------------------------------------
// src/main/harness/claude/session.ts
//
// U5 of the multi-harness migration plan — the PROOF CASE for the whole
// architecture. This is a PARALLEL implementation, not a relocation: the
// existing pushSessionContinuityFlags in src/main/claudeSettings.ts stays
// exactly as-is and keeps being composeClaudeLaunch's sole caller. U7's
// parity gate compares this module's output against that one; only after
// they agree does U9 cut the descriptor over. Until then, nothing here is
// reachable from the live launch path.
//
// The three-way branch below is ported VERBATIM in behavior from
// claudeSettings.ts's pushSessionContinuityFlags (~line 731) — same
// decisions, same flag order, same comment explaining WHY the fork case
// pre-assigns a UUID (that reasoning is hard-won; see the block comment on
// claudeSessionArgs below, carried across unchanged).
//
// WHY THIS BELONGS IN THE HARNESS MODULE: none of this generalizes.
// Codex resumes differently (if at all), and a harness with no resume
// capability needs the whole branch skipped, not reimplemented as a no-op
// elsewhere. Capability gating (capabilities.resume / capabilities.fork,
// resolved from the Claude descriptor via resolveHarness) is the actual
// point of this unit — see claudeSessionArgs's doc comment below.
// ---------------------------------------------------------------------------

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { getWorkspace } from '../../workspaces'
import { encodePathToClaudeDir } from '../../claudeProjectDir'
import { resolveHarness } from '../registry'

const HARNESS_ID = 'claude'

// One-way-true cache for session JSONL existence checks, mirroring
// claudeSettings.ts's sessionJsonlExistsCache exactly (same key shape, same
// "only cache the TRUE result" reasoning — claude never deletes a
// transcript mid-session, but a not-yet-written file can still appear on a
// later check). Kept as this module's OWN cache rather than importing the
// other one: sharing a cache across the two parallel implementations would
// let a false-positive in one silently mask a real bug in the other during
// U7's parity comparison.
const sessionJsonlExistsCache = new Map<string, true>()

// Returns true if claude's transcript file for this session already exists
// on disk. Path/encoding logic identical to claudeSettings.ts's
// sessionJsonlExists — see encodePathToClaudeDir's own doc comment for the
// slash-and-dot encoding rule.
function sessionJsonlExists(cwd: string, sessionId: string): boolean {
  const key = `${cwd}:${sessionId}`
  if (sessionJsonlExistsCache.has(key)) return true
  const encoded = encodePathToClaudeDir(cwd)
  const path = nodePath.join(os.homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`)
  try {
    const exists = fs.statSync(path).isFile()
    if (exists) sessionJsonlExistsCache.set(key, true)
    return exists
  } catch {
    return false
  }
}

/**
 * Composes the session-continuity argv tokens for a workspace — Claude's
 * `--resume`/`--session-id`/`--fork-session` flags. Mirrors
 * pushSessionContinuityFlags's three-way branch exactly:
 *
 *   1. transcript `.jsonl` already exists -> `['--resume', <claudeSessionId>]`
 *   2. no transcript, but forkedFromSessionId is set (Plan A fork,
 *      validated 2025-05) -> pre-assign our own UUID and branch from the
 *      parent transcript: every workspace ships with a pre-generated UUID
 *      (assigned in createWorkspace). On first launch, no .jsonl exists
 *      yet, so instead of a bare `--session-id <uuid>` we pass
 *      `['--session-id', <ourUuid>, '--resume', <parentId>, '--fork-session']`
 *      so claude creates an independent branch of the parent transcript
 *      under our UUID. This is deterministic and survives Orpheus restarts
 *      even if the user quits immediately after the first message.
 *      Subsequent launches fall through to branch 1 once the .jsonl exists.
 *   3. neither -> `['--session-id', <claudeSessionId>]` (normal first
 *      launch, no fork).
 *
 * CAPABILITY GATING — the actual point of this unit:
 *   - `capabilities.resume === false` short-circuits to `[]` unconditionally,
 *     before touching the DB or filesystem at all — a harness with no
 *     resume concept must not emit ANY continuity flags, fork included,
 *     even if a session id and a forkedFromSessionId are both present.
 *   - `capabilities.fork === false` disables ONLY branch 2. Branch 1 (plain
 *     resume) still applies once a transcript exists; a fork-less harness
 *     simply can't pre-branch on first launch, so that case falls through
 *     to branch 3 (bare `--session-id`) instead.
 * Capabilities are resolved from the Claude descriptor via resolveHarness
 * (src/main/harness/registry.ts), never hardcoded here — Claude's
 * descriptor has both `resume: true` and `fork: true` today, so behavior is
 * unchanged versus the unconditional pushSessionContinuityFlags.
 *
 * Returns `[]` (no throw) when workspaceId is undefined, the workspace
 * can't be found, or it has no claudeSessionId yet — matching
 * pushSessionContinuityFlags's early-return behavior.
 */
export function claudeSessionArgs(workspaceId?: string): string[] {
  const capabilities = resolveHarness(HARNESS_ID).capabilities
  if (!capabilities.resume) return []
  if (!workspaceId) return []

  const ws = getWorkspace(workspaceId)
  if (!ws?.claudeSessionId) return []

  if (sessionJsonlExists(ws.cwd, ws.claudeSessionId)) {
    // Session already exists — normal resume
    return ['--resume', ws.claudeSessionId]
  }

  if (capabilities.fork && ws.forkedFromSessionId) {
    // Plan A fork: pre-assign our UUID and branch from parent. Reuse the
    // already-loaded workspace record's field instead of a second DB query.
    return [
      '--session-id',
      ws.claudeSessionId,
      '--resume',
      ws.forkedFromSessionId,
      '--fork-session'
    ]
  }

  // Normal first launch (or fork capability disabled — falls back to a
  // plain new session rather than attempting an unsupported branch).
  return ['--session-id', ws.claudeSessionId]
}
