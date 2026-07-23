// ---------------------------------------------------------------------------
// scripts/verify-model-registry.ts
//
// Assertion harness for src/main/models/registry.ts — the ONE owner for
// "what do we know about model X?". Mirrors the existing
// scripts/verify-cli-flags.ts / scripts/verify-migration-engine.ts
// convention: a script run directly via node --experimental-strip-types
// (the `test:models` package.json script), no test framework.
//
// Covers (per the unit spec):
//   - Claude ids + bare aliases resolve fully with NO network (fetch is
//     stubbed to throw, so any accidental network dependency fails loudly)
//   - Claude source wins precedence over any other source for the same id
//   - A claude-*-named NON-Claude id does NOT inherit Claude pricing
//     (the pricing.ts landmine this registry replaces)
//   - Unknown model -> context: null, pricing: null (no fabrication)
//   - Known model with cost: null -> pricing: null but context still
//     resolves
//   - Per-model cap: min(reported, cap); disable1mContext reproduces
//     today's Claude clamp exactly
//   - One canonical label for ids the three old parsers disagreed on
// ---------------------------------------------------------------------------

import assert from 'node:assert'
import {
  resolveModel,
  modelLabel,
  isClaude,
  effectiveContext,
  resolveContextBudget
} from '../src/main/models/registry.ts'
import { isClaudeModelId } from '../src/main/models/sources/builtin.ts'
import {
  setModelsDevCacheForTests,
  refreshModelsDevCache
} from '../src/main/models/sources/modelsDev.ts'

// ---------------------------------------------------------------------------
// Network guard — the whole suite runs with fetch stubbed to throw, so any
// code path that accidentally reaches the network fails LOUDLY and
// immediately rather than silently degrading Claude data (which must never
// happen — Claude resolution is offline by construction).
// ---------------------------------------------------------------------------

const networkDeniedFetch: typeof fetch = () => {
  throw new Error('network access attempted during offline verification run')
}

// ---------------------------------------------------------------------------
// 1. Claude ids + bare aliases resolve fully with NO network
// ---------------------------------------------------------------------------

{
  // No models.dev cache populated at all — pure offline state.
  setModelsDevCacheForTests(null)

  const claudeIds = [
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-5',
    'claude-sonnet-5',
    'claude-sonnet-4-6',
    'claude-sonnet-4-5',
    'claude-haiku-4-5',
    'claude-fable-5'
  ]
  for (const id of claudeIds) {
    const info = resolveModel(id)
    assert.equal(info.isClaude, true, `${id}: expected isClaude`)
    assert.ok(info.context !== null, `${id}: expected known context`)
    assert.ok(info.pricing !== null, `${id}: expected known pricing`)
    assert.notEqual(info.label, id, `${id}: expected a prettified label, not the raw id`)
  }
  console.log('✓ all explicit Claude ids resolve fully offline')

  const aliases = ['opus', 'sonnet', 'haiku', 'fable']
  for (const alias of aliases) {
    const info = resolveModel(alias)
    assert.equal(info.isClaude, true, `${alias}: expected isClaude`)
    assert.ok(info.context !== null, `${alias}: expected known context`)
    assert.ok(info.pricing !== null, `${alias}: expected known pricing`)
    assert.ok(info.label.includes('(latest)'), `${alias}: expected "(latest)" alias label`)
  }
  console.log('✓ bare Claude aliases (opus/sonnet/haiku/fable) resolve fully offline')

  // Date-stamped variant — claude appends a release date to the id it
  // actually runs at launch time.
  const stamped = resolveModel('claude-opus-4-7-20260416')
  assert.equal(stamped.isClaude, true)
  assert.equal(stamped.context, 1_000_000)
  assert.equal(stamped.label, 'Opus 4.7')
  console.log('✓ date-stamped Claude id resolves via longest-prefix match')
}

// ---------------------------------------------------------------------------
// 2. Claude source wins precedence over any other source for the same id
// ---------------------------------------------------------------------------

{
  // Poison the models.dev cache with WRONG data for a real Claude id, to
  // prove the builtin source is consulted first and wins outright — the
  // registry must never let a network-backed source shadow a Claude id.
  setModelsDevCacheForTests({
    'claude-sonnet-5': {
      context: 1,
      pricing: { input: 999, output: 999, cacheRead: 999, cacheWrite: 999 },
      supportsReasoning: true
    }
  })

  const info = resolveModel('claude-sonnet-5')
  assert.equal(info.isClaude, true)
  assert.equal(info.context, 1_000_000, 'builtin Claude context must win over models.dev')
  assert.equal(info.pricing?.input, 2, 'builtin Claude pricing must win over models.dev')
  assert.equal(info.label, 'Sonnet 5')

  setModelsDevCacheForTests(null)
  console.log('✓ builtin Claude source wins precedence over models.dev for the same id')
}

// ---------------------------------------------------------------------------
// 3. A claude-*-named NON-Claude id does NOT inherit Claude pricing (the
//    pricing.ts landmine: old getPricing's family-alias substring matching
//    applied Claude pricing to any id merely containing opus/sonnet/haiku/
//    fable, or prefixed "claude-").
// ---------------------------------------------------------------------------

{
  setModelsDevCacheForTests(null)

  const landmineIds = [
    'some-vendor-opus-clone',
    'claude-imitation-model',
    'totally-not-sonnet-9000',
    'my-haiku-writer-9b',
    'fable-but-not-anthropic'
  ]
  for (const id of landmineIds) {
    assert.equal(isClaudeModelId(id), false, `${id}: must NOT be classified as a Claude id`)
    const info = resolveModel(id)
    assert.equal(info.isClaude, false, `${id}: must NOT resolve as Claude`)
    assert.equal(info.pricing, null, `${id}: must NOT inherit Claude pricing (unknown, offline)`)
  }
  console.log('✓ claude-*-shaped non-Claude ids never inherit Claude pricing (landmine closed)')

  // Even when models.dev DOES have real data for such an id, isClaude must
  // still read false — the label/family come from models.dev, never from
  // Claude's pricing table.
  setModelsDevCacheForTests({
    'totally-not-sonnet-9000': { context: 32_000, pricing: null, supportsReasoning: false }
  })
  const resolved = resolveModel('totally-not-sonnet-9000')
  assert.equal(resolved.isClaude, false)
  assert.equal(resolved.context, 32_000)
  assert.equal(resolved.pricing, null)
  setModelsDevCacheForTests(null)
  console.log('✓ a landmine-shaped id resolved by models.dev still reports isClaude: false')
}

// ---------------------------------------------------------------------------
// 4. Unknown model -> context: null, pricing: null (no fabrication)
// ---------------------------------------------------------------------------

{
  setModelsDevCacheForTests(null)
  const info = resolveModel('totally-unrecognized-model-id-xyz')
  assert.equal(info.isClaude, false)
  assert.equal(info.context, null)
  assert.equal(info.pricing, null)
  assert.equal(info.label, 'totally-unrecognized-model-id-xyz', 'unknown id falls back to itself')
  console.log('✓ unknown model resolves to context: null, pricing: null (no fabrication)')

  assert.equal(effectiveContext('totally-unrecognized-model-id-xyz'), null)
  console.log('✓ effectiveContext never fabricates a number for an unknown model')
}

// ---------------------------------------------------------------------------
// 5. Known model with cost: null -> pricing: null but context still resolves
//    (models.dev CAN return a real model with no published pricing, e.g.
//    grok-imagine-video per the verified facts in the unit spec)
// ---------------------------------------------------------------------------

{
  setModelsDevCacheForTests({
    'grok-imagine-video': { context: 128_000, pricing: null, supportsReasoning: false }
  })
  const info = resolveModel('grok-imagine-video')
  assert.equal(info.isClaude, false)
  assert.equal(info.context, 128_000, 'context must still resolve even with unknown pricing')
  assert.equal(
    info.pricing,
    null,
    '"known model, unknown pricing" must be distinct from unknown model'
  )
  setModelsDevCacheForTests(null)
  console.log('✓ known model with null cost: context resolves, pricing stays null')
}

// ---------------------------------------------------------------------------
// 6. Per-model cap: min(reported, cap); disable1mContext reproduces today's
//    Claude clamp exactly (200_000, Claude-only — never leaks onto
//    non-Claude models)
// ---------------------------------------------------------------------------

{
  setModelsDevCacheForTests({
    'some-model': { context: 500_000, pricing: null, supportsReasoning: false }
  })

  // Generic cap applies to any model, Claude or not.
  assert.equal(effectiveContext('claude-opus-4-8', { capTokens: 100_000 }), 100_000)
  assert.equal(effectiveContext('some-model', { capTokens: 100_000 }), 100_000)
  assert.equal(
    effectiveContext('some-model', { capTokens: 999_999_999 }),
    500_000,
    'cap larger than native context must not raise the budget'
  )
  console.log('✓ per-model cap: effectiveContext = min(reported, capTokens)')

  // disable1mContext reproduces today's Claude clamp (200_000) EXACTLY, and
  // ONLY for Claude models — it must never leak onto a non-Claude model even
  // if that model's own native context happens to exceed 200_000.
  assert.equal(
    effectiveContext('claude-sonnet-5', { disable1mContext: true }),
    200_000,
    'disable1mContext must clamp a 1M-context Claude model to 200k'
  )
  assert.equal(
    effectiveContext('claude-haiku-4-5', { disable1mContext: true }),
    200_000,
    'disable1mContext clamping a model already <= 200k must be a no-op (min())'
  )
  assert.equal(
    effectiveContext('some-model', { disable1mContext: true }),
    500_000,
    'disable1mContext must NEVER clamp a non-Claude model'
  )
  console.log(
    '✓ disable1mContext reproduces the Claude-only 200k clamp, never leaks to other models'
  )

  // Both caps combine via min().
  assert.equal(
    effectiveContext('claude-sonnet-5', { disable1mContext: true, capTokens: 50_000 }),
    50_000
  )
  console.log('✓ disable1mContext and a user capTokens combine via min()')

  setModelsDevCacheForTests(null)
}

// ---------------------------------------------------------------------------
// 6b. resolveContextBudget bundles model info + effective context in one call
// ---------------------------------------------------------------------------

{
  const { modelId, info, contextBudget } = resolveContextBudget('claude-opus-4-8', {
    disable1mContext: true
  })
  assert.equal(modelId, 'claude-opus-4-8')
  assert.equal(info.isClaude, true)
  assert.equal(contextBudget, 200_000)
  console.log('✓ resolveContextBudget bundles ModelInfo + capped context in one call')
}

// ---------------------------------------------------------------------------
// 7. One canonical label for ids the three old parsers disagreed on
// ---------------------------------------------------------------------------

{
  setModelsDevCacheForTests({
    'gpt-5.1-codex': { context: 400_000, pricing: null, supportsReasoning: true },
    'grok-4.5': { context: 256_000, pricing: null, supportsReasoning: false }
  })

  assert.equal(modelLabel('gpt-5.1-codex'), 'Gpt 5.1 Codex')
  assert.equal(
    resolveModel('gpt-5.1-codex').context,
    400_000,
    'gpt-5-codex-shaped id: 400k, not 200k'
  )
  assert.equal(modelLabel('grok-4.5'), 'Grok 4.5')
  assert.equal(modelLabel('claude-opus-4-8'), 'Opus 4.8')
  assert.equal(modelLabel('opus'), 'Opus (latest)')
  assert.equal(modelLabel(null), '—')
  assert.equal(modelLabel(undefined), '—')
  console.log('✓ one canonical label function agrees across ids the three old parsers disagreed on')

  setModelsDevCacheForTests(null)
}

// ---------------------------------------------------------------------------
// 8. isClaude() convenience + isClaudeModelId() structural guard agree
// ---------------------------------------------------------------------------

{
  assert.equal(isClaude('claude-opus-4-8'), true)
  assert.equal(isClaude('opus'), true)
  assert.equal(isClaude('gpt-5.1-codex'), false)
  assert.equal(isClaudeModelId('claude-opus-4-8'), true)
  assert.equal(isClaudeModelId('gpt-5.1-codex'), false)
  console.log('✓ isClaude()/isClaudeModelId() agree and never misclassify a third-party id')
}

// ---------------------------------------------------------------------------
// 9. refreshModelsDevCache: network failure leaves Claude totally unaffected
//    (offline guarantee under an actual failing fetch, not just an empty
//    cache) — and a real multi-provider payload populates every provider,
//    not just anthropic (the old pricing.ts discarded everything else).
// ---------------------------------------------------------------------------

{
  setModelsDevCacheForTests(null)
  await refreshModelsDevCache(networkDeniedFetch)
  // Must not throw, and Claude must still resolve fully.
  const info = resolveModel('claude-opus-4-8')
  assert.equal(info.isClaude, true)
  assert.equal(info.context, 1_000_000)
  assert.equal(info.pricing?.input, 5)
  console.log('✓ refreshModelsDevCache network failure is swallowed; Claude resolution unaffected')

  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({
        anthropic: {
          models: { 'claude-sonnet-5': { limit: { context: 1 }, cost: { input: 1, output: 1 } } }
        },
        openai: { models: { 'gpt-5.1-codex': { limit: { context: 400_000 }, cost: null } } },
        xai: {
          models: { 'grok-4.5': { limit: { context: 256_000 }, cost: { input: 3, output: 15 } } }
        }
      }),
      { status: 200 }
    )) as typeof fetch

  await refreshModelsDevCache(fakeFetch)

  // Claude must still be resolved by the builtin source, not the (wrong)
  // anthropic entry in this fake payload.
  const claudeInfo = resolveModel('claude-sonnet-5')
  assert.equal(
    claudeInfo.context,
    1_000_000,
    'builtin Claude still wins even if models.dev has anthropic data'
  )

  // Non-Claude providers ARE retained (widened from the old anthropic-only
  // pricing.ts machinery).
  const gpt = resolveModel('gpt-5.1-codex')
  assert.equal(gpt.context, 400_000)
  assert.equal(gpt.pricing, null)
  const grok = resolveModel('grok-4.5')
  assert.equal(grok.context, 256_000)
  assert.equal(grok.pricing?.input, 3)
  console.log(
    '✓ refreshModelsDevCache retains every provider (openai, xai, ...), not just anthropic'
  )

  setModelsDevCacheForTests(null)
}

console.log('\nAll model-registry assertions passed.')
