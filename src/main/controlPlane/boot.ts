import { createReadCapabilities } from './readCapabilities'
import { createReviewCapabilities } from './reviewCapabilities'
import { createWorkspaceCapabilities } from './workspaceCapabilities'
import type { ControlRegistry } from './registry'
import type { ReadCapabilityHandlers, ReviewCapabilityHandlers } from './types'
import type { WorkspaceOrchestrationService } from '../workspaceOrchestration/service'

export function bootControlRegistry(
  registry: ControlRegistry,
  reviewHandlers: ReviewCapabilityHandlers,
  readHandlers?: ReadCapabilityHandlers,
  workspaceService?: WorkspaceOrchestrationService
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
}
