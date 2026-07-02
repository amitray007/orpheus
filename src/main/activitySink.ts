// ---------------------------------------------------------------------------
// Activity sink — batch coalescing for workspace activity broadcasts.
//
// Instead of firing listeners immediately on every hook event (which can be
// N×F times/sec with N busy terminals), we stage the latest state per
// workspace in a pending Map and schedule a single flush ~16ms later.
// The flush emits the whole batch to `batchListeners` via onActivityBatch.
// ---------------------------------------------------------------------------

import type { WorkspaceStatus, WorkspaceActivityDetail } from '../shared/types'

export type ActivityUpdate = {
  workspaceId: string
  status: WorkspaceStatus
  detail: WorkspaceActivityDetail
}

const pendingBatch = new Map<string, ActivityUpdate>()
let flushScheduled = false

const batchListeners = new Set<(updates: ActivityUpdate[]) => void>()

function scheduleBatchFlush(): void {
  if (flushScheduled) return
  flushScheduled = true
  setTimeout(() => {
    flushScheduled = false
    if (pendingBatch.size === 0) return
    const updates = Array.from(pendingBatch.values())
    pendingBatch.clear()
    for (const cb of batchListeners) {
      try {
        cb(updates)
      } catch {
        /* ignore */
      }
    }
  }, 16)
}

export function onActivityBatch(cb: (updates: ActivityUpdate[]) => void): () => void {
  batchListeners.add(cb)
  return () => batchListeners.delete(cb)
}

export function stageActivityUpdate(update: ActivityUpdate): void {
  pendingBatch.set(update.workspaceId, update)
  scheduleBatchFlush()
}
