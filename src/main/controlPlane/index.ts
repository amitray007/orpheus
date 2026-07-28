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
import type { WorkspaceOrchestrationService } from '../workspaceOrchestration/service'
import { createConfiguredControlRegistry } from './configuredRegistry'
import type { WorkbenchControlService } from '../workbenchControl/service'
import type { TerminalObservationService } from '../terminalObservation/service'
import { createTerminalObservationHandlers } from '../terminalObservation/service'
import type { SettingsResourceService } from './settingsResourceService'
import type { ControlToolExposureStore } from './controlToolExposure'

export type Phase2ControlPlaneConfig = {
  authorization: ControlAuthorizationPolicy
  reads: ReadCapabilityHandlers
  workspaceOrchestration?: WorkspaceOrchestrationService
  workbenchControl?: WorkbenchControlService
  terminalObservation?: TerminalObservationService
  settingsResources?: SettingsResourceService
  toolExposure?: Pick<ControlToolExposureStore, 'isEnabled'>
}

let phase2Config: Phase2ControlPlaneConfig | null = null
let registry: ControlRegistry | null = null
let booted = false

function getRegistry(): ControlRegistry {
  if (registry == null) {
    registry =
      phase2Config == null ? new ControlRegistry() : createConfiguredControlRegistry(phase2Config)
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
    phase2Config?.reads,
    phase2Config?.workspaceOrchestration,
    phase2Config?.workbenchControl,
    phase2Config?.terminalObservation == null
      ? undefined
      : createTerminalObservationHandlers(phase2Config.terminalObservation),
    phase2Config?.settingsResources
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

/** Main-process subsystem seam; unlike describeControl this does not publish. */
export function describeRegisteredControl(id: string): ControlDescription | null {
  return getRegistry().describe(id)
}

/** Main-process settings seam; unlike listControl this does not publish. */
export function listRegisteredControl(): ControlDescription[] {
  return getRegistry().list()
}

export function validateRegisteredControlInput(
  id: string,
  input: unknown,
  context: ControlContext
): boolean {
  return getRegistry().validateInput(id, input, context)
}

export { unwrapControlResult }
