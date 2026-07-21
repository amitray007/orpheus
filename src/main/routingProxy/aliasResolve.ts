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

import type { ProviderModelEntry } from './providers/types'

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
 * Grouped by provider id in the return value because that's exactly the
 * shape renderProvidersYaml's aliasModelsByProvider parameter expects — one
 * provider's block gets all of its own aliases attached, nothing more.
 */
export function aliasesToProviderModels(
  aliases: ModelAliasInput[],
  aliasesEnabled: boolean,
  cliProxyModels: AliasCacheEntryInput[]
): Record<string, ProviderModelEntry[]> {
  if (!aliasesEnabled) return {}

  const out: Record<string, ProviderModelEntry[]> = {}

  for (const alias of aliases) {
    if (!alias.enabled) continue
    if (!alias.targetProviderId || !alias.targetModelId) continue

    const knownOnProvider = cliProxyModels.some(
      (m) => m.modelId === alias.targetModelId && m.providerId === alias.targetProviderId
    )
    if (!knownOnProvider) continue // stale/unknown target — skip, never emit broken

    const list = out[alias.targetProviderId] ?? []
    list.push({ name: alias.targetModelId, alias: alias.claudeName })
    out[alias.targetProviderId] = list
  }

  return out
}
