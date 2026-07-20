// ---------------------------------------------------------------------------
// src/main/models/sources/modelsDev.ts — models.dev-backed source
//
// Widens the old src/main/pricing.ts machinery: that file only kept
// `data.anthropic.models`, silently discarding every other provider even
// though models.dev returns the SAME shape for all of them (anthropic,
// openai, xai, google, ...). This source keeps every provider's entries, so
// third-party models (gpt-5.1-codex, grok-4.5, ...) get real context +
// pricing instead of Orpheus fabricating a number for them.
//
// This source is intentionally NEVER consulted for a Claude id — see
// registry.ts's precedence order and builtin.ts's isClaudeModelId guard.
// Even if models.dev's own "anthropic" bucket has entries, this source is
// only ever reached after the builtin Claude source has already had first
// refusal on the id.
//
// `cost` CAN be null on a real, known model (e.g. models.dev has entries
// with no published pricing) — that must resolve to `pricing: null` while
// `context` still resolves from `limit.context`, NOT an unknown model.
// ---------------------------------------------------------------------------

import type { ModelInfo, ModelSource, Pricing } from '../types'

// ---------------------------------------------------------------------------
// models.dev response shape — identical per-provider shape confirmed against
// https://models.dev/api.json (anthropic: 14 models, openai: 56, xai: 9,
// google: 23, plus ~300 other providers, all sharing this shape).
// ---------------------------------------------------------------------------

type ModelsDevCost = {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
}

type ModelsDevLimit = {
  context?: number
  output?: number
  input?: number
}

type ModelsDevModel = {
  cost?: ModelsDevCost | null
  limit?: ModelsDevLimit
  reasoning?: boolean
}

type ModelsDevProvider = {
  models?: Record<string, ModelsDevModel>
}

// Full response is a map of provider-slug -> provider — not just "anthropic".
type ModelsDevResponse = Record<string, ModelsDevProvider>

type CachedEntry = {
  context: number | null
  pricing: Pricing | null
  supportsReasoning: boolean
}

// modelId -> entry, flattened across every provider. Populated by
// refreshModelsDevCache(); null until the first successful fetch (or
// forever, if the network is unavailable — that's fine, it just means this
// source resolves nothing and everything falls through to "unknown", which
// is the correct non-fabricating behavior).
let cache: Map<string, CachedEntry> | null = null

function toPricing(cost: ModelsDevCost | null | undefined): Pricing | null {
  // A model with no cost object at all, OR an explicit `cost: null`, means
  // "known model, unknown pricing" — a real state, not an error. Return
  // null rather than inventing zeros (zero would print as "free", which is
  // a fabricated fact just like a fabricated context window would be).
  if (!cost) return null
  if (cost.input === undefined || cost.output === undefined) return null
  return {
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cache_read ?? 0,
    cacheWrite: cost.cache_write ?? 0
  }
}

/**
 * Fetch models.dev's full catalog and rebuild the in-memory cache. Fails
 * silently on network error, timeout, or malformed response — the cache is
 * simply left as-is (or null, pre-first-fetch), and resolve() then returns
 * null for everything, which downstream callers must already treat as
 * "unknown, don't fabricate". Never blocks boot — call fire-and-forget.
 */
export async function refreshModelsDevCache(fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    const res = await fetchImpl('https://models.dev/api.json', {
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) {
      console.warn(`[models/modelsDev] responded ${res.status} — keeping previous cache`)
      return
    }

    const data = (await res.json()) as ModelsDevResponse
    if (!data || typeof data !== 'object') {
      console.warn('[models/modelsDev] malformed response — keeping previous cache')
      return
    }

    const next = new Map<string, CachedEntry>()
    let count = 0

    for (const provider of Object.values(data)) {
      const models = provider?.models
      if (!models || typeof models !== 'object') continue

      for (const [modelId, model] of Object.entries(models)) {
        // First provider to mention an id wins — ids are not expected to
        // collide across providers in practice (models.dev keys are already
        // provider-qualified in most cases), and this only matters for the
        // rare id string that appears twice; either entry is a reasonable
        // choice since this source is never authoritative for Claude ids.
        if (next.has(modelId)) continue

        next.set(modelId, {
          context: model.limit?.context ?? null,
          pricing: toPricing(model.cost),
          supportsReasoning: model.reasoning === true
        })
        count++
      }
    }

    cache = next
    console.log(`[models/modelsDev] refreshed cache: ${count} models across all providers`)
  } catch (err) {
    console.warn('[models/modelsDev] refresh failed (keeping previous cache):', String(err))
  }
}

/** Test-only: replace the cache directly, bypassing the network fetch. */
export function setModelsDevCacheForTests(entries: Record<string, CachedEntry> | null): void {
  cache = entries ? new Map(Object.entries(entries)) : null
}

function familyFromId(id: string): string | null {
  // Best-effort structural family guess for third-party ids, e.g.
  // "gpt-5.1-codex" -> "gpt", "grok-4.5" -> "grok". Takes the leading
  // alphabetic run of the id. This is intentionally NOT used for any
  // Claude-family-alias-style pricing inheritance — it only ever feeds the
  // `family` display field on a ModelInfo already resolved by THIS source's
  // own cache lookup (i.e. a real, known model), never a pricing decision.
  const match = /^[a-z]+/i.exec(id)
  return match ? match[0].toLowerCase() : null
}

function labelFromId(id: string): string {
  // "gpt-5.1-codex" -> "Gpt 5.1 Codex"; "grok-4.5" -> "Grok 4.5". One
  // canonical rule: split on '-', capitalize each alphabetic segment,
  // leave numeric/mixed segments (including dotted versions) as-is.
  return id
    .split('-')
    .map((part) => (/^[a-z]/i.test(part) ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' ')
}

function resolve(modelId: string): ModelInfo | null {
  const entry = cache?.get(modelId)
  if (!entry) return null

  return {
    id: modelId,
    label: labelFromId(modelId),
    family: familyFromId(modelId),
    isClaude: false,
    context: entry.context,
    pricing: entry.pricing,
    supportsReasoning: entry.supportsReasoning
  }
}

export const modelsDevSource: ModelSource = {
  name: 'models-dev',
  resolve
}
