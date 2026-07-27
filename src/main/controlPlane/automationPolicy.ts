import type {
  AutomationScopeBinding,
  ControlAuthorizationDecision,
  ControlAuthorizationPolicy,
  ControlDescription,
  ControlPermission,
  TrustedAutomationBinding
} from './types'

const ALLOW = { allowed: true } as const

function deny(error: string): ControlAuthorizationDecision {
  return { allowed: false, code: 'forbidden', error }
}

function bindingCoversDescriptor(
  binding: TrustedAutomationBinding,
  description: ControlDescription
): boolean {
  if (description.scope.kind === 'self') return binding.scope.kind === 'workspace'
  if (description.scope.kind === 'project') return binding.scope.kind !== 'app'
  if (description.scope.kind === 'workspace') return binding.scope.kind === 'workspace'
  return binding.scope.kind === 'app'
}

function targetMatchesBinding(
  description: ControlDescription,
  input: unknown,
  binding: TrustedAutomationBinding
): boolean {
  const field = 'inputField' in description.scope ? description.scope.inputField : undefined
  if (field == null || input == null || typeof input !== 'object' || Array.isArray(input)) {
    return true
  }
  const target = (input as Record<string, unknown>)[field]
  if (target == null) return true
  if (description.scope.kind === 'project') {
    return (
      binding.scope.kind !== 'app' &&
      typeof target === 'string' &&
      target === binding.scope.projectId
    )
  }
  if (description.scope.kind === 'workspace' || description.scope.kind === 'self') {
    if (binding.scope.kind !== 'workspace') return false
    const workspaceId = binding.scope.workspaceId
    return Array.isArray(target)
      ? target.every((value) => value === workspaceId)
      : target === workspaceId
  }
  return binding.scope.kind === 'app'
}

function canUse(
  description: ControlDescription,
  binding: TrustedAutomationBinding,
  input?: unknown
): boolean {
  return (
    binding.permissions.includes(description.permission) &&
    description.risk.tier <= binding.maxRiskTier &&
    bindingCoversDescriptor(binding, description) &&
    (input === undefined || targetMatchesBinding(description, input, binding))
  )
}

/**
 * Automation calls never inherit the compatibility policy used by renderer or
 * command-socket callers. A trusted binding is required for discovery and
 * invocation, and it is resolved from a server-owned grant immediately before
 * every attempt.
 */
export function withAutomationPolicy(base: ControlAuthorizationPolicy): ControlAuthorizationPolicy {
  return {
    canDiscover(description, context) {
      if (context.consumer !== 'automation') return base.canDiscover(description, context)
      const binding = context.trustedAutomation
      return binding != null && canUse(description, binding)
    },
    authorize(description, input, context) {
      if (context.consumer !== 'automation') return base.authorize(description, input, context)
      const binding = context.trustedAutomation
      if (binding == null) return deny('A trusted automation grant is required.')
      if (!binding.permissions.includes(description.permission)) {
        return deny(`Permission denied: ${description.permission}`)
      }
      if (description.risk.tier > binding.maxRiskTier) {
        return deny('The automation grant does not allow this risk tier.')
      }
      if (
        !bindingCoversDescriptor(binding, description) ||
        !targetMatchesBinding(description, input, binding)
      ) {
        return deny('The automation grant does not cover this operation scope.')
      }
      return ALLOW
    }
  }
}

export type AutomationGrant = Readonly<{
  permissions: readonly ControlPermission[]
  maxRiskTier: 0 | 1 | 2 | 3
  scopes: readonly AutomationScopeBinding[]
}>

export type AutomationGrantSource = (
  automationId: string
) => AutomationGrant | null | undefined | Promise<AutomationGrant | null | undefined>

function scopeContains(
  allowed: AutomationScopeBinding,
  requested: AutomationScopeBinding
): boolean {
  if (allowed.kind === 'app') return true
  if (requested.kind === 'app' || allowed.projectId !== requested.projectId) return false
  if (allowed.kind === 'project') return true
  return requested.kind === 'workspace' && allowed.workspaceId === requested.workspaceId
}

export class AutomationGrantPolicy {
  constructor(private readonly source?: AutomationGrantSource) {}

  async resolve(
    automationId: string,
    scope: AutomationScopeBinding,
    description: ControlDescription,
    input?: unknown
  ): Promise<TrustedAutomationBinding | null> {
    const grant = await this.source?.(automationId)
    if (
      grant == null ||
      !grant.permissions.includes(description.permission) ||
      description.risk.tier > grant.maxRiskTier ||
      !grant.scopes.some((allowed) => scopeContains(allowed, scope))
    ) {
      return null
    }
    const binding: TrustedAutomationBinding = {
      automationId,
      scope: Object.freeze({ ...scope }),
      permissions: Object.freeze([...grant.permissions]),
      maxRiskTier: grant.maxRiskTier
    }
    const frozen = Object.freeze(binding)
    return input === undefined || canUse(description, frozen, input) ? frozen : null
  }
}
