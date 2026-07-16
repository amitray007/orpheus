// ---------------------------------------------------------------------------
// src/main/ipc/panes.ts
//
// Panes v2 — top-level Panels · Layouts · split Panes
// (docs/plans/2026-07-10-001-feat-panes-v2-toplevel-layouts-plan.md, U4).
// REPLACES the flat-row Panes IPC (U12): typed CRUD surface for the
// panel/layout/terminal hierarchy store (src/main/paneStore.ts). Pure
// passthrough, no injected deps needed (paneStore.ts talks to getDb()
// directly) — mirrors ipc/reviews.ts's shape.
//
// Also owns `panes:pickDirectory` (KTD8) — a folder picker scoped to Panes:
// the chosen path is returned to the renderer to store on a panel/layout's
// `dir` column, and is NEVER written to Orpheus's `projects` table (Panes
// project panels are deliberately independent of registered projects).
// Needs `dialog` from electron, so — unlike the rest of this module — it
// can't be pure passthrough to paneStore.ts; kept here rather than in
// misc.ts since it's conceptually part of the Panes CRUD surface, not a
// general app/window utility.
//
// The pane SURFACE mount IPC (pane:mount/resize/hide/destroy) is a separate
// concern living alongside workbench:* in src/main/index.ts, not here — it
// needs access to index.ts-owned state (the native addon loader, the
// surface registry) that would create a circular import if pulled into this
// module. KTD1: that surface layer is unchanged by Panes v2.
// ---------------------------------------------------------------------------

import { dialog } from 'electron'
import { handle } from './handle'
import {
  listPanels,
  createPanel,
  updatePanel,
  deletePanel,
  setPanelExpanded,
  listLayouts,
  createLayout,
  updateLayout,
  deleteLayout,
  setLayoutAutoStart,
  listTerminals,
  createTerminal,
  updateTerminal,
  deleteTerminal
} from '../paneStore'

export function registerPanesIpc(): void {
  // Panels
  handle('panes:listPanels', () => listPanels())
  handle('panes:createPanel', (_e, { kind, name, dir, position }) =>
    createPanel({ kind, name, dir, position })
  )
  handle('panes:updatePanel', (_e, { id, name, dir, position }) =>
    updatePanel(id, { name, dir, position })
  )
  handle('panes:deletePanel', (_e, { id }) => {
    deletePanel(id)
  })
  handle('panes:setPanelExpanded', (_e, { id, expanded }) => {
    setPanelExpanded(id, expanded)
  })

  // Layouts
  handle('panes:listLayouts', (_e, { panelId }) => listLayouts(panelId))
  handle('panes:createLayout', (_e, { panelId, name, dir, position }) =>
    createLayout({ panelId, name, dir, position })
  )
  handle('panes:updateLayout', (_e, { id, name, dir, splitTree, position }) =>
    updateLayout(id, { name, dir, splitTree, position })
  )
  handle('panes:deleteLayout', (_e, { id }) => {
    deleteLayout(id)
  })
  handle('panes:setLayoutAutoStart', (_e, { id, autoStart }) => setLayoutAutoStart(id, autoStart))

  // Terminals
  handle('panes:listTerminals', (_e, { layoutId }) => listTerminals(layoutId))
  handle('panes:createTerminal', (_e, { layoutId, command, name, position }) =>
    createTerminal({ layoutId, command, name, position })
  )
  handle('panes:updateTerminal', (_e, { id, command, name, position }) =>
    updateTerminal(id, { command, name, position })
  )
  handle('panes:deleteTerminal', (_e, { id }) => {
    deleteTerminal(id)
  })

  // Folder picker (KTD8) — Panes-only, never registers a project.
  handle('panes:pickDirectory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })
}
