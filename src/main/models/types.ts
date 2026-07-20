// ---------------------------------------------------------------------------
// src/main/models/types.ts — shared types for the model registry
// ---------------------------------------------------------------------------

/** USD-per-1M-token pricing for a model. `null` on the containing ModelInfo
 *  means "pricing unknown" — a state distinct from zero-cost, and distinct
 *  from "model unknown" (see ModelInfo.context/pricing doc). */
export type Pricing = {
  /** USD per 1M input tokens */
  input: number
  /** USD per 1M output tokens */
  output: number
  /** USD per 1M cache-read tokens */
  cacheRead: number
  /** USD per 1M cache-write tokens */
  cacheWrite: number
}

/**
 * Canonical, resolved facts about a model. This is the ONE shape every
 * consumer (title bar, sessions tab, live-agents list, cost/context
 * accounting) reads from — replacing three independent label parsers and
 * two independent context-budget paths that used to disagree.
 *
 * `context: null` / `pricing: null` are first-class "unknown" states.
 * Consumers must render them explicitly (e.g. an em-dash) — NEVER fabricate
 * a number. A model can be perfectly well-known (id, label, family) while
 * still having unknown pricing (e.g. models.dev returns `cost: null` for a
 * real model) — that's a different state from an entirely unrecognized id,
 * which resolves to a synthesized ModelInfo with every optional field null.
 */
export type ModelInfo = {
  /** The model id as passed in (never normalized/rewritten). */
  id: string
  /** One canonical human-readable label, e.g. "Opus 4.8", "Gpt 5.1 Codex". */
  label: string
  /** Family bucket, e.g. "opus", "sonnet", "gpt", "grok". Null when the id
   *  doesn't parse into a recognizable family. */
  family: string | null
  /** True only for models resolved by the built-in Claude source. This is
   *  the SINGLE source of truth for "is this Claude" — never re-derive it
   *  from string matching (id.includes('claude') etc.) elsewhere. */
  isClaude: boolean
  /** Native context window in tokens, before any user-configured cap is
   *  applied. Null when unknown — never fabricated. */
  context: number | null
  /** USD-per-1M-token pricing. Null when unknown (distinct from a model
   *  that is free / zero-cost). */
  pricing: Pricing | null
  /** Whether the model supports extended/visible reasoning. */
  supportsReasoning: boolean
}

/**
 * A model source resolves zero or more ModelInfo entries. Sources are tried
 * in registry precedence order; the first source to resolve an id wins —
 * this is what keeps `getPricing`'s old landmine (any id containing "opus"
 * inheriting Claude pricing) from recurring: the builtin Claude source is
 * always consulted FIRST and, being an exact/alias match only (no substring
 * matching), never claims a non-Claude id.
 */
export interface ModelSource {
  /** Stable name for logging/debugging. */
  readonly name: string
  /** Resolve a single model id synchronously from whatever this source has
   *  cached/built-in. Returns null if this source has no data for the id.
   *  MUST be synchronous and MUST NOT perform I/O — network-backed sources
   *  populate an in-memory cache out-of-band (see sources/modelsDev.ts:
   *  refreshModelsDevCache) and this method only ever reads that cache. */
  resolve(modelId: string): ModelInfo | null
}
