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
  /** Provider ids that were reported healthy ('ok') as of the LAST
   *  successful live authFiles fetch, persisted across app launches
   *  (model-routing unit 09-polish — the startup-window race: on a cold
   *  boot the routing proxy is still 'starting' and authFiles is still
   *  empty, so without this the picker would show Claude-only for the
   *  first several seconds of every launch even for a provider that was
   *  definitely connected last session).
   *
   *  THIS IS A PRE-LIVE-DATA FALLBACK, NEVER A NEW SOURCE OF TRUTH — see
   *  persistedAvailabilityFor's own doc comment for the exact precedence
   *  rule that keeps it from ever lying once live data exists. Optional so
   *  every existing call site (including every verify-model-picker.ts
   *  assertion written before this field existed) keeps compiling/behaving
   *  identically when omitted — an absent/undefined set behaves exactly
   *  like an empty one (no persisted fallback offered). */
  persistedHealthyProviderIds?: Set<string>
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
    effortLevels: null,
    provisional: false
  }))
}

/**
 * True iff the routing proxy is in a state where it can actually serve
 * routed traffic right now — enabled AND its process is 'running'. Neither
 * alone is sufficient: `enabled` can be true while still 'starting'/
 * 'error'/'not_installed', and `status` could theoretically be stale.
 *
 * (model-routing unit 09-polish) `status === 'starting'` is DELIBERATELY
 * still excluded here, even for a provider with persisted-healthy history —
 * this function answers "can we trust a LIVE health signal right now", and
 * during 'starting' there simply isn't one yet (authFiles is still empty).
 * The persisted-availability softening happens at a DIFFERENT layer
 * (persistedAvailabilityFor, consulted only when this returns false) so the
 * two concerns stay cleanly separated: this function's contract is
 * unchanged from before this unit, and every existing caller/assertion that
 * depends on "enabled && running" as the live-serving definition keeps
 * working unmodified.
 */
function proxyIsServing(routingProxy: RoutingProxyStatusInput): boolean {
  return routingProxy.enabled && routingProxy.status === 'running'
}

/**
 * True iff the proxy is in the STARTUP WINDOW where a persisted fallback is
 * even worth consulting — enabled and either 'starting' (mid-boot, no live
 * authFiles data could possibly exist yet) or already 'running' but
 * authFiles just hasn't reported this specific provider yet (the fetch is
 * in flight / hasn't completed its first tick). Deliberately EXCLUDES
 * 'error'/'stopped'/'not_installed'/disabled — those are states where we
 * affirmatively know the proxy is NOT going to serve traffic soon, and
 * offering a persisted-available model there would be actively misleading
 * (not a brief startup gap, a real outage).
 */
function inStartupWindow(routingProxy: RoutingProxyStatusInput): boolean {
  if (!routingProxy.enabled) return false
  return routingProxy.status === 'starting' || routingProxy.status === 'running'
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

/**
 * The startup-window fallback decision (model-routing unit 09-polish).
 * Returns true ONLY when ALL of:
 *   - proxy is enabled and in the startup window (inStartupWindow) — never
 *     offered once the proxy is affirmatively down/errored/disabled
 *   - the provider's stored config still exists and is enabled — a
 *     provider disabled or removed from config since the persisted payload
 *     was written must never be resurrected by stale data
 *   - `providerId` is in the persisted-healthy set from last session
 *   - CRITICALLY: authFiles has NO entry at all for this provider yet —
 *     the instant a live entry exists (healthy OR unhealthy), THAT is
 *     authoritative and this function must return false. This is the "never
 *     let a stale persisted healthy override a live unhealthy" rule — it is
 *     enforced structurally here (not by the caller remembering to check)
 *     by looking at the SAME authFiles array providerIsHealthy already
 *     consults: once an entry appears, providerIsHealthy's own real
 *     ok/error answer is what must decide, and this function steps aside.
 */
function persistedAvailabilityFor(
  providerId: string,
  providerConfigs: ProviderConfigInput[],
  routingProxy: RoutingProxyStatusInput,
  persistedHealthyProviderIds: Set<string> | undefined
): boolean {
  if (!persistedHealthyProviderIds || !persistedHealthyProviderIds.has(providerId)) return false
  if (!inStartupWindow(routingProxy)) return false
  const cfg = providerConfigs.find((p) => p.providerId === providerId)
  if (!cfg || !cfg.enabled) return false
  const hasLiveEntry = routingProxy.authFiles.some((f) => f.provider === providerId)
  if (hasLiveEntry) return false // live data has arrived — it alone decides now, never the persisted fallback
  return true
}

function providerLabelFor(providerId: string, descriptors: ProviderDescriptorInput[]): string {
  return descriptors.find((d) => d.id === providerId)?.label ?? providerId
}

/**
 * Assemble the full selectable-model list: Claude (always, first, always
 * available) followed by every routed model the proxy currently reports,
 * gated on proxy-running + provider-healthy (or, during the startup window
 * only, the unit-09-polish persisted-availability fallback — see
 * persistedAvailabilityFor). If `currentModelId` names a routed model that
 * didn't make the cut, it's appended at the end marked unavailable rather
 * than dropped.
 */
export function buildSelectableModels(input: BuildSelectableModelsInput): SelectableModel[] {
  const result: SelectableModel[] = claudeEntries()

  const serving = proxyIsServing(input.routingProxy)
  const seenRoutedIds = new Set<string>()

  for (const entry of input.cliProxyModels) {
    if (!entry.providerId) continue // no provider attribution — can't gate or group it safely

    const liveHealthy =
      serving && providerIsHealthy(entry.providerId, input.providerConfigs, input.routingProxy)
    const provisional =
      !liveHealthy &&
      persistedAvailabilityFor(
        entry.providerId,
        input.providerConfigs,
        input.routingProxy,
        input.persistedHealthyProviderIds
      )

    if (!liveHealthy && !provisional) continue // omitted unless it's the current selection — handled below

    seenRoutedIds.add(entry.modelId)
    result.push({
      id: entry.modelId,
      label: entry.modelId,
      providerId: entry.providerId,
      providerLabel: providerLabelFor(entry.providerId, input.providerDescriptors),
      isClaude: false,
      available: true,
      contextWindow: entry.context,
      effortLevels: entry.effortLevels ?? null,
      provisional
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
      effortLevels: cached?.effortLevels ?? null,
      provisional: false
    })
  }

  return result
}
