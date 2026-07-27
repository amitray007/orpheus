import type { ClaudeRuntimeBinding } from './runtimeLeases'
import type { RuntimeControlGrant, RuntimeControlGrantSource } from './runtimeGrants'
import type { ControlPermission } from './types'

const DEV_APP_NAME = 'Orpheus Dev'
const MAX_ID_LENGTH = 128

export const PHASE456_QA_PERMISSIONS = Object.freeze([
  'ui.workbench.control',
  'terminals.control',
  'terminals.read',
  'settings.read',
  'settings.workspace.patch',
  'resources.read'
] satisfies ControlPermission[])

export type Phase456QaScope = Readonly<{
  projectId: string
  workspaceId: string
  layoutId: string
  terminalId: string
}>

export type Phase456QaGrantSourceOptions = Readonly<{
  flagValue: string | undefined
  scopeValue: string | undefined
  appName: string
  getRuntimeBinding: (runtimeId: string) => ClaudeRuntimeBinding | null
  getWorkspaceProjectId: (workspaceId: string) => string | null
  hasPaneTerminal: (layoutId: string, terminalId: string) => boolean
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_ID_LENGTH &&
    value.trim() === value
  )
}

export function phase456QaGrantEnabled(flagValue: string | undefined, appName: string): boolean {
  return flagValue === '1' && appName === DEV_APP_NAME
}

export function parsePhase456QaScope(value: string | undefined): Phase456QaScope | null {
  if (value == null || value.length === 0) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null

  const keys = Object.keys(parsed)
  if (
    keys.length !== 4 ||
    !keys.every((key) => ['projectId', 'workspaceId', 'layoutId', 'terminalId'].includes(key)) ||
    !isId(parsed['projectId']) ||
    !isId(parsed['workspaceId']) ||
    !isId(parsed['layoutId']) ||
    !isId(parsed['terminalId'])
  ) {
    return null
  }

  return Object.freeze({
    projectId: parsed['projectId'],
    workspaceId: parsed['workspaceId'],
    layoutId: parsed['layoutId'],
    terminalId: parsed['terminalId']
  })
}

function exactBinding(binding: ClaudeRuntimeBinding, scope: Phase456QaScope): boolean {
  return (
    binding.runtimeKind === 'claude' &&
    binding.state === 'live' &&
    binding.pid != null &&
    Number.isSafeInteger(binding.pid) &&
    binding.pid > 0 &&
    binding.projectId === scope.projectId &&
    binding.workspaceId === scope.workspaceId &&
    binding.surfaceId === scope.workspaceId
  )
}

function sameObservedBinding(
  binding: ClaudeRuntimeBinding,
  observed: ClaudeRuntimeBinding | null
): boolean {
  return (
    observed != null &&
    observed.runtimeId === binding.runtimeId &&
    observed.runtimeKind === binding.runtimeKind &&
    observed.surfaceId === binding.surfaceId &&
    observed.workspaceId === binding.workspaceId &&
    observed.projectId === binding.projectId &&
    observed.claudeConversationId === binding.claudeConversationId &&
    observed.parentWorkspaceId === binding.parentWorkspaceId &&
    observed.forkedFromConversationId === binding.forkedFromConversationId &&
    observed.issuedAt === binding.issuedAt &&
    observed.state === 'live' &&
    observed.pid === binding.pid
  )
}

function buildGrant(scope: Phase456QaScope): RuntimeControlGrant {
  return Object.freeze({
    permissions: PHASE456_QA_PERMISSIONS,
    maxRiskTier: 2,
    scope: Object.freeze({
      selfOnly: true,
      layoutIds: Object.freeze([scope.layoutId]),
      surfaceIds: Object.freeze([`pane:${scope.layoutId}:${scope.terminalId}`])
    })
  })
}

/**
 * Explicit, process-local grant source for final Phase 4-6 integration QA.
 *
 * The app-launch scope selects which already-authenticated runtime may receive
 * the grant; it never establishes runtime identity. The source requires a live
 * runtime with an observed PID and re-resolves that binding plus main-owned
 * workspace and pane records on every request. Missing, pending, revoked,
 * stale, invalid, or throwing state fails closed. Production and worktree
 * builds always receive `undefined`, preserving the default read-only runtime
 * grant policy.
 */
export function createPhase456QaGrantSource(
  options: Phase456QaGrantSourceOptions
): RuntimeControlGrantSource | undefined {
  if (!phase456QaGrantEnabled(options.flagValue, options.appName)) return undefined
  const scope = parsePhase456QaScope(options.scopeValue)
  if (scope == null) return undefined
  const grant = buildGrant(scope)

  return (binding) => {
    if (!exactBinding(binding, scope)) return null
    try {
      if (!sameObservedBinding(binding, options.getRuntimeBinding(binding.runtimeId))) return null
      if (options.getWorkspaceProjectId(scope.workspaceId) !== scope.projectId) return null
      if (!options.hasPaneTerminal(scope.layoutId, scope.terminalId)) return null
      return grant
    } catch {
      return null
    }
  }
}
