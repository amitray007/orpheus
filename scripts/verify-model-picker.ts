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

console.log('\nAll model-picker assertions passed.')
