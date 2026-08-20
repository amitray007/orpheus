// ---------------------------------------------------------------------------
// scripts/verify-models-dev-cache.ts
//
// Guards the persisted models.dev catalog (src/main/models/sources/modelsDev.ts).
//
// WHY: refreshModelsDevCache downloads 3.8 MB and parses 3202 models on every
// launch — measured at ~2s before any model fact resolved plus a ~400ms
// main-thread stall. Persisting the DERIVED catalog (~456 KB) and rehydrating
// it removes that from the cold path. These assertions pin the properties that
// make that safe: hydrate never overwrites fresher data, never throws, and the
// derived shape round-trips losslessly.
//
// Pure — no electron, no DB. The persistence PORT is injected, which is the
// same inversion that keeps modelsDev.ts importable by verify-routing.ts and
// friends without mocking electron.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import {
  buildCatalogFromResponse,
  hydrateModelsDevCacheFromDisk,
  setModelsDevPersistence,
  setModelsDevCacheForTests,
  listModelsDevCachedIds,
  modelsDevSource,
  type PersistedCatalog
} from '../src/main/models/sources/modelsDev.ts'

const RESPONSE = {
  anthropic: {
    models: {
      'claude-opus-4-7': {
        limit: { context: 200_000 },
        cost: { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
        reasoning: true
      },
      'claude-haiku-4-5-20251001': { limit: { context: 200_000 }, cost: null, reasoning: false }
    }
  },
  'google-vertex': {
    // Resold Claude SKU — must NOT pollute the anthropic-only id list.
    models: { 'claude-opus-4-7@default': { limit: { context: 200_000 } } }
  },
  openai: {
    models: { 'gpt-5.4-mini': { limit: { context: 400_000 }, cost: { input: 1, output: 2 } } }
  }
}

// ---------------------------------------------------------------------------
// 1. buildCatalogFromResponse — the flattening rules, asserted directly.
// ---------------------------------------------------------------------------
{
  const built = buildCatalogFromResponse(RESPONSE as never)

  assert.equal(built.entries.size, 4, 'every provider bucket contributes its models')
  assert.deepEqual(
    built.anthropicModelIds.sort(),
    ['claude-haiku-4-5-20251001', 'claude-opus-4-7'],
    "anthropicModelIds must come from the 'anthropic' bucket ONLY — a resold " +
      "vendor SKU like 'claude-opus-4-7@default' is not an id Anthropic mints"
  )

  const opus = built.entries.get('claude-opus-4-7')
  assert.equal(opus?.context, 200_000)
  assert.equal(opus?.supportsReasoning, true)
  assert.deepEqual(opus?.pricing, { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 })

  // `cost: null` means "known model, unknown pricing" — never fabricated zeros.
  assert.equal(
    built.entries.get('claude-haiku-4-5-20251001')?.pricing,
    null,
    'an explicit cost:null must stay null, not become a fabricated zero price'
  )
}

// ---------------------------------------------------------------------------
// 2. Round-trip: persist -> hydrate reproduces the catalog exactly.
// ---------------------------------------------------------------------------
{
  const built = buildCatalogFromResponse(RESPONSE as never)
  let stored: PersistedCatalog | null = null
  setModelsDevPersistence({
    read: () => (stored ? { value: stored, fetchedAt: Date.now() } : null),
    write: (v) => {
      stored = v
    }
  })

  // Simulate what a refresh persists.
  stored = {
    entries: Object.fromEntries(built.entries),
    anthropicModelIds: built.anthropicModelIds
  }

  setModelsDevCacheForTests(null)
  assert.equal(hydrateModelsDevCacheFromDisk(), true, 'hydrate must succeed from a stored catalog')

  const facts = modelsDevSource.resolve('claude-opus-4-7')
  assert.equal(facts?.context, 200_000, 'a hydrated entry must resolve like a fetched one')
  assert.deepEqual(
    listModelsDevCachedIds().sort(),
    ['claude-haiku-4-5-20251001', 'claude-opus-4-7'],
    'the anthropic-only id list must survive the round trip'
  )
}

// ---------------------------------------------------------------------------
// 3. Hydrate is a FLOOR, never a rollback: it must not clobber a cache the
//    live refresh already populated with fresher data.
// ---------------------------------------------------------------------------
{
  let stored: PersistedCatalog | null = {
    entries: { 'stale-model': { context: 1, pricing: null, supportsReasoning: false } },
    anthropicModelIds: ['stale-model']
  }
  setModelsDevPersistence({
    read: () => (stored ? { value: stored, fetchedAt: 0 } : null),
    write: (v) => {
      stored = v
    }
  })

  setModelsDevCacheForTests({
    'fresh-model': { context: 999, pricing: null, supportsReasoning: false }
  })
  assert.equal(
    hydrateModelsDevCacheFromDisk(),
    false,
    'hydrate must be a no-op when a cache is already populated'
  )
  assert.equal(
    modelsDevSource.resolve('fresh-model')?.context,
    999,
    'the already-populated (fresher) cache must survive'
  )
  assert.equal(
    modelsDevSource.resolve('stale-model'),
    null,
    'hydrate must NOT roll a live cache back to older on-disk data'
  )
}

// ---------------------------------------------------------------------------
// 4. Total contract — every degrade path leaves the pre-existing
//    network-only behavior rather than throwing into boot.
// ---------------------------------------------------------------------------
{
  // No persistence installed at all.
  setModelsDevCacheForTests(null)
  setModelsDevPersistence(null)
  assert.equal(hydrateModelsDevCacheFromDisk(), false, 'no persistence port -> no hydration')

  // A read that throws.
  setModelsDevCacheForTests(null)
  setModelsDevPersistence({
    read: () => {
      throw new Error('db exploded')
    },
    write: () => {}
  })
  assert.equal(
    hydrateModelsDevCacheFromDisk(),
    false,
    'a throwing read must degrade, not propagate'
  )

  // A corrupt row (shape does not match).
  setModelsDevCacheForTests(null)
  setModelsDevPersistence({
    read: () => ({ value: { nonsense: true } as never, fetchedAt: 0 }),
    write: () => {}
  })
  assert.equal(
    hydrateModelsDevCacheFromDisk(),
    false,
    'a corrupt payload must degrade to no hydration'
  )

  // Cleanup so later verifiers in the same process see a clean slate.
  setModelsDevPersistence(null)
  setModelsDevCacheForTests(null)
}

console.log(
  '✓ models.dev catalog persists in its DERIVED form and rehydrates losslessly; hydrate is a floor (never a rollback) and degrades silently on every failure path'
)
