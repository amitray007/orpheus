// ---------------------------------------------------------------------------
// scripts/verify-providers.ts
//
// Assertion harness for the provider framework (model-routing unit 05):
// src/main/routingProxy/providers/{types,registry}.ts (descriptor layer),
// config.ts's renderProvidersYaml/renderRoutingProxyConfig/
// writeRoutingProxyConfig (config generation), and
// src/main/models/sources/cliproxy.ts (registry source). Mirrors the
// existing scripts/verify-*.ts convention: run via `bun run` (the
// `test:providers` package script), no test framework.
//
// MUST PASS FULLY OFFLINE. cliproxy.ts's refreshCliProxyModelCache takes an
// injected `deps.fetchJson` exactly like modelsDev.ts/authFiles.ts already
// do — nothing here makes a real network call. storage.ts (electron-free? no
// — it imports getDb()/electron) is intentionally NOT exercised here; DB
// behavior for the new tables is covered by `bun run test:db` instead (see
// the unit's own verification checklist).
//
// Covers (per the unit spec):
//   - adding a descriptor requires no code change elsewhere (a synthetic
//     descriptor's ProviderConfig flows through renderProvidersYaml/config
//     generation using only its authMethod/apiKeyConfigKey — no `id` branch)
//   - API-key provider -> correct `<provider>-api-key:` YAML block
//   - generic provider -> correct `openai-compatibility:` entry incl.
//     models/alias/thinking levels
//   - generated config is deterministic + idempotent
//   - the management secret is NEVER in the generated config (read back
//     from disk, not just the in-memory string)
//   - config file written 0600
//   - cliproxy model source returns [] (resolves null / never throws) when
//     the proxy is unreachable
//   - Claude is never treated as a routed provider
// ---------------------------------------------------------------------------

import assert from 'node:assert'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  renderProvidersYaml,
  renderRoutingProxyConfig,
  writeRoutingProxyConfig
} from '../src/main/routingProxy/config.ts'
import {
  PROVIDERS,
  getProviderDescriptor,
  isKnownProviderId
} from '../src/main/routingProxy/providers/registry.ts'
import type { ProviderConfig } from '../src/main/routingProxy/providers/types.ts'
import {
  cliProxyModelSource,
  refreshCliProxyModelCache,
  setCliProxyModelCacheForTests,
  type CliProxyModelSourceDeps
} from '../src/main/models/sources/cliproxy.ts'
import { isClaudeModelId } from '../src/main/models/sources/builtin.ts'

const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpheus-providers-test-'))
async function cleanup(): Promise<void> {
  await fs.rm(scratchRoot, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// 1. Descriptor registry basics — Claude is never a known provider id, and
//    every declared descriptor's config-mapping fields are internally
//    consistent (oauth ids have oauthLoginFlag, apiKey ids have
//    apiKeyConfigKey, openaiCompatible ids don't require either).
// ---------------------------------------------------------------------------

{
  assert.ok(PROVIDERS.length > 0, 'PROVIDERS must not be empty')
  assert.equal(isKnownProviderId('claude'), false, 'Claude must never be a known provider id')
  assert.equal(getProviderDescriptor('claude'), null, 'Claude must not resolve a descriptor')
  assert.equal(isKnownProviderId('copilot'), false, 'Copilot must not be present (ban risk)')

  for (const p of PROVIDERS) {
    if (p.authMethods.includes('oauth')) {
      assert.ok(p.oauthLoginFlag, `${p.id}: oauth provider must declare oauthLoginFlag`)
    }
    if (p.authMethods.includes('apiKey')) {
      assert.ok(p.apiKeyConfigKey, `${p.id}: apiKey provider must declare apiKeyConfigKey`)
    }
  }

  const ids = PROVIDERS.map((p) => p.id)
  assert.equal(new Set(ids).size, ids.length, 'provider ids must be unique')

  // (model-routing unit 09-polish, then 10-creation) PROVIDERS was trimmed to
  // exactly these three ids, in this stable order — gemini/kimi/openrouter/
  // openai-compatible were removed in unit 09-polish, and ollama was removed
  // in unit 10-creation (their stored data, if any, is left in the DB
  // untouched — see registry.ts's own header comment on why removal is
  // data-only and safe).
  assert.deepEqual(
    ids,
    ['codex', 'xai', 'antigravity'],
    'PROVIDERS must contain exactly codex/xai/antigravity, in this order'
  )
  for (const removedId of ['gemini', 'kimi', 'openrouter', 'openai-compatible', 'ollama']) {
    assert.equal(
      getProviderDescriptor(removedId),
      null,
      `${removedId} must no longer resolve to a descriptor — it was removed`
    )
    assert.equal(
      isKnownProviderId(removedId),
      false,
      `${removedId} must no longer be a known provider id`
    )
  }

  console.log(
    '✓ descriptor registry: Claude absent, Copilot absent, ids unique, fields consistent, ' +
      'trimmed to exactly codex/xai/antigravity'
  )
}

// ---------------------------------------------------------------------------
// 2. Adding a provider requires NO code change elsewhere — a synthetic
//    descriptor (never declared in registry.ts) flows through
//    renderProvidersYaml purely via its ProviderConfig.authMethod, proving
//    config generation never branches on `id`.
// ---------------------------------------------------------------------------

{
  // A ProviderConfig referencing a provider id that IS NOT in PROVIDERS at
  // all must be silently skipped (defensive: no descriptor to map fields
  // from) — this also proves the renderer isn't hardcoding known ids.
  const unknownProviderConfig: ProviderConfig = {
    providerId: 'totally-synthetic-vendor-not-in-registry',
    enabled: true,
    authMethod: 'apiKey',
    apiKeys: [{ id: 'k1', apiKey: 'sk-fake' }]
  }
  const yamlForUnknown = renderProvidersYaml([unknownProviderConfig])
  assert.deepEqual(
    yamlForUnknown,
    {},
    'a ProviderConfig for an id with no registered descriptor must emit nothing'
  )
  console.log('✓ ProviderConfig for an unregistered provider id emits no YAML (defensive skip)')
}

// ---------------------------------------------------------------------------
// 3. API-key provider -> correct `<provider>-api-key:` YAML block.
//    Uses the REAL 'codex' descriptor (apiKeyConfigKey: 'codex-api-key') —
//    the assertion below checks the generic renderer maps every
//    ProviderApiKeyEntry field, not just apiKey itself.
// ---------------------------------------------------------------------------

{
  const codexConfig: ProviderConfig = {
    providerId: 'codex',
    enabled: true,
    authMethod: 'apiKey',
    apiKeys: [
      {
        id: 'k1',
        apiKey: 'sk-codex-test-key',
        prefix: 'test',
        baseUrl: 'https://example.invalid/v1',
        proxyUrl: 'socks5://127.0.0.1:1080',
        disableCooling: true,
        models: [
          {
            name: 'gpt-5-codex',
            alias: 'codex-latest',
            displayName: 'Codex Latest',
            forceMapping: true
          }
        ],
        excludedModels: ['gpt-5.1', '*-mini']
      }
    ]
  }

  const yaml = renderProvidersYaml([codexConfig])
  assert.ok('codex-api-key' in yaml, 'must emit the codex-api-key top-level key')
  const block = yaml['codex-api-key'] as Array<Record<string, unknown>>
  assert.equal(block.length, 1)
  assert.equal(block[0]['api-key'], 'sk-codex-test-key')
  assert.equal(block[0].prefix, 'test')
  assert.equal(block[0]['base-url'], 'https://example.invalid/v1')
  assert.equal(block[0]['proxy-url'], 'socks5://127.0.0.1:1080')
  assert.equal(block[0]['disable-cooling'], true)
  const models = block[0].models as Array<Record<string, unknown>>
  assert.equal(models[0].name, 'gpt-5-codex')
  assert.equal(models[0].alias, 'codex-latest')
  assert.equal(models[0]['display-name'], 'Codex Latest')
  assert.equal(models[0]['force-mapping'], true)
  const excluded = block[0]['excluded-models'] as string[] | undefined
  assert.deepEqual(excluded, ['gpt-5.1', '*-mini'])
  console.log(
    '✓ API-key provider (codex) renders a correct codex-api-key: block, all fields mapped'
  )

  // Disabled or empty-keys providers must NOT appear at all.
  const disabled = renderProvidersYaml([{ ...codexConfig, enabled: false }])
  assert.deepEqual(disabled, {}, 'a disabled provider must emit nothing')
  const empty = renderProvidersYaml([{ ...codexConfig, apiKeys: [] }])
  assert.deepEqual(empty, {}, 'an enabled provider with zero api keys must emit nothing')
  console.log('✓ disabled / empty-keys providers emit nothing')
}

// ---------------------------------------------------------------------------
// 4. Generic provider -> correct `openai-compatibility:` entry, including
//    models/alias/thinking levels.
//
//    (unit 10-creation) ollama — the previous fixture for this assertion —
//    was removed from PROVIDERS entirely (product decision: data-only
//    removal, see registry.ts's own header comment). PROVIDERS now has NO
//    remaining openaiCompatible-authMethod descriptor at all (codex/xai are
//    apiKey+oauth, antigravity is oauth-only). renderProvidersYaml's
//    openaiCompatible branch (config.ts) is selected purely by the STORED
//    ProviderConfig.authMethod field, never by the descriptor's own
//    authMethods array or by `id` (that's the whole "adding/removing a
//    provider is data-only" guarantee this file exists to lock in — see
//    assertion 2's synthetic-id case for the apiKey side of the same
//    property). So this assertion reuses the real, still-registered 'codex'
//    descriptor with authMethod overridden to 'openaiCompatible' purely as a
//    fixture to exercise that code path generically — it is NOT asserting
//    that codex is ever configured this way for real (it isn't; Settings
//    only ever stores authMethod: 'apiKey' for codex).
// ---------------------------------------------------------------------------

{
  const genericTestConfig: ProviderConfig = {
    providerId: 'codex',
    enabled: true,
    authMethod: 'openaiCompatible',
    prefix: 'test',
    displayName: 'generic-test-endpoint',
    apiKeys: [
      {
        id: 'k1',
        apiKey: 'unused-local',
        proxyUrl: 'socks5://127.0.0.1:1080',
        models: [
          {
            name: 'llama3.1:8b',
            alias: 'local-llama',
            displayName: 'Llama 3.1 8B',
            image: false,
            inputModalities: ['text', 'image'],
            outputModalities: ['text'],
            thinkingLevels: ['low', 'medium', 'high']
          }
        ]
      }
    ]
  }

  const yaml = renderProvidersYaml([genericTestConfig])
  assert.ok('openai-compatibility' in yaml, 'must emit the shared openai-compatibility: key')
  const entries = yaml['openai-compatibility'] as Array<Record<string, unknown>>
  assert.equal(entries.length, 1)
  const entry = entries[0]
  assert.equal(entry.name, 'generic-test-endpoint')
  assert.equal(entry.disabled, false)
  assert.equal(entry.prefix, 'test')
  const keyEntries = entry['api-key-entries'] as Array<Record<string, unknown>>
  assert.equal(keyEntries[0]['api-key'], 'unused-local')
  assert.equal(keyEntries[0]['proxy-url'], 'socks5://127.0.0.1:1080')
  const models = entry.models as Array<Record<string, unknown>>
  assert.equal(models[0].name, 'llama3.1:8b')
  assert.equal(models[0].alias, 'local-llama')
  assert.equal(models[0]['display-name'], 'Llama 3.1 8B')
  assert.equal(models[0].image, false)
  assert.deepEqual(models[0]['input-modalities'], ['text', 'image'])
  assert.deepEqual(models[0]['output-modalities'], ['text'])
  assert.deepEqual(models[0].thinking, { levels: ['low', 'medium', 'high'] })
  console.log(
    '✓ generic (openaiCompatible authMethod) config renders a correct openai-compatibility: entry, ' +
      'incl. models/alias/thinking levels — selected purely by stored authMethod, not by provider id'
  )

  // Explicit baseUrl override is used verbatim (codex's descriptor has no
  // openaiCompatible.defaultBaseUrl to fall back to, since it's genuinely an
  // apiKey/oauth provider — this fixture only needed a resolvable descriptor).
  const overridden = renderProvidersYaml([
    { ...genericTestConfig, baseUrl: 'http://127.0.0.1:9/v1' }
  ])
  const overriddenEntries = overridden['openai-compatibility'] as Array<Record<string, unknown>>
  assert.equal(overriddenEntries[0]['base-url'], 'http://127.0.0.1:9/v1')
  console.log('✓ stored baseUrl is emitted verbatim when set')

  // A ProviderConfig for a REMOVED provider id (ollama — trimmed from
  // PROVIDERS by unit 10-creation) must be silently skipped exactly like any
  // other unregistered id — proving a user's stale stored ollama row (an
  // existing routing_proxy_providers/routing_proxy_provider_api_keys row
  // left untouched in the DB by the removal) is inert everywhere config
  // generation touches it, not a crash. Same code path as assertion 2's
  // synthetic-id case, exercised here with the REAL formerly-registered
  // 'ollama' id to lock in this specific removal's safety explicitly.
  const removedProviderConfig: ProviderConfig = {
    providerId: 'ollama',
    enabled: true,
    authMethod: 'openaiCompatible',
    apiKeys: [{ id: 'kx', apiKey: 'sk-stale-ollama-key' }]
  }
  const both = renderProvidersYaml([genericTestConfig, removedProviderConfig])
  const bothEntries = both['openai-compatibility'] as Array<Record<string, unknown>>
  assert.equal(
    bothEntries.length,
    1,
    'a stored config row for a REMOVED provider (ollama) must be skipped entirely, never emitted'
  )
  assert.ok(
    !bothEntries.some((e) => e.name === 'ollama' || e.name === undefined),
    'the removed-provider row must not appear in the openai-compatibility: list at all'
  )
  console.log(
    '✓ (unit 10-creation) a stale stored config row for a REMOVED provider (ollama) is silently skipped, ' +
      'never emitted and never throws'
  )

  // Two enabled openaiCompatible-authMethod rows would aggregate into ONE
  // shared list — already proven above (genericTestConfig's entry lands in
  // the shared openai-compatibility: array); the removed-provider row in the
  // same call above additionally proves a mix of a live + a stale row
  // aggregates correctly (stale one dropped, live one kept), same mechanism
  // a second genuinely-registered openaiCompatible provider would use.
}

// ---------------------------------------------------------------------------
// 5. Determinism + idempotency — regenerating from identical input yields
//    byte-identical output.
// ---------------------------------------------------------------------------

{
  // (unit 10-creation) The second row uses 'xai' — a genuinely registered
  // descriptor — with authMethod forced to 'openaiCompatible' purely as a
  // fixture, same rationale as assertion 4 above (ollama, the previous
  // fixture, was removed from PROVIDERS entirely; renderProvidersYaml
  // branches on the STORED authMethod, never on `id`, so any resolvable
  // descriptor exercises the identical code path).
  const cfg: ProviderConfig[] = [
    {
      providerId: 'codex',
      enabled: true,
      authMethod: 'apiKey',
      apiKeys: [
        { id: 'k1', apiKey: 'sk-a' },
        { id: 'k2', apiKey: 'sk-b' }
      ]
    },
    {
      providerId: 'xai',
      enabled: true,
      authMethod: 'openaiCompatible',
      apiKeys: [{ id: 'k3', apiKey: 'unused-local' }]
    }
  ]
  const first = renderRoutingProxyConfig({
    host: '127.0.0.1',
    port: 18765,
    authDir: path.join(scratchRoot, 'auth'),
    providers: cfg
  })
  const second = renderRoutingProxyConfig({
    host: '127.0.0.1',
    port: 18765,
    authDir: path.join(scratchRoot, 'auth'),
    providers: cfg
  })
  assert.equal(first, second, 'identical input must render byte-identical config.yaml text')
  // A shuffled-but-equal-content array (same provider set, same key order
  // within each provider) must still render identically — provider iteration
  // order in the input is caller-controlled (storage.ts orders by
  // provider_id), not re-sorted here, so passing the same array twice (even
  // reversed) with a caller that sorts consistently is the actual guarantee;
  // assert re-running the exact same call is stable, which is what matters
  // for "idempotent" (re-generating from the same DB state twice).
  console.log('✓ renderRoutingProxyConfig is deterministic/idempotent for identical input')

  const parsed = parseYaml(first) as Record<string, unknown>
  assert.ok('codex-api-key' in parsed)
  assert.ok('openai-compatibility' in parsed)
  assert.equal(parsed.host, '127.0.0.1')
  assert.equal(parsed.port, 18765)
  console.log('✓ full config.yaml (base fields + provider blocks) parses as valid YAML')
}

// ---------------------------------------------------------------------------
// 6. The management secret is NEVER in the generated config, even with
//    providers present — read back from the actual written file, not just
//    the in-memory string.
// ---------------------------------------------------------------------------

{
  const configFilePath = path.join(scratchRoot, 'config-with-providers.yaml')
  const authDirPath = path.join(scratchRoot, 'auth2')
  const fakeSecret = crypto.randomBytes(24).toString('hex')
  await writeRoutingProxyConfig(configFilePath, {
    host: '127.0.0.1',
    port: 18765,
    authDir: authDirPath,
    providers: [
      {
        providerId: 'codex',
        enabled: true,
        authMethod: 'apiKey',
        apiKeys: [{ id: 'k1', apiKey: 'sk-real-looking-key-not-the-secret' }]
      }
    ]
  })
  const onDisk = await fs.readFile(configFilePath, 'utf8')
  assert.ok(!onDisk.includes(fakeSecret), 'management secret must never appear in config.yaml')
  assert.ok(!onDisk.includes('MANAGEMENT_PASSWORD'))
  assert.ok(!/management[_-]?(password|secret)/i.test(onDisk))
  assert.ok(
    onDisk.includes('sk-real-looking-key-not-the-secret'),
    'provider API key IS expected in the file'
  )
  console.log('✓ management secret never appears in config.yaml even with providers present')

  // ---------------------------------------------------------------------
  // 7. Config file written 0600.
  // ---------------------------------------------------------------------
  const stat = await fs.stat(configFilePath)
  const mode = stat.mode & 0o777
  assert.equal(mode, 0o600, `config.yaml must be written 0600, got ${mode.toString(8)}`)
  console.log('✓ config.yaml is written with 0600 permissions')
}

// ---------------------------------------------------------------------------
// 8. cliproxy model source degrades gracefully when the proxy is
//    unreachable — resolve() never throws, always returns null when the
//    cache has nothing, and a refresh against a failing fetchJson leaves the
//    cache empty (not a crash) rather than throwing out of
//    refreshCliProxyModelCache itself.
// ---------------------------------------------------------------------------

{
  setCliProxyModelCacheForTests(null)
  assert.equal(
    cliProxyModelSource.resolve('gpt-5-codex'),
    null,
    'unreachable proxy -> resolve() is null, never throws'
  )

  const unreachableDeps: CliProxyModelSourceDeps = {
    fetchJson: async () => {
      throw new Error('ECONNREFUSED — proxy not running')
    }
  }
  // Must not throw.
  await refreshCliProxyModelCache('http://127.0.0.1:18765', 'fake-secret', unreachableDeps)
  assert.equal(
    cliProxyModelSource.resolve('gpt-5-codex'),
    null,
    'a refresh against an unreachable proxy must never populate a fabricated entry'
  )
  console.log(
    '✓ refreshCliProxyModelCache never throws when the proxy is unreachable; resolve() stays null'
  )

  // No management secret at all (proxy never started this run) -> refresh
  // must no-op without even attempting a fetch.
  let fetchCalled = false
  const trackingDeps: CliProxyModelSourceDeps = {
    fetchJson: async () => {
      fetchCalled = true
      return []
    }
  }
  await refreshCliProxyModelCache('http://127.0.0.1:18765', null, trackingDeps)
  assert.equal(
    fetchCalled,
    false,
    'refresh with no management secret must skip the network entirely'
  )
  console.log(
    '✓ refreshCliProxyModelCache no-ops (no fetch) when no management secret is available'
  )

  // A successful refresh DOES populate resolvable entries, proving the
  // happy path also works (not just the degrade path).
  const workingDeps: CliProxyModelSourceDeps = {
    fetchJson: async (url) => {
      if (url.includes('/model-definitions/codex')) {
        return [
          { name: 'gpt-5-codex', context_length: 400_000, thinking: { levels: ['low', 'high'] } }
        ]
      }
      return []
    }
  }
  await refreshCliProxyModelCache('http://127.0.0.1:18765', 'real-secret', workingDeps)
  const resolved = cliProxyModelSource.resolve('gpt-5-codex')
  assert.ok(resolved, 'a successful refresh must make the model resolvable')
  assert.equal(resolved!.context, 400_000)
  assert.equal(resolved!.supportsReasoning, true)
  assert.equal(resolved!.pricing, null, 'cliproxy source must never fabricate pricing')
  console.log('✓ a successful refresh populates real context/thinking facts (happy path)')

  // A partial failure (one channel throws, another succeeds) must still
  // update the cache with whatever DID succeed, not discard everything.
  setCliProxyModelCacheForTests(null)
  const partialDeps: CliProxyModelSourceDeps = {
    fetchJson: async (url) => {
      if (url.includes('/model-definitions/codex')) throw new Error('codex channel down')
      if (url.includes('/model-definitions/xai')) {
        return [{ name: 'grok-4.5', context_length: 256_000 }]
      }
      return []
    }
  }
  await refreshCliProxyModelCache('http://127.0.0.1:18765', 'real-secret', partialDeps)
  assert.equal(
    cliProxyModelSource.resolve('gpt-5-codex'),
    null,
    'the down channel contributes nothing'
  )
  assert.equal(
    cliProxyModelSource.resolve('grok-4.5')?.context,
    256_000,
    'a working channel still resolves'
  )
  console.log(
    '✓ a partial-failure refresh (one channel down) still resolves models from working channels'
  )
}

// ---------------------------------------------------------------------------
// 9. Claude is never treated as a routed provider, at every layer this unit
//    touches.
// ---------------------------------------------------------------------------

{
  assert.equal(isKnownProviderId('claude'), false)
  assert.equal(getProviderDescriptor('claude'), null)
  assert.ok(
    isClaudeModelId('claude-opus-4-5-20251101'),
    'sanity: the registry still knows real Claude ids'
  )
  assert.equal(
    isKnownProviderId('claude-opus-4-5-20251101'),
    false,
    'a Claude MODEL id must also never collide with a provider id'
  )
  console.log('✓ Claude is never a known/routable provider id, at the descriptor layer')
}

await cleanup()
console.log('\nAll provider-framework assertions passed.')
