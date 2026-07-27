import { listByWorkspace, setResolved } from '../reviewStore'
import { bootControlRegistry } from './boot'
import { ControlRegistry, unwrapControlResult } from './registry'
import type {
  ControlAuthorizationPolicy,
  ControlContext,
  ControlDescription,
  ControlInvocation,
  ControlResult,
  ReadCapabilityHandlers
} from './types'

export type Phase2ControlPlaneConfig = {
  authorization: ControlAuthorizationPolicy
  reads: ReadCapabilityHandlers
}

let phase2Config: Phase2ControlPlaneConfig | null = null
let registry: ControlRegistry | null = null
let booted = false

function getRegistry(): ControlRegistry {
  if (registry == null) {
    registry = new ControlRegistry(phase2Config?.authorization)
  }
  return registry
}

export function configurePhase2ControlPlane(config: Phase2ControlPlaneConfig): void {
  if (phase2Config === config) return
  if (phase2Config != null) {
    throw new Error('Phase 2 control plane is already configured.')
  }
  if (registry != null || booted) {
    throw new Error('Phase 2 control plane must be configured before boot.')
  }
  phase2Config = config
}

export function bootControlPlane(): void {
  const activeRegistry = getRegistry()
  bootControlRegistry(
    activeRegistry,
    {
      listByWorkspace: (workspaceId, context) =>
        phase2Config?.reads.listReviewsByWorkspace(workspaceId, context) ??
        listByWorkspace(workspaceId),
      setResolved: (id, resolved) => setResolved(id, resolved)
    },
    phase2Config?.reads
  )
  booted = true
}

export function invokeControl<T>(invocation: ControlInvocation): Promise<ControlResult<T>> {
  return getRegistry().invoke<T>(invocation)
}

export function listControl(context: ControlContext): ControlDescription[] {
  return getRegistry().listForContext(context)
}

export function describeControl(id: string, context: ControlContext): ControlDescription | null {
  return getRegistry().describeForContext(id, context)
}

export { unwrapControlResult }
