// ---------------------------------------------------------------------------
// src/main/ipc/sessions.ts
//
// Sessions IPC — moved verbatim out of index.ts (STR-1). Pure passthrough to
// ./sessions; closes over no index.ts state (the resume handlers create a new
// workspace row but don't touch launchSnapshots/requestOpenWorkspace — the
// renderer separately calls workspaces:open / navigates after the resume
// resolves).
// ---------------------------------------------------------------------------

import {
  listSessionsForProject,
  listSessionsForProjectPaged,
  listAllSessions,
  setSessionStatus,
  createWorkspaceResumingSession,
  createWorktreeResumingSession,
  refreshSessionMetadata,
  deleteSession,
  getContextBudget
} from '../sessions'
import { handle } from './handle'

export function registerSessionsIpc(): void {
  handle('sessions:listForProject', (_e, { projectId, includeArchived }) =>
    listSessionsForProject(projectId, { includeArchived })
  )

  handle('sessions:listAll', (_e, opts) => listAllSessions(opts))

  handle('sessions:setStatus', (_e, { id, status }) => setSessionStatus(id, status))

  handle('sessions:listForProjectPaged', (_e, req) => listSessionsForProjectPaged(req))

  handle('sessions:resumeInNewWorkspace', (_e, { sessionId, projectId }) =>
    createWorkspaceResumingSession(projectId, sessionId)
  )

  handle('sessions:resumeInWorktreeWorkspace', (_e, { sessionId, projectId }) =>
    createWorktreeResumingSession(projectId, sessionId)
  )

  handle('sessions:refreshMetadata', async (_e, { projectId }) => {
    await refreshSessionMetadata(projectId)
  })

  handle('sessions:delete', (_e, { id }) => deleteSession(id))

  handle('sessions:getContextBudget', (_e, { workspaceId }) => getContextBudget(workspaceId))
}
