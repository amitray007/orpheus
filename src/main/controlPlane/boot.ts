import { createReadCapabilities } from './readCapabilities'
import { createReviewCapabilities } from './reviewCapabilities'
import { createWorkspaceCapabilities } from './workspaceCapabilities'
import { createTerminalObservationCapabilities } from './terminalObservationCapabilities'
import type { ControlRegistry } from './registry'
import type { ReadCapabilityHandlers, ReviewCapabilityHandlers } from './types'
import type { TerminalObservationHandlers } from '../terminalObservation/types'
import type { WorkspaceOrchestrationService } from '../workspaceOrchestration/service'

export function bootControlRegistry(
  registry: ControlRegistry,
  reviewHandlers: ReviewCapabilityHandlers,
  readHandlers?: ReadCapabilityHandlers,
  workspaceService?: WorkspaceOrchestrationService,
  terminalObservationHandlers?: TerminalObservationHandlers
): void {
  const [listCapability, setResolvedCapability] = createReviewCapabilities(reviewHandlers, {
    mcpRead: readHandlers != null
  })
  registry.register(listCapability)
  registry.register(setResolvedCapability)
  if (readHandlers != null) {
    const [
      selfGet,
      projectsList,
      projectsGet,
      workspacesList,
      workspacesGet,
      workspacesGetStatus,
      workspacesGetTranscript,
      workspacesGetLastTurn
    ] = createReadCapabilities(readHandlers)
    registry.register(selfGet)
    registry.register(projectsList)
    registry.register(projectsGet)
    registry.register(workspacesList)
    registry.register(workspacesGet)
    registry.register(workspacesGetStatus)
    registry.register(workspacesGetTranscript)
    registry.register(workspacesGetLastTurn)
  }
  if (workspaceService != null) {
    const [getLineage, create, startTask, open, send, wait, close, reopen, rename, archive] =
      createWorkspaceCapabilities(workspaceService)
    registry.register(getLineage)
    registry.register(create)
    registry.register(startTask)
    registry.register(open)
    registry.register(send)
    registry.register(wait)
    registry.register(close)
    registry.register(reopen)
    registry.register(rename)
    registry.register(archive)
  }
  if (terminalObservationHandlers != null) {
    const [list, get, getClaudeSession, getOutputTail, subscribe] =
      createTerminalObservationCapabilities(terminalObservationHandlers)
    registry.register(list)
    registry.register(get)
    registry.register(getClaudeSession)
    registry.register(getOutputTail)
    registry.register(subscribe)
  }
}
