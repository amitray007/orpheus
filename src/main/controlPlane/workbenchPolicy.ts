import type {
  ControlAuthorizationDecision,
  ControlAuthorizationPolicy,
  ControlDescription
} from './types'

const IDS = new Set([
  'workbench.getState',
  'workbench.selectTab',
  'workbench.openFile',
  'workbench.openDiff',
  'panes.getState',
  'panes.selectLayout',
  'panes.startTerminal',
  'panes.stopTerminal',
  'panes.focusTerminal',
  'panes.createWorkspaceTerminal',
  'panes.deleteTerminalLayout'
])

function isPhase4(description: ControlDescription): boolean {
  return IDS.has(description.id)
}

function denyNotFound(): ControlAuthorizationDecision {
  return { allowed: false, code: 'not_found', error: 'Pane resource was not found.' }
}

export function withWorkbenchControlPolicy(
  base: ControlAuthorizationPolicy
): ControlAuthorizationPolicy {
  return {
    canDiscover(description, context) {
      if (!isPhase4(description)) return base.canDiscover(description, context)
      const runtime = context.trustedRuntime
      return (
        context.consumer !== 'mcp' ||
        (runtime?.workspaceId != null && runtime.permissions.includes(description.permission))
      )
    },
    authorize(description, input, context) {
      if (!isPhase4(description)) return base.authorize(description, input, context)
      if (context.consumer !== 'mcp') return { allowed: true }
      const runtime = context.trustedRuntime
      if (runtime?.workspaceId == null || runtime.projectId == null) {
        return {
          allowed: false,
          code: 'forbidden',
          error: 'A trusted workspace runtime is required.'
        }
      }
      if (!runtime.permissions.includes(description.permission)) {
        return {
          allowed: false,
          code: 'forbidden',
          error: `Permission denied: ${description.permission}`
        }
      }
      if (!description.id.startsWith('panes.')) return { allowed: true }
      if (description.id === 'panes.createWorkspaceTerminal') return { allowed: true }
      const params = input as { layoutId?: unknown; terminalId?: unknown }
      if (typeof params.layoutId !== 'string') return denyNotFound()
      const scope = runtime.resourceScope
      if (!scope?.layoutIds.includes(params.layoutId)) return denyNotFound()
      if (typeof params.terminalId === 'string') {
        const surfaceId = `pane:${params.layoutId}:${params.terminalId}`
        if (!scope.surfaceIds.includes(surfaceId)) return denyNotFound()
      }
      return { allowed: true }
    }
  }
}
