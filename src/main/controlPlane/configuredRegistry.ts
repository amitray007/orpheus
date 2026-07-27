import type { WorkspaceOrchestrationService } from '../workspaceOrchestration/service'
import { ControlRegistry } from './registry'
import type { ControlAuthorizationPolicy } from './types'
import { createWorkspaceRejectionAuditor } from './workspaceCapabilities'
import { withWorkspaceMutationPolicy } from './workspacePolicy'
import { withTerminalObservationPolicy } from './terminalObservationPolicy'
import type { TerminalObservationService } from '../terminalObservation/service'

export function createConfiguredControlRegistry(config: {
  authorization: ControlAuthorizationPolicy
  workspaceOrchestration?: WorkspaceOrchestrationService
  terminalObservation?: TerminalObservationService
}): ControlRegistry {
  const workspaceService = config.workspaceOrchestration
  const authorization =
    config.terminalObservation == null
      ? config.authorization
      : withTerminalObservationPolicy(config.authorization, config.terminalObservation)
  if (workspaceService == null) return new ControlRegistry(authorization)
  return new ControlRegistry(
    withWorkspaceMutationPolicy(authorization),
    createWorkspaceRejectionAuditor(workspaceService)
  )
}
