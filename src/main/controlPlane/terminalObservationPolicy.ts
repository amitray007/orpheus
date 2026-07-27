import type { ControlAuthorizationPolicy, ControlContext, ControlDescription } from './types'
import type { TerminalObservationService } from '../terminalObservation/service'

const ALLOW = { allowed: true } as const
const NOT_FOUND = {
  allowed: false,
  code: 'not_found',
  error: 'Requested resource was not found.'
} as const

function hasTerminalGrant(description: ControlDescription, context: ControlContext): boolean {
  const binding = context.trustedRuntime
  return (
    binding != null &&
    description.permission === 'terminals.read' &&
    description.kind === 'query' &&
    description.risk.tier === 0 &&
    binding.permissions.includes('terminals.read')
  )
}

export function withTerminalObservationPolicy(
  base: ControlAuthorizationPolicy,
  service: TerminalObservationService
): ControlAuthorizationPolicy {
  return {
    canDiscover: (description, context) => {
      if (description.permission !== 'terminals.read') {
        return base.canDiscover(description, context)
      }
      return context.consumer === 'mcp' && hasTerminalGrant(description, context)
    },
    authorize: (description, input, context) => {
      if (description.permission !== 'terminals.read') {
        return base.authorize(description, input, context)
      }
      if (context.consumer !== 'mcp' || !hasTerminalGrant(description, context)) {
        return {
          allowed: false,
          code: 'forbidden',
          error: 'Permission denied: terminals.read'
        }
      }
      return service.isInputAuthorized(input, context) ? ALLOW : NOT_FOUND
    }
  }
}
