import type { WorkspaceOrchestrationService } from '../workspaceOrchestration/service'
import { ControlRegistry } from './registry'
import type { ControlAuthorizationPolicy } from './types'
import { createWorkspaceRejectionAuditor } from './workspaceCapabilities'
import { withWorkspaceMutationPolicy } from './workspacePolicy'
import { createSettingsResourceRejectionAuditor } from './settingsResourceCapabilities'
import {
  SETTINGS_RESOURCE_OPERATION_IDS,
  type SettingsResourceService
} from './settingsResourceService'
import { withSettingsResourcePolicy } from './settingsResourcePolicy'
import type { ControlRejectionAuditor } from './types'

const SETTINGS_RESOURCE_OPERATIONS = new Set<string>(SETTINGS_RESOURCE_OPERATION_IDS)

export function createConfiguredControlRegistry(config: {
  authorization: ControlAuthorizationPolicy
  workspaceOrchestration?: WorkspaceOrchestrationService
  settingsResources?: SettingsResourceService
}): ControlRegistry {
  const workspaceService = config.workspaceOrchestration
  const settingsService = config.settingsResources
  const workspacePolicy =
    workspaceService == null
      ? config.authorization
      : withWorkspaceMutationPolicy(config.authorization)
  const authorization =
    settingsService == null
      ? workspacePolicy
      : withSettingsResourcePolicy(workspacePolicy, settingsService)

  const workspaceAuditor =
    workspaceService == null ? null : createWorkspaceRejectionAuditor(workspaceService)
  const settingsAuditor =
    settingsService == null ? null : createSettingsResourceRejectionAuditor(settingsService)
  let rejectionAuditor: ControlRejectionAuditor | undefined
  if (workspaceAuditor != null || settingsAuditor != null) {
    rejectionAuditor = {
      auditRejected(input) {
        return SETTINGS_RESOURCE_OPERATIONS.has(input.description.id)
          ? settingsAuditor?.auditRejected(input)
          : workspaceAuditor?.auditRejected(input)
      }
    }
  }
  return new ControlRegistry(authorization, rejectionAuditor)
}
