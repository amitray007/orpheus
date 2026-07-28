import type { ClaudeRuntimeBinding } from './runtimeLeases'
import type { ControlPermission, TrustedRuntimeBinding } from './types'

export type RuntimeControlGrant = Readonly<{
  permissions: readonly ControlPermission[]
  maxRiskTier: 0 | 1 | 2 | 3
  scope?: Readonly<{
    selfOnly: true
    layoutIds?: readonly string[]
    surfaceIds?: readonly string[]
  }>
}>

export type RuntimeControlGrantSource = (
  binding: ClaudeRuntimeBinding
) => RuntimeControlGrant | null | undefined

export const BASE_RUNTIME_CONTROL_PERMISSIONS = Object.freeze([
  'identity.read',
  'projects.read',
  'workspaces.read',
  'workspaces.wait',
  'reviews.read'
] satisfies ControlPermission[])

export const DEFAULT_RUNTIME_CONTROL_PERMISSIONS = Object.freeze([
  'identity.read',
  'projects.read',
  'workspaces.read',
  'workspaces.create',
  'workspaces.open',
  'workspaces.send',
  'workspaces.wait',
  'workspaces.close',
  'workspaces.rename',
  'workspaces.archive',
  'terminals.read',
  'reviews.read',
  'reviews.resolve',
  'ui.workbench.control',
  'terminals.control',
  'settings.read',
  'settings.workspace.patch',
  'resources.read'
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
  'terminals.read': 0,
  'reviews.read': 0,
  'reviews.resolve': 2,
  'ui.workbench.control': 1,
  'terminals.control': 2,
  'settings.read': 0,
  'settings.workspace.patch': 2,
  'resources.read': 0
}

export type RuntimeControlGrantPolicyOptions = Readonly<{
  getCurrentBinding?: (runtimeId: string) => ClaudeRuntimeBinding | null
  getResourceScope?: (
    binding: ClaudeRuntimeBinding
  ) => TrustedRuntimeBinding['resourceScope'] | null | undefined
}>

function isLive(binding: ClaudeRuntimeBinding): boolean {
  return (
    binding.runtimeKind === 'claude' &&
    binding.state === 'live' &&
    binding.pid != null &&
    Number.isSafeInteger(binding.pid) &&
    binding.pid > 0
  )
}

function sameLiveBinding(
  expected: ClaudeRuntimeBinding,
  current: ClaudeRuntimeBinding | null
): current is ClaudeRuntimeBinding {
  return (
    current != null &&
    isLive(current) &&
    current.runtimeId === expected.runtimeId &&
    current.surfaceId === expected.surfaceId &&
    current.workspaceId === expected.workspaceId &&
    current.projectId === expected.projectId &&
    current.claudeConversationId === expected.claudeConversationId &&
    current.parentWorkspaceId === expected.parentWorkspaceId &&
    current.forkedFromConversationId === expected.forkedFromConversationId &&
    current.issuedAt === expected.issuedAt &&
    current.pid === expected.pid
  )
}

const EMPTY_PERMISSIONS = Object.freeze([]) as readonly ControlPermission[]
const EMPTY_SCOPE = Object.freeze({
  selfOnly: true as const,
  layoutIds: Object.freeze([]),
  surfaceIds: Object.freeze([])
})

/**
 * Live Orpheus-managed Claude runtimes receive the complete registered
 * permission vocabulary by default. The bearer lease is still the authority:
 * pending, dead, rotated, revoked, or mismatched bindings receive nothing.
 *
 * `source` remains an explicit restricted-grant seam for offline QA and
 * bounded integrations. Production does not inject it.
 */
export class RuntimeControlGrantPolicy {
  constructor(
    private readonly source?: RuntimeControlGrantSource,
    private readonly options: RuntimeControlGrantPolicyOptions = {}
  ) {}

  permissionsFor(binding: ClaudeRuntimeBinding): readonly ControlPermission[] {
    const current = this.resolveLive(binding)
    if (current == null) return EMPTY_PERMISSIONS
    if (this.source == null) return DEFAULT_RUNTIME_CONTROL_PERMISSIONS

    let grant: RuntimeControlGrant | null | undefined
    try {
      grant = this.source(current)
    } catch {
      return EMPTY_PERMISSIONS
    }
    if (grant == null) return BASE_RUNTIME_CONTROL_PERMISSIONS
    const permissions = new Set<ControlPermission>(BASE_RUNTIME_CONTROL_PERMISSIONS)
    for (const permission of grant.permissions) {
      if (PERMISSION_RISK_TIER[permission] <= grant.maxRiskTier) permissions.add(permission)
    }
    return Object.freeze([...permissions])
  }

  scopeFor(binding: ClaudeRuntimeBinding): TrustedRuntimeBinding['resourceScope'] {
    const current = this.resolveLive(binding)
    if (current == null) return EMPTY_SCOPE

    let scope: RuntimeControlGrant['scope'] | null | undefined
    if (this.source == null) {
      try {
        scope = this.options.getResourceScope?.(current)
      } catch {
        return EMPTY_SCOPE
      }
    } else {
      try {
        scope = this.source(current)?.scope
      } catch {
        return EMPTY_SCOPE
      }
    }
    return Object.freeze({
      selfOnly: true,
      layoutIds: Object.freeze([...(scope?.layoutIds ?? [])]),
      surfaceIds: Object.freeze([...(scope?.surfaceIds ?? [])])
    })
  }

  private resolveLive(binding: ClaudeRuntimeBinding): ClaudeRuntimeBinding | null {
    if (!isLive(binding)) return null
    const getCurrentBinding = this.options.getCurrentBinding
    if (getCurrentBinding == null) return binding
    try {
      const current = getCurrentBinding(binding.runtimeId)
      return sameLiveBinding(binding, current) ? current : null
    } catch {
      return null
    }
  }
}
