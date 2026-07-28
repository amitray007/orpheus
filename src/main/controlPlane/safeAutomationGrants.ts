import type { WorkspaceRecord } from '../../shared/types'
import type { AutomationGrant, AutomationGrantSource } from './automationPolicy'
import type { AutomationScopeBinding, ControlDescription, ControlPermission } from './types'
import { SETTINGS_GET_EFFECTIVE_ID, SETTINGS_PATCH_WORKSPACE_ID } from './settingsResourceService'

type SafeAutomationGrantDeps = {
  getProject: (projectId: string) => { id: string } | null | undefined
  getWorkspace: (workspaceId: string) => WorkspaceRecord | null | undefined
}

const SAFE_OPERATIONS = new Map<
  string,
  Readonly<{
    kind: 'query' | 'mutation'
    permission: ControlPermission
    riskTier: 0 | 1 | 2 | 3
    effects: readonly string[]
    surfaces: readonly ('renderer' | 'command-socket' | 'mcp' | 'automation')[]
    scope: 'workspace'
    inputField: 'workspaceId'
  }>
>([
  [
    SETTINGS_GET_EFFECTIVE_ID,
    {
      kind: 'query',
      permission: 'settings.read',
      riskTier: 0,
      effects: [],
      surfaces: ['mcp', 'automation'],
      scope: 'workspace',
      inputField: 'workspaceId'
    }
  ],
  [
    SETTINGS_PATCH_WORKSPACE_ID,
    {
      kind: 'mutation',
      permission: 'settings.workspace.patch',
      riskTier: 2,
      effects: ['db.write', 'workspace.dirty.recompute'],
      surfaces: ['mcp', 'automation'],
      scope: 'workspace',
      inputField: 'workspaceId'
    }
  ],
  [
    'workspaces.getLineage',
    {
      kind: 'query',
      permission: 'workspaces.read',
      riskTier: 0,
      effects: [],
      surfaces: ['renderer', 'command-socket', 'mcp', 'automation'],
      scope: 'workspace',
      inputField: 'workspaceId'
    }
  ],
  [
    'workspaces.reopen',
    {
      kind: 'mutation',
      permission: 'workspaces.open',
      riskTier: 1,
      effects: ['db.write'],
      surfaces: ['renderer', 'command-socket', 'mcp', 'automation'],
      scope: 'workspace',
      inputField: 'workspaceId'
    }
  ],
  [
    'workspaces.rename',
    {
      kind: 'mutation',
      permission: 'workspaces.rename',
      riskTier: 2,
      effects: ['db.write'],
      surfaces: ['renderer', 'command-socket', 'mcp', 'automation'],
      scope: 'workspace',
      inputField: 'workspaceId'
    }
  ]
])

function sameList(actual: readonly string[] | undefined, expected: readonly string[]): boolean {
  return (
    actual?.length === expected.length &&
    actual.every((effect, index) => effect === expected[index])
  )
}

function descriptorIsSafe(description: ControlDescription): boolean {
  const safe = SAFE_OPERATIONS.get(description.id)
  if (safe == null) return false
  return (
    description.kind === safe.kind &&
    description.permission === safe.permission &&
    description.risk.tier === safe.riskTier &&
    sameList(description.declaredEffects, safe.effects) &&
    sameList(description.allowedSurfaces, safe.surfaces) &&
    description.idempotency === 'natural' &&
    description.scope.kind === safe.scope &&
    description.scope.inputField === safe.inputField
  )
}

function scopeExists(scope: AutomationScopeBinding, deps: SafeAutomationGrantDeps): boolean {
  if (scope.kind !== 'workspace') return false
  const project = deps.getProject(scope.projectId)
  if (project == null || project.id !== scope.projectId) return false
  const workspace = deps.getWorkspace(scope.workspaceId)
  return (
    workspace != null &&
    workspace.id === scope.workspaceId &&
    workspace.projectId === scope.projectId
  )
}

function paramsMatchScope(params: unknown, scope: AutomationScopeBinding): boolean {
  if (params == null || typeof params !== 'object' || Array.isArray(params)) return false
  if (scope.kind !== 'workspace') return false
  const record = params as Record<string, unknown>
  return record['workspaceId'] === undefined || record['workspaceId'] === scope.workspaceId
}

/**
 * Fixed exact-workspace policy for the small set of naturally idempotent
 * operations that explicitly opt into automation. Every descriptor field is
 * matched against server-owned metadata, and the requested scope is
 * re-resolved against main-owned records; definitions cannot carry or widen
 * this grant.
 */
export function createSafeAutomationGrantSource(
  deps: SafeAutomationGrantDeps
): AutomationGrantSource {
  const resolve = ({
    scope,
    description,
    params
  }: Parameters<AutomationGrantSource>[0]): AutomationGrant | null => {
    try {
      const safe = SAFE_OPERATIONS.get(description.id)
      if (
        safe == null ||
        !descriptorIsSafe(description) ||
        !scopeExists(scope, deps) ||
        !paramsMatchScope(params, scope)
      ) {
        return null
      }
      return Object.freeze({
        permissions: Object.freeze([safe.permission]),
        maxRiskTier: safe.riskTier,
        scopes: Object.freeze([Object.freeze({ ...scope })])
      })
    } catch {
      return null
    }
  }
  return Object.freeze(Object.assign(resolve, { supports: descriptorIsSafe }))
}
