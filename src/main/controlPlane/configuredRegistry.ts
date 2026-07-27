import type { WorkspaceOrchestrationService } from '../workspaceOrchestration/service'
import { ControlRegistry } from './registry'
import type { ControlAuthorizationPolicy } from './types'
import { createWorkspaceRejectionAuditor } from './workspaceCapabilities'
import { withWorkspaceMutationPolicy } from './workspacePolicy'
import { withWorkbenchControlPolicy } from './workbenchPolicy'
import { withTerminalObservationPolicy } from './terminalObservationPolicy'
import type { TerminalObservationService } from '../terminalObservation/service'
import type { WorkbenchControlService } from '../workbenchControl/service'

export function createConfiguredControlRegistry(config: {
  authorization: ControlAuthorizationPolicy
  workspaceOrchestration?: WorkspaceOrchestrationService
  workbenchControl?: WorkbenchControlService
  terminalObservation?: TerminalObservationService
}): ControlRegistry {
  const workspaceService = config.workspaceOrchestration
  const authorization =
    config.terminalObservation == null
      ? config.authorization
      : withTerminalObservationPolicy(config.authorization, config.terminalObservation)
  const policy = withWorkbenchControlPolicy(
    workspaceService == null ? authorization : withWorkspaceMutationPolicy(authorization)
  )
  if (workspaceService == null) return new ControlRegistry(policy)
  return new ControlRegistry(policy, createWorkspaceRejectionAuditor(workspaceService))
}
