// ---------------------------------------------------------------------------
// src/main/ipc/footerActions.ts
//
// Footer actions CRUD + merge IPC surface — moved verbatim out of index.ts
// (STR-1). Pure passthrough to ./footerActions; closes over no index.ts
// state.
// ---------------------------------------------------------------------------

import {
  listGlobal as listGlobalFooterActions,
  listForProject as listProjectFooterActions,
  listForWorkspace as listWorkspaceFooterActions,
  listMerged as listMergedFooterActions,
  create as createFooterAction,
  update as updateFooterAction,
  remove as removeFooterAction,
  reorder as reorderFooterActions,
  resetToDefaults as resetFooterActionsToDefaults
} from '../footerActions'
import { handle } from './handle'

export function registerFooterActionsIpc(): void {
  handle('footerActions:listMerged', (_e, { workspaceId }) => listMergedFooterActions(workspaceId))

  handle('footerActions:listAtScope', (_e, { scope, scopeId }) => {
    if (scope === 'global') return listGlobalFooterActions()
    if (scope === 'project') return listProjectFooterActions(scopeId ?? '')
    return listWorkspaceFooterActions(scopeId ?? '')
  })

  handle('footerActions:create', (_e, { scope, scopeId, draft }) =>
    createFooterAction(scope, scopeId, draft)
  )

  handle('footerActions:update', (_e, { id, patch }) => updateFooterAction(id, patch))

  handle('footerActions:remove', (_e, { id }) => {
    removeFooterAction(id)
  })

  handle('footerActions:reorder', (_e, { scope, scopeId, orderedIds }) =>
    reorderFooterActions(scope, scopeId, orderedIds)
  )

  handle('footerActions:resetDefaults', () => {
    resetFooterActionsToDefaults()
  })
}
