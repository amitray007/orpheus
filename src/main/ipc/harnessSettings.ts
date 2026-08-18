// ---------------------------------------------------------------------------
// src/main/ipc/harnessSettings.ts
//
// IPC surface for the generic harness (coding-agent CLI) settings UI (U8,
// multi-harness architecture plan). Pure passthrough to
// ../harness/registry and ../harness/settings — closes over no index.ts
// state, mirroring mcp.ts's zero-deps registerXxxIpc precedent, since every
// read/write here is keyed by explicit ids passed over IPC rather than
// ambient current-project/workspace state.
// ---------------------------------------------------------------------------

import type { HarnessSummary } from '../../shared/types'
import { HARNESSES } from '../harness/registry'
import { getHarnessSettings, setHarnessSettings, resolveHarnessSettings } from '../harness/settings'
import { handle } from './handle'

/** Projects a HarnessDescriptor down to the renderer-safe HarnessSummary
 *  shape — drops composeLaunch (a function reference) and knownGoodVersions
 *  (a Set, not structured-cloneable in a way the renderer needs) before
 *  crossing the IPC boundary. */
function toSummary(descriptor: (typeof HARNESSES)[number]): HarnessSummary {
  return {
    id: descriptor.id,
    label: descriptor.label,
    capabilities: descriptor.capabilities,
    curated: descriptor.curated
  }
}

export function registerHarnessSettingsIpc(): void {
  handle('harness:list', () => HARNESSES.map(toSummary))

  handle('harness:settings:get', (_e, { harnessId, scope, scopeId }) =>
    getHarnessSettings(harnessId, scope, scopeId)
  )

  handle('harness:settings:set', (_e, { harnessId, scope, scopeId, settings }) => {
    setHarnessSettings(harnessId, scope, scopeId, settings)
    return getHarnessSettings(harnessId, scope, scopeId)
  })

  handle('harness:settings:resolved', (_e, { harnessId, projectId, workspaceId }) =>
    resolveHarnessSettings(harnessId, projectId, workspaceId)
  )
}
