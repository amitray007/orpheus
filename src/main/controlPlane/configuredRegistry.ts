import type { WorkspaceOrchestrationService } from '../workspaceOrchestration/service'
import { ControlRegistry } from './registry'
import type { ControlAuthorizationPolicy } from './types'
import { createWorkspaceRejectionAuditor } from './workspaceCapabilities'
import { withWorkspaceMutationPolicy } from './workspacePolicy'
import { withAutomationPolicy } from './automationPolicy'

export function createConfiguredControlRegistry(config: {
  authorization: ControlAuthorizationPolicy
  workspaceOrchestration?: WorkspaceOrchestrationService
}): ControlRegistry {
  const workspaceService = config.workspaceOrchestration
  if (workspaceService == null) {
    return new ControlRegistry(withAutomationPolicy(config.authorization))
  }
  return new ControlRegistry(
    withAutomationPolicy(withWorkspaceMutationPolicy(config.authorization)),
    createWorkspaceRejectionAuditor(workspaceService)
  )
}
