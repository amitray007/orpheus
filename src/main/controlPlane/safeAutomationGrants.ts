import type { WorkspaceRecord } from '../../shared/types'
import type { AutomationGrant, AutomationGrantSource } from './automationPolicy'
import type { AutomationScopeBinding, ControlDescription, ControlPermission } from './types'
import {
  RESOURCES_LIST_PROJECT_METADATA_ID,
  SETTINGS_GET_EFFECTIVE_ID
} from './settingsResourceService'

type SafeAutomationGrantDeps = {
  getProject: (projectId: string) => { id: string } | null | undefined
  getWorkspace: (workspaceId: string) => WorkspaceRecord | null | undefined
}

const SAFE_OPERATIONS = new Map<
  string,
  Readonly<{ permission: ControlPermission; scope: 'project' | 'workspace' }>
>([
  [SETTINGS_GET_EFFECTIVE_ID, { permission: 'settings.read', scope: 'workspace' }],
  [RESOURCES_LIST_PROJECT_METADATA_ID, { permission: 'resources.read', scope: 'project' }]
])

function descriptorIsSafe(
  description: ControlDescription,
  permission: ControlPermission,
  scope: 'project' | 'workspace'
): boolean {
  return (
    description.kind === 'query' &&
    description.permission === permission &&
    description.risk.tier === 0 &&
    (description.declaredEffects?.length ?? 0) === 0 &&
    description.allowedSurfaces.includes('automation') &&
    description.idempotency === 'natural' &&
    description.scope.kind === scope
  )
}

function scopeExists(scope: AutomationScopeBinding, deps: SafeAutomationGrantDeps): boolean {
  if (scope.kind === 'app') return false
  const project = deps.getProject(scope.projectId)
  if (project == null || project.id !== scope.projectId) return false
  if (scope.kind === 'project') return true
  const workspace = deps.getWorkspace(scope.workspaceId)
  return (
    workspace != null &&
    workspace.id === scope.workspaceId &&
    workspace.projectId === scope.projectId
  )
}

function scopeSupportsOperation(
  scope: AutomationScopeBinding,
  required: 'project' | 'workspace'
): boolean {
  if (required === 'workspace') return scope.kind === 'workspace'
  return scope.kind === 'project' || scope.kind === 'workspace'
}

function paramsMatchScope(
  params: unknown,
  scope: AutomationScopeBinding,
  required: 'project' | 'workspace'
): boolean {
  if (params == null || typeof params !== 'object' || Array.isArray(params)) return false
  const record = params as Record<string, unknown>
  if (required === 'workspace') {
    return (
      scope.kind === 'workspace' &&
      (record['workspaceId'] === undefined || record['workspaceId'] === scope.workspaceId)
    )
  }
  return (
    scope.kind !== 'app' &&
    (record['projectId'] === undefined || record['projectId'] === scope.projectId)
  )
}

/**
 * Fixed Tier-0 policy for the two Phase 6 reads that explicitly opt into
 * automation. The requested scope is re-resolved against main-owned records;
 * definitions cannot carry or widen this grant.
 */
export function createSafeAutomationGrantSource(
  deps: SafeAutomationGrantDeps
): AutomationGrantSource {
  return ({ scope, description, params }): AutomationGrant | null => {
    try {
      const safe = SAFE_OPERATIONS.get(description.id)
      if (
        safe == null ||
        !descriptorIsSafe(description, safe.permission, safe.scope) ||
        !scopeSupportsOperation(scope, safe.scope) ||
        !scopeExists(scope, deps) ||
        !paramsMatchScope(params, scope, safe.scope)
      ) {
        return null
      }
      return Object.freeze({
        permissions: Object.freeze([safe.permission]),
        maxRiskTier: 0,
        scopes: Object.freeze([Object.freeze({ ...scope })])
      })
    } catch {
      return null
    }
  }
}
