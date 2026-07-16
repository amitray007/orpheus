// ---------------------------------------------------------------------------
// pricing.ts — Model pricing lookup with models.dev runtime refresh
//
// Priority order for getPricing(modelId):
//   1. Exact match in runtimeCache (fetched from models.dev)
//   2. Exact match in FALLBACK_PRICING (hardcoded)
//   3. Prefix match in runtimeCache (e.g. "claude-opus-4-7-20260416" → "claude-opus-4-7")
//   4. Prefix match in FALLBACK_PRICING
//   5. Family alias bucket (opus/sonnet/haiku) inferred from model id
//   6. null — caller skips cost accounting for unknown model
//
// FALLBACK_PRICING is intentionally NOT kept current with rate changes — it
// exists so known model IDs are priceable offline. Only bump when an entirely
// new model family appears (and update models.dev cross-check comment below).
//
// Cross-checked against models.dev/api.json on 2026-05-21 (claude-sonnet-5
// added 2026-07-02 per Anthropic's model catalog, not yet cross-checked
// against models.dev):
//   claude-opus-4-7:   $5/$25 input/output (1M ctx)
//   claude-opus-4-5:   $5/$25 input/output (200K ctx)
//   claude-sonnet-5:   $2/$10 input/output (1M ctx) — models.dev promo rate
//   claude-sonnet-4-6: $3/$15 input/output (1M ctx)
//   claude-sonnet-4-5: $3/$15 input/output (200K ctx)
//   claude-haiku-4-5:  $1/$5  input/output (200K ctx)
//   claude-fable-5:    $10/$50 input/output (1M ctx)
// ---------------------------------------------------------------------------

export type ModelPricing = {
  /** USD per 1M input tokens */
  input: number
  /** USD per 1M output tokens */
  output: number
  /** USD per 1M cache-read tokens */
  cacheRead: number
  /** USD per 1M cache-write tokens */
  cacheWrite: number
  /** Context window size in tokens */
  context: number
  /** Max output tokens (optional) */
  output_limit?: number
}

// ---------------------------------------------------------------------------
// Hardcoded fallback — only for known current models, never chased for rate
// updates. Aliases (opus/sonnet/haiku) resolve to representative latest.
// ---------------------------------------------------------------------------

export const FALLBACK_PRICING: Record<string, ModelPricing> = {
  // Claude Opus 4.8 — $5/$25, 1M context
  'claude-opus-4-8': {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    context: 1_000_000,
    output_limit: 128_000
  },
  // Claude Opus 4.7 — $5/$25, 1M context
  'claude-opus-4-7': {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    context: 1_000_000,
    output_limit: 128_000
  },
  // Claude Opus 4.5 — $5/$25, 200K context (cross-checked: models.dev confirms)
  'claude-opus-4-5': {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    context: 200_000,
    output_limit: 64_000
  },
  // Claude Sonnet 5 — $2/$10, 1M context (mirrors models.dev, which currently
  // reflects Anthropic's active promotional rate; reverts to $3/$15 when the
  // promo ends — runtime refreshFromModelsDev() keeps this live)
  'claude-sonnet-5': {
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    context: 1_000_000,
    output_limit: 128_000
  },
  // Claude Sonnet 4.6 — $3/$15, 1M context
  'claude-sonnet-4-6': {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    context: 1_000_000,
    output_limit: 64_000
  },
  // Claude Sonnet 4.5 — $3/$15, 200K context
  'claude-sonnet-4-5': {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    context: 200_000,
    output_limit: 64_000
  },
  // Claude Haiku 4.5 — $1/$5, 200K context
  'claude-haiku-4-5': {
    input: 1,
    output: 5,
    cacheRead: 0.1,
    cacheWrite: 1.25,
    context: 200_000,
    output_limit: 64_000
  },
  // Claude Fable 5 — $10/$50, 1M context
  'claude-fable-5': {
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite: 12.5,
    context: 1_000_000,
    output_limit: 128_000
  },
  // Generic family aliases — map to representative latest pricing
  opus: {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    context: 1_000_000,
    output_limit: 128_000
  },
  sonnet: {
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    context: 1_000_000,
    output_limit: 128_000
  },
  haiku: {
    input: 1,
    output: 5,
    cacheRead: 0.1,
    cacheWrite: 1.25,
    context: 200_000,
    output_limit: 64_000
  },
  fable: {
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite: 12.5,
    context: 1_000_000,
    output_limit: 128_000
  }
}

// ---------------------------------------------------------------------------
// Runtime cache — populated by refreshFromModelsDev(), null until first fetch
// ---------------------------------------------------------------------------

let runtimeCache: Record<string, ModelPricing> | null = null

// ---------------------------------------------------------------------------
// models.dev response shape (only the fields we care about)
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
}

type ModelsDevModel = {
  cost?: ModelsDevCost
  limit?: ModelsDevLimit
}

type ModelsDevResponse = {
  anthropic?: {
    models?: Record<string, ModelsDevModel>
  }
}

/**
 * Fetch pricing from models.dev and populate runtimeCache.
 * Fails silently on network error, timeout, or malformed response.
 * Never blocks boot — call fire-and-forget.
 */
export async function refreshFromModelsDev(): Promise<void> {
  try {
    const res = await fetch('https://models.dev/api.json', {
      signal: AbortSignal.timeout(10_000) // 10s timeout
    })
    if (!res.ok) {
      console.warn(`[pricing] models.dev responded ${res.status} — keeping fallback pricing`)
      return
    }

    const data = (await res.json()) as ModelsDevResponse
    const models = data?.anthropic?.models
    if (!models || typeof models !== 'object') {
      console.warn('[pricing] models.dev response missing anthropic.models — keeping fallback')
      return
    }

    const cache: Record<string, ModelPricing> = {}
    let count = 0

    for (const [modelId, model] of Object.entries(models)) {
      const cost = model?.cost
      const limit = model?.limit
      if (!cost) continue

      const input = cost.input ?? 0
      const output = cost.output ?? 0
      const cacheRead = cost.cache_read ?? 0
      const cacheWrite = cost.cache_write ?? 0
      const context = limit?.context ?? 200_000
      const output_limit = limit?.output

      cache[modelId] = { input, output, cacheRead, cacheWrite, context, output_limit }
      count++
    }

    runtimeCache = cache
    console.log(`[pricing] refreshFromModelsDev: loaded ${count} Anthropic model prices`)
  } catch (err) {
    // Network failure, timeout, JSON parse error — all silently ignored
    console.warn('[pricing] refreshFromModelsDev failed (using fallback):', String(err))
  }
}

// ---------------------------------------------------------------------------
// Family alias inference — maps a model id to an alias bucket
// ---------------------------------------------------------------------------

function inferFamilyAlias(modelId: string): string | null {
  const lower = modelId.toLowerCase()
  if (lower.includes('opus')) return 'opus'
  if (lower.includes('sonnet')) return 'sonnet'
  if (lower.includes('haiku')) return 'haiku'
  if (lower.includes('fable')) return 'fable'
  return null
}

/**
 * Resolve pricing for a model ID.
 * Returns null if the model is completely unknown (caller should skip cost accounting).
 */
export function getPricing(modelId: string): ModelPricing | null {
  // 1. Exact match in runtimeCache
  if (runtimeCache?.[modelId]) return runtimeCache[modelId]

  // 2. Exact match in FALLBACK_PRICING
  if (FALLBACK_PRICING[modelId]) return FALLBACK_PRICING[modelId]

  // 3. Prefix match in runtimeCache — longest match wins so
  // "claude-opus-4-7-20260416" resolves to "claude-opus-4-7", not "claude-opus-4".
  if (runtimeCache) {
    const keys = Object.keys(runtimeCache).sort((a, b) => b.length - a.length)
    for (const key of keys) {
      if (modelId.startsWith(key)) return runtimeCache[key]
    }
  }

  // 4. Prefix match in FALLBACK_PRICING — same longest-wins semantics.
  const fallbackKeys = Object.keys(FALLBACK_PRICING).sort((a, b) => b.length - a.length)
  for (const key of fallbackKeys) {
    if (modelId.startsWith(key)) return FALLBACK_PRICING[key]
  }

  // 5. Family alias bucket (infer opus/sonnet/haiku from the model id string)
  const alias = inferFamilyAlias(modelId)
  if (alias && FALLBACK_PRICING[alias]) return FALLBACK_PRICING[alias]

  // 6. Unknown model
  return null
}
