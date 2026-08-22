// ---------------------------------------------------------------------------
// src/main/harness/codex/usage.ts
//
// Codex's usage/cost reader — Phase 1 of the footer-removal migration
// (title-bar Context/Cost chips). Read src/main/actions/session.ts's header
// first: THAT file's incremental accumulator is Claude-transcript-shaped
// (~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl, an assistant-message-
// per-line format with per-turn `usage` blocks) and was never meant to
// parse Codex's rollout files, which are a completely different on-disk
// shape — see src/main/harness/codex/session.ts's header for the rollout
// path/format itself and src/main/harness/codex/actions.ts's header for WHY
// Context/Cost were deliberately excluded from Codex's footer actions until
// a reader like this one existed.
//
// THE ROLLOUT FACTS THIS MODULE RELIES ON — verified against REAL rollout
// files on this machine (557 files under ~/.codex/sessions), not just the
// single-file sample the originating task brief described. Every line where
// `payload.type === 'token_count'` (record shape
// `{"type":"event_msg","payload":{"type":"token_count", ...}}`) carries a
// full per-turn AND cumulative token breakdown — richer than the task
// brief's own note (which only mentioned a combined `total_tokens`):
//
//   payload.info.total_token_usage = {
//     input_tokens, cached_input_tokens, cache_write_input_tokens,
//     output_tokens, reasoning_output_tokens, total_tokens
//   }                                          — CUMULATIVE across the session
//   payload.info.last_token_usage             — SAME shape, MOST RECENT turn only
//   payload.info.model_context_window          — e.g. 258400 (this model's window)
//   payload.rate_limits.primary.used_percent   — a PLAN-LEVEL usage percentage,
//     NOT context-window occupancy; deliberately unused here (see
//     getCodexUsage's own doc comment on this distinction).
//
// The session's MODEL is not on the token_count line itself — it's read
// from the last `turn_context` record's `payload.model` field instead (also
// verified against real rollout files), since a Codex session can in
// principle switch models turn-to-turn and the token_count line doesn't
// repeat which model produced it.
//
// These are POINT-IN-TIME SNAPSHOTS, not deltas to sum (unlike Claude's
// per-turn token counts, which the accumulator adds up across turns) — so
// this reader only ever needs the LAST such line in the file, never a
// running total across all of them. That is also why there is no
// accumulator/cache/byte-offset machinery here: re-reading and re-parsing
// the whole rollout file on each call is the correct, simplest approach for
// "read the last matching line", and Codex rollout files are turn-count-
// bounded (not multi-megabyte transcripts spanning weeks like a long-lived
// Claude session can be) — if this ever becomes a hot path worth
// optimizing, mirror actions/session.ts's incremental-accumulator approach
// then, not preemptively here.
//
// COST — resolved from models.dev's "openai" provider bucket ONLY, via
// sources/modelsDev.ts's getOpenAiPricingById, NOT the shared flattened
// registry (src/main/models/registry.ts's resolveModel) Claude's cost path
// uses. This is a DELIBERATE DIVERGENCE from Claude's path, found and fixed
// after empirical verification: resolveModel()/modelsDevSource flattens
// EVERY provider's models into one id->entry map with a first-provider-wins
// rule, and for 6 of the 7 Codex model ids in CODEX_MODEL_SLUGS
// (curated.ts), a RESELLER bucket (ai-router, xpersona) wins that flatten
// ahead of "openai" — sometimes at a wildly different price (gpt-5.6-luna:
// ai-router $1/$6 per M vs OpenAI's own $0.20/$1.20, a 5x overstatement).
// See getCodexCost's own doc comment below for the full verified numbers
// and getOpenAiPricingById's doc comment (sources/modelsDev.ts) for how the
// first-party bucket is kept separately from the flatten. Unknown pricing
// (a model id the "openai" bucket doesn't carry at all, or a stale/renamed
// slug) degrades to hasUnknownPricing: true, never a fabricated number and
// never a silent fallback to the flattened/reseller price.
//
// cache_write_input_tokens maps to Pricing.cacheWrite; cached_input_tokens
// maps to Pricing.cacheRead — Codex's naming ("cached" for reads, "cache
// write" for writes) mirrors Claude's cache_read_input_tokens /
// cache_creation_input_tokens distinction closely enough that no relabeling
// is needed beyond the obvious field mapping in toCodexCost below.
// reasoning_output_tokens is a SUBSET of output_tokens (verified: every
// sampled line has reasoning_output_tokens <= output_tokens), not an
// additional bucket — so it is not priced separately here, matching how
// Claude's own accumulator has no separate "reasoning tokens" concept
// either.
// ---------------------------------------------------------------------------

import * as fs from 'node:fs'
import type { SessionCost, SessionUsage } from '../../../shared/types'
import { getOpenAiPricingById } from '../../models/sources/modelsDev'
import { findCodexRolloutFileById, codexSessionsRoot } from './session'

// Minimal shape of the two record types this reader reads — only the
// fields actually accessed. Codex's own event stream is not a contract
// Orpheus owns, so a field this module doesn't recognize (or one Codex
// renames in a future version) must degrade to "unknown", never throw.
type CodexTokenBucket = {
  input_tokens?: number
  cached_input_tokens?: number
  cache_write_input_tokens?: number
  output_tokens?: number
  total_tokens?: number
}

type CodexRolloutLine = {
  type?: string
  payload?: {
    type?: string
    info?: {
      total_token_usage?: CodexTokenBucket
      last_token_usage?: CodexTokenBucket
      model_context_window?: number
    }
    model?: string
  }
}

type ParsedCodexUsage = {
  /** Cumulative totals across the whole session — used for cost. */
  total: CodexTokenBucket
  /** Most-recent-turn-only totals — used for the context-occupancy chip. */
  lastTurn: CodexTokenBucket
  contextWindow: number | null
  /** The model the LAST turn_context line in the file reports, or null if
   *  the rollout has no turn_context line yet (e.g. zero turns taken). */
  model: string | null
}

type LastTokenCount = { total: CodexTokenBucket; lastTurn: CodexTokenBucket; ctx: number | null }

/** Scans every line for `event_msg`/`token_count` records and returns the
 *  LAST one's fields, or null if none were found. Split out of
 *  parseCodexUsageFromRolloutFile (alongside findLastTurnContextModel
 *  below) purely to keep each pass's own branching under the cognitive-
 *  complexity ceiling — the two passes are logically independent (different
 *  top-level `type` values, see this file's header) and were never sharing
 *  state, so splitting them changes nothing about behavior. */
function findLastTokenCount(lines: string[]): LastTokenCount | null {
  let last: LastTokenCount | null = null
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    let parsed: CodexRolloutLine
    try {
      parsed = JSON.parse(line) as CodexRolloutLine
    } catch {
      continue
    }
    if (parsed.type !== 'event_msg' || parsed.payload?.type !== 'token_count') continue
    const info = parsed.payload.info
    if (!info?.total_token_usage) continue
    last = {
      total: info.total_token_usage,
      lastTurn: info.last_token_usage ?? info.total_token_usage,
      ctx: typeof info.model_context_window === 'number' ? info.model_context_window : null
    }
  }
  return last
}

/** Scans every line for top-level `turn_context` records and returns the
 *  LAST one's `payload.model`, or null if none were found. turn_context is
 *  its own top-level `type`, not an event_msg payload variant — read
 *  separately from token_count (see this file's header sample). */
function findLastTurnContextModel(lines: string[]): string | null {
  let last: string | null = null
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    let parsed: { type?: string; payload?: { model?: string } }
    try {
      parsed = JSON.parse(line) as { type?: string; payload?: { model?: string } }
    } catch {
      continue
    }
    if (parsed.type === 'turn_context' && typeof parsed.payload?.model === 'string') {
      last = parsed.payload.model
    }
  }
  return last
}

/**
 * Reads a Codex rollout file end-to-end and returns the fields from the
 * LAST `token_count` event_msg line plus the LAST `turn_context` line's
 * model, or null if the file has no token_count line at all (a session
 * with no turns yet, or one whose rollout predates Codex emitting this
 * event type). Never throws — a missing file, a read error, or a malformed
 * line all degrade to null/skip respectively, matching every other
 * Codex-facing reader in this codebase's fail-soft discipline.
 *
 * Whole-file read (not the incremental byte-offset accumulator
 * actions/session.ts uses for Claude) — see this file's header for why
 * that's the right tradeoff here.
 */
export function parseCodexUsageFromRolloutFile(filePath: string): ParsedCodexUsage | null {
  let contents: string
  try {
    contents = fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }

  const lines = contents.split('\n')
  const lastTokenCount = findLastTokenCount(lines)
  if (!lastTokenCount) return null

  return {
    total: lastTokenCount.total,
    lastTurn: lastTokenCount.lastTurn,
    contextWindow: lastTokenCount.ctx,
    model: findLastTurnContextModel(lines)
  }
}

/** Resolves a bound Codex session id to its rollout file path, or null if
 *  no workspace/binding/file can be found — see findCodexRolloutFileById's
 *  own doc comment for the bounded lookback window this relies on. Never
 *  throws (delegates entirely to functions that already don't). */
function resolveRolloutPath(claudeSessionId: string | null): string | null {
  if (!claudeSessionId) return null
  return findCodexRolloutFileById(codexSessionsRoot(), claudeSessionId)
}

/** Sum of every token bucket field — used for the per-turn context-chip
 *  occupancy figure, mirroring actions/session.ts's
 *  accumulateAssistantUsage's `lastTurnContextTokens` composition (input +
 *  cache-read + cache-write + output, all resident in the window). */
function bucketTotal(bucket: CodexTokenBucket): number {
  return (
    (bucket.input_tokens ?? 0) +
    (bucket.cached_input_tokens ?? 0) +
    (bucket.cache_write_input_tokens ?? 0) +
    (bucket.output_tokens ?? 0)
  )
}

/**
 * Codex's usage reader — see src/main/actions/sessionUsageReader.ts for the
 * SessionUsageReader interface this implements and how it's dispatched to.
 *
 * contextBudget is read DIRECTLY from the rollout's own
 * model_context_window field — unlike Claude's path (which resolves budget
 * from the model registry because Claude's transcript doesn't carry its own
 * context-window size), Codex's rollout already reports the ACTUAL window
 * the running session is using, which is strictly more accurate than a
 * registry guess keyed off a possibly-stale model id. null when the field
 * is missing or the rollout can't be found at all — never fabricated.
 *
 * `rate_limits.primary.used_percent` (verified present on every sampled
 * token_count line) is DELIBERATELY NOT used for usedPct here — it's a
 * plan-level rate-limit consumption figure (resets on a rolling window,
 * e.g. "6% of your weekly Codex plan quota used"), a completely different
 * concept from "how full is the CURRENT turn's context window" that the
 * context chip exists to show. Conflating the two would silently misreport
 * one as the other — see the task brief this unit was built from for the
 * same warning.
 */
// NOT `async` — every step here is synchronous (fs.readFileSync,
// JSON.parse), so there is no `await` to make an async function body
// meaningful (the lint ratchet's @typescript-eslint/require-await flags
// exactly this). The Promise-returning SIGNATURE is still required by
// SessionUsageReader (sessionUsageReader.ts) — Promise.resolve(...) below
// satisfies it without a pointless `async` keyword.
export function getCodexUsage(claudeSessionId: string | null): Promise<SessionUsage | null> {
  const filePath = resolveRolloutPath(claudeSessionId)
  if (!filePath) return Promise.resolve(null)
  const parsed = parseCodexUsageFromRolloutFile(filePath)
  if (!parsed) return Promise.resolve(null)

  const contextBudget = parsed.contextWindow
  const lastTurnContextTokens = bucketTotal(parsed.lastTurn)
  const usedPct =
    contextBudget && contextBudget > 0
      ? Math.min((lastTurnContextTokens / contextBudget) * 100, 100)
      : 0

  return Promise.resolve({
    inputTokens: parsed.total.input_tokens ?? 0,
    outputTokens: parsed.total.output_tokens ?? 0,
    cacheReadTokens: parsed.total.cached_input_tokens ?? 0,
    cacheCreationTokens: parsed.total.cache_write_input_tokens ?? 0,
    lastTurnContextTokens,
    contextBudget,
    usedPct
  })
}

/**
 * Codex's cost reader. Unlike getCodexUsage (which reports the CURRENT
 * turn's occupancy), cost is computed from the CUMULATIVE total_token_usage
 * bucket — the same "sum of everything this session has spent" concept
 * Claude's accumulator tracks via tokensByModel.
 *
 * The model used for pricing is read from the ROLLOUT ITSELF (the last
 * `turn_context` line's `model` field) rather than passed in by the caller
 * — this is what the tokens were ACTUALLY billed against, which can differ
 * from a workspace's current effective-settings model if the user switched
 * models mid-session (Codex's model switch is `restartRequired`, so this
 * is rare in practice, but reading the rollout's own record is strictly
 * more honest than trusting a value from a different source). Falls back to
 * unknown pricing (never a fabricated $0.00) when the rollout has no
 * turn_context line yet (zero turns taken) or the reported model doesn't
 * resolve to known pricing.
 *
 * KNOWN LIMITATION (accepted for v1, same reasoning the task brief calls
 * out): a Codex session that switched models mid-session has its ENTIRE
 * cumulative token total priced against only the LATEST model, understating
 * or overstating cost for turns run under an earlier model — Codex's
 * rollout token_count lines don't carry a per-model breakdown the way
 * Claude's transcript does (each line is a session-wide running total, not
 * tagged by which model produced it), so there is no data source here to
 * split it correctly. Honest single-model attribution beats a fabricated
 * per-model split assembled from data the rollout doesn't expose in that
 * shape.
 *
 * PRICING PROVENANCE — HAZARD FOUND AND FIXED. Verified by fetching
 * https://models.dev/api.json live and replaying modelsDev.ts's own
 * buildCatalogFromResponse flattening rule ("first provider to mention an
 * id, in the JSON's own provider-key order, wins") against all 7 of
 * curated.ts's CODEX_MODEL_SLUGS:
 *
 *   gpt-5.6-sol            -> flattened winner: "ai-router" RESELLER bucket
 *   gpt-5.6-terra          -> flattened winner: "ai-router" RESELLER bucket
 *   gpt-5.6-luna           -> flattened winner: "ai-router" RESELLER bucket
 *   gpt-5.5                -> flattened winner: "ai-router" RESELLER bucket
 *   gpt-5.4                -> flattened winner: "ai-router" RESELLER bucket
 *   gpt-5.4-mini           -> flattened winner: "xpersona" RESELLER bucket
 *   gpt-5.3-codex-spark    -> flattened winner: OpenAI's own "openai" bucket
 *                             (only provider that lists it — no collision)
 *
 * So 6 of 7 Codex models WOULD price off a THIRD-PARTY RESELLER'S
 * advertised rate under the old flattened-registry path, not OpenAI's own
 * published rate — and the divergence is REAL, not just theoretical
 * (re-verified directly against the "openai" vs. reseller cost objects, not
 * just which bucket wins the flatten):
 *
 *   gpt-5.6-luna: ai-router input $1/M, output $6/M  vs.  openai input
 *     $0.20/M, output $1.20/M — the reseller price is 5x OpenAI's own.
 *   gpt-5.4-mini: xpersona input $0.375/M, output $4/M  vs.  openai input
 *     $0.75/M, output $4.5/M — the reseller price UNDERSTATES OpenAI's own
 *     by roughly 2x.
 *
 * A cost figure that is 5x too high (or 2x too low) still reads as
 * authoritative — worse than showing none. So this reader resolves pricing
 * via sources/modelsDev.ts's getOpenAiPricingById, which is built as its
 * OWN map scoped to ONLY the "openai" provider bucket, alongside the
 * flattened `entries`/anthropicModelIds in the same buildCatalogFromResponse
 * pass (identical shape/lifecycle to anthropicModelIds — see that field's
 * own doc comment) — instead of the flattened, reseller-susceptible
 * resolveModel()/modelsDevSource path. The shared flattened catalog itself
 * is UNCHANGED and still exclusively serves Claude's cost path, the model
 * picker, and cliproxy — this divergence is Codex-cost-path-only.
 *
 * FALLBACK POLICY: FIRST-PARTY ONLY, never first-party-then-reseller. If a
 * Codex model id is not in the "openai" bucket at all
 * (getOpenAiPricingById returns undefined) or the bucket carries it with no
 * cost data (returns null), this degrades straight to
 * hasUnknownPricing: true — it NEVER falls back to the flattened/reseller
 * price. Falling back would silently reintroduce the exact hazard this fix
 * removes: a wrong number that looks as authoritative as a right one.
 *
 * TIERED PRICING (context_over_200k et al.) — KNOWN, ACCEPTED
 * SIMPLIFICATION, not implemented here. Some "openai"-bucket entries carry
 * a `tiers` array that roughly doubles the rate above a per-model context
 * threshold (e.g. gpt-5.4: base input $2.50/M, output $15/M; tiered (>=
 * 272k context) input $5/M, output $22.5/M). Only the base tier is used —
 * see buildCatalogFromResponse's own comment (sources/modelsDev.ts) for why
 * correct tiered/blended accounting is out of scope this phase (it needs
 * per-request context-size attribution Codex's rollout doesn't expose in a
 * usable shape). A session that genuinely crossed the threshold is
 * under-priced by this reader — an accepted, documented gap, not an
 * oversight.
 *
 * HOW REACHABLE IS THAT GAP, measured rather than assumed: the tier fires at
 * 272,000 context tokens, which is exactly the MAXIMUM context window every
 * tiered Codex model advertises (`codex debug models`: all six report
 * context_window=272000; gpt-5.3-codex-spark is 128000 and carries no tiers
 * at all). A live rollout on this machine reported
 * model_context_window=258400 — BELOW the threshold. So the higher tier is
 * only reachable by a session running at essentially the full window, and is
 * unreachable entirely at the effective window Codex actually reports. The
 * base tier is therefore the right default, not merely the convenient one.
 * Revisit if Codex ever raises the effective window past 272k.
 */
// NOT `async` — see getCodexUsage's own comment on why; same reasoning
// applies here verbatim (getOpenAiPricingById is synchronous too).
export function getCodexCost(claudeSessionId: string | null): Promise<SessionCost | null> {
  const filePath = resolveRolloutPath(claudeSessionId)
  if (!filePath) return Promise.resolve(null)
  const parsed = parseCodexUsageFromRolloutFile(filePath)
  if (!parsed) return Promise.resolve(null)

  if (!parsed.model) {
    // Tokens exist but we don't know which model earned them — cannot
    // price honestly. Distinct from "known model, no pricing data" below,
    // but both degrade to the same hasUnknownPricing shape for the caller.
    return Promise.resolve({ usd: 0, byModel: {}, hasUnknownPricing: true })
  }

  // FIRST-PARTY ONLY — see this function's own doc comment above in full.
  // getOpenAiPricingById returns undefined (not in the "openai" bucket at
  // all) or null (in the bucket, genuinely unpriced) for an unresolvable
  // id; both collapse to the same falsy check and the same
  // hasUnknownPricing degrade below. Never falls back to the flattened/
  // reseller-susceptible resolveModel() price — that is the exact hazard
  // this fix exists to remove.
  const pricing = getOpenAiPricingById(parsed.model) ?? null
  if (!pricing) {
    return Promise.resolve({ usd: 0, byModel: {}, hasUnknownPricing: true })
  }

  const total = parsed.total
  const usd =
    ((total.input_tokens ?? 0) / 1_000_000) * pricing.input +
    ((total.output_tokens ?? 0) / 1_000_000) * pricing.output +
    ((total.cached_input_tokens ?? 0) / 1_000_000) * pricing.cacheRead +
    ((total.cache_write_input_tokens ?? 0) / 1_000_000) * pricing.cacheWrite

  return Promise.resolve({ usd, byModel: { [parsed.model]: usd }, hasUnknownPricing: false })
}
