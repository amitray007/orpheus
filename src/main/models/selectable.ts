// ---------------------------------------------------------------------------
// src/main/models/selectable.ts — assembles the single selectable-model list
// a workspace/project picker renders from (model-routing unit 06, part A).
//
// This is the ONE place "what models can a workspace pick from right now?"
// is decided. Two groups:
//
//   1. Claude — ALWAYS present, ALWAYS first, unconditionally `available`.
//      This is the offline guarantee: even with the routing proxy fully
//      disabled/stopped/unreachable, Claude must still be a full, selectable
//      list (see verify-model-picker.ts assertion 1). Sourced from
//      CLAUDE_MODEL_OPTIONS (src/shared/types.ts) — the same enumerable list
//      every existing picker (WorkspaceDrawer/SettingsDrawer/DropdownChip)
//      already renders from, now surfaced through IPC instead of imported
//      directly by renderer code (part B of this unit removes those direct
//      imports).
//
//   2. Routed — only offered when ALL of: the proxy is enabled AND running,
//      the owning provider account is connected AND healthy (cross-
//      referenced against the routing-proxy snapshot's authFiles by provider
//      id), AND the model is known to the cliproxy model source's cache
//      (i.e. CLIProxyAPI's own model-definitions endpoint reported it for
//      that provider channel). A model whose provider is disabled/
//      unhealthy/disconnected is simply omitted from the offered list...
//      UNLESS `currentModelId` names it, in which case it is still included
//      with `available: false` — a workspace's stored setting must never be
//      silently dropped from the picker just because its backend went
//      offline (see part A's "never lose the user's setting" requirement).
//
// Deliberately electron-free/DB-free (mirrors modelRouting.ts's own
// constraint — see that module's header comment) so scripts/verify-model-
// picker.ts can exercise it directly without booting Electron or touching
// SQLite. All main-process-only state (routing-proxy snapshot, stored
// provider configs, the cliproxy model cache) is threaded in as plain
// parameters by the IPC handler (src/main/ipc/models.ts), never imported
// here directly.
// ---------------------------------------------------------------------------

import { CLAUDE_MODEL_OPTIONS } from '../../shared/types'
import type { SelectableModel } from '../../shared/types'

const CLAUDE_PROVIDER_ID = 'claude'
const CLAUDE_PROVIDER_LABEL = 'Claude'

/** Minimal shape of a routing-proxy snapshot this module needs — a subset of
 *  RoutingProxySnapshot, kept narrow so this stays a plain-data dependency
 *  rather than importing the electron-touching manager module. */
export interface RoutingProxyStatusInput {
  enabled: boolean
  status: string
  authFiles: Array<{ provider: string; health: 'ok' | 'error' | 'unknown' }>
}

/** Minimal shape of a stored provider config this module needs. */
export interface ProviderConfigInput {
  providerId: string
  enabled: boolean
}

/** Minimal shape of a provider descriptor this module needs (for the
 *  provider's display label when grouping routed models). */
export interface ProviderDescriptorInput {
  id: string
  label: string
}

/** One cliproxy-model-cache entry, as returned by
 *  listCliProxyModelCacheEntries() in sources/cliproxy.ts. */
export interface CliProxyCacheEntryInput {
  modelId: string
  providerId?: string
  context: number | null
  effortLevels?: string[] | null
}

export interface BuildSelectableModelsInput {
  routingProxy: RoutingProxyStatusInput
  providerConfigs: ProviderConfigInput[]
  providerDescriptors: ProviderDescriptorInput[]
  cliProxyModels: CliProxyCacheEntryInput[]
  /** The workspace's currently-selected model id, if any — an empty string
   *  or undefined means "no override / claude default", never treated as a
   *  routed id to preserve. */
  currentModelId?: string
}

function claudeEntries(): SelectableModel[] {
  return CLAUDE_MODEL_OPTIONS.map((o) => ({
    id: o.value,
    label: o.label,
    providerId: CLAUDE_PROVIDER_ID,
    providerLabel: CLAUDE_PROVIDER_LABEL,
    isClaude: true,
    available: true,
    contextWindow: null, // resolved on demand via models:resolveLabels/registry, not duplicated here
    effortLevels: null
  }))
}

/** True iff the routing proxy is in a state where it can actually serve
 *  routed traffic right now — enabled AND its process is 'running'. Neither
 *  alone is sufficient: `enabled` can be true while still 'starting'/
 *  'error'/'not_installed', and `status` could theoretically be stale. */
function proxyIsServing(routingProxy: RoutingProxyStatusInput): boolean {
  return routingProxy.enabled && routingProxy.status === 'running'
}

/** True iff `providerId`'s stored config is enabled AND its connection
 *  (matched by provider id in the snapshot's authFiles) reports health 'ok'.
 *  A provider with no authFiles entry at all (never connected) is not
 *  healthy — absence is not health. */
function providerIsHealthy(
  providerId: string,
  providerConfigs: ProviderConfigInput[],
  routingProxy: RoutingProxyStatusInput
): boolean {
  const cfg = providerConfigs.find((p) => p.providerId === providerId)
  if (!cfg || !cfg.enabled) return false
  const connection = routingProxy.authFiles.find((f) => f.provider === providerId)
  return connection?.health === 'ok'
}

function providerLabelFor(providerId: string, descriptors: ProviderDescriptorInput[]): string {
  return descriptors.find((d) => d.id === providerId)?.label ?? providerId
}

/**
 * Assemble the full selectable-model list: Claude (always, first, always
 * available) followed by every routed model the proxy currently reports,
 * gated on proxy-running + provider-healthy. If `currentModelId` names a
 * routed model that didn't make the cut, it's appended at the end marked
 * unavailable rather than dropped.
 */
export function buildSelectableModels(input: BuildSelectableModelsInput): SelectableModel[] {
  const result: SelectableModel[] = claudeEntries()

  const serving = proxyIsServing(input.routingProxy)
  const seenRoutedIds = new Set<string>()

  for (const entry of input.cliProxyModels) {
    if (!entry.providerId) continue // no provider attribution — can't gate or group it safely
    const healthy =
      serving && providerIsHealthy(entry.providerId, input.providerConfigs, input.routingProxy)
    if (!healthy) continue // omitted unless it's the current selection — handled below

    seenRoutedIds.add(entry.modelId)
    result.push({
      id: entry.modelId,
      label: entry.modelId,
      providerId: entry.providerId,
      providerLabel: providerLabelFor(entry.providerId, input.providerDescriptors),
      isClaude: false,
      available: true,
      contextWindow: entry.context,
      effortLevels: entry.effortLevels ?? null
    })
  }

  // Preserve an already-selected routed model that didn't make the cut above
  // (proxy down, provider disconnected/unhealthy, or the model itself is no
  // longer reported) — never silently drop a workspace's stored setting.
  const current = input.currentModelId
  if (
    current &&
    !seenRoutedIds.has(current) &&
    !CLAUDE_MODEL_OPTIONS.some((o) => o.value === current)
  ) {
    const cached = input.cliProxyModels.find((m) => m.modelId === current)
    const providerId = cached?.providerId
    result.push({
      id: current,
      label: current,
      providerId: providerId ?? 'unknown',
      providerLabel: providerId
        ? providerLabelFor(providerId, input.providerDescriptors)
        : 'Unavailable',
      isClaude: false,
      available: false,
      contextWindow: cached?.context ?? null,
      effortLevels: cached?.effortLevels ?? null
    })
  }

  return result
}
