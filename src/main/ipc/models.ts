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
import { listCliProxyModelCacheEntries } from '../models/sources/cliproxy'
import { getRoutingProxySnapshot, ensureCliProxyModelCacheFresh } from '../routingProxy/manager'
import { listProviderConfigs } from '../routingProxy/providers/storage'
import { PROVIDERS } from '../routingProxy/providers/registry'
import { handle } from './handle'

export function registerModelsIpc(): void {
  handle('models:resolveLabels', (_e, { modelIds }) => {
    const labels: Record<string, string> = {}
    for (const id of modelIds) {
      labels[id] = modelLabel(id)
    }
    return labels
  })

  handle('models:listSelectable', (_e, { currentModelId }) => {
    const snapshot = getRoutingProxySnapshot()
    // Best-effort, non-blocking: if the proxy is running but this run's
    // cliproxy model cache hasn't been populated yet (e.g. the picker opens
    // before the first 30s auth-files tick), kick off a refresh in the
    // background so the NEXT call sees routed models. Never awaited — the
    // Claude-only offline guarantee below must resolve immediately either way.
    ensureCliProxyModelCacheFresh()
    return buildSelectableModels({
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
      currentModelId
    })
  })
}
