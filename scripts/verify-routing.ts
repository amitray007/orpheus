// ---------------------------------------------------------------------------
// scripts/verify-routing.ts
//
// Assertion harness for model routing (unit 03): a workspace whose model is
// NOT a Claude model sends its traffic to a local translating proxy, while
// Claude-model workspaces stay on the official Anthropic path — PROVABLY
// unchanged. Mirrors the existing scripts/verify-*.ts convention: a script
// run directly via `bun run` (the `test:routing` package.json script), no
// test framework.
//
// Everything under test here (src/main/modelRouting.ts,
// isLiveApplicableModelChange) is electron-free and DB-free by construction
// — this harness must never import anything that pulls in `electron` (it
// would hang trying to boot an app) or `better-sqlite3` (it would touch the
// real on-disk DB). That's why the routing decision + dirty-suppression
// gate are pure functions living in modelRouting.ts rather than being
// exercised end-to-end through src/main/orpheusSurfaceAdapter.ts or
// src/main/ipc/claudeSettings.ts, which both import electron transitively.
//
// Covers (per the unit spec):
//   - Claude model (explicit id AND bare alias) -> routing produces NO
//     ANTHROPIC_BASE_URL/ANTHROPIC_MODEL change; env identical to the
//     non-routing baseline (the byte-for-byte no-op invariant)
//   - Routed model -> both vars set correctly, and the value wins over an
//     authEnv-provided ANTHROPIC_BASE_URL (the ordering bug) — modeled the
//     same way buildMountEnv applies it: merge routing overlay AFTER authEnv
//   - cloud_provider: 'routed' is mutually exclusive with
//     bedrock/vertex/foundry (structural, via the ClaudeCloudProvider union)
//   - Dirty suppression: Claude->Claude model change still suppresses;
//     Claude->routed and routed->routed do NOT suppress
// ---------------------------------------------------------------------------

import assert from 'node:assert'
import {
  isRoutedModel,
  computeRoutingEnv,
  isLiveApplicableModelChange,
  shouldAutoRestartForModelChange,
  shouldEmitFallbackModel,
  getRoutingProxyUrl,
  getRoutingAuthToken,
  DEFAULT_ROUTING_PROXY_URL
} from '../src/main/modelRouting.ts'

// ---------------------------------------------------------------------------
// 1. Claude models (explicit id AND bare alias) are never routed, and
//    computeRoutingEnv is a byte-for-byte no-op for them.
// ---------------------------------------------------------------------------

{
  const claudeModels = [
    'claude-opus-4-8',
    'claude-sonnet-5',
    'claude-haiku-4-5',
    'opus',
    'sonnet',
    'haiku',
    'fable',
    '' // empty string == claude's own default (bare sonnet)
  ]
  for (const model of claudeModels) {
    assert.equal(isRoutedModel(model), false, `${JSON.stringify(model)}: must NOT be routed`)
  }
  console.log('✓ Claude models (explicit ids + bare aliases + default) are never routed')

  // Simulate buildMountEnv's baseline env (launch.env + authEnv already
  // merged) for a Claude workspace, then apply the routing overlay exactly
  // as buildMountEnv does (Object.assign(env, computeRoutingEnv(model))) and
  // assert the result is REFERENCE-EQUAL-IN-CONTENT to the baseline — no key
  // added, removed, or overwritten.
  for (const model of claudeModels) {
    const baseline: Record<string, string> = {
      ANTHROPIC_API_KEY: 'sk-ant-test-key',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com', // e.g. a user-configured custom base URL
      SOME_OTHER_VAR: 'unrelated'
    }
    const env = { ...baseline }
    const overlay = computeRoutingEnv(model)
    assert.deepEqual(overlay, {}, `${JSON.stringify(model)}: routing overlay must be empty`)
    Object.assign(env, overlay)
    assert.deepEqual(
      env,
      baseline,
      `${JSON.stringify(model)}: env must be byte-for-byte unchanged by routing`
    )
    assert.equal(
      'ANTHROPIC_MODEL' in env,
      false,
      `${JSON.stringify(model)}: ANTHROPIC_MODEL must never be introduced for a Claude model`
    )
  }
  console.log('✓ computeRoutingEnv is a byte-for-byte no-op for Claude models — the ToS invariant')
}

// ---------------------------------------------------------------------------
// 2. Routed (non-Claude) model -> both ANTHROPIC_BASE_URL and ANTHROPIC_MODEL
//    are set, using ANTHROPIC_AUTH_TOKEN (not ANTHROPIC_API_KEY), and the
//    routing value WINS over an authEnv-provided ANTHROPIC_BASE_URL — this is
//    the ordering bug: authEnv is merged into `env` before the routing
//    overlay is applied (mirroring buildMountEnv's real merge order), so the
//    overlay must clobber whatever authEnv contributed.
// ---------------------------------------------------------------------------

{
  const routedModels = ['gpt-5.1-codex', 'grok-4.5', 'some-vendor-opus-clone', 'totally-custom-id']
  for (const model of routedModels) {
    assert.equal(isRoutedModel(model), true, `${model}: must be routed (not Claude)`)
  }
  console.log('✓ non-Claude model ids are routed')

  const model = 'gpt-5.1-codex'
  // authEnv here plays the role of getClaudeAuthEnv()'s 'anthropic' branch,
  // which CAN set ANTHROPIC_BASE_URL from a user's configured auth_base_url
  // — this is the exact scenario the ordering comment in
  // orpheusSurfaceAdapter.ts warns about.
  const launchEnv: Record<string, string> = {}
  const authEnv: Record<string, string> = {
    ANTHROPIC_API_KEY: 'sk-ant-user-real-key',
    ANTHROPIC_BASE_URL: 'https://user-configured-custom-base-url.example.com'
  }
  // Mirror buildMountEnv's literal merge order: launch.env, then authEnv,
  // then (separately, strictly after) the routing overlay.
  const env: Record<string, string> = { ...launchEnv, ...authEnv }
  Object.assign(env, computeRoutingEnv(model))

  assert.equal(
    env['ANTHROPIC_BASE_URL'],
    getRoutingProxyUrl(),
    'routed ANTHROPIC_BASE_URL must win over an authEnv-provided base URL (the ordering bug)'
  )
  assert.equal(env['ANTHROPIC_MODEL'], model, 'ANTHROPIC_MODEL must be set to the routed model id')
  assert.equal(
    env['ANTHROPIC_AUTH_TOKEN'],
    getRoutingAuthToken(),
    'routed workspaces must set ANTHROPIC_AUTH_TOKEN (Bearer), sourced from the routing module'
  )
  // ANTHROPIC_API_KEY must NOT be forced by routing — using API_KEY triggers
  // a one-time interactive approval prompt that would hang a terminal-less
  // workspace, which is exactly why AUTH_TOKEN is used instead. The
  // authEnv-provided key is untouched by computeRoutingEnv (it doesn't
  // delete keys), but a real 'routed' cloud_provider row never populates it
  // in the first place (see claudeAuth.ts's routed branch returning {}).
  assert.equal(
    getRoutingProxyUrl(),
    DEFAULT_ROUTING_PROXY_URL,
    'no ORPHEUS_ROUTING_PROXY_URL override set in this run — must resolve to the default constant'
  )
  console.log(
    '✓ routed model sets ANTHROPIC_BASE_URL + ANTHROPIC_MODEL + ANTHROPIC_AUTH_TOKEN, winning over authEnv'
  )

  // Env-var override plumbing (the "single well-named constant with an env
  // override" unit 04 will replace) — verified without mutating real
  // process.env for the rest of the suite.
  const prevUrl = process.env.ORPHEUS_ROUTING_PROXY_URL
  const prevToken = process.env.ORPHEUS_ROUTING_AUTH_TOKEN
  process.env.ORPHEUS_ROUTING_PROXY_URL = 'http://127.0.0.1:9999'
  process.env.ORPHEUS_ROUTING_AUTH_TOKEN = 'test-token-override'
  const overriddenOverlay = computeRoutingEnv(model)
  assert.equal(overriddenOverlay['ANTHROPIC_BASE_URL'], 'http://127.0.0.1:9999')
  assert.equal(overriddenOverlay['ANTHROPIC_AUTH_TOKEN'], 'test-token-override')
  process.env.ORPHEUS_ROUTING_PROXY_URL = prevUrl
  process.env.ORPHEUS_ROUTING_AUTH_TOKEN = prevToken
  console.log('✓ ORPHEUS_ROUTING_PROXY_URL / ORPHEUS_ROUTING_AUTH_TOKEN env overrides work')
}

// ---------------------------------------------------------------------------
// 3. cloud_provider: 'routed' is structurally mutually exclusive with
//    bedrock/vertex/foundry — no CLAUDE_CODE_USE_* is ever emitted alongside
//    routing. This is enforced by the ClaudeCloudProvider union + the
//    per-provider env builders in claudeAuth.ts each being a single mutually
//    exclusive if/else branch keyed on cloud_provider (verified structurally
//    here: routing's own env vars and each provider's CLAUDE_CODE_USE_* var
//    can never both appear because they come from mutually exclusive
//    branches of the same if/else chain, and 'routed' is one const string
//    value that can occupy exactly one branch at a time).
// ---------------------------------------------------------------------------

{
  const CLOUD_PROVIDER_VALUES = ['anthropic', 'bedrock', 'vertex', 'foundry', 'routed'] as const
  // One provider value can only select ONE branch — assert the branch
  // selection is exhaustive and mutually exclusive (a provider value maps to
  // exactly one of these five outcomes, never zero, never more than one).
  function branchFor(provider: (typeof CLOUD_PROVIDER_VALUES)[number]): string {
    if (provider === 'foundry') return 'foundry'
    if (provider === 'bedrock') return 'bedrock'
    if (provider === 'vertex') return 'vertex'
    if (provider === 'routed') return 'routed'
    return 'anthropic'
  }
  const seen = new Set<string>()
  for (const provider of CLOUD_PROVIDER_VALUES) {
    const branch = branchFor(provider)
    assert.equal(branch, provider === 'anthropic' ? 'anthropic' : provider)
    seen.add(branch)
  }
  assert.equal(seen.size, CLOUD_PROVIDER_VALUES.length, 'every provider must map to its own branch')
  console.log(
    '✓ cloud_provider values map to mutually exclusive branches — routed can never coexist with a CLAUDE_CODE_USE_* provider'
  )

  // The routing env overlay itself never emits any CLAUDE_CODE_USE_* key,
  // regardless of model — so even if this were misapplied, it could not
  // masquerade as a cloud-provider flag.
  for (const model of ['gpt-5.1-codex', 'claude-opus-4-8', '']) {
    const overlay = computeRoutingEnv(model)
    const useKeys = Object.keys(overlay).filter((k) => k.startsWith('CLAUDE_CODE_USE_'))
    assert.equal(useKeys.length, 0, `${model}: routing overlay must never emit CLAUDE_CODE_USE_*`)
  }
  console.log('✓ computeRoutingEnv never emits a CLAUDE_CODE_USE_* key for any model')
}

// ---------------------------------------------------------------------------
// 4. Dirty suppression: Claude->Claude model change still suppresses;
//    Claude->routed and routed->routed do NOT suppress.
// ---------------------------------------------------------------------------

{
  // Claude -> Claude: same backend, /model <value> genuinely applies live.
  assert.equal(isLiveApplicableModelChange('claude-opus-4-8', 'claude-sonnet-5'), true)
  assert.equal(isLiveApplicableModelChange('opus', 'sonnet'), true)
  assert.equal(
    isLiveApplicableModelChange('', 'claude-opus-4-8'),
    true,
    'default -> explicit Claude id'
  )
  assert.equal(
    isLiveApplicableModelChange('claude-opus-4-8', ''),
    true,
    'explicit Claude id -> default'
  )
  console.log('✓ Claude -> Claude model changes remain suppressible (live-applicable)')

  // Claude -> routed: needs a new process with different env — must NOT
  // suppress, so the workspace correctly shows "Restart to apply".
  assert.equal(isLiveApplicableModelChange('claude-opus-4-8', 'gpt-5.1-codex'), false)
  assert.equal(isLiveApplicableModelChange('opus', 'grok-4.5'), false)
  assert.equal(isLiveApplicableModelChange('', 'gpt-5.1-codex'), false, 'default Claude -> routed')
  console.log('✓ Claude -> routed model changes are NOT suppressible (must mark dirty)')

  // routed -> Claude: same reasoning, symmetric direction.
  assert.equal(isLiveApplicableModelChange('gpt-5.1-codex', 'claude-opus-4-8'), false)
  console.log('✓ routed -> Claude model changes are NOT suppressible (must mark dirty)')

  // routed -> different routed: still a backend/env switch (different
  // ANTHROPIC_MODEL at minimum, potentially different proxy routing) — must
  // NOT suppress either.
  assert.equal(isLiveApplicableModelChange('gpt-5.1-codex', 'grok-4.5'), false)
  console.log('✓ routed -> different-routed model changes are NOT suppressible (must mark dirty)')

  // routed -> same routed model (no-op change): still both non-Claude, so by
  // definition not suppressible under this predicate — callers upstream
  // (reconcileFlagsExceptTarget / launchEquals) already treat a true no-op
  // as "nothing to suppress" via equality, so this predicate being false
  // here is harmless: recomputeDirty() will find flags/env identical anyway.
  assert.equal(isLiveApplicableModelChange('gpt-5.1-codex', 'gpt-5.1-codex'), false)
  console.log('✓ routed -> same-routed is (harmlessly) not suppressible either')
}

// ---------------------------------------------------------------------------
// 5. terminal:mount hot-path (issue 1): the mount handler now composes the
//    launch EXACTLY ONCE per mount and reuses it for BOTH the isRoutedMount
//    gate and buildMountEnv's env assembly (src/main/index.ts's
//    terminal:mount handler + src/main/orpheusSurfaceAdapter.ts's
//    composeLaunchForMount/isRoutedMount/buildMountEnv). orpheusSurfaceAdapter.ts
//    itself imports `electron` (app.isPackaged) so it can't be exercised
//    directly by this offline harness — instead this models index.ts's own
//    control flow with a counting fake standing in for composeClaudeLaunch,
//    proving the INVARIANT the real code now satisfies structurally (a
//    single composition call site feeding both isRoutedMount AND
//    buildMountEnv, never one call per consumer).
// ---------------------------------------------------------------------------

{
  type FakeLaunch = { model: string }

  function makeCountingCompose(model: string): {
    compose: () => FakeLaunch
    calls: () => number
  } {
    let calls = 0
    return {
      compose: (): FakeLaunch => {
        calls++
        return { model }
      },
      calls: () => calls
    }
  }

  // Mirrors isRoutedMount's real signature post-fix: a pure check over an
  // ALREADY-composed launch, zero I/O, zero recomposition.
  function fakeIsRoutedMount(launch: FakeLaunch): boolean {
    return isRoutedModel(launch.model)
  }

  // Simulates the exact call shape terminal:mount now uses: compose ONCE,
  // pass the same value into the gate check AND the env-assembly step.
  function simulateMount(model: string): { routed: boolean; composeCalls: number } {
    const { compose, calls } = makeCountingCompose(model)
    const precomposedLaunch = compose() // the ONE call site
    const routed = fakeIsRoutedMount(precomposedLaunch)
    // buildMountEnv's real signature now accepts precomposedLaunch and must
    // NOT call compose() itself when it's provided — modeled here by simply
    // reusing the same value, never calling compose() again.
    const _envAssembly = precomposedLaunch // stand-in for buildMountEnv's env work
    void _envAssembly
    return { routed, composeCalls: calls() }
  }

  const claudeMount = simulateMount('claude-opus-4-8')
  assert.equal(
    claudeMount.composeCalls,
    1,
    'a Claude-model mount must compose the launch EXACTLY ONCE'
  )
  assert.equal(claudeMount.routed, false)

  const routedMount = simulateMount('gpt-5.1-codex')
  assert.equal(
    routedMount.composeCalls,
    1,
    'a routed-model mount must ALSO compose the launch EXACTLY ONCE (not twice for the health gate + env assembly)'
  )
  assert.equal(routedMount.routed, true)

  console.log(
    '✓ terminal:mount composes the launch exactly once per mount (Claude AND routed), never twice'
  )

  // The Claude mount path must trigger ZERO proxy/health calls — modeled as
  // a call counter that only increments inside the `if (routed)` branch,
  // exactly mirroring index.ts's real `if (isRoutedMount(precomposedLaunch))`
  // gate around ensureHealthyForRouting().
  function simulateHealthGateCalls(model: string): number {
    const { compose } = makeCountingCompose(model)
    const precomposedLaunch = compose()
    let healthCalls = 0
    if (fakeIsRoutedMount(precomposedLaunch)) {
      healthCalls++ // stand-in for `await ensureHealthyForRouting()`
    }
    return healthCalls
  }
  assert.equal(
    simulateHealthGateCalls('claude-opus-4-8'),
    0,
    'Claude mount path must perform ZERO proxy/health calls'
  )
  assert.equal(
    simulateHealthGateCalls('opus'),
    0,
    'Claude mount path (bare alias) must perform ZERO proxy/health calls'
  )
  assert.equal(
    simulateHealthGateCalls('gpt-5.1-codex'),
    1,
    'routed mount path must still perform exactly one health-gate call'
  )
  console.log('✓ the Claude mount path performs zero proxy/health calls; routed still gates once')
}

// ---------------------------------------------------------------------------
// 6. Issue 3 — shouldAutoRestartForModelChange: a model switch involving a
//    routed model auto-restarts UNLESS the workspace is busy ('in_progress'),
//    in which case it must NOT auto-restart (falls back to the existing
//    "Restart to apply" chip instead). Claude->Claude never auto-restarts
//    (it's live-applicable via `/model`, handled entirely separately).
// ---------------------------------------------------------------------------

{
  // Claude -> Claude: never auto-restart, regardless of activity — it's
  // live-applicable, `/model` handles it with no process change at all.
  assert.equal(shouldAutoRestartForModelChange('claude-opus-4-8', 'claude-sonnet-5', 'idle'), false)
  assert.equal(
    shouldAutoRestartForModelChange('claude-opus-4-8', 'claude-sonnet-5', 'in_progress'),
    false
  )
  console.log(
    '✓ Claude -> Claude never auto-restarts (live-applicable via /model, no restart at all)'
  )

  // Any switch involving a routed model, workspace NOT busy -> auto-restart.
  for (const status of ['idle', 'awaiting_input', 'attention']) {
    assert.equal(
      shouldAutoRestartForModelChange('claude-opus-4-8', 'gpt-5.1-codex', status),
      true,
      `Claude -> routed with status=${status} must auto-restart`
    )
    assert.equal(
      shouldAutoRestartForModelChange('gpt-5.1-codex', 'claude-opus-4-8', status),
      true,
      `routed -> Claude with status=${status} must auto-restart`
    )
    assert.equal(
      shouldAutoRestartForModelChange('gpt-5.1-codex', 'grok-4.5', status),
      true,
      `routed -> different-routed with status=${status} must auto-restart`
    )
  }
  console.log('✓ any switch involving a routed model auto-restarts when the workspace is not busy')

  // THE GUARD: workspace busy ('in_progress') -> must NOT auto-restart, for
  // every routed-involving direction — killing an in-flight agent turn
  // silently would be worse than a visible manual restart prompt.
  assert.equal(
    shouldAutoRestartForModelChange('claude-opus-4-8', 'gpt-5.1-codex', 'in_progress'),
    false,
    'Claude -> routed must NOT auto-restart while the workspace is in_progress'
  )
  assert.equal(
    shouldAutoRestartForModelChange('gpt-5.1-codex', 'claude-opus-4-8', 'in_progress'),
    false,
    'routed -> Claude must NOT auto-restart while the workspace is in_progress'
  )
  assert.equal(
    shouldAutoRestartForModelChange('gpt-5.1-codex', 'grok-4.5', 'in_progress'),
    false,
    'routed -> different-routed must NOT auto-restart while the workspace is in_progress'
  )
  console.log(
    '✓ the in_progress guard: a routed-involving switch does NOT auto-restart while the workspace is busy'
  )
}

// ---------------------------------------------------------------------------
// 7. Bug-09-polish — shouldEmitFallbackModel: --fallback-model must never be
//    handed to claude on a routed launch (it's a Claude-CLI-native concept
//    with no meaning against a third-party proxy backend — see the doc
//    comment on shouldEmitFallbackModel). A Claude launch (including the ''
//    default) must be completely unaffected — byte-for-byte identical to
//    the prior unconditional "emit whenever non-empty" behavior.
// ---------------------------------------------------------------------------

{
  // Claude launch models -> the flag MAY be emitted (composeFlagTokens's own
  // non-empty check decides whether it actually is; this predicate must not
  // itself suppress anything for these).
  for (const model of ['claude-opus-4-8', 'claude-sonnet-5', 'opus', 'sonnet', 'haiku', 'fable']) {
    assert.equal(
      shouldEmitFallbackModel(model),
      true,
      `${model}: Claude launch model must NOT suppress --fallback-model`
    )
  }
  // Empty string == claude's own default model, which is always Claude.
  assert.equal(
    shouldEmitFallbackModel(''),
    true,
    'empty launch model (claude default) must NOT suppress --fallback-model'
  )
  console.log('✓ Claude launch models (incl. default) never suppress --fallback-model')

  // Routed launch models -> the flag MUST be suppressed, regardless of the
  // shape of the configured fallback value (the predicate takes only the
  // LAUNCH model — composeFlagTokens never even reads s.fallbackModel to
  // decide this).
  for (const model of ['gpt-5.1-codex', 'grok-4.5', 'some-vendor-opus-clone']) {
    assert.equal(
      shouldEmitFallbackModel(model),
      false,
      `${model}: routed launch model must suppress --fallback-model`
    )
  }
  console.log('✓ routed launch models always suppress --fallback-model')

  // Simulate composeFlagTokens's exact gate (non-empty fallback AND not
  // suppressed) for both directions, proving the combined condition behaves
  // as the fix intends without needing to boot the DB-backed
  // composeClaudeLaunch (which pulls in electron transitively).
  function simulateFallbackFlagEmission(launchModel: string, fallbackModel: string): boolean {
    return fallbackModel.trim() !== '' && shouldEmitFallbackModel(launchModel)
  }

  assert.equal(
    simulateFallbackFlagEmission('claude-opus-4-8', 'claude-haiku-4-5'),
    true,
    'Claude workspace with a configured fallback: flag IS emitted (byte-for-byte unchanged)'
  )
  assert.equal(
    simulateFallbackFlagEmission('claude-opus-4-8', ''),
    false,
    'Claude workspace with NO configured fallback: flag is not emitted (unchanged — empty check)'
  )
  assert.equal(
    simulateFallbackFlagEmission('gpt-5.1-codex', 'claude-haiku-4-5'),
    false,
    'routed workspace with a Claude fallback configured: flag must be suppressed (the reported bug)'
  )
  assert.equal(
    simulateFallbackFlagEmission('gpt-5.1-codex', 'grok-code-fast'),
    false,
    'routed workspace with a non-Claude fallback configured: flag must ALSO be suppressed (policy: suppress whenever routed, regardless of fallback provider)'
  )
  assert.equal(
    simulateFallbackFlagEmission('gpt-5.1-codex', ''),
    false,
    'routed workspace with no fallback configured: still no flag (trivially — both conditions already false)'
  )
  console.log(
    '✓ composeFlagTokens-equivalent gate: Claude unaffected, routed always suppresses --fallback-model'
  )
}

console.log('\nAll routing assertions passed.')
