// ---------------------------------------------------------------------------
// src/main/ipc/reviews.ts
//
// Workbench Git tab — Phase 4d. Typed IPC surface for the LOCAL
// (Orpheus-owned) review-comment store (src/main/reviewStore.ts). Pure
// passthrough, no injected deps needed (reviewStore.ts talks to getDb()
// directly, same as footerActions.ts) — mirrors ipc/footerActions.ts's shape.
// ---------------------------------------------------------------------------

import { handle } from './handle'
import { listByWorkspace, add, setResolved, remove } from '../reviewStore'

export function registerReviewsIpc(): void {
  handle('reviews:list', (_e, { workspaceId }) => listByWorkspace(workspaceId))

  handle('reviews:add', (_e, { workspaceId, prNumber, path, line, startLine, side, body }) =>
    add({ workspaceId, prNumber, path, line, startLine, side, body })
  )

  handle('reviews:setResolved', (_e, { id, resolved }) => setResolved(id, resolved))

  handle('reviews:delete', (_e, { id }) => {
    remove(id)
  })
}
