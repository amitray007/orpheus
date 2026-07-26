// ---------------------------------------------------------------------------
// src/main/ipc/reviews.ts
//
// Workbench Git tab — Phase 4d. Typed IPC surface for the LOCAL
// (Orpheus-owned) review-comment store (src/main/reviewStore.ts). Pure
// passthrough, no injected deps needed (reviewStore.ts talks to getDb()
// directly, same as footerActions.ts) — mirrors ipc/footerActions.ts's shape.
// ---------------------------------------------------------------------------

import { handle } from './handle'
import { add, remove } from '../reviewStore'
import {
  invokeReviewList,
  invokeReviewSetResolved,
  rendererReviewContext
} from '../reviewControlAdapter'
import { invokeControl } from '../controlPlane'

export function registerReviewsIpc(): void {
  handle('reviews:list', async (e, { workspaceId }) =>
    invokeReviewList(
      invokeControl,
      { workspaceId },
      rendererReviewContext(e.sender.id, workspaceId)
    )
  )

  handle('reviews:add', (_e, { workspaceId, prNumber, path, line, startLine, side, body }) =>
    add({ workspaceId, prNumber, path, line, startLine, side, body })
  )

  handle('reviews:setResolved', async (e, { id, resolved }) =>
    invokeReviewSetResolved(
      invokeControl,
      { id, resolved },
      rendererReviewContext(e.sender.id, null)
    )
  )

  handle('reviews:delete', (_e, { id }) => {
    remove(id)
  })
}
