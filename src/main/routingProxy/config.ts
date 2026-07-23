// ---------------------------------------------------------------------------
// src/main/routingProxy/config.ts
//
// Generates the CLIProxyAPI config.yaml written into
// userData/routing-proxy/<version>/config.yaml. Base fields (host, port,
// auth-dir, debug) plus — as of unit 05 — a `providers:` composition layer
// (see renderProvidersYaml below) that turns stored ProviderConfig rows into
// CLIProxyAPI's `<provider>-api-key:` / `openai-compatibility:` blocks. The
// auth dir is passed in explicitly by the caller (manager.ts, via
// paths.authDir()) rather than derived internally here — keeps this module
// electron-free so scripts/verify-providers.ts and
// scripts/verify-routing-proxy.ts can exercise it fully offline.
//
// THE MANAGEMENT SECRET NEVER GOES IN THIS FILE. MANAGEMENT_PASSWORD is
// supplied to the child process purely via env (see lifecycle.ts) so the
// management API is usable without a plaintext secret ever touching disk —
// see the "no MANAGEMENT_PASSWORD/secret key in config.yaml" assertion in
// scripts/verify-routing-proxy.ts and scripts/verify-providers.ts.
//
// PROVIDER API KEYS DO go in this file — CLIProxyAPI reads them from
// config.yaml, there is no alternate env-only channel for them (unlike
// MANAGEMENT_PASSWORD). That's why writeRoutingProxyConfig chmods the file
// 0600 (owner-only) immediately after writing — see the "config file written
// 0600" assertion.
// ---------------------------------------------------------------------------

import * as fs from 'node:fs/promises'
import { stringify } from 'yaml'
import type { ProviderApiKeyEntry, ProviderConfig, ProviderModelEntry } from './providers/types'
import { getProviderDescriptor } from './providers/registry'

export interface RoutingProxyConfigOptions {
  host: string
  port: number
  authDir: string
  debug?: boolean
  /** Stored per-provider configs (unit C storage) to fold into the
   *  generated config.yaml. Omit/empty for the base proxy config with no
   *  providers wired yet — existing callers (manager.ts's install()/start())
   *  keep working unchanged. */
  providers?: ProviderConfig[]
  /** Model-name aliases (unit 08) targeting an apiKey/openaiCompatible-
   *  configured provider, already resolved+validated and grouped by target
   *  provider id — see aliasResolve.ts's aliasesToProviderModels
   *  (apiKeyModels bucket). Folded onto that provider's own
   *  `<provider>-api-key:`/`openai-compatibility:` block. Omit/empty for no
   *  aliases (existing callers unaffected). */
  aliasModelsByProvider?: Record<string, ProviderModelEntry[]>
  /** Model-name aliases targeting an oauth-configured provider (same
   *  aliasesToProviderModels call, oauthModels bucket) — emitted as a
   *  SEPARATE top-level `oauth-model-alias:` block instead, since
   *  CLIProxyAPI's OAuth/file-backed auth channels don't consult the
   *  per-credential `models:` list at all (see renderOauthModelAliasYaml's
   *  doc comment for the empirical verification). Omit/empty for no
   *  oauth-routed aliases. */
  oauthAliasModelsByProvider?: Record<string, ProviderModelEntry[]>
}

// ---------------------------------------------------------------------------
// Provider -> YAML block composition
//
// Two shapes only, selected purely by ProviderConfig.authMethod — never by
// provider id. This is the "adding a provider requires no code change here"
// guarantee: a synthetic/unknown descriptor with authMethod 'apiKey' and an
// apiKeyConfigKey flows through renderApiKeyEntries exactly like 'codex' or
// 'xai' does.
// ---------------------------------------------------------------------------

function toCliProxyModelEntry(m: ProviderModelEntry): Record<string, unknown> {
  const entry: Record<string, unknown> = { name: m.name }
  if (m.alias !== undefined) entry.alias = m.alias
  if (m.displayName !== undefined) entry['display-name'] = m.displayName
  if (m.forceMapping !== undefined) entry['force-mapping'] = m.forceMapping
  if (m.image !== undefined) entry.image = m.image
  if (m.inputModalities !== undefined) entry['input-modalities'] = m.inputModalities
  if (m.outputModalities !== undefined) entry['output-modalities'] = m.outputModalities
  if (m.thinkingLevels !== undefined) entry.thinking = { levels: m.thinkingLevels }
  return entry
}

function toCliProxyApiKeyEntry(
  k: ProviderApiKeyEntry,
  extraModels: ProviderModelEntry[] = []
): Record<string, unknown> {
  const entry: Record<string, unknown> = { 'api-key': k.apiKey }
  if (k.prefix !== undefined) entry.prefix = k.prefix
  if (k.baseUrl !== undefined) entry['base-url'] = k.baseUrl
  if (k.proxyUrl !== undefined) entry['proxy-url'] = k.proxyUrl
  if (k.disableCooling !== undefined) entry['disable-cooling'] = k.disableCooling
  const allModels = [...(k.models ?? []), ...extraModels]
  if (allModels.length > 0) entry.models = allModels.map(toCliProxyModelEntry)
  if (k.excludedModels && k.excludedModels.length > 0) entry['excluded-models'] = k.excludedModels
  return entry
}

function toCliProxyOpenAiCompatEntry(
  cfg: ProviderConfig,
  descriptor: NonNullable<ReturnType<typeof getProviderDescriptor>>,
  aliasModels: ProviderModelEntry[]
): Record<string, unknown> {
  const baseUrl = cfg.baseUrl ?? descriptor.openaiCompatible?.defaultBaseUrl
  const ownModels = cfg.apiKeys.flatMap((k) => k.models ?? [])
  const allModels = [...ownModels, ...aliasModels]

  return {
    name: cfg.displayName ?? descriptor.id,
    disabled: false,
    ...(cfg.prefix !== undefined ? { prefix: cfg.prefix } : {}),
    ...(baseUrl !== undefined ? { 'base-url': baseUrl } : {}),
    'api-key-entries': cfg.apiKeys.map((k) => {
      const e: Record<string, unknown> = { 'api-key': k.apiKey }
      if (k.proxyUrl !== undefined) e['proxy-url'] = k.proxyUrl
      return e
    }),
    ...(allModels.length > 0 ? { models: allModels.map(toCliProxyModelEntry) } : {})
  }
}

/**
 * Fold every enabled, non-empty ProviderConfig into the top-level YAML keys
 * CLIProxyAPI expects: one `<provider>-api-key:` list per dedicated-key
 * provider, plus a single shared `openai-compatibility:` list aggregating
 * every generic-endpoint provider. Deterministic: providers are iterated in
 * the order they appear in the input array (callers pass a stable order —
 * see storage.ts's listProviderConfigs, which orders by provider_id), and
 * within a provider, api key entries keep their stored array order.
 *
 * Never includes a provider whose descriptor is unknown (defensive: a stale
 * DB row referencing a removed provider id is silently skipped rather than
 * emitting a block CLIProxyAPI can't map back to anything), disabled, or with
 * zero api key entries (an enabled-but-empty apiKey/openaiCompatible provider
 * has nothing to emit).
 *
 * `aliasModelsByProvider` (model-routing unit 08, optional) folds extra
 * `{name, alias}` model entries onto the OWNING provider's block — callers
 * (config.ts's own writeRoutingProxyConfig) are responsible for having
 * already validated each alias's target model actually exists in the live
 * cliproxy model cache before including it here (see aliasResolve.ts's
 * aliasesToProviderModels); this function itself does no such validation, it
 * just attaches whatever it's given to the right provider. For an apiKey
 * provider (dedicated `<provider>-api-key:` block), alias models attach to
 * the FIRST api-key entry — CLIProxyAPI's `models:` list is per-key-entry,
 * and aliasing is a provider-level (not per-key) concept in this UI, so the
 * first entry is as good a home as any (matches how a provider's own
 * apiKeys[0].models would already be authored by hand in config.example.yaml
 * for a single-key provider, the overwhelmingly common case).
 */
export function renderProvidersYaml(
  providers: ProviderConfig[],
  aliasModelsByProvider: Record<string, ProviderModelEntry[]> = {}
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const openaiCompatEntries: Record<string, unknown>[] = []

  for (const cfg of providers) {
    if (!cfg.enabled) continue
    const descriptor = getProviderDescriptor(cfg.providerId)
    if (!descriptor) continue
    if (cfg.apiKeys.length === 0) continue

    const aliasModels = aliasModelsByProvider[cfg.providerId] ?? []

    if (cfg.authMethod === 'apiKey' && descriptor.apiKeyConfigKey) {
      out[descriptor.apiKeyConfigKey] = cfg.apiKeys.map((k, idx) =>
        toCliProxyApiKeyEntry(k, idx === 0 ? aliasModels : [])
      )
      continue
    }

    if (cfg.authMethod === 'openaiCompatible') {
      openaiCompatEntries.push(toCliProxyOpenAiCompatEntry(cfg, descriptor, aliasModels))
    }
    // 'oauth' providers have nothing to write into config.yaml — auth lives
    // in CLIProxyAPI's own auth-dir (see paths.ts's authDir()), populated by
    // the login flow (deferred to unit 06), not by this config generator.
  }

  if (openaiCompatEntries.length > 0) {
    out['openai-compatibility'] = openaiCompatEntries
  }

  return out
}

/**
 * Render the top-level `oauth-model-alias:` block — CLIProxyAPI's SEPARATE
 * aliasing mechanism for OAuth/file-backed auth channels (verified against
 * the pinned v7.2.92 binary with a real Codex OAuth credential: a
 * per-credential `codex-api-key[].models[].alias` entry is silently ignored
 * for an oauth-configured provider — `POST /v1/messages` for the alias name
 * returns "unknown provider for model X" — while the SAME alias emitted here
 * under `oauth-model-alias.codex` resolves and completes normally). See
 * aliasResolve.ts's SplitAliasProviderModels doc comment for the full
 * mechanism writeup.
 *
 * Keyed by provider/channel id (codex, xai, kimi, antigravity — CLIProxyAPI's
 * supported OAuth channels that this registry also models as authMethod
 * 'oauth'). Only ever called with entries already gated through
 * aliasesToProviderModels' oauthModels bucket, so every entry here has
 * already passed the knownOnProvider live-cache guard — this function does
 * no validation of its own, purely a shape transform.
 *
 * EVERY entry gets `fork: true` unconditionally — this was the root cause of
 * a regression (unit 09-polish) where the user's MAIN agent broke with
 * "unknown provider for model gpt-5.6-sol". Per internal/config/config.go's
 * OAuthModelAlias struct, `fork` defaults false, and a false/omitted `fork`
 * makes the alias REPLACE the upstream model in listings/routing rather than
 * adding alongside it — so once aliases existed for a channel's models, the
 * upstream ids themselves (which the main agent's own routed model actually
 * needs) stopped resolving. Verified end-to-end on a scratch proxy with the
 * user's real Codex OAuth credential: WITHOUT fork, `GET /v1/models` no
 * longer lists the upstream id at all and `POST /v1/messages` for it 502s;
 * WITH fork:true on every entry, both the upstream id AND every alias
 * resolve and complete normally in the same listing/session. There is no
 * case where we want an alias to consume the upstream model, so this is
 * unconditional — not derived from any alias/provider data.
 */
export function renderOauthModelAliasYaml(
  oauthAliasModelsByProvider: Record<string, ProviderModelEntry[]> = {}
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [providerId, models] of Object.entries(oauthAliasModelsByProvider)) {
    if (models.length === 0) continue
    out[providerId] = models.map((m) => ({ ...toCliProxyModelEntry(m), fork: true }))
  }
  return out
}

/**
 * Render config.yaml text. Pure/no I/O so it's directly assertable in the
 * offline harness (host/port/auth-dir present, no hardcoded absolute path
 * baked in beyond what the caller explicitly passed via authDir, no secret
 * key present, deterministic for identical input).
 */
export function renderRoutingProxyConfig(options: RoutingProxyConfigOptions): string {
  const lines = [
    '# Generated by Orpheus — do not edit by hand.',
    `host: ${options.host}`,
    `port: ${options.port}`,
    `auth-dir: ${options.authDir}`,
    `debug: ${options.debug ? 'true' : 'false'}`,
    ''
  ]
  let text = lines.join('\n')

  const providerYaml = renderProvidersYaml(
    options.providers ?? [],
    options.aliasModelsByProvider ?? {}
  )
  if (Object.keys(providerYaml).length > 0) {
    text += stringify(providerYaml)
  }

  const oauthAliasYaml = renderOauthModelAliasYaml(options.oauthAliasModelsByProvider ?? {})
  if (Object.keys(oauthAliasYaml).length > 0) {
    text += stringify({ 'oauth-model-alias': oauthAliasYaml })
  }

  return text
}

export interface WriteConfigOptions {
  host: string
  port: number
  /** Caller-supplied auth-dir (manager.ts passes paths.authDir()) — never
   *  derived internally so this module has no electron dependency. */
  authDir: string
  debug?: boolean
  providers?: ProviderConfig[]
  aliasModelsByProvider?: Record<string, ProviderModelEntry[]>
  oauthAliasModelsByProvider?: Record<string, ProviderModelEntry[]>
}

/**
 * Build config options + write config.yaml to `configPath`. `options.authDir`
 * is caller-supplied (never hardcoded — manager.ts derives it from
 * app.getPath('userData') via paths.authDir()). Returns the rendered text
 * (mainly for tests/logging — NEVER log this return value in production code
 * once providers are in play, since it can now contain real API keys; this
 * export exists for the config file's own on-disk copy and the offline
 * harness's assertions, not for a log line).
 *
 * Writes the file 0600 (owner read/write only) — provider API keys live in
 * this file (unlike MANAGEMENT_PASSWORD, which never touches disk), so the
 * file itself must not be group/world readable.
 */
export async function writeRoutingProxyConfig(
  configFilePath: string,
  options: WriteConfigOptions
): Promise<string> {
  await fs.mkdir(options.authDir, { recursive: true })
  const text = renderRoutingProxyConfig({
    host: options.host,
    port: options.port,
    authDir: options.authDir,
    debug: options.debug ?? false,
    providers: options.providers,
    aliasModelsByProvider: options.aliasModelsByProvider,
    oauthAliasModelsByProvider: options.oauthAliasModelsByProvider
  })
  await fs.writeFile(configFilePath, text, { encoding: 'utf8', mode: 0o600 })
  // writeFile's `mode` only applies to a freshly-created file; an existing
  // file (e.g. regenerated on every proxy start — see manager.ts) keeps its
  // prior mode bits. chmod unconditionally so permissions are always correct
  // on every write, not just the first.
  await fs.chmod(configFilePath, 0o600)
  return text
}
