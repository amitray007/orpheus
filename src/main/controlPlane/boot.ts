import { createReadCapabilities } from './readCapabilities'
import { createReviewCapabilities } from './reviewCapabilities'
import { createWorkspaceCapabilities } from './workspaceCapabilities'
import { createTerminalObservationCapabilities } from './terminalObservationCapabilities'
import { createSettingsResourceCapabilities } from './settingsResourceCapabilities'
import type { ControlRegistry } from './registry'
import type { ControlDescriptor, ReadCapabilityHandlers, ReviewCapabilityHandlers } from './types'
import type { TerminalObservationHandlers } from '../terminalObservation/types'
import type { WorkspaceOrchestrationService } from '../workspaceOrchestration/service'
import type { WorkbenchControlService } from '../workbenchControl/service'
import { createWorkbenchCapabilities } from './workbenchCapabilities'
import type { SettingsResourceService } from './settingsResourceService'
import type { ReviewMutationService } from './reviewMutation'
import { createAutomationManagementCapabilities } from './automationManagementCapabilities'
import type { AutomationManagementService } from './automationManagementService'

export function bootControlRegistry(
  registry: ControlRegistry,
  reviewHandlers: ReviewCapabilityHandlers,
  readHandlers?: ReadCapabilityHandlers,
  workspaceService?: WorkspaceOrchestrationService,
  workbenchService?: WorkbenchControlService,
  terminalObservationHandlers?: TerminalObservationHandlers,
  settingsResourceService?: SettingsResourceService,
  reviewMutationService?: ReviewMutationService,
  automationManagementService?: AutomationManagementService
): void {
  const [listCapability, setResolvedCapability] = createReviewCapabilities(reviewHandlers, {
    mcpRead: readHandlers != null,
    mcpMutation: reviewMutationService
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
  if (workbenchService != null) {
    for (const capability of createWorkbenchCapabilities(
      workbenchService
    ) as readonly ControlDescriptor<unknown, unknown>[]) {
      registry.register(capability)
    }
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
  if (settingsResourceService != null) {
    const [effective, patch, resources] =
      createSettingsResourceCapabilities(settingsResourceService)
    registry.register(effective)
    registry.register(patch)
    registry.register(resources)
  }
  if (automationManagementService != null) {
    for (const capability of createAutomationManagementCapabilities(automationManagementService)) {
      registry.register(capability)
    }
  }
}
