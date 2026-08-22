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

// Ids from ONLY the "anthropic" provider bucket (models.dev's key for
// Anthropic's own catalog), kept separately from the flattened `cache` above.
// This is deliberately NOT the full multi-provider `cache` — models.dev
// carries ~300 OTHER provider buckets (google-vertex, nano-gpt, aihubmix,
// venice, llmgateway, ...) that resell Claude models under THEIR OWN
// vendor-suffixed SKU names sharing a Claude-shaped prefix, e.g.
// "claude-opus-4-7@default", "claude-haiku-4-5-20251001-thinking",
// "claude-opus-4-7-fast" — none of these are date stamps Anthropic actually
// mints, and treating the whole flattened cache as a candidate pool for
// "known Claude ids" (as an earlier version of the unit-09-polish alias-
// expansion fix did) incorrectly emitted alias entries for them. Only
// Anthropic's own bucket is a trustworthy source of "ids Anthropic
// themselves stamp".
let anthropicModelIds: string[] = []

// Pricing scoped to ONLY the "openai" provider bucket (models.dev's key for
// OpenAI's own first-party catalog), keyed by model id — kept separately
// from the flattened `cache` above for the EXACT same reason
// anthropicModelIds is kept separate from it (see that field's own doc
// comment): the flattened `cache`'s first-provider-wins rule can and does
// pick a RESELLER bucket's price over OpenAI's own. Verified empirically
// against a live https://models.dev/api.json fetch: 6 of the 7 Codex model
// ids in harness/codex/curated.ts's CODEX_MODEL_SLUGS resolve, in the
// flattened cache, to a reseller bucket (ai-router or xpersona) rather than
// "openai" — e.g. gpt-5.6-luna's ai-router price is input $1/M, output $6/M,
// a 5x OVERSTATEMENT of OpenAI's own $0.20/$1.20 rate; gpt-5.4-mini's
// xpersona price ($0.375/$4) UNDERSTATES OpenAI's own ($0.75/$4.5) by
// roughly 2x. A wrong cost figure that looks authoritative is worse than
// showing none, so Codex's cost path (harness/codex/usage.ts's
// getCodexCost) reads pricing from THIS map instead of the flattened
// `cache` — see getOpenAiPricingById below.
//
// Value is `null` for a real "openai"-bucket model with no cost object
// (mirrors toPricing's own don't-fabricate-zeros discipline); the key is
// simply ABSENT for a model id the "openai" bucket doesn't carry at all —
// that distinction is what lets getOpenAiPricingById return `undefined`
// (not in the bucket) vs `null` (in the bucket, genuinely unpriced).
let openaiPricing: Map<string, Pricing | null> = new Map()

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

/** The derived catalog: the flattened id->entry map, Anthropic's own bucket
 *  of ids, and OpenAI's own bucket of pricing. This — NOT models.dev's
 *  3.8 MB raw response — is what gets persisted and rehydrated. */
export type ModelsDevCatalog = {
  entries: Map<string, CachedEntry>
  anthropicModelIds: string[]
  openaiPricing: Map<string, Pricing | null>
}

/**
 * Pure: models.dev's response -> the derived catalog. Extracted from
 * refreshModelsDevCache so the flattening rules (first-provider-wins, the
 * anthropic-bucket-only id list, toPricing's don't-fabricate-zeros contract)
 * can be asserted directly against a fixture instead of only through a live
 * network fetch.
 */
export function buildCatalogFromResponse(data: ModelsDevResponse): ModelsDevCatalog {
  const entries = new Map<string, CachedEntry>()
  let anthropicIds: string[] = []
  const openaiPrices = new Map<string, Pricing | null>()

  for (const [providerSlug, provider] of Object.entries(data)) {
    const models = provider?.models
    if (!models || typeof models !== 'object') continue

    for (const [modelId, model] of Object.entries(models)) {
      // First provider to mention an id wins — ids are not expected to
      // collide across providers in practice (models.dev keys are already
      // provider-qualified in most cases), and this only matters for the
      // rare id string that appears twice; either entry is a reasonable
      // choice since this source is never authoritative for Claude ids.
      if (entries.has(modelId)) continue

      entries.set(modelId, {
        context: model.limit?.context ?? null,
        pricing: toPricing(model.cost),
        supportsReasoning: model.reasoning === true
      })
    }
    // See anthropicModelIds' own doc comment: only Anthropic's own bucket
    // is a trustworthy source of "date-stamped ids Anthropic actually
    // mints" — every other provider bucket may resell Claude models under
    // vendor-suffixed SKU names sharing a Claude-shaped prefix.
    if (providerSlug === 'anthropic') {
      anthropicIds = Object.keys(models)
    }
    // See openaiPricing's own doc comment: OpenAI's own bucket is the only
    // trustworthy source of "OpenAI's actual published price" for a Codex
    // model id — every other bucket may be a reseller advertising its own
    // (sometimes wildly different) rate under the same id string.
    //
    // TIERED PRICING — KNOWN, ACCEPTED SIMPLIFICATION: some "openai"-bucket
    // entries carry a base cost PLUS a `tiers`/`context_over_200k` field
    // that roughly doubles the rate once a session's cumulative context
    // crosses a per-model threshold (e.g. 272k tokens for gpt-5.4). Only
    // the BASE tier (model.cost) is used here — the tiered/blended rate is
    // deliberately NOT implemented in this pass. Doing so correctly would
    // require attributing which tokens were billed at which tier per
    // request, which Codex's rollout does not expose in a form that makes
    // that attribution possible (see harness/codex/usage.ts's own doc
    // comment on why cost is computed from a single cumulative bucket).
    // Under-pricing a session that genuinely crossed the threshold is an
    // accepted, documented gap for this phase, not an oversight.
    if (providerSlug === 'openai') {
      for (const [modelId, model] of Object.entries(models)) {
        openaiPrices.set(modelId, toPricing(model.cost))
      }
    }
  }

  return { entries, anthropicModelIds: anthropicIds, openaiPricing: openaiPrices }
}

/** On-disk shape. `entries`/`openaiPricing` are plain objects because JSON
 *  has no Map. */
export type PersistedCatalog = {
  entries: Record<string, CachedEntry>
  anthropicModelIds: string[]
  openaiPricing: Record<string, Pricing | null>
}

/**
 * Persistence PORT — injected by src/main/models/modelsDevPersistence.ts
 * rather than imported here, deliberately.
 *
 * This module is imported directly by pure, no-electron verifiers
 * (verify-routing.ts, verify-model-registry.ts, verify-providers.ts, ...).
 * Importing db/dashboardCache would drag `electron` into every one of them
 * through the DB layer — verify-routing.ts mocks nothing today and would have
 * to start mocking electron just to keep testing routing logic. Keeping the
 * dependency INVERTED means this file stays DB-free and those verifiers stay
 * as they are; the electron-reaching wiring lives in one place that only the
 * main process imports.
 *
 * Unset means "no persistence" — the pre-existing network-only behavior.
 */
let persistence: ModelsDevPersistence | null = null

/** Read/write the derived catalog. Both sides must be total: neither may
 *  throw, because they run inside a fire-and-forget refresh. */
export type ModelsDevPersistence = {
  read: () => { value: PersistedCatalog; fetchedAt: number } | null
  write: (value: PersistedCatalog) => void
}

/** Installs the persistence port. Called once, from the main process. */
export function setModelsDevPersistence(impl: ModelsDevPersistence | null): void {
  persistence = impl
}

function persistCatalog(catalog: ModelsDevCatalog): void {
  if (!persistence) return
  try {
    persistence.write({
      entries: Object.fromEntries(catalog.entries),
      anthropicModelIds: catalog.anthropicModelIds,
      openaiPricing: Object.fromEntries(catalog.openaiPricing)
    })
  } catch (err) {
    console.error('[models/modelsDev] persist failed (cache still live in memory)', err)
  }
}

/**
 * Populate the in-memory cache from the last persisted catalog, synchronously,
 * so a cold launch can resolve model facts WITHOUT waiting on the network.
 *
 * WHY: refreshModelsDevCache downloads 3.8 MB from models.dev and parses 3202
 * models. Measured on a real cold boot, that was a ~2 s wait before any model
 * fact resolved plus a ~400 ms main-thread stall when the JSON landed — the
 * app's largest startup hitch, and it happened on EVERY launch even though the
 * catalog changes rarely. Reading the derived form back from SQLite (~456 KB,
 * no network) makes the common case local, and the live refresh still runs
 * fire-and-forget afterwards to pick up genuine changes.
 *
 * Deliberately does NOT overwrite a cache a refresh has already populated:
 * hydrate is a floor, never a rollback to older data.
 *
 * Never throws — a miss, a corrupt row, or a DB error all degrade to "no
 * hydration", leaving exactly the pre-existing wait-for-network behavior.
 */
export function hydrateModelsDevCacheFromDisk(): boolean {
  if (cache) return false
  try {
    if (!persistence) return false
    const row = persistence.read()
    if (!row?.value || typeof row.value !== 'object') return false
    const { entries, anthropicModelIds: ids, openaiPricing: openaiPrices } = row.value
    if (!entries || typeof entries !== 'object') return false

    cache = new Map(Object.entries(entries))
    anthropicModelIds = Array.isArray(ids) ? ids : []
    openaiPricing = new Map<string, Pricing | null>(
      openaiPrices && typeof openaiPrices === 'object' ? Object.entries(openaiPrices) : []
    )
    console.log(
      `[models/modelsDev] hydrated ${cache.size} models from disk (age ${Math.round(
        (Date.now() - row.fetchedAt) / 1000
      )}s) — skipping the cold-start network wait`
    )
    return true
  } catch (err) {
    console.error('[models/modelsDev] hydrate failed — falling back to network only', err)
    return false
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

    const built = buildCatalogFromResponse(data)

    cache = built.entries
    anthropicModelIds = built.anthropicModelIds
    openaiPricing = built.openaiPricing
    console.log(
      `[models/modelsDev] refreshed cache: ${built.entries.size} models across all providers`
    )

    // Persist the DERIVED catalog (~456 KB) — never the 3.8 MB raw response —
    // so the next cold launch resolves from disk instead of the network. See
    // hydrateModelsDevCacheFromDisk below for why this matters.
    persistCatalog(built)
  } catch (err) {
    console.warn('[models/modelsDev] refresh failed (keeping previous cache):', String(err))
  }
}

/** Test-only: replace the cache directly, bypassing the network fetch.
 *  `anthropicIds` optionally seeds the ANTHROPIC-ONLY bucket
 *  (listModelsDevCachedIds) independently of `entries` — defaults to [] so
 *  existing call sites that predate this parameter keep compiling/behaving
 *  unchanged (no anthropic ids -> stamped-alias expansion sources nothing
 *  from this test fixture, matching pre-fixture behavior). `openaiPrices`
 *  optionally seeds the OPENAI-ONLY pricing bucket (getOpenAiPricingById)
 *  the same way — defaults to an empty map so existing call sites keep
 *  behaving unchanged (no openai prices -> getOpenAiPricingById returns
 *  undefined for everything, same as pre-fixture behavior). */
export function setModelsDevCacheForTests(
  entries: Record<string, CachedEntry> | null,
  anthropicIds: string[] = [],
  openaiPrices: Record<string, Pricing | null> = {}
): void {
  cache = entries ? new Map(Object.entries(entries)) : null
  anthropicModelIds = anthropicIds
  openaiPricing = new Map(Object.entries(openaiPrices))
}

/**
 * Every model id currently in models.dev's "anthropic" provider bucket ONLY
 * — used by routingProxy/manager.ts's date-stamped-alias expansion
 * (model-routing unit 09-polish) to find Claude ids like
 * "claude-haiku-4-5-20251001" that Anthropic's OWN catalog entry publishes.
 *
 * Deliberately NOT the full flattened multi-provider `cache` (unlike this
 * source's own resolve(), which doesn't discriminate by provider for pricing
 * lookups) — models.dev carries ~300 OTHER provider buckets that resell
 * Claude models under their own vendor-suffixed SKU names sharing a
 * Claude-shaped prefix (e.g. "claude-opus-4-7@default" from google-vertex,
 * "claude-haiku-4-5-20251001-thinking" from nano-gpt) — an earlier version of
 * this fix sourced from the full flattened cache and incorrectly emitted
 * alias entries for those vendor SKUs. Scoping to the anthropic bucket alone
 * is the semantically correct fix: only Anthropic mints real Claude date
 * stamps. The caller (manager.ts) additionally cross-checks every id against
 * the registry's own bareClaudeIdFor (builtin.ts), which independently
 * requires a clean 8-digit date-stamp suffix — defense in depth, not a
 * substitute for scoping the source pool correctly here.
 *
 * Empty array pre-first-fetch, when the network is unavailable, or when a
 * refresh's response happened to have no "anthropic" key at all — same
 * degrade-to-nothing contract as resolve() itself.
 */
export function listModelsDevCachedIds(): string[] {
  return anthropicModelIds
}

/**
 * OpenAI's own first-party price for a model id, sourced ONLY from
 * models.dev's "openai" provider bucket — see openaiPricing's own doc
 * comment above for why this is scoped separately from the flattened
 * `cache` this source's own resolve() reads (the flatten's
 * first-provider-wins rule can and does pick a reseller bucket's price
 * instead of OpenAI's own for several real Codex model ids).
 *
 * Three-state return, mirroring toPricing's own "don't fabricate" contract:
 *   - a Pricing object: the "openai" bucket carries this id with real cost
 *     data.
 *   - `null`: the "openai" bucket carries this id, but with no cost object
 *     (or an incomplete one) — a real, known model with genuinely unknown
 *     pricing.
 *   - `undefined`: this id does not appear in the "openai" bucket AT ALL —
 *     distinct from `null` structurally, though callers that only care
 *     about "do I have a trustworthy first-party price or not" can treat
 *     both the same way (fall back to unknown-pricing policy).
 *
 * Empty pre-first-fetch, when the network is unavailable, or when a
 * refresh's response happened to have no "openai" key — same degrade-to-
 * nothing contract as resolve()/listModelsDevCachedIds.
 */
export function getOpenAiPricingById(modelId: string): Pricing | null | undefined {
  return openaiPricing.get(modelId)
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
