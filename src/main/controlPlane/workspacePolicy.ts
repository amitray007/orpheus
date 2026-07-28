import { WORKSPACE_OPERATION_IDS } from './workspaceCapabilities'
import type {
  ControlAuthorizationDecision,
  ControlAuthorizationPolicy,
  ControlDescription
} from './types'

const WORKSPACE_OPERATIONS = new Set<string>(WORKSPACE_OPERATION_IDS)
const ALLOW = { allowed: true } as const

function isPhase3WorkspaceOperation(description: ControlDescription): boolean {
  return WORKSPACE_OPERATIONS.has(description.id)
}

function deny(error: string): ControlAuthorizationDecision {
  return { allowed: false, code: 'forbidden', error }
}

/**
 * Adds the frozen Phase 3 mutation/query vocabulary to an existing Phase 2
 * policy. Target existence, project membership, lineage, self-action, and
 * effect authorization are deliberately revalidated by the orchestration
 * service immediately before effects.
 */
export function withWorkspaceMutationPolicy(
  base: ControlAuthorizationPolicy
): ControlAuthorizationPolicy {
  return {
    canDiscover(description, context) {
      if (!isPhase3WorkspaceOperation(description)) {
        return base.canDiscover(description, context)
      }
      if (context.consumer !== 'mcp') return true
      const binding = context.trustedRuntime
      return (
        binding != null &&
        binding.projectId != null &&
        binding.workspaceId != null &&
        binding.permissions.includes(description.permission)
      )
    },
    authorize(description, input, context) {
      if (!isPhase3WorkspaceOperation(description)) {
        return base.authorize(description, input, context)
      }
      if (context.consumer !== 'mcp') return ALLOW
      const binding = context.trustedRuntime
      if (binding == null) return deny('A trusted runtime lease is required.')
      if (!binding.permissions.includes(description.permission)) {
        return deny(`Permission denied: ${description.permission}`)
      }
      if (binding.projectId == null || binding.workspaceId == null) {
        return deny('The trusted runtime has no workspace project binding.')
      }
      return ALLOW
    }
  }
}
