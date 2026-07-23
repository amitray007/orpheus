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
  deleteModelAlias,
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
 *  form.
 *
 *  Deliberately NOT expanded with date-stamped variants here — this function
 *  only decides which ROWS the Settings UI's "Use defaults" action creates/
 *  displays (AliasesSection.tsx renders exactly one row per
 *  CLAUDE_MODEL_OPTIONS entry; a stamped id has no UI row of its own to
 *  belong to). Date-stamped-variant expansion for the REPORTED BUG ("502
 *  unknown provider for model claude-haiku-4-5-20251001") happens once,
 *  uniformly, at config-emission time instead — routingProxy/manager.ts's
 *  resolveAliasModelsByProvider expands every stored row (however it was
 *  created: via useDefaults below OR a manual aliases:setAlias pin) to also
 *  emit its known stamped variants, mapped to the same target. See that
 *  module's buildStampedVariantsByBareId doc comment for where variant ids
 *  are sourced (models.dev cache + this app's own observed session models)
 *  and the residual-gap writeup (a stamp neither source has seen yet is
 *  invisible until one catches up, self-healing on the same ~30s cadence as
 *  the rest of the alias-refresh loop). Expanding at emission time rather
 *  than here means a stamped variant discovered AFTER a row was created
 *  (no re-click of "Use defaults" required) still resolves. */
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

/** Auto-managed names — one per CLAUDE_MODEL_OPTIONS entry. Any stored row
 *  whose claudeName ISN'T in this set is a user-added custom row (see
 *  ModelAliasSummary.isCustom's doc comment) — membership, not a stored
 *  column, is what drives the distinction, so a custom row that happens to
 *  be named e.g. "claude-opus-4-9" the day that becomes a real
 *  CLAUDE_MODEL_OPTIONS entry correctly reclassifies as auto without a
 *  migration. */
const AUTO_CLAUDE_NAMES = new Set(candidateClaudeNames())

function toSummary(a: ModelAlias): ModelAliasSummary {
  return {
    claudeName: a.claudeName,
    enabled: a.enabled,
    targetProviderId: a.targetProviderId,
    targetModelId: a.targetModelId,
    isCustom: !AUTO_CLAUDE_NAMES.has(a.claudeName)
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

  // -------------------------------------------------------------------
  // Custom alias rows (model-routing unit 09-polish) — an arbitrary
  // free-text name a user adds by hand, distinct from the auto-managed
  // CLAUDE_MODEL_OPTIONS rows above. Deliberately NOT restricted to a
  // "claude-*" shape (unlike candidateClaudeNames) — a user may need to
  // alias a non-Claude name some other tool requests, or manually cover a
  // date-stamped id the stamped-variant auto-detection
  // (routingProxy/manager.ts's buildStampedVariantsByBareId) hasn't
  // observed yet. This is that escape hatch.
  //
  // Validation happens here (IPC layer), not in storage.ts/aliasResolve.ts
  // — those stay permissive (free-text PK, no CHECK — see schema.ts's own
  // doc comment on routing_proxy_model_aliases.claude_name) because a
  // stored row's name is trusted-by-construction once it passes THIS gate;
  // re-validating on every read would be redundant. A rejected call throws,
  // which the renderer surfaces as an error rather than a silent no-op —
  // a typo'd name that silently did nothing would be worse than a visible
  // rejection.
  // -------------------------------------------------------------------

  handle('aliases:addCustom', async (_e, { claudeName, targetProviderId, targetModelId }) => {
    const trimmed = claudeName.trim()
    if (!trimmed) throw new Error('Name must not be empty')

    const existingNames = new Set(listModelAliases().map((a) => a.claudeName))
    if (existingNames.has(trimmed)) {
      throw new Error(
        AUTO_CLAUDE_NAMES.has(trimmed)
          ? `"${trimmed}" is already an auto-managed alias row — edit it above instead of adding a duplicate`
          : `"${trimmed}" is already a custom alias — edit it instead of adding a duplicate`
      )
    }

    // Self-referential guard: a name aliasing itself is never meaningful
    // (CLIProxyAPI's oauth-model-alias would just be renaming an id to its
    // own value) — reject rather than silently accepting a no-op mapping.
    if (targetModelId !== null && trimmed === targetModelId) {
      throw new Error(`"${trimmed}" cannot alias to itself`)
    }

    upsertModelAlias(trimmed, {
      enabled: true,
      targetProviderId,
      targetModelId
    })
    await regenerateConfigNow()
    return buildState()
  })

  handle('aliases:removeCustom', async (_e, { claudeName }) => {
    // Auto-managed rows regenerate from CLAUDE_MODEL_OPTIONS on every "Use
    // defaults" click and are always displayed — deleting one here would
    // just have it silently reappear (or worse, leave a gap until the next
    // useDefaults click), which reads as a broken delete button. Refuse
    // explicitly instead of a confusing no-op.
    if (AUTO_CLAUDE_NAMES.has(claudeName)) {
      throw new Error(`"${claudeName}" is an auto-managed row and cannot be removed`)
    }
    deleteModelAlias(claudeName)
    await regenerateConfigNow()
    return buildState()
  })
}
