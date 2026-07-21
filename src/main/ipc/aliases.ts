// ---------------------------------------------------------------------------
// src/main/ipc/aliases.ts
//
// Model-name aliasing IPC (model-routing unit 08). Thin translation layer
// between src/main/routingProxy/aliases.ts's storage + resolution and the
// renderer-facing ModelAliasesState/ModelAliasTargetOption wire shapes —
// mirrors src/main/ipc/providers.ts's shape exactly: every mutating handler
// regenerates config.yaml immediately via routingProxy/manager.ts's
// regenerateConfigNow() so an edit takes effect without an app restart
// (CLIProxyAPI watches config.yaml itself and reloads on change — see
// manager.ts's resolveAliasModelsByProvider doc comment).
// ---------------------------------------------------------------------------

import type {
  ModelAliasesState,
  ModelAliasSummary,
  ModelAliasTargetOption
} from '../../shared/types'
import { CLAUDE_MODEL_OPTIONS } from '../../shared/types'
import {
  listModelAliases,
  upsertModelAlias,
  replaceModelAliases,
  type ModelAlias
} from '../routingProxy/aliases'
import { listCliProxyModelCacheEntries } from '../models/sources/cliproxy'
import { getRoutingProxySnapshot, regenerateConfigNow } from '../routingProxy/manager'
import { listProviderConfigs } from '../routingProxy/providers/storage'
import { PROVIDERS } from '../routingProxy/providers/registry'
import { getAppUiState, updateAppUiState } from '../uiState'
import { handle } from './handle'

// ---------------------------------------------------------------------------
// Defaults (unit 08, part B) — the one place the requested name -> upstream
// model mapping is declared. Effort/thinking-level pinning is deliberately
// NOT part of this shape — CLIProxyAPI has no per-alias effort field (only
// thinking.levels, which DECLARES supported levels, not a pinned one; see
// this unit's own task doc) — so 'opus' and 'fable' both mapping to the same
// upstream model is correct, not a bug: any "high-effort Fable" distinction
// the user wants happens by choosing a different DEFAULT_ALIAS_TARGETS entry
// or editing the row by hand, never by a fabricated effort control.
// ---------------------------------------------------------------------------

const DEFAULT_ALIAS_TARGETS: Record<string, string> = {
  sonnet: 'gpt-5.6-terra',
  opus: 'gpt-5.6-sol',
  fable: 'gpt-5.6-sol'
}

/** Every Claude name a subagent's frontmatter might plausibly pin, sourced
 *  from CLAUDE_MODEL_OPTIONS (never hand-typed) — both the "always latest"
 *  aliases (sonnet/opus/haiku/fable) and every explicit versioned id
 *  (claude-sonnet-5, claude-opus-4-8, ...), since a subagent can pin either
 *  form. */
function candidateClaudeNames(): string[] {
  return CLAUDE_MODEL_OPTIONS.map((o) => o.value)
}

/** Providers that are both enabled in stored config AND report health 'ok'
 *  in the live routing-proxy snapshot — mirrors models/selectable.ts's own
 *  providerIsHealthy gate (duplicated rather than imported since that
 *  function isn't exported; kept in lockstep intentionally — both decide
 *  "is this provider's model actually usable right now"). */
function healthyProviderIds(): Set<string> {
  const snapshot = getRoutingProxySnapshot()
  const configs = listProviderConfigs()
  const ids = new Set<string>()
  for (const cfg of configs) {
    if (!cfg.enabled) continue
    const connection = snapshot.authFiles.find((f) => f.provider === cfg.providerId)
    if (connection?.health === 'ok') ids.add(cfg.providerId)
  }
  return ids
}

function providerLabel(providerId: string): string {
  return PROVIDERS.find((p) => p.id === providerId)?.label ?? providerId
}

/** Every routed model an alias may currently point to — live cliproxy cache
 *  entries whose provider is enabled+healthy. Deliberately excludes Claude
 *  entirely (the cliproxy cache never contains Claude ids in the first
 *  place — see cliproxy.ts's own scope) and excludes any model whose
 *  provider isn't actually usable, so the dropdown can't offer a mapping
 *  that renderProvidersYaml would immediately skip as stale. */
function listTargetOptions(): ModelAliasTargetOption[] {
  const healthy = healthyProviderIds()
  return listCliProxyModelCacheEntries()
    .filter((e) => e.providerId && healthy.has(e.providerId))
    .map((e) => ({
      providerId: e.providerId as string,
      providerLabel: providerLabel(e.providerId as string),
      modelId: e.modelId
    }))
    .sort((a, b) => a.modelId.localeCompare(b.modelId) || a.providerId.localeCompare(b.providerId))
}

function toSummary(a: ModelAlias): ModelAliasSummary {
  return {
    claudeName: a.claudeName,
    enabled: a.enabled,
    targetProviderId: a.targetProviderId,
    targetModelId: a.targetModelId
  }
}

function buildState(): ModelAliasesState {
  return {
    enabled: getAppUiState().modelAliasesEnabled,
    aliases: listModelAliases().map(toSummary)
  }
}

export function registerAliasesIpc(): void {
  handle('aliases:list', () => buildState())

  handle('aliases:listTargets', () => listTargetOptions())

  handle('aliases:setEnabled', async (_e, { enabled }) => {
    updateAppUiState({ modelAliasesEnabled: enabled })
    await regenerateConfigNow()
    return buildState()
  })

  handle('aliases:setAlias', async (_e, { claudeName, targetProviderId, targetModelId }) => {
    if (!claudeName.trim()) throw new Error('claudeName must not be empty')
    upsertModelAlias(claudeName, {
      enabled: true,
      targetProviderId,
      targetModelId
    })
    await regenerateConfigNow()
    return buildState()
  })

  handle('aliases:useDefaults', async () => {
    // Only include a default whose exact target id is present in the LIVE
    // cache right now (degrade gracefully — skip/disable rather than emit a
    // broken mapping to a model that isn't actually available). Grouped by
    // modelId -> providerId from the cache so the emitted alias always names
    // a real, currently-known provider+model pair.
    const cacheByModelId = new Map(listCliProxyModelCacheEntries().map((e) => [e.modelId, e]))
    const existing = new Map(listModelAliases().map((a) => [a.claudeName, a]))

    const next: ModelAlias[] = candidateClaudeNames().map((name) => {
      const prior = existing.get(name)
      const defaultTarget = DEFAULT_ALIAS_TARGETS[name]
      const cached = defaultTarget ? cacheByModelId.get(defaultTarget) : undefined
      if (cached?.providerId) {
        return {
          claudeName: name,
          enabled: true,
          targetProviderId: cached.providerId,
          targetModelId: cached.modelId,
          updatedAt: Date.now()
        }
      }
      // No default declared for this name, or its target isn't present in
      // the live cache right now — keep whatever was already stored (don't
      // clobber a manual mapping) rather than forcing it to "not mapped".
      return (
        prior ?? {
          claudeName: name,
          enabled: true,
          targetProviderId: null,
          targetModelId: null,
          updatedAt: Date.now()
        }
      )
    })

    replaceModelAliases(next)
    await regenerateConfigNow()
    return buildState()
  })
}
