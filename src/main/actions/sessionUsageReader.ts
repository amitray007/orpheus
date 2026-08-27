// ---------------------------------------------------------------------------
// src/main/actions/sessionUsageReader.ts
//
// The harness seam for session.getUsage/session.getCost (Phase 1 of the
// footer-removal migration — see the task brief this unit was built from
// for the full context). Before this file existed, handleGetUsage/
// handleGetCost in ./session.ts unconditionally parsed CLAUDE's on-disk
// transcript (~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl) for every
// workspace, regardless of which harness actually owned it — correct for
// Claude, silently wrong (or simply empty/no-op) for Codex, whose usage
// data lives in a completely different on-disk shape and location (see
// src/main/harness/codex/usage.ts's header).
//
// SessionUsageReader is a small per-harness interface: "given a workspace,
// what does session.getUsage/getCost return for it". handleGetUsage/
// handleGetCost (./session.ts) now RESOLVE which reader owns a workspace's
// harness and delegate — they no longer assume Claude. The Claude reader
// wraps the EXACT SAME accumulator/cache machinery that already lived in
// session.ts (unchanged — see claudeUsageReader below), so Claude's
// behavior/perf characteristics (incremental byte-offset parsing, 30s TTL
// cache, chunked reads, UTF-8 boundary handling) are completely unaffected
// by this seam existing; it is a dispatch wrapper, not a rewrite.
//
// WHY A READER INTERFACE RATHER THAN A FIELD ON HarnessDescriptor
// (src/main/harness/registry.ts) — the shape the task brief itself
// suggested as an option. HarnessDescriptor lives in src/shared/harness/
// types.ts, which src/renderer also imports (check:arch enforces this);
// attaching Node-fs-touching reader functions to that type would put
// Node-only code on a type the renderer's bundle graph can reach, even if
// the renderer itself never calls the field. Keeping the registry
// ({claude, codex-cli} -> reader) OWNED HERE, in src/main/actions (a
// main-only module), keeps that boundary exactly where check:arch already
// draws it, at the cost of one extra small lookup table instead of a
// descriptor field. If a THIRD harness needs this and the pattern feels
// heavy, revisit then — for two harnesses, a plain Record is simpler than
// threading a new field through HarnessDescriptor's shared type and every
// existing descriptor literal.
//
// CAPABILITY GATING — the task brief is explicit that capabilities.usage
// being true does NOT by itself guarantee a working reader exists (e.g. a
// future third harness could declare usage: true before anyone wires its
// reader). getSessionUsageReader returns undefined for a harness with no
// registered reader, and handleGetUsage/handleGetCost treat that exactly
// like "no data available" (the same empty/unknown shape as a workspace
// with no session yet) — never a thrown error, never a fabricated value.
// ---------------------------------------------------------------------------

import type { SessionCost, SessionUsage, WorkspaceRecord } from '../../shared/types'
import { getCodexCost, getCodexUsage } from '../harness/codex/usage'

/** One harness's usage/cost data source. Both methods return `null` (never
 *  throw) when nothing can be resolved for this workspace — an unbound
 *  session, a missing/unreadable transcript, or any other "no data yet"
 *  case. `null` is the caller's cue to render the existing empty/unknown
 *  shape (SessionUsage.contextBudget: null, SessionCost.hasUnknownPricing:
 *  true) rather than a spinner that can never resolve or a fabricated
 *  number. */
export interface SessionUsageReader {
  getUsage(ws: WorkspaceRecord): Promise<SessionUsage | null>
  getCost(ws: WorkspaceRecord): Promise<SessionCost | null>
}

// Codex's reader — a thin adapter over src/main/harness/codex/usage.ts's
// pure functions, reshaped to this interface's ws-in shape (that module
// takes a bare claudeSessionId since it has no other dependency on the
// WorkspaceRecord type, keeping it a smaller, more independently testable
// surface — see its own header).
const codexUsageReader: SessionUsageReader = {
  getUsage: (ws) => getCodexUsage(ws.claudeSessionId),
  getCost: (ws) => getCodexCost(ws.claudeSessionId)
}

// Registry keyed by harness id. Claude has NO entry here — its reader is
// the pre-existing accumulator machinery already living in ./session.ts,
// wired directly into handleGetUsage/handleGetCost's dispatch (see that
// file) rather than routed through this table, so as to change exactly
// nothing about Claude's call path while still sharing the SAME "resolve
// harness -> read the right way" decision point conceptually. Only
// non-Claude readers live in this map.
const READERS: Record<string, SessionUsageReader | undefined> = {
  'codex-cli': codexUsageReader
}

/** Resolves the reader for a workspace's harness, or undefined for Claude
 *  (handled inline by the caller) or any harness with no registered reader
 *  yet — see this file's header on why "no reader" must degrade exactly
 *  like "no data", never throw or silently return zeros. `harnessId` absent
 *  (legacy workspace, pre-multi-harness) resolves to undefined here too —
 *  the caller's existing Claude-default path already handles that case,
 *  same as it always has. */
export function getSessionUsageReader(
  harnessId: string | null | undefined
): SessionUsageReader | undefined {
  if (!harnessId || harnessId === 'claude') return undefined
  return READERS[harnessId]
}
