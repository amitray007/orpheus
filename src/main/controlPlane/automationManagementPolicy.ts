import { isAutomationManagementOperation } from './automationManagementCapabilities'
import type { AutomationManagementService } from './automationManagementService'
import type { ControlAuthorizationPolicy, ControlRejectionAuditor } from './types'

export function withAutomationManagementPolicy(
  base: ControlAuthorizationPolicy,
  service: Pick<AutomationManagementService, 'authorize' | 'canDiscover'>
): ControlAuthorizationPolicy {
  return {
    canDiscover(description, context) {
      if (context.consumer !== 'mcp' || !isAutomationManagementOperation(description.id)) {
        return base.canDiscover(description, context)
      }
      return service.canDiscover(context)
    },
    authorize(description, input, context) {
      if (context.consumer !== 'mcp' || !isAutomationManagementOperation(description.id)) {
        return base.authorize(description, input, context)
      }
      return service.authorize(description.id, input, context)
    }
  }
}

export function createAutomationManagementRejectionAuditor(
  service: Pick<AutomationManagementService, 'auditRejected'>
): ControlRejectionAuditor {
  return {
    auditRejected: (input) =>
      service.auditRejected({
        operationId: input.description.id,
        params: input.params,
        context: input.context,
        code: input.code
      })
  }
}
