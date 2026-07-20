// ---------------------------------------------------------------------------
// scripts/verify-model-picker.ts
//
// Assertion harness for the model picker (model-routing unit 06):
// src/main/models/selectable.ts's buildSelectableModels — the single
// selectable-model list every picker (WorkspaceDrawer/SettingsDrawer/
// DropdownChip) renders from — plus src/main/modelRouting.ts's
// computeRoutingEnv, exercised here to prove the user's core requirement:
// three different workspaces resolving three different models each produce
// the correct, INDEPENDENT env.
//
// MUST PASS FULLY OFFLINE. buildSelectableModels takes every main-process-only
// dependency (routing-proxy snapshot, stored provider configs, provider
// descriptors, the cliproxy model cache) as plain parameters — mirrors
// modelRouting.ts's own electron-free/DB-free constraint (see that module's
// header comment) and scripts/verify-routing.ts's own doc comment for why
// this harness never imports anything that pulls in `electron` or
// `better-sqlite3`.
//
// Covers (per the unit spec):
//   1. Claude models are always offered, even with the proxy disabled/
//      stopped/unreachable (the offline guarantee)
//   2. routed models are offered ONLY when proxy running AND account
//      connected/healthy
//   3. a model whose account is unhealthy is NOT offered as selectable
//   4. an already-selected-but-now-unavailable model is still surfaced
//      (marked unavailable), never silently dropped
//   5. per-workspace independence: three different workspaces resolving
//      three different models (claude / codex / grok) each produce the
//      correct env — Claude's is a byte-for-byte no-op while the other two
//      get distinct ANTHROPIC_MODEL values
//   6. effort levels come from real data; a model with none yields no
//      fabricated levels
// ---------------------------------------------------------------------------

import assert from 'node:assert'
import { buildSelectableModels } from '../src/main/models/selectable.ts'
import type {
  BuildSelectableModelsInput,
  ProviderConfigInput,
  ProviderDescriptorInput,
  RoutingProxyStatusInput
} from '../src/main/models/selectable.ts'
import { computeRoutingEnv, isRoutedModel } from '../src/main/modelRouting.ts'
import { CLAUDE_MODEL_OPTIONS } from '../src/shared/types.ts'
import {
  claudeFallbackModels,
  resolveDisabledSnapshot,
  type Entry
} from '../src/renderer/src/lib/selectableModelsStore.ts'

const PROVIDER_DESCRIPTORS: ProviderDescriptorInput[] = [
  { id: 'codex', label: 'Codex (OpenAI)' },
  { id: 'xai', label: 'Grok (xAI)' },
  { id: 'gemini', label: 'Gemini (Google)' }
]

function baseInput(
  overrides: Partial<BuildSelectableModelsInput> = {}
): BuildSelectableModelsInput {
  return {
    routingProxy: { enabled: false, status: 'not_installed', authFiles: [] },
    providerConfigs: [],
    providerDescriptors: PROVIDER_DESCRIPTORS,
    cliProxyModels: [],
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// 1. Claude models are ALWAYS offered — proxy disabled, stopped, AND
//    unreachable/error — the offline guarantee.
// ---------------------------------------------------------------------------

{
  const disabledSnapshot: RoutingProxyStatusInput = {
    enabled: false,
    status: 'not_installed',
    authFiles: []
  }
  const stoppedSnapshot: RoutingProxyStatusInput = {
    enabled: true,
    status: 'stopped',
    authFiles: []
  }
  const errorSnapshot: RoutingProxyStatusInput = {
    enabled: true,
    status: 'error',
    authFiles: [{ provider: 'codex', health: 'error' }]
  }

  for (const snapshot of [disabledSnapshot, stoppedSnapshot, errorSnapshot]) {
    const result = buildSelectableModels(baseInput({ routingProxy: snapshot }))
    assert.equal(
      result.length,
      CLAUDE_MODEL_OPTIONS.length,
      `status=${snapshot.status}: only Claude models must be offered`
    )
    assert.ok(
      result.every((m) => m.isClaude && m.available),
      `status=${snapshot.status}: every offered model must be Claude and available`
    )
    // Claude first, in CLAUDE_MODEL_OPTIONS' own order.
    assert.deepEqual(
      result.map((m) => m.id),
      CLAUDE_MODEL_OPTIONS.map((o) => o.value)
    )
  }
  console.log(
    '✓ Claude models are always offered (and ALL available) even with the proxy disabled/stopped/erroring — offline guarantee'
  )
}

// ---------------------------------------------------------------------------
// 2. Routed models are offered ONLY when proxy running AND the owning
//    provider is connected/healthy — every other combination omits them.
// ---------------------------------------------------------------------------

{
  const codexConfig: ProviderConfigInput = { providerId: 'codex', enabled: true }
  const cliProxyModels = [{ modelId: 'gpt-5-codex', providerId: 'codex', context: 400_000 }]

  // Proxy not running at all (enabled true, status stopped) — provider
  // otherwise healthy — must still omit the routed model.
  const notRunning = buildSelectableModels(
    baseInput({
      routingProxy: {
        enabled: true,
        status: 'stopped',
        authFiles: [{ provider: 'codex', health: 'ok' }]
      },
      providerConfigs: [codexConfig],
      cliProxyModels
    })
  )
  assert.ok(
    !notRunning.some((m) => m.id === 'gpt-5-codex'),
    'proxy not running -> routed model must be omitted even if the provider is healthy'
  )

  // Proxy running, but provider disabled in stored config.
  const disabledProvider = buildSelectableModels(
    baseInput({
      routingProxy: {
        enabled: true,
        status: 'running',
        authFiles: [{ provider: 'codex', health: 'ok' }]
      },
      providerConfigs: [{ providerId: 'codex', enabled: false }],
      cliProxyModels
    })
  )
  assert.ok(
    !disabledProvider.some((m) => m.id === 'gpt-5-codex'),
    'provider disabled in stored config -> routed model must be omitted'
  )

  // Proxy running, provider enabled, but never connected (no authFiles entry
  // at all) — absence is not health.
  const neverConnected = buildSelectableModels(
    baseInput({
      routingProxy: { enabled: true, status: 'running', authFiles: [] },
      providerConfigs: [codexConfig],
      cliProxyModels
    })
  )
  assert.ok(
    !neverConnected.some((m) => m.id === 'gpt-5-codex'),
    'provider never connected (absent from authFiles) -> routed model must be omitted'
  )

  // The happy path: proxy running AND provider enabled AND healthy -> offered.
  const healthy = buildSelectableModels(
    baseInput({
      routingProxy: {
        enabled: true,
        status: 'running',
        authFiles: [{ provider: 'codex', health: 'ok' }]
      },
      providerConfigs: [codexConfig],
      cliProxyModels
    })
  )
  const offered = healthy.find((m) => m.id === 'gpt-5-codex')
  assert.ok(offered, 'proxy running + provider healthy -> routed model must be offered')
  assert.equal(offered!.available, true)
  assert.equal(offered!.isClaude, false)
  assert.equal(offered!.providerId, 'codex')
  assert.equal(offered!.providerLabel, 'Codex (OpenAI)')
  assert.equal(offered!.contextWindow, 400_000)
  console.log(
    '✓ routed models are offered ONLY when proxy is running AND the account is connected+healthy'
  )
}

// ---------------------------------------------------------------------------
// 3. A model whose account is unhealthy (health: 'error' or 'unknown') is
//    NOT offered as a fresh selection.
// ---------------------------------------------------------------------------

{
  for (const health of ['error', 'unknown'] as const) {
    const result = buildSelectableModels(
      baseInput({
        routingProxy: {
          enabled: true,
          status: 'running',
          authFiles: [{ provider: 'xai', health }]
        },
        providerConfigs: [{ providerId: 'xai', enabled: true }],
        cliProxyModels: [{ modelId: 'grok-4.5', providerId: 'xai', context: 256_000 }]
      })
    )
    assert.ok(
      !result.some((m) => m.id === 'grok-4.5'),
      `health='${health}' -> routed model must NOT be offered as selectable`
    )
  }
  console.log('✓ a model whose account health is error/unknown is never offered as selectable')
}

// ---------------------------------------------------------------------------
// 4. An already-selected-but-now-unavailable model is still surfaced, marked
//    unavailable — never silently dropped.
// ---------------------------------------------------------------------------

{
  // Case A: the model is still known to the cliproxy cache (so its facts are
  // preserved) but its provider is now unhealthy/disconnected.
  const stillCached = buildSelectableModels(
    baseInput({
      routingProxy: {
        enabled: true,
        status: 'running',
        authFiles: [{ provider: 'xai', health: 'error' }]
      },
      providerConfigs: [{ providerId: 'xai', enabled: true }],
      cliProxyModels: [
        { modelId: 'grok-4.5', providerId: 'xai', context: 256_000, effortLevels: ['low', 'high'] }
      ],
      currentModelId: 'grok-4.5'
    })
  )
  const preserved = stillCached.find((m) => m.id === 'grok-4.5')
  assert.ok(preserved, 'a currently-selected routed model must never be dropped from the list')
  assert.equal(preserved!.available, false, 'it must be marked unavailable, not silently hidden')
  assert.equal(preserved!.contextWindow, 256_000, 'known facts are preserved even when unavailable')
  assert.deepEqual(preserved!.effortLevels, ['low', 'high'])

  // Case B: the proxy is entirely down (cache empty too) — the model is
  // still surfaced (unavailable, facts unknown) rather than vanishing.
  const proxyFullyDown = buildSelectableModels(
    baseInput({
      routingProxy: { enabled: false, status: 'not_installed', authFiles: [] },
      cliProxyModels: [],
      currentModelId: 'gpt-5-codex'
    })
  )
  const stillThere = proxyFullyDown.find((m) => m.id === 'gpt-5-codex')
  assert.ok(stillThere, 'a stored routed selection must survive even a fully-down proxy')
  assert.equal(stillThere!.available, false)
  assert.equal(stillThere!.contextWindow, null, 'unknown facts stay null, never fabricated')

  // Case C: a Claude-model currentModelId must NOT get a duplicate/unavailable
  // entry appended — it's already in the Claude group as available.
  const claudeCurrent = buildSelectableModels(baseInput({ currentModelId: 'claude-opus-4-8' }))
  assert.equal(
    claudeCurrent.filter((m) => m.id === 'claude-opus-4-8').length,
    1,
    'a Claude currentModelId must not produce a second (unavailable) entry'
  )
  console.log(
    '✓ an already-selected-but-now-unavailable model is preserved (marked unavailable), never silently dropped'
  )
}

// ---------------------------------------------------------------------------
// 5. THE CORE REQUIREMENT: per-workspace independence. Three different
//    workspaces resolving three different models (claude / codex / grok)
//    each produce the correct, INDEPENDENT env — Claude's is a byte-for-byte
//    no-op while the other two get distinct ANTHROPIC_MODEL values, all
//    computed from the SAME proxy url/auth token (proving the divergence is
//    solely a function of each workspace's own resolved model, not shared
//    mutable state leaking between workspaces).
// ---------------------------------------------------------------------------

{
  const sharedOptions = { proxyUrl: 'http://127.0.0.1:18765', authToken: 'shared-run-token' }

  const workspaceA = { id: 'workspace-a', model: 'claude-opus-4-8' }
  const workspaceB = { id: 'workspace-b', model: 'gpt-5-codex' }
  const workspaceC = { id: 'workspace-c', model: 'grok-4.5' }

  const envA = computeRoutingEnv(workspaceA.model, sharedOptions)
  const envB = computeRoutingEnv(workspaceB.model, sharedOptions)
  const envC = computeRoutingEnv(workspaceC.model, sharedOptions)

  // Claude's is a BYTE-FOR-BYTE no-op: empty overlay, no keys at all.
  assert.deepEqual(envA, {}, 'workspace A (Claude) must get a byte-for-byte no-op env overlay')
  assert.equal(isRoutedModel(workspaceA.model), false)

  // The other two get real routing overlays with DISTINCT ANTHROPIC_MODEL
  // values, proving each workspace's routing is independent of the others.
  assert.equal(isRoutedModel(workspaceB.model), true)
  assert.equal(isRoutedModel(workspaceC.model), true)
  assert.equal(envB.ANTHROPIC_MODEL, 'gpt-5-codex')
  assert.equal(envC.ANTHROPIC_MODEL, 'grok-4.5')
  assert.notEqual(
    envB.ANTHROPIC_MODEL,
    envC.ANTHROPIC_MODEL,
    'workspace B and workspace C must resolve DIFFERENT ANTHROPIC_MODEL values simultaneously'
  )

  // Both routed workspaces share the same proxy URL/auth token (same local
  // proxy process) but differ ONLY in ANTHROPIC_MODEL — proving routing is
  // per-workspace-model-scoped, not per-provider-process-scoped.
  assert.equal(envB.ANTHROPIC_BASE_URL, envC.ANTHROPIC_BASE_URL)
  assert.equal(envB.ANTHROPIC_AUTH_TOKEN, envC.ANTHROPIC_AUTH_TOKEN)
  assert.equal(envB.ANTHROPIC_BASE_URL, 'http://127.0.0.1:18765')

  // Re-resolving workspace A AFTER computing B and C proves no shared
  // module-level state leaked between workspaces — A is still a no-op.
  const envAAgain = computeRoutingEnv(workspaceA.model, sharedOptions)
  assert.deepEqual(envAAgain, {}, 'workspace A must still be a no-op after B/C were resolved')

  console.log(
    '✓ per-workspace independence: claude/codex/grok resolve simultaneously and independently — Claude stays a byte-for-byte no-op, the other two get distinct ANTHROPIC_MODEL values'
  )
}

// ---------------------------------------------------------------------------
// 6. Effort levels come from REAL data (thinking.levels via the cliproxy
//    cache); a model with none yields effortLevels: null — never a fabricated
//    generic list.
// ---------------------------------------------------------------------------

{
  const runningHealthy: RoutingProxyStatusInput = {
    enabled: true,
    status: 'running',
    authFiles: [{ provider: 'codex', health: 'ok' }]
  }
  const providerConfigs: ProviderConfigInput[] = [{ providerId: 'codex', enabled: true }]

  const withLevels = buildSelectableModels(
    baseInput({
      routingProxy: runningHealthy,
      providerConfigs,
      cliProxyModels: [
        {
          modelId: 'gpt-5-codex',
          providerId: 'codex',
          context: 400_000,
          effortLevels: ['low', 'medium', 'high']
        }
      ]
    })
  )
  const withLevelsEntry = withLevels.find((m) => m.id === 'gpt-5-codex')
  assert.deepEqual(withLevelsEntry!.effortLevels, ['low', 'medium', 'high'])

  const withoutLevels = buildSelectableModels(
    baseInput({
      routingProxy: runningHealthy,
      providerConfigs,
      cliProxyModels: [{ modelId: 'gpt-5-mini', providerId: 'codex', context: 128_000 }]
    })
  )
  const withoutLevelsEntry = withoutLevels.find((m) => m.id === 'gpt-5-mini')
  assert.equal(
    withoutLevelsEntry!.effortLevels,
    null,
    'a model with no reported thinking.levels must yield effortLevels: null, never a fabricated generic list'
  )

  // Claude entries never carry fabricated effort levels either — the picker
  // must disable/hide the effort control for them via this same null, not a
  // hardcoded generic list.
  const claudeEntry = withLevels.find((m) => m.isClaude)
  assert.equal(claudeEntry!.effortLevels, null)

  console.log(
    '✓ effort levels come from real cliproxy thinking.levels data; a model with none yields null, never fabricated'
  )
}

// ---------------------------------------------------------------------------
// 7. Renderer-boundary guarantee (bug-fix regression coverage): the fallback
//    used when models:listSelectable's IPC has not yet resolved OR has
//    failed outright must contain the FULL Claude model list — never `[]` —
//    and that fallback must be derived from the built-in CLAUDE_MODEL_OPTIONS
//    constant, not from any proxy/routing state. Exercises
//    claudeFallbackModels() directly (the exact function
//    src/renderer/src/lib/selectableModelsStore.ts seeds its initial
//    useSyncExternalStore snapshot with AND falls back to on IPC failure) so
//    this is asserted without needing React/Electron.
// ---------------------------------------------------------------------------

{
  // 7a. No currentModelId — the bare fallback must equal the full Claude
  // list, in CLAUDE_MODEL_OPTIONS' own order, every entry available.
  const fallback = claudeFallbackModels()
  assert.equal(
    fallback.length,
    CLAUDE_MODEL_OPTIONS.length,
    'the zero-IPC fallback must contain the FULL Claude model list, never empty'
  )
  assert.ok(
    fallback.every((m) => m.isClaude && m.available),
    'every fallback entry must be Claude and available (the offline guarantee)'
  )
  assert.deepEqual(
    fallback.map((m) => m.id),
    CLAUDE_MODEL_OPTIONS.map((o) => o.value),
    'the fallback must be derived from CLAUDE_MODEL_OPTIONS, not proxy/routing state'
  )
  console.log(
    '✓ the renderer fallback (first paint AND IPC failure) is the full Claude list, never empty'
  )
}

{
  // 7b. Routed models are additive ON TOP of the fallback, never a
  // replacement — the store's cache entry always starts from
  // claudeFallbackModels() and is only ever REPLACED wholesale by a
  // successful models:listSelectable response (which itself always leads
  // with the same Claude entries per buildSelectableModels — assertion 1
  // above), so a caller reading the fallback mid-fetch never sees routed
  // models before Claude, and Claude entries are never displaced.
  const fallback = claudeFallbackModels()
  const claudeIds = new Set(CLAUDE_MODEL_OPTIONS.map((o) => o.value))
  assert.ok(
    fallback.every((m) => claudeIds.has(m.id)),
    'the bare fallback must contain ONLY Claude entries — routed models only ever layer in via a resolved IPC response'
  )
  console.log('✓ routed models are additive on top of the Claude fallback, never a replacement')
}

{
  // 7c. An already-selected-but-unavailable (routed) model must survive in
  // the FALLBACK path too, not just in buildSelectableModels' server-side
  // result — otherwise a workspace pinned to a routed model would see its
  // own selection vanish from the dropdown for the entire window between
  // mount and IPC resolution (or permanently, if the IPC call fails).
  const withCurrent = claudeFallbackModels('grok-4.5')
  const preserved = withCurrent.find((m) => m.id === 'grok-4.5')
  assert.ok(
    preserved,
    'an already-selected-but-unavailable model must survive in the renderer fallback path'
  )
  assert.equal(preserved!.available, false, 'it must be marked unavailable, not fabricated as ok')
  assert.equal(preserved!.isClaude, false)

  // A Claude currentModelId must NOT produce a duplicate entry in the
  // fallback either (mirrors buildSelectableModels' own case C).
  const claudeCurrent = claudeFallbackModels('claude-opus-4-8')
  assert.equal(
    claudeCurrent.filter((m) => m.id === 'claude-opus-4-8').length,
    1,
    'a Claude currentModelId must not produce a second entry in the fallback'
  )
  console.log(
    '✓ an already-selected-but-unavailable model survives the fallback path, without duplicating an already-Claude selection'
  )
}

// ---------------------------------------------------------------------------
// 8. Stale-fallback-shadowing regression coverage (bug fix in
//    selectableModelsStore.ts): a disabled caller's memoized fallback entry
//    for a key must NEVER shadow a live (enabled, fetched) entry that exists
//    for the SAME key — this is exactly the "one workspace shows Claude-only
//    forever" bug. Exercises resolveDisabledSnapshot() directly (the pure
//    function factored out of the disabled-path branch of
//    useSelectableModelsStore's getSnapshot) against plain Maps, so this is
//    asserted fully offline without React/useSyncExternalStore.
// ---------------------------------------------------------------------------

{
  // 8a. No live entry yet -> the memoized Claude-only fallback is returned
  // (and cached) — this is the correct first-paint/no-data-yet behavior.
  const live = new Map<string, Entry>()
  const fallbackCache = new Map<string, Entry>()
  const key = 'gpt-5-codex'

  const first = resolveDisabledSnapshot(live, fallbackCache, key, key)
  assert.ok(
    first.models.every((m) => m.isClaude || m.id === key),
    'with no live entry, resolveDisabledSnapshot must return the Claude-only fallback (plus the preserved current selection)'
  )
  assert.ok(fallbackCache.has(key), 'the fallback must be memoized under the key after first read')

  // Same reference returned on a second read with still-no-live-data — this
  // is the referential-stability property useSyncExternalStore requires:
  // getSnapshot must not construct a fresh array/object every call or React
  // infinite-loops re-rendering.
  const second = resolveDisabledSnapshot(live, fallbackCache, key, key)
  assert.equal(
    second,
    first,
    'repeated reads with no live data must return the SAME memoized reference (referential stability for useSyncExternalStore)'
  )

  // 8b. THE CORE REGRESSION: live data now arrives for this key (a routed
  // model list, including a Codex entry) — resolveDisabledSnapshot must
  // return the LIVE entry, not the memoized Claude-only fallback from 8a,
  // even though the fallback is still sitting in fallbackCache un-cleared.
  const liveEntry: Entry = {
    models: [
      ...claudeFallbackModels(),
      {
        id: 'gpt-5-codex',
        label: 'GPT-5 Codex',
        providerId: 'codex',
        providerLabel: 'Codex (OpenAI)',
        isClaude: false,
        available: true,
        contextWindow: 400_000,
        effortLevels: null
      }
    ],
    loading: false
  }
  live.set(key, liveEntry)

  const afterLiveArrives = resolveDisabledSnapshot(live, fallbackCache, key, key)
  assert.equal(
    afterLiveArrives,
    liveEntry,
    'once a live entry exists for a key, resolveDisabledSnapshot must return it — a memoized fallback must never shadow live data'
  )
  assert.ok(
    afterLiveArrives.models.some((m) => m.id === 'gpt-5-codex'),
    'the returned entry must include the routed (Codex) model, proving the fallback did not shadow it'
  )
  console.log(
    '✓ a memoized fallback entry for a key does NOT shadow live data once live data exists for that key'
  )
}

{
  // 8c. Invalidation clears the fallback memo, so a stale Claude-only entry
  // cannot survive a proxy/health change: after live data is cleared (as
  // invalidateAll() does to `store` for keys with no active subscriber) AND
  // the fallback cache is cleared (as invalidateAll() now also does to
  // disabledSnapshots), the next read re-derives a FRESH fallback entry
  // rather than returning a stale pre-invalidation reference.
  const live = new Map<string, Entry>()
  const fallbackCache = new Map<string, Entry>()
  const key = ''

  const beforeInvalidation = resolveDisabledSnapshot(live, fallbackCache, key)
  assert.ok(fallbackCache.has(key), 'sanity: the fallback must be memoized before invalidation')

  // Mirrors invalidateAll(): clear both the live store's stale entries (none
  // here) and disabledSnapshots.
  live.clear()
  fallbackCache.clear()

  const afterInvalidation = resolveDisabledSnapshot(live, fallbackCache, key)
  assert.notEqual(
    afterInvalidation,
    beforeInvalidation,
    'after invalidation, the fallback must be RE-DERIVED (a new reference), never the stale pre-invalidation one'
  )
  assert.ok(
    afterInvalidation.models.every((m) => m.isClaude),
    're-derived fallback must still be the full Claude-only list'
  )

  // And if live data has meanwhile arrived for this key (the realistic
  // post-invalidation case — invalidateAll() refetches keys with active
  // subscribers), the re-derived read must prefer THAT over deriving a new
  // fallback at all.
  const liveAfterInvalidation: Entry = { models: claudeFallbackModels(), loading: false }
  live.set(key, liveAfterInvalidation)
  const afterInvalidationWithLive = resolveDisabledSnapshot(live, fallbackCache, key)
  assert.equal(
    afterInvalidationWithLive,
    liveAfterInvalidation,
    'post-invalidation, if live data has arrived for the key, it must be preferred over deriving another fallback'
  )
  console.log(
    '✓ invalidation clears the fallback memo so it is re-derived — a stale Claude-only entry cannot survive a proxy/health change'
  )
}

{
  // 8d. Non-negotiable invariant preserved: the disabled-path fallback is
  // STILL what would be rendered on first paint (no live data yet, nothing
  // memoized yet) — and it is never empty. This is the same guarantee
  // assertion 7 proves for claudeFallbackModels() directly; here it's
  // re-proven through the exact function the disabled hook branch calls.
  const live = new Map<string, Entry>()
  const fallbackCache = new Map<string, Entry>()
  const firstPaint = resolveDisabledSnapshot(live, fallbackCache, '')
  assert.ok(firstPaint.models.length > 0, 'first-paint disabled-path snapshot must never be empty')
  assert.ok(
    firstPaint.models.every((m) => m.isClaude && m.available),
    'first-paint disabled-path snapshot must be the fully-available Claude list'
  )
  console.log(
    '✓ the disabled-path fallback is still returned (non-empty, Claude-only) on first paint with no live data'
  )
}

console.log('\nAll model-picker assertions passed.')
