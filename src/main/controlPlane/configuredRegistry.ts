import type { WorkspaceOrchestrationService } from '../workspaceOrchestration/service'
import { ControlRegistry } from './registry'
import type {
  ControlAuthorizationPolicy,
  ControlRejectionAuditor
} from './types'
import { createWorkspaceRejectionAuditor } from './workspaceCapabilities'
import { withWorkspaceMutationPolicy } from './workspacePolicy'
import { withWorkbenchControlPolicy } from './workbenchPolicy'
import { withTerminalObservationPolicy } from './terminalObservationPolicy'
import type { TerminalObservationService } from '../terminalObservation/service'
import type { WorkbenchControlService } from '../workbenchControl/service'
import { createSettingsResourceRejectionAuditor } from './settingsResourceCapabilities'
import {
  SETTINGS_RESOURCE_OPERATION_IDS,
  type SettingsResourceService
} from './settingsResourceService'
import { withSettingsResourcePolicy } from './settingsResourcePolicy'

const SETTINGS_RESOURCE_OPERATIONS = new Set<string>(SETTINGS_RESOURCE_OPERATION_IDS)

export function createConfiguredControlRegistry(config: {
  authorization: ControlAuthorizationPolicy
  workspaceOrchestration?: WorkspaceOrchestrationService
  workbenchControl?: WorkbenchControlService
  terminalObservation?: TerminalObservationService
  settingsResources?: SettingsResourceService
}): ControlRegistry {
  const workspaceService = config.workspaceOrchestration
  const settingsService = config.settingsResources
  const terminalPolicy =
    config.terminalObservation == null
      ? config.authorization
      : withTerminalObservationPolicy(config.authorization, config.terminalObservation)
  const workspacePolicy =
    workspaceService == null ? terminalPolicy : withWorkspaceMutationPolicy(terminalPolicy)
  const settingsPolicy =
    settingsService == null
      ? workspacePolicy
      : withSettingsResourcePolicy(workspacePolicy, settingsService)
  const authorization = withWorkbenchControlPolicy(settingsPolicy)

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
