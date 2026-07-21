// ---------------------------------------------------------------------------
// src/main/routingProxy/aliasResolve.ts
//
// Pure resolution/validation for model-name aliasing (model-routing unit
// 08) — deliberately split out of aliases.ts (which imports getDb()/
// electron for the storage functions) so this module has NO electron/
// better-sqlite3 dependency at all, mirroring the modelRouting.ts /
// models/selectable.ts split already established in this codebase (see
// those modules' own header comments on why the pure decision logic lives
// separately from anything that touches Electron or SQLite). This is what
// lets scripts/verify-aliases.ts exercise it fully offline.
//
// A plain structural copy of ModelAlias (not imported from aliases.ts) so
// this module truly has zero imports from an electron-touching file —
// aliases.ts's ModelAlias and this file's ModelAliasInput are kept
// field-for-field identical by convention; storage.ts/manager.ts pass the
// real ModelAlias objects straight through since the shapes are compatible.
// ---------------------------------------------------------------------------

import type { ProviderAuthMethod, ProviderModelEntry } from './providers/types'

export interface ModelAliasInput {
  claudeName: string
  enabled: boolean
  targetProviderId: string | null
  targetModelId: string | null
}

export interface AliasCacheEntryInput {
  modelId: string
  providerId?: string
}

/**
 * Split-by-destination result of aliasesToProviderModels. CLIProxyAPI has
 * TWO, mutually exclusive alias mechanisms (verified empirically against the
 * pinned v7.2.92 binary + a real OAuth-backed Codex credential — see this
 * module's own doc comment on aliasesToProviderModels for the full story):
 *   - apiKeyModels: per-credential `models: [{name, alias}]` entries folded
 *     onto a provider's OWN `<provider>-api-key:` / `openai-compatibility:`
 *     block (config.ts's renderProvidersYaml). Only takes effect for a
 *     provider actually configured with authMethod 'apiKey'/'openaiCompatible'.
 *   - oauthModels: top-level `oauth-model-alias: { <channel>: [{name, alias}] }`
 *     entries (config.ts's renderOauthModelAliasYaml). Required for a
 *     provider configured with authMethod 'oauth' — CLIProxyAPI's OAuth/
 *     file-backed auth channels do NOT consult the per-credential `models:`
 *     list at all (that list lives under a per-key config block; an
 *     OAuth-backed provider has no such per-key entry in config.yaml, its
 *     credential lives in auth-dir instead), so an alias emitted the
 *     apiKeyModels way for an oauth-configured provider is silently ignored
 *     by CLIProxyAPI's routing table -> "unknown provider for model X" even
 *     though config.yaml "looks" like it declared the alias.
 */
export interface SplitAliasProviderModels {
  apiKeyModels: Record<string, ProviderModelEntry[]>
  oauthModels: Record<string, ProviderModelEntry[]>
}

const EMPTY_SPLIT: SplitAliasProviderModels = { apiKeyModels: {}, oauthModels: {} }

/**
 * THE gate that decides which stored aliases are actually safe to emit into
 * config.yaml:
 *
 *   - the master switch (aliasesEnabled, mirrors AppUiState.modelAliasesEnabled)
 *     must be on — false means this returns {} unconditionally, never
 *     touching config generation
 *   - the row itself must be enabled (a disabled row is stored but inert)
 *   - both targetProviderId and targetModelId must be set (a row created by
 *     "Use defaults" or the picker but not yet fully filled in is a no-op,
 *     not a broken partial emission)
 *   - targetModelId must currently be present in the live cliproxy model
 *     cache for that exact targetProviderId — this is the "skip, don't emit
 *     broken" requirement: a stale alias naming a model the proxy no longer
 *     reports (upstream removed it, provider disconnected, cache not yet
 *     populated this run) is silently dropped rather than handed to
 *     CLIProxyAPI as an alias for a model it doesn't recognize.
 *
 * `providerAuthMethods` (target provider id -> its CURRENTLY CONFIGURED
 * authMethod, from providers/storage.ts's listProviderConfigs) decides which
 * of the two output buckets (see SplitAliasProviderModels) each provider's
 * aliases land in. A provider id present in the alias's targetProviderId but
 * ABSENT from providerAuthMethods (stale/removed provider) is treated as
 * apiKey-shaped by default — matches the pre-existing behavior for that edge
 * case (the knownOnProvider cache guard above already means this can only
 * happen for a provider that was live in the cache at some point but whose
 * ProviderConfig row is now gone, an already-unusual state).
 */
export function aliasesToProviderModels(
  aliases: ModelAliasInput[],
  aliasesEnabled: boolean,
  cliProxyModels: AliasCacheEntryInput[],
  providerAuthMethods: Record<string, ProviderAuthMethod> = {}
): SplitAliasProviderModels {
  if (!aliasesEnabled) return EMPTY_SPLIT

  const apiKeyModels: Record<string, ProviderModelEntry[]> = {}
  const oauthModels: Record<string, ProviderModelEntry[]> = {}

  for (const alias of aliases) {
    if (!alias.enabled) continue
    if (!alias.targetProviderId || !alias.targetModelId) continue

    const knownOnProvider = cliProxyModels.some(
      (m) => m.modelId === alias.targetModelId && m.providerId === alias.targetProviderId
    )
    if (!knownOnProvider) continue // stale/unknown target — skip, never emit broken

    const entry: ProviderModelEntry = { name: alias.targetModelId, alias: alias.claudeName }
    const isOauth = providerAuthMethods[alias.targetProviderId] === 'oauth'
    const bucket = isOauth ? oauthModels : apiKeyModels
    const list = bucket[alias.targetProviderId] ?? []
    list.push(entry)
    bucket[alias.targetProviderId] = list
  }

  return { apiKeyModels, oauthModels }
}

/**
 * Structural equality for two aliasesToProviderModels() results — used by
 * manager.ts to decide whether a freshly-resolved alias map actually differs
 * from what's currently on disk before paying for a config.yaml rewrite
 * (see manager.ts's maybeRegenerateConfigForAliasChange doc comment for the
 * full ordering problem this solves: cache population happens async, on a
 * timer, potentially every 30s, and must NOT trigger a rewrite when nothing
 * about the resolved alias set actually changed).
 *
 * Order-independent per provider (aliasesToProviderModels always emits
 * entries in `aliases` input order, which is itself stable — listModelAliases
 * orders by claudeName — but comparing as a set-of-JSON-strings is cheap and
 * avoids coupling this equality check to that ordering guarantee holding
 * forever). Compares the full entry shape (name + alias), not just presence,
 * so a target model changing for the same claudeName is correctly detected
 * as a change.
 */
export function aliasProviderModelsEqual(
  a: Record<string, ProviderModelEntry[]>,
  b: Record<string, ProviderModelEntry[]>
): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false

  const sortedEntryKey = (entries: ProviderModelEntry[]): string =>
    entries
      .map((e) => JSON.stringify(e))
      .sort()
      .join('|')

  for (const key of aKeys) {
    const aEntries = a[key]
    const bEntries = b[key]
    if (!bEntries) return false
    if (aEntries.length !== bEntries.length) return false
    if (sortedEntryKey(aEntries) !== sortedEntryKey(bEntries)) return false
  }

  return true
}

/**
 * Same structural-equality contract as aliasProviderModelsEqual, extended to
 * the split { apiKeyModels, oauthModels } shape aliasesToProviderModels now
 * returns — both buckets must match for the two results to be considered
 * equal. Used by manager.ts's regenerateConfigIfAliasesChanged so a churn
 * cycle that leaves either bucket unchanged (the common case) skips the
 * config.yaml rewrite exactly as it did before the oauth/apiKey split.
 */
export function aliasSplitEqual(a: SplitAliasProviderModels, b: SplitAliasProviderModels): boolean {
  return (
    aliasProviderModelsEqual(a.apiKeyModels, b.apiKeyModels) &&
    aliasProviderModelsEqual(a.oauthModels, b.oauthModels)
  )
}
