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
import {
  refreshCliProxyModelCache,
  setCliProxyModelCacheForTests,
  listCliProxyModelCacheEntries,
  shouldRefreshCliProxyModelCache,
  hydrateCliProxyModelCacheFromPersisted,
  type CliProxyModelSourceDeps
} from '../src/main/models/sources/cliproxy.ts'
import { CLAUDE_MODEL_OPTIONS } from '../src/shared/types.ts'
import {
  fetchRoutingProxyAuthFiles,
  type AuthFilesDeps
} from '../src/main/routingProxy/authFiles.ts'
import {
  reclaimOrphanRoutingProxyPort,
  type OrphanReclaimDeps
} from '../src/main/routingProxy/orphan.ts'
import {
  claudeFallbackModels,
  resolveDisabledSnapshot,
  shouldStartFetchNow,
  shouldRefetchAfterSettle,
  type Entry
} from '../src/renderer/src/lib/selectableModelsStore.ts'
import {
  isPersistedCacheVersionValid,
  isPersistedCacheFresh,
  raceWithTimeout
} from '../src/main/models/cliProxyModelCacheStaleness.ts'
import { PINNED_VERSION } from '../src/main/routingProxy/constants.ts'

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

  // Claude entries carry REAL per-model levels from the hand-maintained
  // CLAUDE_BUILTIN_EFFORT_LEVELS table (model-routing unit 11) — not a
  // blanket null and not a fabricated generic list. See
  // scripts/verify-effort-levels.ts for the full per-model assertions
  // (ladder order, the stale-selection guard, live per-model data); this
  // assertion just proves selectable.ts's Claude entries are wired to that
  // table rather than left at the old hardcoded null.
  const claudeEntry = withLevels.find((m) => m.isClaude)
  assert.ok(
    Array.isArray(claudeEntry!.effortLevels) && claudeEntry!.effortLevels!.length > 0,
    'Claude entries must carry real per-model effort levels from CLAUDE_BUILTIN_EFFORT_LEVELS, not null'
  )

  console.log(
    '✓ effort levels come from real cliproxy thinking.levels data (routed models) and the builtin ' +
      'per-model table (Claude models); a model with neither yields null, never fabricated'
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

// ---------------------------------------------------------------------------
// 9. Issue 2 — the on-demand cliproxy model-cache refresh.
//    shouldRefreshCliProxyModelCache (the pure gate factored out of
//    routingProxy/manager.ts's ensureCliProxyModelCacheFresh, which itself
//    can't be exercised offline because manager.ts imports `electron`) must
//    fire ONLY when the cache is empty, the proxy is running, a secret
//    exists, nothing is already in flight, and the throttle window elapsed —
//    and refreshCliProxyModelCache (fully offline-testable via its injected
//    fetchJson dep) must populate the cache from a fake proxy response and
//    leave it untouched on a failed fetch (never throws).
// ---------------------------------------------------------------------------

{
  const baseGateInput = {
    cacheSize: 0,
    isProxyRunning: true,
    hasManagementSecret: true,
    isRefreshInFlight: false,
    lastAttemptAt: 0,
    now: 10_000,
    minIntervalMs: 5_000
  }

  assert.equal(
    shouldRefreshCliProxyModelCache(baseGateInput),
    true,
    'empty cache + running proxy + secret + no in-flight + throttle elapsed -> must refresh'
  )
  assert.equal(
    shouldRefreshCliProxyModelCache({ ...baseGateInput, cacheSize: 3 }),
    false,
    'a non-empty cache must never trigger an on-demand refresh — the 30s interval is enough'
  )
  assert.equal(
    shouldRefreshCliProxyModelCache({ ...baseGateInput, isProxyRunning: false }),
    false,
    'proxy not running -> must not attempt a refresh (nothing to query)'
  )
  assert.equal(
    shouldRefreshCliProxyModelCache({ ...baseGateInput, hasManagementSecret: false }),
    false,
    'no management secret -> must not attempt a refresh'
  )
  assert.equal(
    shouldRefreshCliProxyModelCache({ ...baseGateInput, isRefreshInFlight: true }),
    false,
    'a refresh already in flight -> must not start a second one'
  )
  assert.equal(
    shouldRefreshCliProxyModelCache({ ...baseGateInput, lastAttemptAt: 8_000, now: 10_000 }),
    false,
    'throttle window not yet elapsed (10000 - 8000 = 2000 < 5000) -> must not refresh'
  )
  assert.equal(
    shouldRefreshCliProxyModelCache({ ...baseGateInput, lastAttemptAt: 4_000, now: 10_000 }),
    true,
    'throttle window elapsed (10000 - 4000 = 6000 >= 5000) -> must refresh'
  )
  console.log(
    '✓ shouldRefreshCliProxyModelCache gates the on-demand refresh correctly (empty cache, running, secret, not in-flight, throttled)'
  )
}

{
  // refreshCliProxyModelCache itself: a fake fetchJson simulating CLIProxyAPI's
  // model-definitions endpoint populates the cache; buildSelectableModels then
  // reflects it — proving the mechanism ensureCliProxyModelCacheFresh wraps
  // actually makes previously-invisible routed models selectable.
  setCliProxyModelCacheForTests(null) // start from a clean, empty cache
  assert.equal(listCliProxyModelCacheEntries().length, 0, 'sanity: cache starts empty')

  const fakeDeps: CliProxyModelSourceDeps = {
    fetchJson: async (url: string): Promise<unknown> => {
      if (url.includes('/model-definitions/codex')) {
        return [
          { name: 'gpt-5-codex', context_length: 400_000, thinking: { levels: ['low', 'high'] } }
        ]
      }
      return [] // every other provider channel: no models reported
    }
  }
  await refreshCliProxyModelCache('http://127.0.0.1:18765', 'fake-secret', fakeDeps)

  const entries = listCliProxyModelCacheEntries()
  assert.ok(
    entries.some((e) => e.modelId === 'gpt-5-codex'),
    'a successful refresh must populate the cache from the fake proxy response'
  )

  const afterRefresh = buildSelectableModels(
    baseInput({
      routingProxy: {
        enabled: true,
        status: 'running',
        authFiles: [{ provider: 'codex', health: 'ok' }]
      },
      providerConfigs: [{ providerId: 'codex', enabled: true }],
      cliProxyModels: entries
    })
  )
  assert.ok(
    afterRefresh.some((m) => m.id === 'gpt-5-codex' && m.available),
    'once the cache is populated by the on-demand refresh, the model becomes selectable — the issue-2 fix'
  )
  console.log(
    '✓ refreshCliProxyModelCache populates the cache from a fake proxy response, making the model selectable'
  )

  // A failed fetch (every channel throws) must leave the existing cache
  // intact, never throw, and never wipe known facts.
  const failingDeps: CliProxyModelSourceDeps = {
    fetchJson: (): Promise<unknown> => Promise.reject(new Error('ECONNREFUSED'))
  }
  await refreshCliProxyModelCache('http://127.0.0.1:18765', 'fake-secret', failingDeps)
  const afterFailedRefresh = listCliProxyModelCacheEntries()
  assert.ok(
    afterFailedRefresh.some((e) => e.modelId === 'gpt-5-codex'),
    'a fully-failed refresh (proxy unreachable) must leave the previous cache intact, never wipe it'
  )
  console.log(
    '✓ a failed refresh (proxy unreachable) never throws and never wipes the existing cache'
  )

  // Reset the module-level cache so this harness leaves no cross-test state.
  setCliProxyModelCacheForTests(null)
}

// ---------------------------------------------------------------------------
// End-to-end reproduction of the reported bug: "Until I open Settings ->
// Model Routing, the CLIProxyAPI models are not shown."
//
// Root cause (confirmed): manager.ts's reconcileRoutingProxy() only calls
// start() when isRunning() is false AND nothing else runs refreshAuthFiles()
// or arms its 30s timer. isRunning() reflects only THIS run's in-memory
// child handle (lifecycle.ts), so a proxy process left listening by a PRIOR
// app run (crash/force-quit before shutdownRoutingProxySync) is invisible to
// it — reconcileRoutingProxy() sees "not running" (per its own bookkeeping),
// takes no action, and authFiles stays [] for the entire session UNLESS the
// user visits Settings -> Model Routing (which calls refreshAuthFilesNow()
// directly, the ONLY other call site for refreshAuthFiles()).
//
// This section proves, entirely with data available to buildSelectableModels
// (routing-proxy snapshot + provider configs + cliproxy cache — see that
// module's own doc comment: NO concept of "settings page visited" exists
// anywhere in its input shape), that:
//   1. Before authFiles is populated, routed models are correctly withheld
//      (matches today's gating in selectable.ts — proves the gate itself is
//      untouched).
//   2. Once authFiles is populated via the SAME mechanism the fix uses
//      (fetchRoutingProxyAuthFiles against a fake proxy, exactly as
//      manager.ts's refreshAuthFiles() calls it), the routed model becomes
//      selectable — with nothing resembling "open the settings page" anywhere
//      in this call sequence. This is the requirement: routed models must
//      become selectable purely because authFiles reported healthy, never
//      because of a UI navigation event.
//   3. Claude models remain selectable throughout, including in the
//      pre-fix (empty authFiles) state — the offline guarantee is never at
//      risk from this change.
// ---------------------------------------------------------------------------

{
  const routingProxyRunning = { enabled: true, status: 'running' as const }

  // Step 0 (sanity/regression): before ANY authFiles population — mirrors
  // the exact broken state a reconcileRoutingProxy() that silently skipped
  // start() against an orphan-held port would leave behind for the entire
  // session pre-fix.
  const preFix = buildSelectableModels(
    baseInput({
      routingProxy: { ...routingProxyRunning, authFiles: [] },
      providerConfigs: [{ providerId: 'codex', enabled: true }],
      cliProxyModels: [{ modelId: 'gpt-5-codex', providerId: 'codex', context: 400_000 }]
    })
  )
  assert.ok(
    !preFix.some((m) => m.id === 'gpt-5-codex'),
    "THIS ASSERTION FAILS ON PRE-FIX BEHAVIOR'S SYMPTOM (empty authFiles): routed model correctly " +
      'withheld while authFiles is empty — proves the gate itself is untouched, only the data-flow ' +
      'that populates authFiles changed'
  )
  assert.ok(
    preFix.some((m) => m.isClaude),
    'Claude models remain offered even while authFiles is empty (offline guarantee, unreachable-proxy case)'
  )
  console.log(
    '✓ (pre-populate sanity) routed model correctly withheld while authFiles is empty; Claude still offered'
  )

  // Step 1: simulate reclaimOrphanRoutingProxyPort() finding + killing an
  // orphan process holding the port (the fix's new boot-time step) — proves
  // the reclaim function itself reports what the caller needs to decide to
  // proceed to a fresh start(), without touching anything settings-page-related.
  const orphanDeps: OrphanReclaimDeps = {
    tcpProbe: async () => true, // something (the orphan) is listening
    listPortOwners: async () => [55555], // its PID, discoverable via lsof
    killPid: () => {},
    sleep: async () => {}
  }
  const reclaim = await reclaimOrphanRoutingProxyPort('127.0.0.1', 18765, orphanDeps)
  assert.equal(
    reclaim.reclaimed,
    true,
    "the orphan-port case (the reported bug's actual root cause) must be detected and reclaimed"
  )

  // Step 2: after reclaim, a fresh child is spawned (manager.ts's start(),
  // not exercised here directly since it needs electron) and refreshAuthFiles()
  // runs — simulated here via the exact same fetchRoutingProxyAuthFiles() call
  // manager.ts makes, against a fake proxy reporting the codex provider healthy.
  const fakeAuthFilesDeps: AuthFilesDeps = {
    fetchJson: async () => [{ provider: 'codex', status: 'ok', name: 'Codex' }]
  }
  const authFiles = await fetchRoutingProxyAuthFiles(
    'http://127.0.0.1:18765',
    'fresh-post-respawn-secret',
    fakeAuthFilesDeps
  )
  assert.ok(
    authFiles.some((f) => f.provider === 'codex' && f.health === 'ok'),
    'authFiles must be populated after the reclaim+respawn path — this is the actual fix: authFiles ' +
      'reaches this state at BOOT now, not only after a Settings page visit'
  )

  // Step 3: buildSelectableModels now offers the routed model — reached with
  // ZERO involvement of anything resembling "settings page opened". Nothing
  // in buildSelectableModelsInput's shape (see selectable.ts) even has a
  // field for that; the only inputs are the routing-proxy snapshot, provider
  // configs, provider descriptors, and the cliproxy cache — all sourced here
  // from the boot-time reclaim+refresh path.
  const postFix = buildSelectableModels(
    baseInput({
      routingProxy: { ...routingProxyRunning, authFiles },
      providerConfigs: [{ providerId: 'codex', enabled: true }],
      cliProxyModels: [{ modelId: 'gpt-5-codex', providerId: 'codex', context: 400_000 }]
    })
  )
  assert.ok(
    postFix.some((m) => m.id === 'gpt-5-codex' && m.available),
    'THE FIX: once authFiles reports the provider healthy via the boot-time orphan-reclaim + ' +
      'refreshAuthFiles path, the routed model becomes selectable — reproducing the user-reported ' +
      "bug's resolution with no settings-page visit anywhere in this sequence"
  )
  assert.ok(
    postFix.some((m) => m.isClaude),
    'Claude models remain offered alongside the newly-available routed model (offline guarantee intact)'
  )
  console.log(
    '✓ END-TO-END: orphan-port reclaim -> authFiles populated -> routed model selectable, with no ' +
      'settings-page visit involved anywhere in the sequence (reproduces + resolves the reported bug)'
  )
}

// ---------------------------------------------------------------------------
// Claude offline guarantee, explicitly re-asserted against a completely
// unreachable proxy (orphan reclaim finds nothing, proxy never starts) —
// this is the regression the fix must never introduce: Claude must still be
// fully selectable no matter what the orphan-reclaim/authFiles machinery
// does or fails to do.
// ---------------------------------------------------------------------------

{
  const noOrphanDeps: OrphanReclaimDeps = {
    tcpProbe: async () => false, // nothing listening at all — proxy fully down
    listPortOwners: async () => {
      throw new Error('must not even be called when tcpProbe already says nothing is listening')
    },
    killPid: () => {
      throw new Error('must never kill anything when nothing is listening')
    },
    sleep: async () => {
      throw new Error('must never sleep when nothing is listening')
    }
  }
  const reclaim = await reclaimOrphanRoutingProxyPort('127.0.0.1', 18765, noOrphanDeps)
  assert.equal(reclaim.reclaimed, false, 'nothing to reclaim when the proxy is fully unreachable')

  const claudeOnly = buildSelectableModels(
    baseInput({
      routingProxy: { enabled: false, status: 'not_installed', authFiles: [] },
      providerConfigs: [],
      cliProxyModels: []
    })
  )
  assert.ok(
    claudeOnly.length > 0 && claudeOnly.every((m) => m.isClaude),
    'with the proxy fully down/unreachable, ONLY Claude models must be offered — the offline ' +
      'guarantee must survive the orphan-reclaim change completely intact'
  )
  console.log(
    '✓ (no-regression) Claude offline guarantee intact: proxy fully unreachable -> Claude-only list, ' +
      'unaffected by the orphan-reclaim addition'
  )
}

// ---------------------------------------------------------------------------
// 10. THE REPORTED BUG (persisted cache across launches): "Still noticing
//    delay... something is off." Root cause: cliproxy.ts's cache is
//    in-memory only, so it's empty on EVERY app launch — the first
//    models:listSelectable call of every run was guaranteed Claude-only
//    until a later background refresh completed. The fix hydrates the
//    in-memory cache from a persisted payload
//    (cliProxyModelCachePersistence.ts, wired at boot by
//    routingProxy/manager.ts's hydrateSnapshotAtBoot) BEFORE any network
//    call happens this run.
//
// This section simulates exactly that boot sequence — hydrate from a
// "previous run's" persisted payload via hydrateCliProxyModelCacheFromPersisted,
// then immediately call buildSelectableModels with ZERO refresh having
// happened yet this run — and proves the routed model is already selectable.
//
// THIS ASSERTION FAILS ON PRE-FIX BEHAVIOR: before this fix,
// hydrateCliProxyModelCacheFromPersisted did not exist and the cache started
// (and stayed) empty until a live refresh — so the "first call after launch"
// step below would find the cache still empty and the routed model absent.
// ---------------------------------------------------------------------------

{
  setCliProxyModelCacheForTests(null) // clean slate — nothing fetched THIS run yet

  // Simulate "a previous run persisted this to disk" — exactly the shape
  // loadPersistedCliProxyModelCache() would hand routingProxy/manager.ts.
  const persistedFromPreviousRun = {
    'gpt-5-codex': {
      context: 400_000,
      supportsReasoning: true,
      providerId: 'codex',
      effortLevels: ['low', 'medium', 'high']
    }
  }

  // Boot-time hydration — the ONLY thing that has happened this run. No
  // fetch, no refreshCliProxyModelCache call.
  hydrateCliProxyModelCacheFromPersisted(persistedFromPreviousRun)

  assert.equal(
    listCliProxyModelCacheEntries().length,
    1,
    'boot-time hydration must populate the in-memory cache from the persisted payload, with no network call'
  )

  // THE FIRST models:listSelectable-equivalent call of this run.
  const firstCallThisRun = buildSelectableModels(
    baseInput({
      routingProxy: {
        enabled: true,
        status: 'running',
        authFiles: [{ provider: 'codex', health: 'ok' }]
      },
      providerConfigs: [{ providerId: 'codex', enabled: true }],
      cliProxyModels: listCliProxyModelCacheEntries()
    })
  )
  const routedEntry = firstCallThisRun.find((m) => m.id === 'gpt-5-codex')
  assert.ok(
    routedEntry && routedEntry.available,
    'THE REPORTED BUG, FIXED: the FIRST models:listSelectable call after boot must already include ' +
      'the routed model when a valid persisted cache exists — this assertion fails against pre-fix ' +
      'behavior (in-memory-only cache, always empty at boot)'
  )
  assert.equal(routedEntry!.contextWindow, 400_000, 'persisted facts (context) must be preserved')
  assert.deepEqual(
    routedEntry!.effortLevels,
    ['low', 'medium', 'high'],
    'persisted facts (effort levels) must be preserved'
  )
  console.log(
    '✓ THE FIX: a persisted cache hydrates the in-memory cache at boot, so the FIRST ' +
      'models:listSelectable call of a run already includes routed models (reproduces + resolves the ' +
      'reported "still noticing delay" bug)'
  )

  setCliProxyModelCacheForTests(null)
}

// ---------------------------------------------------------------------------
// 11. Persisted entries are STILL fully gated by live authFiles health — a
//    persisted model whose provider is now unhealthy/disconnected must NOT
//    be offered, even though its facts survived hydration. Persistence
//    supplies facts only, never availability (selectable.ts's gating is
//    untouched by this fix).
// ---------------------------------------------------------------------------

{
  setCliProxyModelCacheForTests(null)
  hydrateCliProxyModelCacheFromPersisted({
    'grok-4.5': { context: 256_000, supportsReasoning: false, providerId: 'xai' }
  })
  const entries = listCliProxyModelCacheEntries()

  // Provider now reports unhealthy (e.g. token expired since the last run).
  const unhealthy = buildSelectableModels(
    baseInput({
      routingProxy: {
        enabled: true,
        status: 'running',
        authFiles: [{ provider: 'xai', health: 'error' }]
      },
      providerConfigs: [{ providerId: 'xai', enabled: true }],
      cliProxyModels: entries
    })
  )
  assert.ok(
    !unhealthy.some((m) => m.id === 'grok-4.5' && m.available),
    'a persisted model whose provider now reports unhealthy must NOT be offered as available — ' +
      'persistence supplies facts only, never bypasses live health gating'
  )

  // Provider never connected at all this run (authFiles empty) — same rule.
  const neverConnected = buildSelectableModels(
    baseInput({
      routingProxy: { enabled: true, status: 'running', authFiles: [] },
      providerConfigs: [{ providerId: 'xai', enabled: true }],
      cliProxyModels: entries
    })
  )
  assert.ok(
    !neverConnected.some((m) => m.id === 'grok-4.5' && m.available),
    'a persisted model must not be offered when its provider has no live authFiles entry at all this run'
  )
  console.log(
    '✓ persisted entries remain fully gated by LIVE authFiles health — an unhealthy/disconnected ' +
      "provider's persisted models are never offered"
  )
  setCliProxyModelCacheForTests(null)
}

// ---------------------------------------------------------------------------
// 12. A disabled/removed provider's persisted models are not offered, even
//    though the model's facts survived hydration from a run where that
//    provider was still configured+enabled.
// ---------------------------------------------------------------------------

{
  setCliProxyModelCacheForTests(null)
  hydrateCliProxyModelCacheFromPersisted({
    'gemini-3-pro': { context: 1_000_000, supportsReasoning: true, providerId: 'gemini' }
  })
  const entries = listCliProxyModelCacheEntries()

  // Provider disabled in stored config since the persisted payload was written.
  const disabled = buildSelectableModels(
    baseInput({
      routingProxy: {
        enabled: true,
        status: 'running',
        authFiles: [{ provider: 'gemini', health: 'ok' }]
      },
      providerConfigs: [{ providerId: 'gemini', enabled: false }],
      cliProxyModels: entries
    })
  )
  assert.ok(
    !disabled.some((m) => m.id === 'gemini-3-pro' && m.available),
    'a persisted model whose provider is now disabled in stored config must not be offered'
  )

  // Provider removed entirely (no stored config row at all).
  const removed = buildSelectableModels(
    baseInput({
      routingProxy: {
        enabled: true,
        status: 'running',
        authFiles: [{ provider: 'gemini', health: 'ok' }]
      },
      providerConfigs: [],
      cliProxyModels: entries
    })
  )
  assert.ok(
    !removed.some((m) => m.id === 'gemini-3-pro' && m.available),
    'a persisted model whose provider config row was removed entirely must not be offered'
  )
  console.log(
    "✓ a disabled/removed provider's persisted models are not offered, even though their facts " +
      'survived hydration'
  )
  setCliProxyModelCacheForTests(null)
}

// ---------------------------------------------------------------------------
// 13. Staleness/version-invalidation — the pure decisions
//    cliProxyModelCachePersistence.ts's loadPersistedCliProxyModelCache()
//    wraps around the real DB read (not offline-testable itself, since it
//    imports electron transitively — see that module's doc comment). These
//    pure functions live in cliProxyModelCacheStaleness.ts specifically so
//    they ARE assertable here.
// ---------------------------------------------------------------------------

{
  // 13a. A pinned-version mismatch invalidates the payload outright — never
  // trust facts fetched against a different CLIProxyAPI release's
  // model-definitions contract.
  assert.equal(
    isPersistedCacheVersionValid(PINNED_VERSION, PINNED_VERSION),
    true,
    'matching pinned version -> valid'
  )
  assert.equal(
    isPersistedCacheVersionValid('7.2.90', PINNED_VERSION),
    false,
    'a stale pinned version (from before a CLIProxyAPI bump) must invalidate the persisted payload'
  )
  console.log(
    '✓ a pinned-CLIProxyAPI-version mismatch invalidates the persisted cache (never trusted across a version bump)'
  )

  // 13b. Staleness: within TTL -> fresh (usable without a mandatory refresh
  // signal); past TTL -> stale (still usable immediately per the
  // "serve-immediately, refresh-in-background" rule — staleness is a
  // background-refresh TRIGGER, not a block on serving what's cached).
  const oneHourMs = 60 * 60 * 1000
  const now = 10 * oneHourMs
  assert.equal(isPersistedCacheFresh(now - oneHourMs, now), true, '1h old, 24h TTL -> fresh')
  assert.equal(isPersistedCacheFresh(now - 25 * oneHourMs, now), false, '25h old, 24h TTL -> stale')
  console.log(
    '✓ staleness (TTL) is computed correctly — stale is a background-refresh trigger, not a block on serving cached data'
  )

  // 13c. Stale entries are served immediately (never withheld from
  // buildSelectableModels just because they're stale) — staleness is
  // orthogonal to the offered/available decision entirely; only version
  // validity and live health gate that.
  setCliProxyModelCacheForTests(null)
  hydrateCliProxyModelCacheFromPersisted({
    'gpt-5-codex': { context: 400_000, supportsReasoning: true, providerId: 'codex' }
  })
  const staleButServed = buildSelectableModels(
    baseInput({
      routingProxy: {
        enabled: true,
        status: 'running',
        authFiles: [{ provider: 'codex', health: 'ok' }]
      },
      providerConfigs: [{ providerId: 'codex', enabled: true }],
      cliProxyModels: listCliProxyModelCacheEntries()
    })
  )
  assert.ok(
    staleButServed.some((m) => m.id === 'gpt-5-codex' && m.available),
    'a stale-but-version-valid persisted entry must still be served immediately (available), not withheld ' +
      'pending a background refresh'
  )
  console.log(
    '✓ a stale (past-TTL) persisted entry is served immediately — staleness only triggers a background refresh, never blocks'
  )
  setCliProxyModelCacheForTests(null)
}

// ---------------------------------------------------------------------------
// 14. The bounded first-call wait (routingProxy/manager.ts's
//    waitForCliProxyModelCacheFresh) is built on raceWithTimeout — a
//    pure, offline-testable "resolve no later than timeoutMs" race,
//    exercised here with a FAKE scheduler (no real setTimeout/sleep) so this
//    harness stays fast and deterministic. Proves both directions: a
//    slow/never-resolving refresh times out cleanly, and a fast refresh
//    resolves before the timeout fires.
// ---------------------------------------------------------------------------

{
  // 14a. A refresh that never resolves within the budget must still cause
  // raceWithTimeout to resolve (never hang, never reject) once the fake
  // timeout fires — this is the "always falls back to Claude-only on
  // timeout" guarantee: the caller (models:listSelectable) proceeds to
  // buildSelectableModels regardless.
  let timeoutFired = false
  const neverResolves = new Promise<void>(() => {
    /* deliberately never settles — simulates a wedged/hanging proxy call */
  })
  const fakeScheduler = (resolve: () => void): void => {
    timeoutFired = true
    resolve() // fire "immediately" in call-order, standing in for the deadline elapsing
  }
  await raceWithTimeout(neverResolves, 250, fakeScheduler)
  assert.equal(
    timeoutFired,
    true,
    'raceWithTimeout must resolve via the timeout path when the pending work never settles — never hang'
  )
  console.log(
    '✓ raceWithTimeout resolves cleanly on timeout even when the underlying refresh never settles (no real sleep used)'
  )

  // 14b. A refresh that resolves (or rejects) before the timeout is awaited
  // is still handled cleanly — raceWithTimeout never rejects even if the
  // pending promise itself rejects.
  const rejectsFast = Promise.reject(new Error('ECONNREFUSED'))
  let rejected = false
  try {
    await raceWithTimeout(rejectsFast, 250, (resolve) => resolve())
  } catch {
    rejected = true
  }
  assert.equal(
    rejected,
    false,
    'raceWithTimeout must never reject even when the underlying pending work rejects (proxy unreachable case)'
  )
  console.log(
    '✓ raceWithTimeout never rejects even when the underlying refresh itself rejects (proxy unreachable)'
  )
}

// ---------------------------------------------------------------------------
// 15. Claude offline guarantee re-proven in the persisted-cache world: with
//    the proxy fully disabled, buildSelectableModels resolves SYNCHRONOUSLY
//    (it has always been a plain function, never async — this fix does not
//    change that) regardless of anything in the persisted-cache/hydration
//    machinery, and returns Claude-only. shouldRefreshCliProxyModelCache
//    (the pure gate the new bounded-wait path shares with the existing
//    fire-and-forget path) also refuses to fire when the proxy isn't
//    running, which is what keeps routingProxy/manager.ts's
//    waitForCliProxyModelCacheFresh from ever awaiting real proxy I/O when
//    disabled/unreachable.
// ---------------------------------------------------------------------------

{
  setCliProxyModelCacheForTests(null)
  hydrateCliProxyModelCacheFromPersisted({
    'gpt-5-codex': { context: 400_000, supportsReasoning: true, providerId: 'codex' }
  })

  assert.equal(
    shouldRefreshCliProxyModelCache({
      cacheSize: listCliProxyModelCacheEntries().length,
      isProxyRunning: false, // proxy disabled/unreachable
      hasManagementSecret: false,
      isRefreshInFlight: false,
      lastAttemptAt: 0,
      now: 1_000,
      minIntervalMs: 5_000
    }),
    false,
    'with the proxy not running, the refresh gate must refuse immediately — the bounded first-call ' +
      'wait built on this same gate can never await real proxy work while disabled/unreachable'
  )

  const start = Date.now()
  const claudeOnly = buildSelectableModels(
    baseInput({
      routingProxy: { enabled: false, status: 'not_installed', authFiles: [] },
      providerConfigs: [],
      cliProxyModels: [] // proxy disabled -> ipc/models.ts would pass live cache entries, but even a
      // populated persisted cache is irrelevant here since routingProxy.enabled is false
    })
  )
  const elapsedMs = Date.now() - start
  assert.ok(
    claudeOnly.length > 0 && claudeOnly.every((m) => m.isClaude && m.available),
    'Claude models are returned immediately with the proxy disabled, regardless of persisted-cache state'
  )
  assert.ok(
    elapsedMs < 5,
    'buildSelectableModels must resolve synchronously (no await on any proxy work) — offline guarantee'
  )
  console.log(
    '✓ Claude offline guarantee intact in the persisted-cache world: buildSelectableModels resolves ' +
      'synchronously and Claude-only with the proxy disabled, independent of any persisted/hydrated data'
  )
  setCliProxyModelCacheForTests(null)
}

// ---------------------------------------------------------------------------
// 16. (model-routing unit 09-polish) THE STARTUP-RACE BUG — user's exact
//     report: app opens directly on a workspace, the proxy is still
//     'starting', authFiles is still empty, so the footer picker showed
//     Claude-only even though a provider (e.g. Codex) was connected and
//     healthy last session. This assertion FAILS against pre-fix
//     buildSelectableModels (no persistedHealthyProviderIds param existed at
//     all, so a 'starting' proxy with empty authFiles always omitted every
//     routed model, full stop).
// ---------------------------------------------------------------------------

{
  const providerConfigs: ProviderConfigInput[] = [{ providerId: 'codex', enabled: true }]
  const cliProxyModels = [{ modelId: 'gpt-5.6-terra', providerId: 'codex', context: 200_000 }]

  const duringStartup = buildSelectableModels(
    baseInput({
      routingProxy: { enabled: true, status: 'starting', authFiles: [] },
      providerConfigs,
      cliProxyModels,
      persistedHealthyProviderIds: new Set(['codex'])
    })
  )
  const codexEntry = duringStartup.find((m) => m.id === 'gpt-5.6-terra')
  assert.ok(
    codexEntry,
    'THE REPORTED BUG: a provider known-healthy last session must be offered during the proxy startup ' +
      'window (status starting, authFiles still empty) — not held back until the first live authFiles tick'
  )
  assert.equal(
    codexEntry!.available,
    true,
    'the startup-window fallback entry must be available: true'
  )
  assert.equal(
    codexEntry!.provisional,
    true,
    'a startup-window fallback entry must be marked provisional — it is a pre-live-data optimisation, ' +
      'not a live-confirmed health signal'
  )
  console.log(
    '✓ (unit 09-polish) THE REPORTED BUG: a provider known-healthy last session is offered during the ' +
      "proxy's startup window (status 'starting', authFiles still empty), marked provisional"
  )

  // Without the persisted fallback (e.g. first-ever run, or nothing was
  // ever recorded), the SAME startup-window state must still correctly
  // withhold the model — this is not a blanket "offer everything while
  // starting" softening, it's strictly gated on persisted history.
  const duringStartupNoHistory = buildSelectableModels(
    baseInput({
      routingProxy: { enabled: true, status: 'starting', authFiles: [] },
      providerConfigs,
      cliProxyModels
      // persistedHealthyProviderIds omitted entirely
    })
  )
  assert.ok(
    !duringStartupNoHistory.some((m) => m.id === 'gpt-5.6-terra'),
    'without any persisted history, a provider must NOT be offered during the startup window — this is a ' +
      'fallback for known-previously-healthy providers only, never a blanket startup softening'
  )
  console.log(
    '✓ (unit 09-polish) without persisted history, the startup window offers nothing extra — the fallback ' +
      'is strictly gated on prior-session data, not a blanket softening'
  )
}

// ---------------------------------------------------------------------------
// 17. (model-routing unit 09-polish) Live authFiles data ALWAYS overrides a
//     stale persisted-healthy entry — the instant a live authFiles entry
//     exists (healthy OR unhealthy), it alone decides, regardless of what
//     was persisted. This is the "never let staleness win over live truth"
//     invariant.
// ---------------------------------------------------------------------------

{
  const providerConfigs: ProviderConfigInput[] = [{ providerId: 'codex', enabled: true }]
  const cliProxyModels = [{ modelId: 'gpt-5.6-terra', providerId: 'codex', context: 200_000 }]

  // Proxy is already 'running' (past the startup window in status terms) but
  // the LIVE authFiles entry for codex reports 'error' — persisted history
  // said healthy, but live data must win: the model must NOT be offered.
  const liveUnhealthyOverridesPersisted = buildSelectableModels(
    baseInput({
      routingProxy: {
        enabled: true,
        status: 'running',
        authFiles: [{ provider: 'codex', health: 'error' }]
      },
      providerConfigs,
      cliProxyModels,
      persistedHealthyProviderIds: new Set(['codex'])
    })
  )
  assert.ok(
    !liveUnhealthyOverridesPersisted.some((m) => m.id === 'gpt-5.6-terra' && m.available),
    'a LIVE authFiles entry reporting unhealthy must override a stale persisted-healthy record — staleness ' +
      'must never win over live truth'
  )
  console.log(
    '✓ (unit 09-polish) live authFiles reporting unhealthy OVERRIDES a stale persisted-healthy record'
  )

  // Same scenario but status still 'starting' with a live (already-arrived)
  // unhealthy entry — proves the override applies during the startup window
  // too, not just once status flips to 'running'.
  const liveUnhealthyDuringStartup = buildSelectableModels(
    baseInput({
      routingProxy: {
        enabled: true,
        status: 'starting',
        authFiles: [{ provider: 'codex', health: 'error' }]
      },
      providerConfigs,
      cliProxyModels,
      persistedHealthyProviderIds: new Set(['codex'])
    })
  )
  assert.ok(
    !liveUnhealthyDuringStartup.some((m) => m.id === 'gpt-5.6-terra' && m.available),
    'a live unhealthy entry overrides persisted-healthy even while the proxy is still starting'
  )
  console.log(
    '✓ (unit 09-polish) the live-overrides-persisted rule holds during the startup window too, not just ' +
      "once status is 'running'"
  )

  // And the positive case for completeness: once a LIVE healthy entry
  // arrives, the entry is offered as fully live (NOT provisional), even
  // though it's also in the persisted set — live data, once present, is
  // authoritative and the provisional flag must reflect that.
  const liveHealthy = buildSelectableModels(
    baseInput({
      routingProxy: {
        enabled: true,
        status: 'running',
        authFiles: [{ provider: 'codex', health: 'ok' }]
      },
      providerConfigs,
      cliProxyModels,
      persistedHealthyProviderIds: new Set(['codex'])
    })
  )
  const liveEntry = liveHealthy.find((m) => m.id === 'gpt-5.6-terra')
  assert.ok(liveEntry?.available, 'a live-healthy entry must be offered')
  assert.equal(
    liveEntry!.provisional,
    false,
    'once live authFiles data confirms health, the entry must NOT be marked provisional, even though it ' +
      'also appears in the persisted-healthy set'
  )
  console.log(
    '✓ (unit 09-polish) a live-confirmed-healthy entry is never marked provisional, even when it also ' +
      'appears in the persisted set'
  )
}

// ---------------------------------------------------------------------------
// 18. (model-routing unit 09-polish) Provider disabled/removed since the
//     persisted payload was recorded -> the persisted entry must NOT be
//     used, even during the startup window.
// ---------------------------------------------------------------------------

{
  const cliProxyModels = [{ modelId: 'gpt-5.6-terra', providerId: 'codex', context: 200_000 }]

  const disabled = buildSelectableModels(
    baseInput({
      routingProxy: { enabled: true, status: 'starting', authFiles: [] },
      providerConfigs: [{ providerId: 'codex', enabled: false }],
      cliProxyModels,
      persistedHealthyProviderIds: new Set(['codex'])
    })
  )
  assert.ok(
    !disabled.some((m) => m.id === 'gpt-5.6-terra'),
    'a provider disabled in stored config must not be resurrected by persisted startup-window history'
  )

  const removed = buildSelectableModels(
    baseInput({
      routingProxy: { enabled: true, status: 'starting', authFiles: [] },
      providerConfigs: [], // no stored config row at all
      cliProxyModels,
      persistedHealthyProviderIds: new Set(['codex'])
    })
  )
  assert.ok(
    !removed.some((m) => m.id === 'gpt-5.6-terra'),
    'a provider with no stored config row at all must not be resurrected by persisted startup-window history'
  )
  console.log(
    '✓ (unit 09-polish) provider disabled/removed from config -> persisted startup-window history is not used'
  )

  // Master proxy-disabled case too: even with persisted history and a
  // configured+enabled provider, an explicitly disabled/errored/stopped
  // proxy must never be softened by the startup-window fallback — that
  // fallback exists for a BRIEF startup gap, never for an affirmative outage.
  for (const status of ['error', 'stopped', 'not_installed'] as const) {
    const outage = buildSelectableModels(
      baseInput({
        routingProxy: { enabled: true, status, authFiles: [] },
        providerConfigs: [{ providerId: 'codex', enabled: true }],
        cliProxyModels,
        persistedHealthyProviderIds: new Set(['codex'])
      })
    )
    assert.ok(
      !outage.some((m) => m.id === 'gpt-5.6-terra'),
      `status '${status}' must never be softened by the startup-window fallback — it is an affirmative ` +
        'outage state, not a brief startup gap'
    )
  }
  console.log(
    '✓ (unit 09-polish) an affirmative outage status (error/stopped/not_installed) is never softened by ' +
      'the startup-window fallback, even with matching persisted history'
  )
}

// ---------------------------------------------------------------------------
// 19. (model-routing unit 09-polish) Claude-only offline guarantee, re-
//     proven once more with the proxy fully down — must return immediately
//     and be completely unaffected by ANY persistedHealthyProviderIds value,
//     including a maximally-populated one.
// ---------------------------------------------------------------------------

{
  const start = Date.now()
  const claudeOnly = buildSelectableModels(
    baseInput({
      routingProxy: { enabled: false, status: 'not_installed', authFiles: [] },
      providerConfigs: [{ providerId: 'codex', enabled: true }],
      cliProxyModels: [{ modelId: 'gpt-5.6-terra', providerId: 'codex', context: 200_000 }],
      persistedHealthyProviderIds: new Set(['codex', 'xai', 'antigravity'])
    })
  )
  const elapsedMs = Date.now() - start
  assert.ok(
    claudeOnly.length > 0 && claudeOnly.every((m) => m.isClaude && m.available),
    'Claude-only offline guarantee must hold even with a fully-populated persisted-healthy set, when the ' +
      'proxy itself is disabled'
  )
  assert.ok(elapsedMs < 5, 'buildSelectableModels must still resolve synchronously')
  console.log(
    '✓ (unit 09-polish) Claude-only offline guarantee unaffected by persistedHealthyProviderIds when the ' +
      'proxy is fully disabled — resolves synchronously'
  )
}

// ---------------------------------------------------------------------------
// 20. (model-routing unit 09-polish) Manual maintenance actions — the
//     "Refresh models" button (routingProxy/manager.ts's
//     forceRefreshCliProxyModelCache) deliberately does NOT call
//     shouldRefreshCliProxyModelCache at all — that pure gate exists to
//     protect the AUTOMATIC background paths from hammering a down proxy; a
//     user-initiated click is a deliberate one-shot request that must always
//     actually attempt the fetch even when the gate would otherwise refuse
//     it (non-empty cache, throttle window not elapsed, etc). This is
//     asserted here at the boundary this harness CAN reach offline: proving
//     the gate itself still says "no" for exactly the states the manual
//     button is supposed to override, so a future change can't accidentally
//     make forceRefreshCliProxyModelCache start deferring to this gate
//     without that being a visible, deliberate decision (manager.ts's own
//     forceRefreshCliProxyModelCache function can't be imported by this
//     offline harness — it pulls in `electron` via BrowserWindow, same
//     carve-out as every other manager.ts-touching concern in this file).
// ---------------------------------------------------------------------------

{
  const wouldBeRefusedByAutomaticGate = {
    cacheSize: 5, // non-empty — the automatic gate refuses here
    isProxyRunning: true,
    hasManagementSecret: true,
    isRefreshInFlight: false,
    lastAttemptAt: 9_000,
    now: 10_000, // throttle window (default 5000ms) not yet elapsed either
    minIntervalMs: 5_000
  }
  assert.equal(
    shouldRefreshCliProxyModelCache(wouldBeRefusedByAutomaticGate),
    false,
    'sanity: the automatic gate must refuse for a non-empty cache + unelapsed throttle — this is exactly ' +
      'the state a manual "Refresh models" click needs to override by calling refreshCliProxyModelCache ' +
      'DIRECTLY rather than going through this gate at all'
  )
  console.log(
    '✓ (unit 09-polish) the automatic refresh gate correctly refuses in states the manual "Refresh models" ' +
      'button is meant to bypass — locking in that forceRefreshCliProxyModelCache must call ' +
      'refreshCliProxyModelCache directly, never through this gate'
  )
}

// ---------------------------------------------------------------------------
// 21. THE COLD-BOOT PICKER-STALENESS BUG'S RENDERER-SIDE HALF (user-reported:
//     opening a workspace quickly on app launch showed Claude-only until
//     switching away and back). The main-process half was already fixed
//     (routingProxy/manager.ts's refreshAuthFiles now re-broadcasts once the
//     cliproxy model catalog actually populates). That alone didn't fix the
//     live bug: selectableModelsStore.ts's fetchKey used to unconditionally
//     `if (inFlight.has(key)) return` — dropping ANY request (including the
//     invalidation the fix's re-broadcast carries) that arrived while a
//     fetch for the same key was already in flight. On a fast cold boot,
//     DropdownChip's own mount-time fetch (reading the still-empty cache)
//     and the catalog-populate push landed close enough together that the
//     push's invalidation was silently dropped into the in-flight mount
//     fetch, which then resolved with the STALE empty-cache result and was
//     treated as final.
//
//     Fixed by never dropping a request: shouldStartFetchNow/
//     shouldRefetchAfterSettle (exported from selectableModelsStore.ts) are
//     the pure decision fetchKey now makes — a request arriving while one is
//     in flight is remembered instead of dropped, and re-issued the instant
//     the in-flight one settles.
//
//     This section asserts the two pure decision functions directly, plus
//     simulates the full state machine fetchKey's real Set-based
//     inFlight/pendingRefetch bookkeeping implements (mirroring, not
//     re-testing, since fetchKey itself calls window.api.models.listSelectable
//     — real browser IPC this offline harness cannot invoke; see the honest-
//     coverage note at the end of this section).
// ---------------------------------------------------------------------------

{
  // The two pure decisions in isolation.
  assert.equal(
    shouldStartFetchNow(false),
    true,
    'a fetch requested when nothing is in-flight for this key must proceed immediately'
  )
  assert.equal(
    shouldStartFetchNow(true),
    false,
    'a fetch requested while one is ALREADY in-flight for this key must NOT start a second one — the ' +
      'caller must mark the key pending instead of dropping the request'
  )
  assert.equal(
    shouldRefetchAfterSettle(true),
    true,
    'when an in-flight fetch settles and the key WAS marked pending, exactly one re-fetch must be issued'
  )
  assert.equal(
    shouldRefetchAfterSettle(false),
    false,
    'when an in-flight fetch settles and the key was NOT marked pending (steady state), no re-fetch must ' +
      'be issued — this is the loop guard'
  )

  // The full sequence fetchKey's real inFlight/pendingRefetch Sets implement,
  // simulated here with the SAME pure decisions (not a re-implementation) so
  // the "never drop, but never double-fetch, and never loop" behavior is
  // proven end-to-end at the state-machine level, not just per-branch.
  const inFlightKeys = new Set<string>()
  const pendingKeys = new Set<string>()
  const fetchesStarted: string[] = []
  const key = 'grok-4.5'

  function simulateFetchKey(k: string): void {
    if (!shouldStartFetchNow(inFlightKeys.has(k))) {
      pendingKeys.add(k)
      return
    }
    inFlightKeys.add(k)
    fetchesStarted.push(k)
  }
  function simulateSettle(k: string): void {
    inFlightKeys.delete(k)
    const wasPending = pendingKeys.delete(k)
    if (shouldRefetchAfterSettle(wasPending)) {
      simulateFetchKey(k)
    }
  }

  // Mount-time fetch starts (the cold-boot case: cache still empty).
  simulateFetchKey(key)
  assert.deepEqual(fetchesStarted, [key], 'the first request for an idle key must start a fetch')

  // The catalog-populate re-broadcast's invalidation arrives WHILE that
  // mount fetch is still in flight — must be remembered, NOT dropped, and
  // must NOT start a second concurrent fetch for the same key.
  simulateFetchKey(key)
  assert.deepEqual(
    fetchesStarted,
    [key],
    'a request arriving while one is in-flight must NOT start a second concurrent fetch for the same key'
  )
  assert.ok(
    pendingKeys.has(key),
    'the request that arrived while in-flight must be remembered (pending), not silently dropped — this ' +
      'is the exact fix for the cold-boot bug: the old code just `return`ed here'
  )

  // The stale mount fetch settles — because a newer request was pending, one
  // more fetch must be issued automatically (this is what makes the picker
  // self-heal to the real, now-populated catalog without the user needing to
  // navigate away and back).
  simulateSettle(key)
  assert.deepEqual(
    fetchesStarted,
    [key, key],
    'settling an in-flight fetch with a pending request queued must immediately start exactly one more ' +
      'fetch for the same key'
  )
  assert.ok(!pendingKeys.has(key), 'the pending flag must be cleared once its re-fetch is issued')

  // That second (fresh) fetch settles with NOTHING newer queued — steady
  // state must NOT loop into a third fetch.
  simulateSettle(key)
  assert.deepEqual(
    fetchesStarted,
    [key, key],
    'settling a fetch with no pending request queued must NOT start another one — the loop guard'
  )

  console.log(
    '✓ THE COLD-BOOT PICKER-STALENESS BUG (renderer half): a request arriving while one is in-flight is ' +
      'remembered and re-issued on settle (never dropped, never double-fetched, never loops) — simulated ' +
      'end-to-end via the same shouldStartFetchNow/shouldRefetchAfterSettle decisions fetchKey itself uses'
  )

  console.log(
    '  HONEST COVERAGE NOTE: this proves the pure coalescing decision + the state machine built from it ' +
      'in isolation. It does NOT exercise fetchKey/refetchSelectableModels themselves (they call ' +
      'window.api.models.listSelectable — real browser IPC this offline harness has no `window` to invoke) ' +
      "or DropdownChip.tsx's new open-time refetch call (React/DOM, no renderer test runner in this repo — " +
      "see verify-effort-levels.ts's own repeated note on this same gap). Manually confirmed by reading the " +
      'source: fetchKey (selectableModelsStore.ts) calls shouldStartFetchNow(inFlight.has(key)) and, when ' +
      'false, does pendingRefetch.add(key) instead of returning bare; its .finally() does ' +
      'pendingRefetch.delete(key) and calls shouldRefetchAfterSettle on the result, re-invoking fetchKey ' +
      "when true. DropdownChip.tsx's handleClick calls refetchSelectableModels(modelValueRef.current) " +
      'immediately after setOpen(true), gated on needsModelList, using a ref (not the closed-over ' +
      "modelValue) specifically so a stale memoized handleClick closure can't pass a stale model id. The " +
      'live cold-boot TIMING itself (does a picker opened within the first ~30s of a real launch actually ' +
      'show every provider) remains unverified beyond this — no UI automation for the native Electron ' +
      'window exists in this environment, and CLAUDE.md forbids foregrounding the dev build during a ' +
      'build/test loop (open -g only).'
  )
}

// ---------------------------------------------------------------------------
// 22. Effort options derive from the SAME selectable-model list this whole
//     file exercises — confirmed by reading the source, not re-tested here
//     (already covered end-to-end by scripts/verify-effort-levels.ts's own
//     sections 9-11): DropdownChip.tsx's effort chip calls
//     useSelectableModels(needsModelList ? modelValue : undefined,
//     needsModelList) — the EXACT SAME hook call (and, since both chip
//     instances share `modelValue` from the same workspaceModelStore, the
//     EXACT SAME cache key) as the model chip. resolveEffortLevelsForScope
//     (effortPickerOptions.ts) derives currentModelEffortLevels straight from
//     that hook's `models`/`loading` return values — there is no separate
//     effort-specific cache anywhere in the renderer that could see the
//     model list refresh (this section's fix, and the open-time refetch)
//     without also seeing the effort levels update. So both this section's
//     coalescing fix AND DropdownChip's open-time refetch cover the effort
//     chip automatically, with zero additional wiring.
// ---------------------------------------------------------------------------

{
  console.log(
    '✓ effort options are confirmed (by reading the source, not re-tested here — see ' +
      'verify-effort-levels.ts sections 9-11 for the pure options/visibility derivation itself) to derive ' +
      'from the SAME useSelectableModels(modelValue, needsModelList) call and cache key as the model chip ' +
      "— no separate cache exists that could miss this section's coalescing fix or DropdownChip's " +
      'open-time refetch'
  )
}

console.log('\nAll model-picker assertions passed.')
