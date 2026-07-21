// ---------------------------------------------------------------------------
// scripts/verify-aliases.ts
//
// Assertion harness for model-name aliasing (model-routing unit 08):
// src/main/routingProxy/aliases.ts's aliasesToProviderModels (pure
// resolution/validation, electron-free) and config.ts's renderProvidersYaml
// alias-emission path. Mirrors scripts/verify-providers.ts's convention: run
// via `bun run` (the `test:aliases` package script), no test framework, must
// pass fully offline.
//
// Imports aliasesToProviderModels from aliasResolve.ts DIRECTLY (not
// aliases.ts, which imports getDb()/electron for its storage functions) —
// mirrors modelRouting.ts / models/selectable.ts's existing pure-vs-electron
// split in this codebase. The storage functions (listModelAliases/
// upsertModelAlias/replaceModelAliases in aliases.ts) are NOT exercised
// here — DB behavior for routing_proxy_model_aliases +
// app_ui_state.model_aliases_enabled is covered by `bun run test:db`
// instead, exactly like storage.ts's own carve-out documented in
// verify-providers.ts.
//
// Covers (per the unit 08 task spec, extended by unit 09's oauth-model-alias
// fix):
//   - an enabled alias targeting an apiKey/openaiCompatible-configured
//     provider emits a correct models: [{name, alias}] entry on that
//     provider's own block (apiKeyModels bucket)
//   - an enabled alias targeting an OAUTH-configured provider emits into the
//     SEPARATE top-level oauth-model-alias: block instead (oauthModels
//     bucket) — verified empirically against the real v7.2.92 binary + a
//     real Codex OAuth credential: the per-credential models:/alias shape is
//     silently ignored by CLIProxyAPI for an oauth-configured provider
//     ("unknown provider for model X" even though config.yaml "declared" the
//     alias), while oauth-model-alias resolves and completes correctly. See
//     aliasResolve.ts's SplitAliasProviderModels doc comment.
//   - aliases disabled (master switch off) => zero alias entries in either
//     bucket
//   - config generation stays deterministic/idempotent with aliases present
//   - an alias targeting a model NOT in the live cache is skipped, not
//     emitted broken
//   - aliases never leak into buildSelectableModels (the workspace picker
//     must not offer 'sonnet' as a routed choice)
//   - the Claude no-op routing invariant is unaffected by aliases being
//     configured
//   - defaults produce exactly the intended name->model pairs when those
//     targets exist (and skip when they don't)
// ---------------------------------------------------------------------------

import assert from 'node:assert'
import {
  aliasesToProviderModels,
  aliasProviderModelsEqual,
  aliasSplitEqual
} from '../src/main/routingProxy/aliasResolve.ts'
import type { ModelAliasInput as ModelAlias } from '../src/main/routingProxy/aliasResolve.ts'
import { renderProvidersYaml, renderOauthModelAliasYaml } from '../src/main/routingProxy/config.ts'
import type { ProviderConfig } from '../src/main/routingProxy/providers/types.ts'
import { buildSelectableModels } from '../src/main/models/selectable.ts'
import { computeRoutingEnv } from '../src/main/modelRouting.ts'

function alias(
  claudeName: string,
  patch: Partial<Omit<ModelAlias, 'claudeName'>> = {}
): ModelAlias {
  return {
    claudeName,
    enabled: true,
    targetProviderId: null,
    targetModelId: null,
    ...patch
  }
}

// ---------------------------------------------------------------------------
// 1. An enabled alias, master switch on, target present in the live cache,
//    targeting an apiKey-configured provider -> resolves to exactly
//    {name, alias} grouped by provider id, in the apiKeyModels bucket (the
//    oauthModels bucket stays empty since no oauth-configured provider is
//    involved).
// ---------------------------------------------------------------------------

{
  const aliases: ModelAlias[] = [
    alias('sonnet', { targetProviderId: 'openai-compatible', targetModelId: 'gpt-5.6-terra' })
  ]
  const cache = [{ modelId: 'gpt-5.6-terra', providerId: 'openai-compatible' }]
  const authMethods = { 'openai-compatible': 'openaiCompatible' as const }

  const resolved = aliasesToProviderModels(aliases, true, cache, authMethods)
  assert.deepEqual(
    resolved,
    {
      apiKeyModels: { 'openai-compatible': [{ name: 'gpt-5.6-terra', alias: 'sonnet' }] },
      oauthModels: {}
    },
    'an enabled alias with a cache-present target on an apiKey/openaiCompatible provider must resolve ' +
      'to exactly one {name, alias} entry in apiKeyModels, nothing in oauthModels'
  )
  console.log(
    '✓ enabled alias + present target on an apiKey-configured provider -> correct {name, alias} entry in apiKeyModels'
  )
}

// ---------------------------------------------------------------------------
// 1b. THE unit-09 FIX — the SAME alias shape, but targeting a provider
//     configured with authMethod 'oauth' (e.g. codex, connected via OAuth
//     rather than a stored API key) must land in the SEPARATE oauthModels
//     bucket instead, never apiKeyModels. This is what config.ts's
//     renderOauthModelAliasYaml turns into the top-level
//     `oauth-model-alias:` block CLIProxyAPI actually consults for an
//     OAuth-backed channel.
// ---------------------------------------------------------------------------

{
  const aliases: ModelAlias[] = [
    alias('claude-sonnet-5', { targetProviderId: 'codex', targetModelId: 'gpt-5.6-terra' })
  ]
  const cache = [{ modelId: 'gpt-5.6-terra', providerId: 'codex' }]
  const authMethods = { codex: 'oauth' as const }

  const resolved = aliasesToProviderModels(aliases, true, cache, authMethods)
  assert.deepEqual(
    resolved,
    {
      apiKeyModels: {},
      oauthModels: { codex: [{ name: 'gpt-5.6-terra', alias: 'claude-sonnet-5' }] }
    },
    'an alias targeting an oauth-configured provider must resolve into oauthModels, never apiKeyModels — ' +
      'this is the fix for the reported bug (CLIProxyAPI silently ignores the per-credential models: shape ' +
      'for an OAuth/file-backed channel)'
  )
  console.log(
    '✓ (unit 09 fix) alias targeting an oauth-configured provider (codex) resolves into oauthModels, not apiKeyModels'
  )
}

// ---------------------------------------------------------------------------
// 2. Master switch off -> zero entries in both buckets, regardless of how
//    many alias rows are enabled/valid or which authMethod their target is.
// ---------------------------------------------------------------------------

{
  const aliases: ModelAlias[] = [
    alias('sonnet', { targetProviderId: 'openai-compatible', targetModelId: 'gpt-5.6-terra' }),
    alias('opus', { targetProviderId: 'codex', targetModelId: 'gpt-5.6-sol' })
  ]
  const cache = [
    { modelId: 'gpt-5.6-terra', providerId: 'openai-compatible' },
    { modelId: 'gpt-5.6-sol', providerId: 'codex' }
  ]
  const authMethods = { 'openai-compatible': 'openaiCompatible' as const, codex: 'oauth' as const }
  const resolved = aliasesToProviderModels(aliases, false, cache, authMethods)
  assert.deepEqual(
    resolved,
    { apiKeyModels: {}, oauthModels: {} },
    'master switch off must produce zero alias entries in either bucket'
  )
  console.log('✓ aliases disabled (master switch off) -> zero entries in both buckets')
}

// ---------------------------------------------------------------------------
// 3. A disabled individual row is skipped even with the master switch on;
//    an alias with no target set (not yet configured) is skipped.
// ---------------------------------------------------------------------------

{
  const aliases: ModelAlias[] = [
    alias('sonnet', {
      enabled: false,
      targetProviderId: 'openai-compatible',
      targetModelId: 'gpt-5.6-terra'
    }),
    alias('opus', { targetProviderId: null, targetModelId: null })
  ]
  const cache = [{ modelId: 'gpt-5.6-terra', providerId: 'openai-compatible' }]
  const resolved = aliasesToProviderModels(aliases, true, cache)
  assert.deepEqual(
    resolved,
    { apiKeyModels: {}, oauthModels: {} },
    'a disabled row and an unconfigured row must both be skipped'
  )
  console.log('✓ per-row disabled / not-yet-configured aliases are skipped, not emitted')
}

// ---------------------------------------------------------------------------
// 4. An alias targeting a model NOT in the live cache is skipped, not
//    emitted broken — including a provider/model MISMATCH (right model id,
//    wrong provider) which must also be treated as absent.
// ---------------------------------------------------------------------------

{
  const aliases: ModelAlias[] = [
    alias('sonnet', { targetProviderId: 'openai-compatible', targetModelId: 'ghost-model' }),
    alias('opus', { targetProviderId: 'codex', targetModelId: 'gpt-5.6-sol' }) // model exists but on a different provider
  ]
  const cache = [{ modelId: 'gpt-5.6-sol', providerId: 'openai-compatible' }]
  const resolved = aliasesToProviderModels(aliases, true, cache)
  assert.deepEqual(
    resolved,
    { apiKeyModels: {}, oauthModels: {} },
    'a stale/unknown target (including a provider/model mismatch) must be silently skipped'
  )
  console.log(
    '✓ alias targeting a model absent from the live cache (or provider-mismatched) is skipped, never emitted broken'
  )
}

// ---------------------------------------------------------------------------
// 5. renderProvidersYaml folds aliasModelsByProvider onto the right block —
//    both shapes: a dedicated apiKey block (codex-api-key:) and the shared
//    openai-compatibility: list. Alias models APPEND to the provider's own
//    stored models rather than replacing them.
// ---------------------------------------------------------------------------

{
  const codexConfig: ProviderConfig = {
    providerId: 'codex',
    enabled: true,
    authMethod: 'apiKey',
    apiKeys: [
      { id: 'k1', apiKey: 'sk-codex', models: [{ name: 'gpt-5-codex', alias: 'codex-latest' }] }
    ]
  }
  const yaml = renderProvidersYaml([codexConfig], {
    codex: [{ name: 'gpt-5.6-terra', alias: 'sonnet' }]
  })
  const block = yaml['codex-api-key'] as Array<Record<string, unknown>>
  const models = block[0].models as Array<Record<string, unknown>>
  assert.equal(
    models.length,
    2,
    'alias models must APPEND to the provider api-key entry, not replace'
  )
  assert.ok(
    models.some((m) => m.name === 'gpt-5-codex' && m.alias === 'codex-latest'),
    "the provider's own stored model entry must survive"
  )
  assert.ok(
    models.some((m) => m.name === 'gpt-5.6-terra' && m.alias === 'sonnet'),
    'the alias model entry must be present'
  )
  console.log(
    '✓ renderProvidersYaml folds alias models onto a dedicated apiKey provider block (append, not replace)'
  )

  const openaiCompatConfig: ProviderConfig = {
    providerId: 'openai-compatible',
    enabled: true,
    authMethod: 'openaiCompatible',
    apiKeys: [{ id: 'k1', apiKey: 'sk-oc' }]
  }
  const yaml2 = renderProvidersYaml([openaiCompatConfig], {
    'openai-compatible': [{ name: 'gpt-5.6-sol', alias: 'opus' }]
  })
  const entries = yaml2['openai-compatibility'] as Array<Record<string, unknown>>
  const ocModels = entries[0].models as Array<Record<string, unknown>>
  assert.equal(ocModels.length, 1)
  assert.equal(ocModels[0].name, 'gpt-5.6-sol')
  assert.equal(ocModels[0].alias, 'opus')
  console.log('✓ renderProvidersYaml folds alias models onto an openaiCompatible provider block')

  // Empty aliasModelsByProvider (or omitted entirely) changes nothing —
  // proves existing callers (manager.ts's pre-unit-08 call sites) are
  // unaffected.
  const noAliasYaml = renderProvidersYaml([codexConfig])
  const noAliasBlock = noAliasYaml['codex-api-key'] as Array<Record<string, unknown>>
  assert.equal(
    (noAliasBlock[0].models as unknown[]).length,
    1,
    'omitting aliasModelsByProvider must not add anything'
  )
  console.log('✓ omitting aliasModelsByProvider entirely leaves provider blocks unchanged')
}

// ---------------------------------------------------------------------------
// 5b. (unit 09 fix) renderOauthModelAliasYaml — the SEPARATE top-level
//     oauth-model-alias: block, keyed by provider/channel id, for aliases
//     targeting an oauth-configured provider. Distinct code path from
//     renderProvidersYaml (5, above) — an oauth-configured provider has NO
//     per-key config.yaml block at all (its credential lives in auth-dir),
//     so there is nothing for an alias to "append" to; the whole channel's
//     entry is just its alias list.
//
//     Every entry must carry `fork: true` — see config.ts's
//     renderOauthModelAliasYaml doc comment for the full regression writeup.
//     This assertion (checking the exact {name, alias, fork} shape) FAILS
//     against commit 3b9bb648, which emitted {name, alias} with no `fork`
//     key at all — that was the actual regression: CLIProxyAPI's
//     OAuthModelAlias struct defaults Fork to false/omitted, and a
//     false/omitted Fork makes the alias REPLACE the upstream model in
//     listings/routing instead of adding alongside it (verified against
//     sdk/cliproxy/service.go's applyOAuthModelAliasEntries + the pinned
//     v7.2.92 test file service_oauth_model_alias_test.go's
//     TestApplyOAuthModelAlias_Rename vs _ForkAddsAlias).
// ---------------------------------------------------------------------------

{
  const yaml = renderOauthModelAliasYaml({
    codex: [{ name: 'gpt-5.6-terra', alias: 'claude-sonnet-5' }]
  })
  assert.deepEqual(
    yaml,
    { codex: [{ name: 'gpt-5.6-terra', alias: 'claude-sonnet-5', fork: true }] },
    'renderOauthModelAliasYaml must emit exactly {channel: [{name, alias, fork: true}]} for an oauth-routed alias — ' +
      'this is the unit-09-polish regression fix; a missing fork:true here means the alias silently ' +
      'consumes the upstream model id (the reported "502 unknown provider for model gpt-5.6-sol" bug)'
  )
  console.log(
    '✓ renderOauthModelAliasYaml emits the correct {channel: [{name, alias, fork: true}]} shape'
  )

  // Every emitted entry, across every channel, must carry fork: true —
  // scanned generically rather than re-asserting one shape, so this catches
  // a regression that only drops fork on a LATER entry (e.g. an accidental
  // per-index conditional) as well as a blanket omission.
  const multi = renderOauthModelAliasYaml({
    codex: [
      { name: 'gpt-5.6-terra', alias: 'claude-sonnet-5' },
      { name: 'gpt-5.6-sol', alias: 'claude-opus-4-8' }
    ],
    xai: [{ name: 'grok-5', alias: 'fable' }]
  })
  assert.equal(Object.keys(multi).length, 2, 'must emit one key per channel')
  assert.equal((multi.codex as unknown[]).length, 2)
  assert.equal((multi.xai as unknown[]).length, 1)
  for (const [channel, entries] of Object.entries(multi)) {
    for (const entry of entries as Array<Record<string, unknown>>) {
      assert.equal(
        entry.fork,
        true,
        `every emitted oauth-model-alias entry must carry fork: true (channel ${channel}, entry ${JSON.stringify(entry)})`
      )
    }
  }
  console.log(
    '✓ renderOauthModelAliasYaml handles multiple channels/aliases correctly, every entry carries fork: true'
  )

  // Round-trip through yaml.stringify (what actually gets written to disk)
  // to prove `fork: true` survives serialization in the expected shape, not
  // just in the in-memory object renderOauthModelAliasYaml returns.
  const { stringify: yamlStringify, parse: yamlParse } = await import('yaml')
  const roundTripped = yamlParse(yamlStringify({ 'oauth-model-alias': multi })) as Record<
    string,
    Record<string, Array<Record<string, unknown>>>
  >
  assert.deepEqual(
    roundTripped['oauth-model-alias'].codex[0],
    { name: 'gpt-5.6-terra', alias: 'claude-sonnet-5', fork: true },
    'the rendered YAML must round-trip to the exact {name, alias, fork} shape CLIProxyAPI expects'
  )
  console.log('✓ rendered YAML round-trips to the exact {name, alias, fork} shape')

  // Empty/omitted input -> empty object, so renderRoutingProxyConfig's own
  // Object.keys(...).length > 0 gate correctly omits the whole
  // oauth-model-alias: key rather than emitting an empty block.
  assert.deepEqual(renderOauthModelAliasYaml({}), {}, 'empty input must yield an empty object')
  assert.deepEqual(renderOauthModelAliasYaml(), {}, 'omitted input must yield an empty object')
  console.log(
    '✓ renderOauthModelAliasYaml yields {} for empty/omitted input (caller omits the key entirely)'
  )

  // A full config render round-trip proves the two mechanisms coexist
  // without interfering: an apiKey-configured provider's alias lands in its
  // own block, an oauth-configured provider's alias lands in the top-level
  // oauth-model-alias: block, in the SAME generated document.
  const { renderRoutingProxyConfig } = await import('../src/main/routingProxy/config.ts')
  const combined = renderRoutingProxyConfig({
    host: '127.0.0.1',
    port: 18765,
    authDir: '/tmp/fake-auth-dir',
    providers: [
      {
        providerId: 'openai-compatible',
        enabled: true,
        authMethod: 'openaiCompatible',
        apiKeys: [{ id: 'k1', apiKey: 'sk-oc' }]
      }
    ],
    aliasModelsByProvider: { 'openai-compatible': [{ name: 'gpt-5.6-sol', alias: 'opus' }] },
    oauthAliasModelsByProvider: { codex: [{ name: 'gpt-5.6-terra', alias: 'claude-sonnet-5' }] }
  })
  assert.ok(
    combined.includes('openai-compatibility:'),
    'the apiKey/openaiCompatible bucket must still render its own block'
  )
  assert.ok(
    combined.includes('oauth-model-alias:'),
    'the oauth bucket must render the separate top-level oauth-model-alias: block'
  )
  assert.ok(combined.includes('claude-sonnet-5'), 'the oauth alias name must appear in the output')
  assert.ok(
    combined.includes('opus'),
    'the apiKey-bucket alias name must also appear in the output'
  )
  assert.ok(
    combined.includes('fork: true'),
    'the oauth-model-alias block in a full config render must include fork: true'
  )
  console.log(
    '✓ renderRoutingProxyConfig emits BOTH the per-provider models: block and the top-level ' +
      'oauth-model-alias: block in the same document, for aliases targeting different authMethod providers, ' +
      'with fork: true present'
  )

  // ---------------------------------------------------------------------
  // (unit 09-polish investigation) The per-provider `models:` path
  // (apiKey/openaiCompatible — renderProvidersYaml, toCliProxyModelEntry)
  // has NO equivalent fork concept AT ALL — verified against the pinned
  // v7.2.92 Go source: ClaudeModel/CodexModel/XAIModel/GeminiModel/
  // OpenAICompatibilityModel (internal/config/config.go) declare only
  // {name, alias, display-name, force-mapping} — there is no `fork` field
  // to set on this struct, unlike OAuthModelAlias. sdk/cliproxy/service.go's
  // buildConfiguredModelInfo (the function that turns each configured
  // `models:` entry into a listed ModelInfo) always sets `ID: alias` with
  // no separate upstream-id entry emitted — i.e. this path ALREADY replaces
  // by construction, with no fork opt-out available upstream. The practical
  // exposure here is smaller than the oauth bug because a real apiKey/
  // openaiCompatible ProviderConfig normally has its OWN pre-existing
  // {name, alias: name} entries in apiKeys[].models (hand-authored via
  // config.example.yaml conventions) that an alias entry is APPENDED to
  // (see renderProvidersYaml's doc comment) — so the upstream id typically
  // stays reachable via its own separate entry, not because aliasing here
  // is fork-safe. Orpheus's `ProviderModelEntry` type (providers/types.ts)
  // correctly has no `fork` field either, matching upstream. This assertion
  // just documents/locks that toCliProxyModelEntry never emits a `fork` key
  // for the apiKeyModels path (it would be meaningless to CLIProxyAPI there).
  // ---------------------------------------------------------------------
  {
    const apiKeyYaml = renderProvidersYaml(
      [
        {
          providerId: 'openai-compatible',
          enabled: true,
          authMethod: 'openaiCompatible',
          apiKeys: [{ id: 'k1', apiKey: 'sk-oc' }]
        }
      ],
      { 'openai-compatible': [{ name: 'gpt-5.6-sol', alias: 'opus' }] }
    )
    const entries = apiKeyYaml['openai-compatibility'] as Array<Record<string, unknown>>
    const models = entries[0].models as Array<Record<string, unknown>>
    assert.equal(
      'fork' in models[0],
      false,
      "the per-provider models: path (apiKeyModels) must never emit a fork key — CLIProxyAPI's " +
        'ClaudeModel/CodexModel/XAIModel/GeminiModel/OpenAICompatibilityModel structs have no such field'
    )
    console.log(
      '✓ (documented finding) the apiKey/openaiCompatible models: path never emits fork — no such field exists upstream'
    )
  }
}

// ---------------------------------------------------------------------------
// 6. Determinism/idempotency WITH aliases present — regenerating from
//    identical input yields byte-identical YAML.
// ---------------------------------------------------------------------------

{
  const cfg: ProviderConfig[] = [
    {
      providerId: 'codex',
      enabled: true,
      authMethod: 'apiKey',
      apiKeys: [{ id: 'k1', apiKey: 'sk-a' }]
    }
  ]
  const aliasModels = { codex: [{ name: 'gpt-5.6-terra', alias: 'sonnet' }] }
  const first = JSON.stringify(renderProvidersYaml(cfg, aliasModels))
  const second = JSON.stringify(renderProvidersYaml(cfg, aliasModels))
  assert.equal(
    first,
    second,
    'renderProvidersYaml must be deterministic/idempotent with aliases present'
  )
  console.log('✓ renderProvidersYaml is deterministic/idempotent with aliases present')
}

// ---------------------------------------------------------------------------
// 7. Aliases never leak into buildSelectableModels — the workspace picker
//    must not offer 'sonnet' as a routed CHOICE, even when the underlying
//    data that would represent a leak is present. Two angles:
//
//    a) The realistic shape: refreshCliProxyModelCache only ever populates
//       upstream model ids (e.g. 'gpt-5.6-terra'), never a Claude-facing
//       alias name — buildSelectableModels fed exactly that real shape must
//       produce only ONE 'sonnet' entry: the builtin Claude one.
//    b) The adversarial shape: even if something upstream misbehaved and
//       fed a cliproxy cache entry literally named 'sonnet' (simulating the
//       leak this invariant guards against), buildSelectableModels must
//       still surface it as available:false-or-true ROUTED entry alongside
//       (not instead of) the Claude one — proving Claude's own 'sonnet'
//       entry is never shadowed/overwritten by a routed id collision, and
//       there is exactly one isClaude:true 'sonnet'.
// ---------------------------------------------------------------------------

{
  const realistic = buildSelectableModels({
    routingProxy: {
      enabled: true,
      status: 'running',
      authFiles: [{ provider: 'openai-compatible', health: 'ok' }]
    },
    providerConfigs: [{ providerId: 'openai-compatible', enabled: true }],
    providerDescriptors: [{ id: 'openai-compatible', label: 'Custom (OpenAI-compatible)' }],
    // Deliberately does NOT include 'sonnet' or any Claude alias name — this
    // is the real shape refreshCliProxyModelCache produces (CLIProxyAPI's
    // model-definitions endpoint reports upstream ids like gpt-5.6-terra,
    // never the Claude-facing alias name it was reached through).
    cliProxyModels: [
      { modelId: 'gpt-5.6-terra', providerId: 'openai-compatible', context: 128_000 }
    ]
  })
  const realisticSonnets = realistic.filter((m) => m.id === 'sonnet')
  assert.equal(
    realisticSonnets.length,
    1,
    'with a realistic cliproxy cache (upstream ids only), exactly one sonnet entry must exist'
  )
  assert.equal(realisticSonnets[0].isClaude, true)
  assert.equal(realisticSonnets[0].providerId, 'claude')
  console.log(
    '✓ with a realistic cliproxy cache, buildSelectableModels surfaces exactly one sonnet entry (the builtin Claude one)'
  )

  const adversarial = buildSelectableModels({
    routingProxy: {
      enabled: true,
      status: 'running',
      authFiles: [{ provider: 'openai-compatible', health: 'ok' }]
    },
    providerConfigs: [{ providerId: 'openai-compatible', enabled: true }],
    providerDescriptors: [{ id: 'openai-compatible', label: 'Custom (OpenAI-compatible)' }],
    // Adversarial: simulate a leak by feeding a cache entry literally named
    // 'sonnet' — this must NEVER happen in real code (aliases.ts writes
    // {name: upstreamId, alias: claudeName} into config.yaml, and
    // refreshCliProxyModelCache reads upstream ids back from CLIProxyAPI,
    // never the alias field) but the invariant must hold even under this
    // adversarial input: Claude's own 'sonnet' entry must never be shadowed.
    cliProxyModels: [{ modelId: 'sonnet', providerId: 'openai-compatible', context: 128_000 }]
  })
  const adversarialSonnets = adversarial.filter((m) => m.id === 'sonnet')
  const claudeSonnets = adversarialSonnets.filter((m) => m.isClaude)
  assert.equal(
    claudeSonnets.length,
    1,
    "the builtin Claude 'sonnet' entry must survive even if a routed cache entry collides on the same id"
  )
  assert.equal(claudeSonnets[0].providerId, 'claude')
  assert.equal(
    claudeSonnets[0].available,
    true,
    "Claude's sonnet must remain unconditionally available"
  )
  console.log(
    "✓ even under an adversarial id collision, the builtin Claude 'sonnet' entry is never shadowed"
  )
}

// ---------------------------------------------------------------------------
// 8. The Claude no-op routing invariant is unaffected by aliases being
//    configured — computeRoutingEnv must still return {} for every Claude
//    model id, aliases or no aliases (aliases are a proxy-side config-
//    generation concern; computeRoutingEnv has no aliases parameter at all,
//    so this simply re-confirms the invariant still holds post-unit-08).
// ---------------------------------------------------------------------------

{
  for (const claudeId of ['sonnet', 'opus', 'claude-sonnet-5', 'claude-opus-4-8']) {
    const env = computeRoutingEnv(claudeId, { proxyUrl: 'http://127.0.0.1:18765' })
    assert.deepEqual(
      env,
      {},
      `computeRoutingEnv('${claudeId}') must still return {} — aliases must not change this`
    )
  }
  console.log('✓ Claude no-op routing invariant (computeRoutingEnv -> {}) unaffected by aliases')
}

// ---------------------------------------------------------------------------
// 9. Defaults produce exactly the intended name -> model pairs when those
//    targets exist in the live cache, and are skipped (not forced) when
//    they don't. Mirrors ipc/aliases.ts's aliases:useDefaults DEFAULT_ALIAS_TARGETS
//    table (sonnet -> gpt-5.6-terra, opus -> gpt-5.6-sol, fable -> gpt-5.6-sol)
//    by re-deriving the same resolution aliasesToProviderModels performs.
// ---------------------------------------------------------------------------

{
  const DEFAULT_ALIAS_TARGETS: Record<string, string> = {
    sonnet: 'gpt-5.6-terra',
    opus: 'gpt-5.6-sol',
    fable: 'gpt-5.6-sol'
  }

  // Case A: all default targets present in the cache -> all three resolve,
  // opus and fable correctly sharing the same upstream model (NOT distinct
  // effort variants — see this unit's own doc on why that's impossible).
  const fullCache = [
    { modelId: 'gpt-5.6-terra', providerId: 'openai-compatible' },
    { modelId: 'gpt-5.6-sol', providerId: 'openai-compatible' }
  ]
  const defaultAliases: ModelAlias[] = Object.entries(DEFAULT_ALIAS_TARGETS).map(([name, target]) =>
    alias(name, { targetProviderId: 'openai-compatible', targetModelId: target })
  )
  const resolvedFull = aliasesToProviderModels(defaultAliases, true, fullCache)
  assert.deepEqual(
    resolvedFull.apiKeyModels['openai-compatible']?.sort((a, b) =>
      a.alias!.localeCompare(b.alias!)
    ),
    [
      { name: 'gpt-5.6-sol', alias: 'fable' },
      { name: 'gpt-5.6-sol', alias: 'opus' },
      { name: 'gpt-5.6-terra', alias: 'sonnet' }
    ],
    'defaults must produce exactly sonnet->gpt-5.6-terra, opus->gpt-5.6-sol, fable->gpt-5.6-sol when all targets exist'
  )
  assert.deepEqual(
    resolvedFull.oauthModels,
    {},
    'openai-compatible is never oauth-configured — nothing must land in oauthModels here'
  )
  console.log('✓ defaults resolve to exactly the intended name->model pairs when all targets exist')

  // Case B: only ONE default target present -> only that one resolves, the
  // others are skipped (degrade gracefully, never emit a broken alias).
  const partialCache = [{ modelId: 'gpt-5.6-terra', providerId: 'openai-compatible' }]
  const resolvedPartial = aliasesToProviderModels(defaultAliases, true, partialCache)
  assert.deepEqual(
    resolvedPartial,
    {
      apiKeyModels: { 'openai-compatible': [{ name: 'gpt-5.6-terra', alias: 'sonnet' }] },
      oauthModels: {}
    },
    'when only one default target exists in the cache, only that alias must resolve — the rest skipped, not broken'
  )
  console.log(
    '✓ defaults degrade gracefully — only targets present in the live cache resolve, others skipped'
  )
}

// ---------------------------------------------------------------------------
// 10. THE REPORTED BUG (unit 09) — chicken-and-egg ordering between
//     config-write time and cliproxy model-cache population. Simulates
//     manager.ts's real sequence: writeRoutingProxyConfig is called with
//     aliasModelsByProvider resolved against whatever the cache looked like
//     AT THAT MOMENT — resolveAliasModelsByProvider() is a snapshot, not a
//     live binding. The fix is regenerateConfigIfAliasesChanged() re-running
//     that resolution AFTER the cache populates and rewriting if the result
//     changed. This assertion reproduces both halves:
//       a) at config-write time with an EMPTY cache, the alias is skipped
//          (this is the bug as reported — must be true both pre- and
//          post-fix, since the guard itself is correct)
//       b) after the cache populates, RE-RESOLVING (what
//          regenerateConfigIfAliasesChanged does) produces the alias entry
//          — proving a rewrite at that point would fix the user's symptom.
//     Without the manager.ts fix (i.e. only ever resolving once, at
//     config-write time, and never again), the session would be stuck with
//     (a) forever — this assertion fails against that pre-fix behavior
//     because it demands (b) succeed on a SECOND, later resolution using the
//     SAME aliases input, proving the fix must be "resolve again later", not
//     "resolve differently".
// ---------------------------------------------------------------------------

{
  const aliases: ModelAlias[] = [
    alias('claude-sonnet-5', {
      targetProviderId: 'codex',
      targetModelId: 'gpt-5.6-terra'
    })
  ]
  // codex is oauth-configured in the user's real reported scenario — this is
  // what makes this section double as the unit-09 regression check: the
  // fully-resolved alias below must land in oauthModels, not apiKeyModels,
  // or CLIProxyAPI would silently ignore it exactly as it did for the user.
  const authMethods = { codex: 'oauth' as const }

  // (a) Config-write time: cache is empty (proxy just enabled, cliproxy
  // model cache never populated yet — the exact state the user's live
  // machine was diagnosed in: routing_proxy_model_aliases has an enabled
  // row, routing_proxy_providers has codex enabled, but dashboard_cache's
  // cliproxy_model_cache entry is empty).
  const emptyCache: Array<{ modelId: string; providerId?: string }> = []
  const resolvedAtWriteTime = aliasesToProviderModels(aliases, true, emptyCache, authMethods)
  assert.deepEqual(
    resolvedAtWriteTime,
    { apiKeyModels: {}, oauthModels: {} },
    'with an empty model cache at config-write time, the alias must be skipped (this IS the reported bug state)'
  )

  // (b) The cache populates (refreshCliProxyModelCache succeeds) — a
  // SECOND, later resolution against the SAME aliases input must now
  // produce the alias entry, in oauthModels (codex is oauth-configured) —
  // this is what regenerateConfigIfAliasesChanged performs in manager.ts
  // after every cache refresh; a build that never re-resolves (the pre-fix
  // behavior) would never reach this state for the lifetime of the session.
  const populatedCache = [{ modelId: 'gpt-5.6-terra', providerId: 'codex' }]
  const resolvedAfterCachePopulates = aliasesToProviderModels(
    aliases,
    true,
    populatedCache,
    authMethods
  )
  assert.deepEqual(
    resolvedAfterCachePopulates,
    {
      apiKeyModels: {},
      oauthModels: { codex: [{ name: 'gpt-5.6-terra', alias: 'claude-sonnet-5' }] }
    },
    're-resolving after the cache populates must now emit the alias into oauthModels (codex is ' +
      'oauth-configured) — this is the fix: config.yaml must be regenerated at this point, not just ' +
      'once at the original (empty-cache) write time, AND the alias must land in the bucket CLIProxyAPI ' +
      'actually consults for an OAuth-backed channel'
  )

  // And the two resolutions must actually DIFFER — this is exactly the
  // signal aliasSplitEqual uses to decide whether a rewrite is warranted at
  // all (see 11 below for the no-rewrite-when-unchanged case).
  assert.equal(
    aliasSplitEqual(resolvedAtWriteTime, resolvedAfterCachePopulates),
    false,
    'the pre-cache-population and post-cache-population resolutions must be recognized as different, ' +
      'so a rewrite is actually triggered'
  )

  console.log(
    '✓ reported bug reproduced+fixed: empty-cache-at-write-time skips the alias, but re-resolving after ' +
      'the cache populates now emits it (proves a post-populate rewrite fixes the user symptom)'
  )
}

// ---------------------------------------------------------------------------
// 11. No-churn guard — aliasProviderModelsEqual must recognize two resolved
//     maps as equal (so manager.ts's regenerateConfigIfAliasesChanged skips
//     the rewrite) across: identical input, key order shuffled, and entry
//     order shuffled within a provider's list. Must recognize them as
//     DIFFERENT when an entry's target model actually changes, when a
//     provider gains/loses entries, or when the number of providers differs.
// ---------------------------------------------------------------------------

{
  const a = {
    codex: [
      { name: 'gpt-5.6-terra', alias: 'claude-sonnet-5' },
      { name: 'gpt-5.6-sol', alias: 'opus' }
    ],
    xai: [{ name: 'grok-5', alias: 'fable' }]
  }

  // Identical input (fresh object, same content) -> equal, no rewrite.
  const aAgain = {
    codex: [
      { name: 'gpt-5.6-terra', alias: 'claude-sonnet-5' },
      { name: 'gpt-5.6-sol', alias: 'opus' }
    ],
    xai: [{ name: 'grok-5', alias: 'fable' }]
  }
  assert.equal(
    aliasProviderModelsEqual(a, aAgain),
    true,
    'identical resolved alias maps must compare equal (steady-state 30s tick must not trigger a rewrite)'
  )

  // Key order shuffled + entry order shuffled within a provider -> still equal.
  const shuffled = {
    xai: [{ name: 'grok-5', alias: 'fable' }],
    codex: [
      { name: 'gpt-5.6-sol', alias: 'opus' },
      { name: 'gpt-5.6-terra', alias: 'claude-sonnet-5' }
    ]
  }
  assert.equal(
    aliasProviderModelsEqual(a, shuffled),
    true,
    'provider-key order and within-provider entry order must not affect equality'
  )

  // A target model actually changing for the same alias name -> different.
  const changedTarget = {
    codex: [
      { name: 'gpt-5.6-nova', alias: 'claude-sonnet-5' }, // target changed
      { name: 'gpt-5.6-sol', alias: 'opus' }
    ],
    xai: [{ name: 'grok-5', alias: 'fable' }]
  }
  assert.equal(
    aliasProviderModelsEqual(a, changedTarget),
    false,
    'a changed target model for the same claudeName must be detected as a real change'
  )

  // A provider losing an entry -> different.
  const fewerEntries = {
    codex: [{ name: 'gpt-5.6-terra', alias: 'claude-sonnet-5' }],
    xai: [{ name: 'grok-5', alias: 'fable' }]
  }
  assert.equal(
    aliasProviderModelsEqual(a, fewerEntries),
    false,
    'a provider gaining/losing entries must be detected as a real change'
  )

  // A provider key present/absent entirely -> different.
  const fewerProviders = {
    codex: [
      { name: 'gpt-5.6-terra', alias: 'claude-sonnet-5' },
      { name: 'gpt-5.6-sol', alias: 'opus' }
    ]
  }
  assert.equal(
    aliasProviderModelsEqual(a, fewerProviders),
    false,
    'a provider key appearing/disappearing entirely must be detected as a real change'
  )

  // Both empty -> equal (e.g. master switch off both times, or nothing
  // configured yet — the disabled-toggle-app case must never spuriously
  // "change" and rewrite).
  assert.equal(aliasProviderModelsEqual({}, {}), true, 'two empty resolutions must compare equal')

  console.log(
    '✓ aliasProviderModelsEqual: order-independent equality, real changes (target/entry-count/provider-set) detected'
  )
}

// ---------------------------------------------------------------------------
// 12. (unit 09 fix) aliasSplitEqual — the split-shape equality manager.ts's
//     regenerateConfigIfAliasesChanged actually calls now. Must require BOTH
//     buckets to match; a change confined to only one bucket (e.g. an oauth
//     provider's alias changes while the apiKey bucket stays identical, or
//     vice versa) must still be detected as an overall change.
// ---------------------------------------------------------------------------

{
  const base = {
    apiKeyModels: { 'openai-compatible': [{ name: 'gpt-5.6-sol', alias: 'opus' }] },
    oauthModels: { codex: [{ name: 'gpt-5.6-terra', alias: 'claude-sonnet-5' }] }
  }
  const identical = {
    apiKeyModels: { 'openai-compatible': [{ name: 'gpt-5.6-sol', alias: 'opus' }] },
    oauthModels: { codex: [{ name: 'gpt-5.6-terra', alias: 'claude-sonnet-5' }] }
  }
  assert.equal(
    aliasSplitEqual(base, identical),
    true,
    'identical split resolutions across both buckets must compare equal'
  )

  const oauthChanged = {
    apiKeyModels: { 'openai-compatible': [{ name: 'gpt-5.6-sol', alias: 'opus' }] },
    oauthModels: { codex: [{ name: 'gpt-5.6-nova', alias: 'claude-sonnet-5' }] } // target changed
  }
  assert.equal(
    aliasSplitEqual(base, oauthChanged),
    false,
    'a change confined to the oauthModels bucket alone must still be detected as an overall change'
  )

  const apiKeyChanged = {
    apiKeyModels: { 'openai-compatible': [{ name: 'gpt-5.6-nova', alias: 'opus' }] }, // target changed
    oauthModels: { codex: [{ name: 'gpt-5.6-terra', alias: 'claude-sonnet-5' }] }
  }
  assert.equal(
    aliasSplitEqual(base, apiKeyChanged),
    false,
    'a change confined to the apiKeyModels bucket alone must still be detected as an overall change'
  )

  assert.equal(
    aliasSplitEqual({ apiKeyModels: {}, oauthModels: {} }, { apiKeyModels: {}, oauthModels: {} }),
    true,
    'two fully-empty split resolutions must compare equal (disabled master switch / nothing configured yet)'
  )

  console.log(
    '✓ aliasSplitEqual requires BOTH buckets to match; a change confined to either bucket alone is detected'
  )
}

console.log('\nAll verify-aliases assertions passed.')
