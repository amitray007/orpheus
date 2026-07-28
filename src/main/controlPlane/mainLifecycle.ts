import type { AutomationChangedEvent, WorkspaceRecord, WorkspaceStatus } from '../../shared/types'
import {
  createAutomationRuntime,
  type AutomationScheduler,
  type AutomationService
} from '../automations'
import {
  wireWorkspaceAutomationEvents,
  WORKSPACE_COMPLETED_EVENT
} from '../automations/workspaceEvents'
import type { DbLike } from '../db/types'
import { registerAutomationsIpc } from '../ipc/automations'
import { registerControlToolsIpc } from '../ipc/controlTools'
import {
  AutomationManagementService,
  bootControlPlane,
  configurePhase2ControlPlane,
  describeRegisteredControl,
  invokeControl,
  listRegisteredControl,
  type Phase2ControlPlaneConfig,
  validateRegisteredControlInput
} from './index'
import { createSafeAutomationGrantSource } from './safeAutomationGrants'
import { ControlToolExposureStore } from './controlToolExposure'

type PersistingStatusObserver = (
  workspaceId: string,
  oldStatus: WorkspaceStatus,
  newStatus: WorkspaceStatus,
  workspace: WorkspaceRecord
) => void
type CommittedStatusObserver = (
  workspaceId: string,
  oldStatus: WorkspaceStatus | undefined,
  newStatus: WorkspaceStatus
) => void

export type MainControlPlaneLifecycleDeps = {
  db: DbLike
  controlPlane: Omit<Phase2ControlPlaneConfig, 'toolExposure' | 'automationManagement'>
  getProject: (projectId: string) => { id: string } | null | undefined
  getWorkspace: (workspaceId: string) => WorkspaceRecord | null | undefined
  broadcastAutomationChanged: (event: AutomationChangedEvent) => void
  subscribePersisting: (observer: PersistingStatusObserver) => () => void
  subscribeCommitted: (observer: CommittedStatusObserver) => () => void
  onAutomationEventError?: (error: unknown) => void
  onSchedulerStartError?: (error: unknown) => void
}

export type MainControlPlaneLifecycle = {
  toolExposure: ControlToolExposureStore
  automations: AutomationService
  scheduler: AutomationScheduler
  dispose: () => void
}

/**
 * Owns main-process control-plane/automation composition and its paired
 * lifecycle. Keeping startup and disposal together prevents individual
 * pollers/subscriptions from being orphaned as the registry grows.
 */
export function startMainControlPlaneLifecycle(
  deps: MainControlPlaneLifecycleDeps
): MainControlPlaneLifecycle {
  const toolExposure = new ControlToolExposureStore(deps.db, listRegisteredControl)
  const automations = createAutomationRuntime({
    db: deps.db,
    registry: {
      describe: describeRegisteredControl,
      validateInput: validateRegisteredControlInput,
      invoke: invokeControl
    },
    grants: createSafeAutomationGrantSource({
      getProject: deps.getProject,
      getWorkspace: deps.getWorkspace
    }),
    allowedEventTypes: new Set([WORKSPACE_COMPLETED_EVENT])
  })
  const automationManagement = new AutomationManagementService({
    service: automations.service,
    listOperations: listRegisteredControl,
    broadcastChanged: deps.broadcastAutomationChanged
  })

  configurePhase2ControlPlane({
    ...deps.controlPlane,
    toolExposure,
    automationManagement
  })
  bootControlPlane()
  toolExposure.initializeDescriptions()
  registerControlToolsIpc(toolExposure)
  registerAutomationsIpc(
    automations.service,
    listRegisteredControl,
    deps.broadcastAutomationChanged
  )

  const disposeEvents = wireWorkspaceAutomationEvents({
    scheduler: automations.scheduler,
    subscribePersisting: deps.subscribePersisting,
    subscribeCommitted: deps.subscribeCommitted,
    onError: deps.onAutomationEventError
  })
  void automations.scheduler.start().catch((error: unknown) => {
    deps.onSchedulerStartError?.(error)
  })

  let disposed = false
  return {
    toolExposure,
    automations: automations.service,
    scheduler: automations.scheduler,
    dispose: () => {
      if (disposed) return
      disposed = true
      disposeEvents()
      automations.scheduler.stop()
    }
  }
}
