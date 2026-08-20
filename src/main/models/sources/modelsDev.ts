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

/** The derived catalog: the flattened id->entry map plus Anthropic's own
 *  bucket of ids. This — NOT models.dev's 3.8 MB raw response — is what gets
 *  persisted and rehydrated. */
export type ModelsDevCatalog = {
  entries: Map<string, CachedEntry>
  anthropicModelIds: string[]
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
  }

  return { entries, anthropicModelIds: anthropicIds }
}

/** On-disk shape. `entries` is a plain object because JSON has no Map. */
export type PersistedCatalog = {
  entries: Record<string, CachedEntry>
  anthropicModelIds: string[]
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
      anthropicModelIds: catalog.anthropicModelIds
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
    const { entries, anthropicModelIds: ids } = row.value
    if (!entries || typeof entries !== 'object') return false

    cache = new Map(Object.entries(entries))
    anthropicModelIds = Array.isArray(ids) ? ids : []
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
 *  from this test fixture, matching pre-fixture behavior). */
export function setModelsDevCacheForTests(
  entries: Record<string, CachedEntry> | null,
  anthropicIds: string[] = []
): void {
  cache = entries ? new Map(Object.entries(entries)) : null
  anthropicModelIds = anthropicIds
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
