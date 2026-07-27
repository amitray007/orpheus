import { createReadCapabilities } from './readCapabilities'
import { createReviewCapabilities } from './reviewCapabilities'
import type { ControlRegistry } from './registry'
import type { ReadCapabilityHandlers, ReviewCapabilityHandlers } from './types'

export function bootControlRegistry(
  registry: ControlRegistry,
  reviewHandlers: ReviewCapabilityHandlers,
  readHandlers?: ReadCapabilityHandlers
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
}
