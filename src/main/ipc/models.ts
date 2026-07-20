// ---------------------------------------------------------------------------
// src/main/ipc/models.ts
//
// Thin IPC surface over src/main/models/registry.ts. The renderer must not
// compute model facts (label, family, isClaude, context, pricing) itself —
// this is the one channel that lets renderer code that only has a bare
// model id (e.g. joined from SessionRecord.model) resolve a display label
// without duplicating any of the registry's parsing logic client-side.
// ---------------------------------------------------------------------------

import { modelLabel } from '../models/registry'
import { handle } from './handle'

export function registerModelsIpc(): void {
  handle('models:resolveLabels', (_e, { modelIds }) => {
    const labels: Record<string, string> = {}
    for (const id of modelIds) {
      labels[id] = modelLabel(id)
    }
    return labels
  })
}
