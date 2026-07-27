import type { WorkspaceOrchestrationService } from '../workspaceOrchestration/service'
import { ControlRegistry } from './registry'
import type { ControlAuthorizationPolicy } from './types'
import { createWorkspaceRejectionAuditor } from './workspaceCapabilities'
import { withWorkspaceMutationPolicy } from './workspacePolicy'
import { withWorkbenchControlPolicy } from './workbenchPolicy'

export function createConfiguredControlRegistry(config: {
  authorization: ControlAuthorizationPolicy
  workspaceOrchestration?: WorkspaceOrchestrationService
}): ControlRegistry {
  const workspaceService = config.workspaceOrchestration
  const policy = withWorkbenchControlPolicy(
    workspaceService == null
      ? config.authorization
      : withWorkspaceMutationPolicy(config.authorization)
  )
  if (workspaceService == null) return new ControlRegistry(policy)
  return new ControlRegistry(policy, createWorkspaceRejectionAuditor(workspaceService))
}
