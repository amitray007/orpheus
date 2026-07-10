// ---------------------------------------------------------------------------
// src/main/ipc/panes.ts
//
// Workbench Panes tab (U12). Typed IPC surface for the declared per-workspace
// terminal panes CRUD store (src/main/paneStore.ts). Pure passthrough, no
// injected deps needed (paneStore.ts talks to getDb() directly) — mirrors
// ipc/reviews.ts's shape. The pane SURFACE mount IPC (pane:mount/resize/
// hide/destroy) is a separate concern living alongside workbench:* in
// src/main/index.ts, not here — it needs access to index.ts-owned state
// (the native addon loader, the surface registry) that would create a
// circular import if pulled into this module.
// ---------------------------------------------------------------------------

import { handle } from './handle'
import { listByWorkspace, add, update, remove } from '../paneStore'

export function registerPanesIpc(): void {
  handle('panes:list', (_e, { workspaceId }) => listByWorkspace(workspaceId))

  handle('panes:create', (_e, { workspaceId, command, title, position, sizeFraction }) =>
    add({ workspaceId, command, title, position, sizeFraction })
  )

  handle('panes:update', (_e, { id, command, title, position, sizeFraction }) =>
    update(id, { command, title, position, sizeFraction })
  )

  handle('panes:delete', (_e, { id }) => {
    remove(id)
  })
}
