import { listByWorkspace, setResolved } from '../reviewStore'
import { bootControlRegistry } from './boot'
import { ControlRegistry, unwrapControlResult } from './registry'
import type { ControlInvocation, ControlResult } from './types'

const registry = new ControlRegistry()

export function bootControlPlane(): void {
  bootControlRegistry(registry, {
    listByWorkspace: (workspaceId) => listByWorkspace(workspaceId),
    setResolved: (id, resolved) => setResolved(id, resolved)
  })
}

export function invokeControl<T>(invocation: ControlInvocation): Promise<ControlResult<T>> {
  return registry.invoke<T>(invocation)
}

export { unwrapControlResult }
