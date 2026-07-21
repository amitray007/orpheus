// ---------------------------------------------------------------------------
// src/main/ipc/models.ts
//
// Thin IPC surface over src/main/models/registry.ts + models/selectable.ts.
// The renderer must not compute model facts (label, family, isClaude,
// context, pricing) itself — models:resolveLabels lets renderer code that
// only has a bare model id (e.g. joined from SessionRecord.model) resolve a
// display label without duplicating any of the registry's parsing logic
// client-side, and models:listSelectable is the single selectable-model list
// every picker (WorkspaceDrawer/SettingsDrawer/DropdownChip) renders from
// (model-routing unit 06) instead of importing CLAUDE_MODEL_OPTIONS/routed
// facts directly.
// ---------------------------------------------------------------------------

import { modelLabel } from '../models/registry'
import { buildSelectableModels } from '../models/selectable'
import type { BuildSelectableModelsInput } from '../models/selectable'
import { listCliProxyModelCacheEntries } from '../models/sources/cliproxy'
import {
  getRoutingProxySnapshot,
  ensureCliProxyModelCacheFresh,
  waitForCliProxyModelCacheFresh,
  getPersistedHealthyProviderIds
} from '../routingProxy/manager'
import { listProviderConfigs } from '../routingProxy/providers/storage'
import { PROVIDERS } from '../routingProxy/providers/registry'
import { handle } from './handle'

// Hard cap on the bounded first-call wait below. The measured cost of a full
// cliproxy model-definitions refresh (all provider channels, sequential) is
// ~15ms against a live proxy — 250ms leaves generous headroom for a slow
// tick while still being imperceptible, and guarantees this handler can never
// hang on a proxy that's enabled but wedged: waitForCliProxyModelCacheFresh
// always resolves (never rejects) at or before this deadline.
const FIRST_CALL_MODEL_CACHE_WAIT_MS = 250

function collectSelectableInput(currentModelId: string | undefined): BuildSelectableModelsInput {
  const snapshot = getRoutingProxySnapshot()
  return {
    routingProxy: {
      enabled: snapshot.enabled,
      status: snapshot.status,
      authFiles: snapshot.authFiles
    },
    providerConfigs: listProviderConfigs().map((p) => ({
      providerId: p.providerId,
      enabled: p.enabled
    })),
    providerDescriptors: PROVIDERS.map((p) => ({ id: p.id, label: p.label })),
    cliProxyModels: listCliProxyModelCacheEntries(),
    currentModelId,
    // (model-routing unit 09-polish) Startup-window fallback — see
    // models/selectable.ts's persistedAvailabilityFor for the precedence
    // rule that keeps this from ever overriding live authFiles data.
    persistedHealthyProviderIds: getPersistedHealthyProviderIds()
  }
}

export function registerModelsIpc(): void {
  handle('models:resolveLabels', (_e, { modelIds }) => {
    const labels: Record<string, string> = {}
    for (const id of modelIds) {
      labels[id] = modelLabel(id)
    }
    return labels
  })

  handle('models:listSelectable', async (_e, { currentModelId }) => {
    // Boot-time persisted-cache hydration (routingProxy/manager.ts's
    // hydrateSnapshotAtBoot) already covers the common case: the cliproxy
    // model cache is non-empty from app launch, so listCliProxyModelCacheEntries()
    // below already has routed-model facts and this call returns immediately.
    //
    // The only remaining cold-cache case is a genuinely first-ever run (no
    // persisted cache exists yet) or a version bump that invalidated it. For
    // THAT case only — cache still empty right now — take one short, hard-
    // capped bounded wait on the in-flight refresh so this very first call
    // can still include routed models, instead of guaranteeing Claude-only
    // until some later call. waitForCliProxyModelCacheFresh no-ops
    // immediately (no await cost) whenever the proxy is disabled/unreachable/
    // already-fresh — the Claude offline guarantee below is never at risk.
    if (listCliProxyModelCacheEntries().length === 0) {
      await waitForCliProxyModelCacheFresh(FIRST_CALL_MODEL_CACHE_WAIT_MS)
    } else {
      // Cache already has data (persisted-hydrated or a prior refresh) —
      // still best-effort refresh in the background so it never goes stale
      // without a live proxy round trip; never awaited.
      ensureCliProxyModelCacheFresh()
    }
    return buildSelectableModels(collectSelectableInput(currentModelId))
  })
}
