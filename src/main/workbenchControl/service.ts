import { randomUUID } from 'node:crypto'
import type {
  PaneLayoutDeletionStateV1,
  PaneStateV1,
  PaneTerminalLayoutMutationV1,
  RendererControlAck,
  RendererControlCommand,
  WorkbenchDiffTarget,
  WorkbenchFileMode,
  WorkbenchStateV1
} from '../../shared/workbenchControl'
import type { ControlContext, ControlErrorCode, ControlPermission } from '../controlPlane/types'
import { WorkspaceOrchestrationError, orchestrationError } from '../workspaceOrchestration/errors'
import { recursivelyRedact } from '../workspaceOrchestration/redaction'
import type {
  EffectReceipt,
  WorkspaceAuditPort,
  WorkspaceControlAuditRecord,
  WorkspaceOperationReceipt
} from '../workspaceOrchestration/types'
import { RendererCommandError } from './rendererCommandBroker'

export type PaneTarget = { layoutId: string; terminalId?: string; panelId: string }

export class PaneManagementPortError extends Error {
  constructor(
    readonly code: 'capacity' | 'conflict' | 'not_found' | 'invalid_shape' | 'failed',
    message: string
  ) {
    super(message)
  }
}

export type CreateWorkspaceTerminalInput = {
  layoutName?: string
  terminalName?: string
  initialCommand?: string
}

export type ProvisionedPaneTarget = {
  layoutId: string
  panelId: string
  terminalId: string
  layoutUpdatedAt: number
  terminalUpdatedAt: number
  initialCommand: string
}

type OperationMeta = {
  id: string
  permission: ControlPermission
  tier: 0 | 1 | 2 | 3
  effects: readonly string[]
}

const WORKBENCH_PERMISSION = 'ui.workbench.control'
const TERMINAL_PERMISSION = 'terminals.control'
const UI_PRESENT_EFFECT = 'ui.present'

const OPERATIONS = {
  selectTab: {
    id: 'workbench.selectTab',
    permission: WORKBENCH_PERMISSION,
    tier: 1,
    effects: [UI_PRESENT_EFFECT]
  },
  openFile: {
    id: 'workbench.openFile',
    permission: WORKBENCH_PERMISSION,
    tier: 1,
    effects: ['filesystem.read', UI_PRESENT_EFFECT]
  },
  openDiff: {
    id: 'workbench.openDiff',
    permission: WORKBENCH_PERMISSION,
    tier: 1,
    effects: ['git.read', 'process.spawn', UI_PRESENT_EFFECT]
  },
  selectLayout: {
    id: 'panes.selectLayout',
    permission: WORKBENCH_PERMISSION,
    tier: 1,
    effects: ['db.write', UI_PRESENT_EFFECT]
  },
  startTerminal: {
    id: 'panes.startTerminal',
    permission: TERMINAL_PERMISSION,
    tier: 2,
    effects: ['surface.mount', 'process.spawn']
  },
  stopTerminal: {
    id: 'panes.stopTerminal',
    permission: TERMINAL_PERMISSION,
    tier: 2,
    effects: ['surface.destroy', 'process.terminate']
  },
  focusTerminal: {
    id: 'panes.focusTerminal',
    permission: TERMINAL_PERMISSION,
    tier: 1,
    effects: [UI_PRESENT_EFFECT, 'ui.focus']
  },
  createWorkspaceTerminal: {
    id: 'panes.createWorkspaceTerminal',
    permission: 'panes.manage',
    tier: 3,
    effects: [
      'db.write',
      'surface.mount',
      'process.spawn',
      'shell.execute',
      UI_PRESENT_EFFECT,
      'ui.focus'
    ]
  },
  deleteTerminalLayout: {
    id: 'panes.deleteTerminalLayout',
    permission: 'panes.manage',
    tier: 3,
    effects: ['surface.destroy', 'process.terminate', 'db.write', 'ui.reconcile']
  }
} as const satisfies Record<string, OperationMeta>

export type WorkbenchControlPorts = {
  renderer: {
    execute: (requestId: string, command: RendererControlCommand) => Promise<RendererControlAck>
  }
  paths: {
    isSafe: (
      workspaceId: string,
      path: string,
      options: { requireFile: boolean }
    ) => boolean | Promise<boolean>
  }
  authorization: {
    revalidate: (input: {
      context: ControlContext
      permission: ControlPermission
      tier: 0 | 1 | 2 | 3
      layoutId?: string
      terminalId?: string
    }) => 'allow' | 'forbidden' | 'not_found' | Promise<'allow' | 'forbidden' | 'not_found'>
  }
  panes: {
    resolve: (layoutId: string, terminalId?: string) => PaneTarget | null
    start: (layoutId: string, terminalId: string) => Promise<'started' | 'retained'>
    startProvisioned: (
      layoutId: string,
      terminalId: string,
      initialCommand: string
    ) => Promise<'started' | 'retained'>
    stop: (layoutId: string, terminalId: string) => Promise<'stopped' | 'absent'>
    focus: (layoutId: string, terminalId: string) => Promise<void>
    provision: (
      workspaceId: string,
      input: CreateWorkspaceTerminalInput
    ) => Promise<ProvisionedPaneTarget>
    deleteDedicated: (
      workspaceId: string,
      input: {
        layoutId: string
        terminalId: string
        expectedLayoutUpdatedAt: number
        expectedTerminalUpdatedAt: number
      }
    ) => Promise<{
      target: ProvisionedPaneTarget
      terminalState: 'stopped' | 'absent'
      persistence: 'deleted' | 'retained'
    }>
  }
  audit?: WorkspaceAuditPort
  onAuditFailure?: (error: unknown, record: WorkspaceControlAuditRecord) => void | Promise<void>
  now?: () => number
  generateId?: () => string
}

type MutationResult<T> = {
  value: T
  effects: EffectReceipt[]
  status?: 'completed' | 'partial'
}

function bound(context: ControlContext): { workspaceId: string; projectId: string } {
  const runtime = context.trustedRuntime
  if (runtime?.workspaceId == null || runtime.projectId == null) {
    throw orchestrationError('forbidden', 'A workspace-bound runtime lease is required.')
  }
  return { workspaceId: runtime.workspaceId, projectId: runtime.projectId }
}

function record(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function validWorkbenchState(value: unknown, workspaceId: string): value is WorkbenchStateV1 {
  if (
    !record(value) ||
    !hasOnly(value, [
      'schemaVersion',
      'workspaceId',
      'observedAt',
      'source',
      'workbench',
      'file',
      'diff'
    ]) ||
    value.schemaVersion !== 1 ||
    value.workspaceId !== workspaceId ||
    typeof value.observedAt !== 'number' ||
    !Number.isFinite(value.observedAt) ||
    value.source !== 'renderer-live' ||
    !record(value.workbench) ||
    !hasOnly(value.workbench, ['state', 'activeTab']) ||
    !['dormant', 'open', 'expanded'].includes(String(value.workbench.state)) ||
    !['git', 'terminal', 'files'].includes(String(value.workbench.activeTab))
  ) {
    return false
  }
  if (
    value.file !== null &&
    (!record(value.file) ||
      !hasOnly(value.file, ['path', 'mode']) ||
      typeof value.file.path !== 'string' ||
      !['viewer', 'preview'].includes(String(value.file.mode)))
  ) {
    return false
  }
  return (
    value.diff === null ||
    (record(value.diff) &&
      hasOnly(value.diff, ['kind', 'path', 'reviewId']) &&
      (value.diff.kind === 'working-tree-file' || value.diff.kind === 'local-review') &&
      typeof value.diff.path === 'string' &&
      (value.diff.reviewId === null || typeof value.diff.reviewId === 'string'))
  )
}

function validPaneTerminal(value: unknown): value is PaneStateV1['terminals'][number] {
  return (
    record(value) &&
    hasOnly(value, ['terminalId', 'selected', 'desiredState']) &&
    typeof value.terminalId === 'string' &&
    typeof value.selected === 'boolean' &&
    (value.desiredState === 'running' || value.desiredState === 'stopped')
  )
}

function validPaneState(value: unknown, target: PaneTarget): value is PaneStateV1 {
  const terminals: unknown =
    record(value) && Object.prototype.hasOwnProperty.call(value, 'terminals')
      ? value.terminals
      : undefined
  if (
    !record(value) ||
    !hasOnly(value, [
      'schemaVersion',
      'observedAt',
      'source',
      'layoutId',
      'panelId',
      'selected',
      'focusedTerminalId',
      'terminals'
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.observedAt !== 'number' ||
    !Number.isFinite(value.observedAt) ||
    value.source !== 'renderer-live' ||
    value.layoutId !== target.layoutId ||
    value.panelId !== target.panelId ||
    typeof value.selected !== 'boolean' ||
    (value.focusedTerminalId !== null && typeof value.focusedTerminalId !== 'string') ||
    !Array.isArray(terminals) ||
    !(terminals as unknown[]).every(validPaneTerminal)
  ) {
    return false
  }
  const validTerminals = terminals as PaneStateV1['terminals']
  const terminalIds = validTerminals.map((terminal) => terminal.terminalId)
  if (new Set(terminalIds).size !== terminalIds.length) return false
  if (value.focusedTerminalId != null && !terminalIds.includes(value.focusedTerminalId))
    return false
  return target.terminalId == null || terminalIds.includes(target.terminalId)
}

function validPaneDeletionState(
  value: unknown,
  deletedLayoutId: string
): value is PaneLayoutDeletionStateV1 {
  return (
    record(value) &&
    hasOnly(value, [
      'schemaVersion',
      'observedAt',
      'source',
      'deletedLayoutId',
      'selectedLayoutId'
    ]) &&
    value.schemaVersion === 1 &&
    typeof value.observedAt === 'number' &&
    Number.isFinite(value.observedAt) &&
    value.source === 'renderer-live' &&
    value.deletedLayoutId === deletedLayoutId &&
    (value.selectedLayoutId === null ||
      (typeof value.selectedLayoutId === 'string' && value.selectedLayoutId !== deletedLayoutId))
  )
}

function controlCodeForRendererError(code: RendererCommandError['code']): ControlErrorCode {
  if (code === 'timeout' || code === 'not_found' || code === 'conflict' || code === 'unavailable') {
    return code
  }
  return 'failed'
}

function safeRendererMessage(code: ControlErrorCode): string {
  if (code === 'timeout') return 'Renderer command timed out.'
  if (code === 'unavailable') return 'Renderer is unavailable.'
  if (code === 'conflict') return 'Renderer command conflicted with an in-flight request.'
  if (code === 'not_found') return 'Renderer control target was not found.'
  return 'Renderer command failed.'
}

function resultCode(error: unknown): WorkspaceControlAuditRecord['result']['code'] {
  return error instanceof WorkspaceOrchestrationError ? error.code : 'failed'
}

function auditConsumer(
  consumer: ControlContext['consumer']
): WorkspaceControlAuditRecord['consumer'] {
  if (consumer === 'renderer-ipc') return 'renderer'
  if (consumer === 'command-socket') return 'cli'
  return consumer
}

function failedNativeOperation(): WorkspaceOrchestrationError {
  return orchestrationError('failed', 'Pane terminal operation failed.')
}

export class WorkbenchControlService {
  private readonly serialTails = new Map<string, Promise<void>>()

  constructor(private readonly ports: WorkbenchControlPorts) {}

  getWorkbenchState(context: ControlContext): Promise<WorkbenchStateV1> {
    const { workspaceId } = bound(context)
    return this.serialize(`workbench:${workspaceId}`, async () => {
      await this.assertAuthorized(context, WORKBENCH_PERMISSION, 0)
      const ack = await this.executeRenderer(context.requestId, {
        kind: 'workbench.readState',
        workspaceId
      })
      return this.workbenchValue(ack, workspaceId)
    })
  }

  getPaneState(layoutId: string, context: ControlContext): Promise<PaneStateV1> {
    bound(context)
    return this.serialize(`pane-layout:${layoutId}`, async () => {
      await this.assertAuthorized(context, WORKBENCH_PERMISSION, 0, layoutId)
      const target = this.resolvePane(layoutId)
      const ack = await this.executeRenderer(context.requestId, {
        kind: 'panes.readState',
        layoutId
      })
      return this.paneValue(ack, target)
    })
  }

  selectTab(
    tab: 'git' | 'terminal' | 'files',
    context: ControlContext
  ): Promise<WorkspaceOperationReceipt<WorkbenchStateV1>> {
    const { workspaceId } = bound(context)
    return this.serialize(`workbench:${workspaceId}`, () =>
      this.runMutation(OPERATIONS.selectTab, { tab }, context, async () => {
        const ack = await this.executeRenderer(context.requestId, {
          kind: 'workbench.selectTab',
          workspaceId,
          tab
        })
        const value = this.workbenchValue(ack, workspaceId)
        if (value.workbench.activeTab !== tab || value.workbench.state === 'dormant') {
          throw orchestrationError('failed', 'Renderer did not apply the Workbench tab selection.')
        }
        return {
          value,
          effects: [{ effect: UI_PRESENT_EFFECT, status: 'applied', workspaceId }]
        }
      })
    )
  }

  openFile(
    path: string,
    mode: WorkbenchFileMode,
    context: ControlContext
  ): Promise<WorkspaceOperationReceipt<WorkbenchStateV1>> {
    const { workspaceId } = bound(context)
    return this.serialize(`workbench:${workspaceId}`, () =>
      this.runMutation(OPERATIONS.openFile, { path, mode }, context, async () => {
        await this.assertSafePath(workspaceId, path, true)
        const ack = await this.executeRenderer(context.requestId, {
          kind: 'workbench.openFile',
          workspaceId,
          path,
          mode
        })
        const value = this.workbenchValue(ack, workspaceId)
        if (
          value.workbench.activeTab !== 'files' ||
          value.file?.path !== path ||
          value.file.mode !== mode
        ) {
          throw orchestrationError('failed', 'Renderer did not apply the file selection.')
        }
        return {
          value,
          effects: [
            { effect: 'filesystem.read', status: 'applied', workspaceId },
            { effect: UI_PRESENT_EFFECT, status: 'applied', workspaceId }
          ]
        }
      })
    )
  }

  openDiff(
    target: WorkbenchDiffTarget,
    context: ControlContext
  ): Promise<WorkspaceOperationReceipt<WorkbenchStateV1>> {
    const { workspaceId } = bound(context)
    return this.serialize(`workbench:${workspaceId}`, () =>
      this.runMutation(OPERATIONS.openDiff, { target }, context, async () => {
        if (target.kind === 'working-tree-file') {
          await this.assertSafePath(workspaceId, target.path, false)
        }
        const ack = await this.executeRenderer(context.requestId, {
          kind: 'workbench.openDiff',
          workspaceId,
          target
        })
        const value = this.workbenchValue(ack, workspaceId)
        const selected =
          value.workbench.activeTab === 'git' &&
          value.diff?.kind === target.kind &&
          (target.kind === 'working-tree-file'
            ? value.diff.path === target.path && value.diff.reviewId === null
            : value.diff.reviewId === target.reviewId)
        if (!selected) {
          throw orchestrationError('failed', 'Renderer did not apply the diff selection.')
        }
        return {
          value,
          effects: [
            { effect: 'git.read', status: 'applied', workspaceId },
            { effect: 'process.spawn', status: 'applied', workspaceId },
            { effect: UI_PRESENT_EFFECT, status: 'applied', workspaceId }
          ]
        }
      })
    )
  }

  selectLayout(
    layoutId: string,
    context: ControlContext
  ): Promise<WorkspaceOperationReceipt<PaneStateV1>> {
    return this.serialize(`pane-layout:${layoutId}`, () =>
      this.runMutation(OPERATIONS.selectLayout, { layoutId }, context, async () => {
        const target = this.resolvePane(layoutId)
        const ack = await this.executeRenderer(context.requestId, {
          kind: 'panes.selectLayout',
          layoutId
        })
        const value = this.paneValue(ack, target)
        if (!value.selected) {
          throw orchestrationError('failed', 'Renderer did not apply the pane layout selection.')
        }
        return {
          value,
          effects: [
            { effect: 'db.write', status: 'applied', resourceId: layoutId },
            { effect: UI_PRESENT_EFFECT, status: 'applied', resourceId: layoutId }
          ]
        }
      })
    )
  }

  terminal(
    action: 'start' | 'stop' | 'focus',
    layoutId: string,
    terminalId: string,
    context: ControlContext
  ): Promise<WorkspaceOperationReceipt<{ layoutId: string; terminalId: string }>> {
    const meta =
      action === 'start'
        ? OPERATIONS.startTerminal
        : action === 'stop'
          ? OPERATIONS.stopTerminal
          : OPERATIONS.focusTerminal
    return this.serialize(`pane-layout:${layoutId}`, () =>
      this.runMutation(meta, { layoutId, terminalId }, context, async () => {
        const target = this.resolvePane(layoutId, terminalId)
        return action === 'focus'
          ? this.focusTerminal(target, context)
          : this.setTerminalRunning(action, target, context)
      })
    )
  }

  createWorkspaceTerminal(
    input: CreateWorkspaceTerminalInput,
    context: ControlContext
  ): Promise<WorkspaceOperationReceipt<PaneTerminalLayoutMutationV1>> {
    const { workspaceId } = bound(context)
    return this.serialize(`pane-provision:${workspaceId}`, () =>
      this.runMutation(OPERATIONS.createWorkspaceTerminal, input, context, async () => {
        let target: ProvisionedPaneTarget
        try {
          target = await this.ports.panes.provision(workspaceId, input)
        } catch (error) {
          throw this.paneManagementError(error)
        }

        const value: PaneTerminalLayoutMutationV1 = {
          layoutId: target.layoutId,
          panelId: target.panelId,
          terminalId: target.terminalId,
          layoutUpdatedAt: target.layoutUpdatedAt,
          terminalUpdatedAt: target.terminalUpdatedAt
        }
        const effects: EffectReceipt[] = [
          { effect: 'db.write', status: 'applied', resourceId: target.layoutId }
        ]

        try {
          const started = await this.ports.panes.startProvisioned(
            target.layoutId,
            target.terminalId,
            target.initialCommand
          )
          effects.push(
            {
              effect: 'surface.mount',
              status: 'applied',
              resourceId: `pane:${target.layoutId}:${target.terminalId}`
            },
            ...(started === 'started'
              ? ([
                  {
                    effect: 'process.spawn',
                    status: 'applied',
                    resourceId: `pane:${target.layoutId}:${target.terminalId}`
                  }
                ] satisfies EffectReceipt[])
              : [])
          )
        } catch {
          effects.push(
            {
              effect: 'surface.mount',
              status: 'failed',
              resourceId: `pane:${target.layoutId}:${target.terminalId}`
            },
            {
              effect: 'process.spawn',
              status: 'failed',
              resourceId: `pane:${target.layoutId}:${target.terminalId}`
            }
          )
          return { value, effects, status: 'partial' }
        }

        try {
          const pane = this.paneValue(
            await this.executeRenderer(context.requestId, {
              kind: 'panes.presentCreatedTerminal',
              layoutId: target.layoutId,
              terminalId: target.terminalId
            }),
            {
              layoutId: target.layoutId,
              panelId: target.panelId,
              terminalId: target.terminalId
            }
          )
          if (!pane.selected || pane.focusedTerminalId !== target.terminalId) {
            throw orchestrationError('failed', 'Renderer did not present the created terminal.')
          }
          effects.push({
            effect: UI_PRESENT_EFFECT,
            status: 'applied',
            resourceId: target.layoutId,
            message:
              'Renderer semantically selected the created layout and terminal; this is not native mount proof.'
          })
        } catch {
          effects.push({
            effect: UI_PRESENT_EFFECT,
            status: 'failed',
            resourceId: target.layoutId
          })
          return { value, effects, status: 'partial' }
        }

        effects.push({
          effect: 'ui.focus',
          status: 'skipped',
          resourceId: `pane:${target.layoutId}:${target.terminalId}`,
          message: 'First-responder focus cannot be confirmed by the native surface API.'
        })
        return { value, effects }
      })
    )
  }

  deleteTerminalLayout(
    input: {
      layoutId: string
      terminalId: string
      expectedLayoutUpdatedAt: number
      expectedTerminalUpdatedAt: number
    },
    context: ControlContext
  ): Promise<WorkspaceOperationReceipt<PaneTerminalLayoutMutationV1>> {
    const { workspaceId } = bound(context)
    return this.serialize(`pane-layout:${input.layoutId}`, () =>
      this.runMutation(OPERATIONS.deleteTerminalLayout, input, context, async () => {
        let deleted: {
          target: ProvisionedPaneTarget
          terminalState: 'stopped' | 'absent'
          persistence: 'deleted' | 'retained'
        }
        try {
          deleted = await this.ports.panes.deleteDedicated(workspaceId, input)
        } catch (error) {
          throw this.paneManagementError(error)
        }
        const { target } = deleted
        const stopped = deleted.terminalState === 'stopped'
        const effects: EffectReceipt[] = [
          {
            effect: 'surface.destroy',
            status: stopped ? 'applied' : 'skipped',
            resourceId: `pane:${target.layoutId}:${target.terminalId}`
          },
          {
            effect: 'process.terminate',
            status: 'skipped',
            resourceId: `pane:${target.layoutId}:${target.terminalId}`,
            message: stopped
              ? 'Native teardown was accepted; asynchronous process exit is not confirmed.'
              : 'No mounted native surface was present.'
          },
          {
            effect: 'db.write',
            status: deleted.persistence === 'deleted' ? 'applied' : 'failed',
            resourceId: target.layoutId,
            ...(deleted.persistence === 'retained'
              ? { message: 'Persisted layout was retained and can be remounted.' }
              : {})
          }
        ]
        const value: PaneTerminalLayoutMutationV1 = {
          layoutId: target.layoutId,
          panelId: target.panelId,
          terminalId: target.terminalId,
          layoutUpdatedAt: target.layoutUpdatedAt,
          terminalUpdatedAt: target.terminalUpdatedAt
        }
        if (deleted.persistence === 'retained') {
          return { value, effects, status: 'partial' }
        }
        try {
          const ack = await this.executeRenderer(context.requestId, {
            kind: 'panes.reconcileDeletedLayout',
            layoutId: target.layoutId,
            panelId: target.panelId
          })
          if (!validPaneDeletionState(ack.value, target.layoutId)) {
            throw orchestrationError('failed', 'Renderer returned an invalid pane deletion state.')
          }
          effects.push({
            effect: 'ui.reconcile',
            status: 'applied',
            resourceId: target.layoutId
          })
          return { value, effects }
        } catch {
          effects.push({
            effect: 'ui.reconcile',
            status: 'failed',
            resourceId: target.layoutId
          })
          return { value, effects, status: 'partial' }
        }
      })
    )
  }

  private async focusTerminal(
    target: Required<Pick<PaneTarget, 'layoutId' | 'terminalId'>> & PaneTarget,
    context: ControlContext
  ): Promise<MutationResult<{ layoutId: string; terminalId: string }>> {
    const { layoutId, terminalId } = target
    const presented = this.paneValue(
      await this.executeRenderer(context.requestId, {
        kind: 'panes.presentTerminal',
        layoutId,
        terminalId
      }),
      target
    )
    if (!presented.selected || presented.focusedTerminalId !== terminalId) {
      throw orchestrationError('failed', 'Renderer did not present the pane terminal.')
    }
    const effects: EffectReceipt[] = [
      { effect: UI_PRESENT_EFFECT, status: 'applied', resourceId: `pane:${layoutId}:${terminalId}` }
    ]
    try {
      await this.ports.panes.focus(layoutId, terminalId)
      effects.push({
        effect: 'ui.focus',
        status: 'applied',
        resourceId: `pane:${layoutId}:${terminalId}`
      })
      return { value: { layoutId, terminalId }, effects }
    } catch {
      effects.push({
        effect: 'ui.focus',
        status: 'failed',
        resourceId: `pane:${layoutId}:${terminalId}`
      })
      return { value: { layoutId, terminalId }, effects, status: 'partial' }
    }
  }

  private async setTerminalRunning(
    action: 'start' | 'stop',
    target: Required<Pick<PaneTarget, 'layoutId' | 'terminalId'>> & PaneTarget,
    context: ControlContext
  ): Promise<MutationResult<{ layoutId: string; terminalId: string }>> {
    const { layoutId, terminalId } = target
    this.paneValue(
      await this.executeRenderer(context.requestId, {
        kind: 'panes.validateTerminal',
        layoutId,
        terminalId
      }),
      target
    )
    let effects: EffectReceipt[]
    try {
      effects =
        action === 'start'
          ? this.startEffects(
              layoutId,
              terminalId,
              await this.ports.panes.start(layoutId, terminalId)
            )
          : this.stopEffects(
              layoutId,
              terminalId,
              await this.ports.panes.stop(layoutId, terminalId)
            )
    } catch {
      throw failedNativeOperation()
    }

    try {
      const desiredState = action === 'start' ? 'running' : 'stopped'
      const committed = this.paneValue(
        await this.executeRenderer(`${context.requestId}:commit`, {
          kind: 'panes.commitTerminalState',
          layoutId,
          terminalId,
          desiredState
        }),
        target
      )
      const terminal = committed.terminals.find((item) => item.terminalId === terminalId)
      if (terminal?.desiredState !== desiredState) {
        return { value: { layoutId, terminalId }, effects, status: 'partial' }
      }
      return { value: { layoutId, terminalId }, effects }
    } catch {
      return { value: { layoutId, terminalId }, effects, status: 'partial' }
    }
  }

  private startEffects(
    layoutId: string,
    terminalId: string,
    state: 'started' | 'retained'
  ): EffectReceipt[] {
    const resourceId = `pane:${layoutId}:${terminalId}`
    return [
      { effect: 'surface.mount', status: 'applied', resourceId },
      ...(state === 'started'
        ? ([{ effect: 'process.spawn', status: 'applied', resourceId }] satisfies EffectReceipt[])
        : [])
    ]
  }

  private stopEffects(
    layoutId: string,
    terminalId: string,
    state: 'stopped' | 'absent'
  ): EffectReceipt[] {
    const resourceId = `pane:${layoutId}:${terminalId}`
    const status = state === 'stopped' ? 'applied' : 'skipped'
    return [
      { effect: 'surface.destroy', status, resourceId },
      { effect: 'process.terminate', status, resourceId }
    ]
  }

  private async runMutation<T>(
    meta: OperationMeta,
    params: unknown,
    context: ControlContext,
    task: () => Promise<MutationResult<T>>
  ): Promise<WorkspaceOperationReceipt<T>> {
    const { projectId, workspaceId } = bound(context)
    const auditId = this.ports.generateId?.() ?? randomUUID()
    let decision: 'allow' | 'deny' = 'deny'
    try {
      const values = record(params) ? params : {}
      await this.assertAuthorized(
        context,
        meta.permission,
        meta.tier,
        typeof values.layoutId === 'string' ? values.layoutId : undefined,
        typeof values.terminalId === 'string' ? values.terminalId : undefined
      )
      decision = 'allow'
      const result = await task()
      const status = result.status ?? 'completed'
      await this.audit(auditId, meta, params, context, decision, result.effects, status)
      return {
        schemaVersion: 1,
        requestId: context.requestId,
        operationId: meta.id,
        status,
        target: { projectId, workspaceId },
        value: result.value,
        effects: result.effects,
        auditId
      }
    } catch (error) {
      await this.audit(auditId, meta, params, context, decision, [], resultCode(error))
      throw error
    }
  }

  private async audit(
    auditId: string,
    meta: OperationMeta,
    params: unknown,
    context: ControlContext,
    decision: 'allow' | 'deny',
    effects: EffectReceipt[],
    result: WorkspaceControlAuditRecord['result']['code']
  ): Promise<void> {
    if (this.ports.audit == null) return
    const runtime = context.trustedRuntime
    const record: WorkspaceControlAuditRecord = {
      schemaVersion: 1,
      auditId,
      requestId: context.requestId,
      occurredAt: this.ports.now?.() ?? Date.now(),
      consumer: auditConsumer(context.consumer),
      operation: { id: meta.id, version: 1 },
      principal: {
        kind: context.principal.type,
        runtimeId: runtime?.runtimeId ?? null
      },
      target: {
        projectId: runtime?.projectId ?? null,
        workspaceIds: runtime?.workspaceId == null ? [] : [runtime.workspaceId]
      },
      permission: meta.permission,
      tier: meta.tier,
      decision,
      declaredEffects: [...meta.effects],
      redactedParams: recursivelyRedact(params),
      receipts: effects,
      result: { code: result },
      correlation: { requestId: context.requestId }
    }
    try {
      await this.ports.audit.append(record)
    } catch (error) {
      try {
        await this.ports.onAuditFailure?.(error, record)
      } catch {
        // Diagnostics must not change the outcome of an already-applied operation.
      }
    }
  }

  private resolvePane(layoutId: string): PaneTarget
  private resolvePane(
    layoutId: string,
    terminalId: string
  ): Required<Pick<PaneTarget, 'layoutId' | 'terminalId'>> & PaneTarget
  private resolvePane(layoutId: string, terminalId?: string): PaneTarget {
    let target: PaneTarget | null
    try {
      target = this.ports.panes.resolve(layoutId, terminalId)
    } catch {
      throw orchestrationError('failed', 'Pane resource resolution failed.')
    }
    if (target == null || (terminalId != null && target.terminalId !== terminalId)) {
      throw orchestrationError('not_found', 'Pane resource was not found.')
    }
    return target
  }

  private async assertSafePath(
    workspaceId: string,
    path: string,
    requireFile: boolean
  ): Promise<void> {
    let safe: boolean
    try {
      safe = await this.ports.paths.isSafe(workspaceId, path, { requireFile })
    } catch {
      throw orchestrationError('failed', 'Workbench path validation failed.')
    }
    if (!safe) {
      throw orchestrationError('not_found', 'Workbench path was not found.')
    }
  }

  private async assertAuthorized(
    context: ControlContext,
    permission: ControlPermission,
    tier: 0 | 1 | 2 | 3,
    layoutId?: string,
    terminalId?: string
  ): Promise<void> {
    let decision: 'allow' | 'forbidden' | 'not_found'
    try {
      decision = await this.ports.authorization.revalidate({
        context,
        permission,
        tier,
        ...(layoutId == null ? {} : { layoutId }),
        ...(terminalId == null ? {} : { terminalId })
      })
    } catch {
      throw orchestrationError('failed', 'Control authorization revalidation failed.')
    }
    if (decision === 'allow') return
    if (decision === 'not_found') {
      throw orchestrationError('not_found', 'Pane resource was not found.')
    }
    throw orchestrationError('forbidden', `Permission denied: ${permission}`)
  }

  private paneManagementError(error: unknown): WorkspaceOrchestrationError {
    if (!(error instanceof PaneManagementPortError)) {
      return orchestrationError('failed', 'Pane terminal management failed.')
    }
    if (error.code === 'capacity' || error.code === 'conflict') {
      return orchestrationError(
        'conflict',
        'Pane terminal management conflicted with current state.'
      )
    }
    if (error.code === 'not_found' || error.code === 'invalid_shape') {
      return orchestrationError('not_found', 'Pane resource was not found.')
    }
    return orchestrationError('failed', 'Pane terminal management failed.')
  }

  private workbenchValue(ack: RendererControlAck, workspaceId: string): WorkbenchStateV1 {
    if (!validWorkbenchState(ack.value, workspaceId)) {
      throw orchestrationError('failed', 'Renderer returned an invalid Workbench state.')
    }
    return ack.value
  }

  private paneValue(ack: RendererControlAck, target: PaneTarget): PaneStateV1 {
    if (!validPaneState(ack.value, target)) {
      throw orchestrationError('failed', 'Renderer returned an invalid pane state.')
    }
    return ack.value
  }

  private async executeRenderer(
    requestId: string,
    command: RendererControlCommand
  ): Promise<RendererControlAck> {
    try {
      const ack = await this.ports.renderer.execute(requestId, command)
      if (ack.requestId !== requestId || ack.status !== 'completed') {
        throw orchestrationError('failed', 'Renderer returned an invalid acknowledgement.')
      }
      return ack
    } catch (error) {
      if (error instanceof WorkspaceOrchestrationError) throw error
      if (error instanceof RendererCommandError) {
        const code = controlCodeForRendererError(error.code)
        throw orchestrationError(code, safeRendererMessage(code))
      }
      throw orchestrationError('failed', 'Renderer command failed.')
    }
  }

  private serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.serialTails.get(key) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(task)
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    this.serialTails.set(key, tail)
    return run.finally(() => {
      if (this.serialTails.get(key) === tail) this.serialTails.delete(key)
    })
  }
}
