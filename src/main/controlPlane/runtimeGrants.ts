import type { ClaudeRuntimeBinding } from './runtimeLeases'
import type { ControlPermission } from './types'

export type RuntimeControlGrant = Readonly<{
  permissions: readonly ControlPermission[]
  maxRiskTier: 0 | 1 | 2 | 3
}>

export type RuntimeControlGrantSource = (
  binding: ClaudeRuntimeBinding
) => RuntimeControlGrant | null | undefined

export const DEFAULT_RUNTIME_CONTROL_PERMISSIONS = Object.freeze([
  'identity.read',
  'projects.read',
  'workspaces.read',
  'workspaces.wait',
  'reviews.read'
] satisfies ControlPermission[])

const PERMISSION_RISK_TIER: Readonly<Record<ControlPermission, 0 | 1 | 2 | 3>> = {
  'identity.read': 0,
  'projects.read': 0,
  'workspaces.read': 0,
  'workspaces.create': 2,
  'workspaces.open': 1,
  'workspaces.send': 2,
  'workspaces.wait': 0,
  'workspaces.close': 2,
  'workspaces.rename': 2,
  'workspaces.archive': 3,
  'reviews.read': 0,
  'reviews.resolve': 2
}

/**
 * Server-owned grant seam. Runtime metadata is never authority: without an
 * injected grant source, only read/wait capabilities are exposed.
 */
export class RuntimeControlGrantPolicy {
  constructor(private readonly source?: RuntimeControlGrantSource) {}

  permissionsFor(binding: ClaudeRuntimeBinding): readonly ControlPermission[] {
    const grant = this.source?.(binding)
    if (grant == null) return DEFAULT_RUNTIME_CONTROL_PERMISSIONS
    const permissions = new Set<ControlPermission>(DEFAULT_RUNTIME_CONTROL_PERMISSIONS)
    for (const permission of grant.permissions) {
      if (PERMISSION_RISK_TIER[permission] <= grant.maxRiskTier) permissions.add(permission)
    }
    return Object.freeze([...permissions])
  }
}
