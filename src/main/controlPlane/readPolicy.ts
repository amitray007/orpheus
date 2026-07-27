import type {
  ControlAuthorizationDecision,
  ControlAuthorizationPolicy,
  ControlContext,
  ControlDescription,
  TrustedRuntimeBinding
} from './types'

const ALLOW = { allowed: true } as const
const RESOURCE_NOT_FOUND = {
  allowed: false,
  code: 'not_found',
  error: 'Requested resource was not found.'
} as const

export type TrustedRuntimeReadPolicyDeps = {
  getWorkspaceProjectId: (workspaceId: string) => string | null | Promise<string | null>
}

function trustedBinding(context: ControlContext): TrustedRuntimeBinding | null {
  return context.trustedRuntime ?? null
}

function hasPermission(description: ControlDescription, binding: TrustedRuntimeBinding): boolean {
  return binding.permissions.includes(description.permission)
}

function inputString(input: unknown, field: string): string | null {
  if (input == null || typeof input !== 'object') return null
  const value = (input as Record<string, unknown>)[field]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function discoveryHasDefault(
  description: ControlDescription,
  binding: TrustedRuntimeBinding
): boolean {
  if (description.scope.kind === 'self' || description.scope.kind === 'resource') return true
  if (description.scope.kind === 'project') return binding.projectId != null
  return binding.workspaceId != null && binding.projectId != null
}

function denyForbidden(error: string): ControlAuthorizationDecision {
  return { allowed: false, code: 'forbidden', error }
}

async function authorizeMcpRead(
  deps: TrustedRuntimeReadPolicyDeps,
  description: ControlDescription,
  input: unknown,
  context: ControlContext
): Promise<ControlAuthorizationDecision> {
  const binding = trustedBinding(context)
  if (binding == null) return denyForbidden('A trusted runtime lease is required.')
  if (description.kind !== 'query' || description.risk.tier !== 0) {
    return denyForbidden('Only Tier 0 queries are available through the Phase 2 MCP surface.')
  }
  if (!hasPermission(description, binding)) {
    return denyForbidden(`Permission denied: ${description.permission}`)
  }

  if (description.scope.kind === 'self' || description.scope.kind === 'resource') return ALLOW

  const targetField =
    description.scope.inputField ??
    (description.scope.kind === 'project' ? 'projectId' : 'workspaceId')
  const explicitTarget = inputString(input, targetField)

  if (description.scope.kind === 'project') {
    const targetProjectId = explicitTarget ?? binding.projectId
    return targetProjectId != null && targetProjectId === binding.projectId
      ? ALLOW
      : RESOURCE_NOT_FOUND
  }

  const targetWorkspaceId = explicitTarget ?? binding.workspaceId
  if (targetWorkspaceId == null || binding.projectId == null) return RESOURCE_NOT_FOUND
  const targetProjectId = await deps.getWorkspaceProjectId(targetWorkspaceId)
  return targetProjectId === binding.projectId ? ALLOW : RESOURCE_NOT_FOUND
}

export function createTrustedRuntimeReadPolicy(
  deps: TrustedRuntimeReadPolicyDeps
): ControlAuthorizationPolicy {
  return {
    canDiscover: (description, context) => {
      if (context.consumer !== 'mcp') return true
      const binding = trustedBinding(context)
      return (
        binding != null &&
        description.kind === 'query' &&
        description.risk.tier === 0 &&
        hasPermission(description, binding) &&
        discoveryHasDefault(description, binding)
      )
    },
    authorize: (description, input, context) => {
      if (context.consumer !== 'mcp') return ALLOW
      return authorizeMcpRead(deps, description, input, context)
    }
  }
}
