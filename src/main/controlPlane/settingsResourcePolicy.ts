import type {
  ControlAuthorizationDecision,
  ControlAuthorizationPolicy,
  ControlDescription
} from './types'
import {
  SETTINGS_RESOURCE_OPERATION_IDS,
  type SettingsResourceService
} from './settingsResourceService'

const PHASE6_OPERATIONS = new Set<string>(SETTINGS_RESOURCE_OPERATION_IDS)
const ALLOW = { allowed: true } as const
const NOT_FOUND = {
  allowed: false,
  code: 'not_found',
  error: 'Requested resource was not found.'
} as const

function isPhase6(description: ControlDescription): boolean {
  return PHASE6_OPERATIONS.has(description.id)
}

function deny(error: string): ControlAuthorizationDecision {
  return { allowed: false, code: 'forbidden', error }
}

export function withSettingsResourcePolicy(
  base: ControlAuthorizationPolicy,
  service: SettingsResourceService
): ControlAuthorizationPolicy {
  return {
    canDiscover(description, context) {
      if (!isPhase6(description)) return base.canDiscover(description, context)
      if (context.consumer !== 'mcp') return false
      const binding = context.trustedRuntime
      return (
        binding != null &&
        binding.workspaceId != null &&
        binding.projectId != null &&
        binding.permissions.includes(description.permission)
      )
    },
    authorize(description, input, context) {
      if (!isPhase6(description)) return base.authorize(description, input, context)
      const binding = context.trustedRuntime
      if (context.consumer !== 'mcp' || binding == null) {
        return deny('A trusted runtime lease is required.')
      }
      if (!binding.permissions.includes(description.permission)) {
        return deny(`Permission denied: ${description.permission}`)
      }
      return service.targetAllowed(description.id, input, context) ? ALLOW : NOT_FOUND
    }
  }
}
