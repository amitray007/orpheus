import type { WorkspaceOrchestrationService } from '../workspaceOrchestration/service'
import { ControlRegistry } from './registry'
import type { ControlAuthorizationPolicy, ControlRejectionAuditor } from './types'
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
import { withAutomationPolicy } from './automationPolicy'
import { withControlToolExposurePolicy, type ControlToolExposureStore } from './controlToolExposure'
import {
  createReviewMutationRejectionAuditor,
  type ReviewMutationService,
  withReviewMutationPolicy
} from './reviewMutation'

const SETTINGS_RESOURCE_OPERATIONS = new Set<string>(SETTINGS_RESOURCE_OPERATION_IDS)
const REVIEW_MUTATION_OPERATION = 'reviews.setResolved'

export function createConfiguredControlRegistry(config: {
  authorization: ControlAuthorizationPolicy
  workspaceOrchestration?: WorkspaceOrchestrationService
  workbenchControl?: WorkbenchControlService
  terminalObservation?: TerminalObservationService
  settingsResources?: SettingsResourceService
  toolExposure?: Pick<ControlToolExposureStore, 'isEnabled'>
  reviewMutations?: ReviewMutationService
}): ControlRegistry {
  const workspaceService = config.workspaceOrchestration
  const settingsService = config.settingsResources
  const reviewService = config.reviewMutations
  const reviewPolicy =
    reviewService == null
      ? config.authorization
      : withReviewMutationPolicy(config.authorization, reviewService)
  const terminalPolicy =
    config.terminalObservation == null
      ? reviewPolicy
      : withTerminalObservationPolicy(reviewPolicy, config.terminalObservation)
  const workspacePolicy =
    workspaceService == null ? terminalPolicy : withWorkspaceMutationPolicy(terminalPolicy)
  const settingsPolicy =
    settingsService == null
      ? workspacePolicy
      : withSettingsResourcePolicy(workspacePolicy, settingsService)
  const automationPolicy = withAutomationPolicy(withWorkbenchControlPolicy(settingsPolicy))
  const authorization =
    config.toolExposure == null
      ? automationPolicy
      : withControlToolExposurePolicy(automationPolicy, config.toolExposure)

  const workspaceAuditor =
    workspaceService == null ? null : createWorkspaceRejectionAuditor(workspaceService)
  const settingsAuditor =
    settingsService == null ? null : createSettingsResourceRejectionAuditor(settingsService)
  const reviewAuditor =
    reviewService == null ? null : createReviewMutationRejectionAuditor(reviewService)
  let rejectionAuditor: ControlRejectionAuditor | undefined
  if (workspaceAuditor != null || settingsAuditor != null || reviewAuditor != null) {
    rejectionAuditor = {
      auditRejected(input) {
        if (input.description.id === REVIEW_MUTATION_OPERATION) {
          return reviewAuditor?.auditRejected(input)
        }
        return SETTINGS_RESOURCE_OPERATIONS.has(input.description.id)
          ? settingsAuditor?.auditRejected(input)
          : workspaceAuditor?.auditRejected(input)
      }
    }
  }
  return new ControlRegistry(authorization, rejectionAuditor)
}
