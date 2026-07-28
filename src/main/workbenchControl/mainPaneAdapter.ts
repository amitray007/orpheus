import type { PaneLayout, PaneTerminal, WorkspaceRecord } from '../../shared/types'
import { PaneManagementPortError, type WorkbenchControlPorts } from './service'
import {
  type CreateDedicatedWorkspaceTerminalInput,
  type DedicatedWorkspaceTerminal,
  type DeleteDedicatedWorkspaceTerminalInput
} from '../paneStore'
import { PaneProvisioningStoreError } from './paneManagementErrors'

export type MainPaneControlDeps = {
  getLayout: (layoutId: string) => PaneLayout | null
  listTerminals: (layoutId: string) => PaneTerminal[]
  getWorkspace: (workspaceId: string) => WorkspaceRecord | null
  createDedicated: (input: CreateDedicatedWorkspaceTerminalInput) => DedicatedWorkspaceTerminal
  deleteDedicated: <T>(
    input: DeleteDedicatedWorkspaceTerminalInput,
    beforeDelete: (layout: PaneLayout, terminal: PaneTerminal) => T
  ) => {
    layout: PaneLayout
    terminal: PaneTerminal
    teardown: T
    persisted: 'deleted' | 'retained'
  }
  startConfigured: (
    layout: PaneLayout,
    terminal: PaneTerminal
  ) => 'started' | 'retained' | Promise<'started' | 'retained'>
  stopSurface: (layoutId: string, terminalId: string) => 'stopped' | 'absent'
  focusSurface: (layoutId: string, terminalId: string) => void | Promise<void>
}

function translateStoreError(error: unknown): never {
  if (error instanceof PaneProvisioningStoreError) {
    throw new PaneManagementPortError(error.code, error.message)
  }
  throw new PaneManagementPortError('failed', 'Pane terminal management failed.')
}

export function createMainPaneControlPort(
  deps: MainPaneControlDeps
): WorkbenchControlPorts['panes'] {
  return {
    resolve(layoutId, terminalId) {
      const layout = deps.getLayout(layoutId)
      if (layout == null) return null
      if (
        terminalId != null &&
        !deps.listTerminals(layoutId).some((terminal) => terminal.id === terminalId)
      ) {
        return null
      }
      return { layoutId, terminalId, panelId: layout.panelId }
    },
    start(layoutId, terminalId) {
      const layout = deps.getLayout(layoutId)
      const terminal = deps.listTerminals(layoutId).find((candidate) => candidate.id === terminalId)
      if (layout == null || terminal == null) {
        return Promise.reject(new Error('Pane terminal is unavailable.'))
      }
      return Promise.resolve(deps.startConfigured(layout, terminal))
    },
    startProvisioned(layoutId, terminalId, initialCommand) {
      const layout = deps.getLayout(layoutId)
      const terminal = deps.listTerminals(layoutId).find((candidate) => candidate.id === terminalId)
      if (layout == null || terminal == null) {
        return Promise.reject(new Error('Pane terminal is unavailable.'))
      }
      return Promise.resolve(deps.startConfigured(layout, { ...terminal, command: initialCommand }))
    },
    stop(layoutId, terminalId) {
      const layout = deps.getLayout(layoutId)
      const terminal = deps.listTerminals(layoutId).find((candidate) => candidate.id === terminalId)
      if (layout == null || terminal == null) {
        return Promise.reject(new Error('Pane terminal is unavailable.'))
      }
      return Promise.resolve(deps.stopSurface(layoutId, terminalId))
    },
    focus(layoutId, terminalId) {
      const layout = deps.getLayout(layoutId)
      const terminal = deps.listTerminals(layoutId).find((candidate) => candidate.id === terminalId)
      if (layout == null || terminal == null) {
        return Promise.reject(new Error('Pane terminal is unavailable.'))
      }
      return Promise.resolve(deps.focusSurface(layoutId, terminalId))
    },
    async provision(workspaceId, input) {
      const workspace = deps.getWorkspace(workspaceId)
      if (workspace == null) {
        throw new PaneManagementPortError('not_found', 'Workspace was not found.')
      }
      try {
        const created = deps.createDedicated({
          workspaceId,
          dir: workspace.cwd,
          layoutName: input.layoutName ?? `${workspace.name} terminal`,
          terminalName: input.terminalName ?? 'Terminal'
        })
        return {
          layoutId: created.layout.id,
          panelId: created.layout.panelId,
          terminalId: created.terminal.id,
          layoutUpdatedAt: created.layout.updatedAt,
          terminalUpdatedAt: created.terminal.updatedAt,
          initialCommand: input.initialCommand ?? ''
        }
      } catch (error) {
        return translateStoreError(error)
      }
    },
    async deleteDedicated(workspaceId, input) {
      const workspace = deps.getWorkspace(workspaceId)
      if (workspace == null) {
        throw new PaneManagementPortError('not_found', 'Workspace was not found.')
      }
      try {
        const deleted = deps.deleteDedicated(
          {
            workspaceId,
            layoutId: input.layoutId,
            terminalId: input.terminalId,
            expectedLayoutUpdatedAt: input.expectedLayoutUpdatedAt,
            expectedTerminalUpdatedAt: input.expectedTerminalUpdatedAt,
            dir: workspace.cwd
          },
          (_layout, terminal) => deps.stopSurface(input.layoutId, terminal.id)
        )
        return {
          target: {
            layoutId: deleted.layout.id,
            panelId: deleted.layout.panelId,
            terminalId: deleted.terminal.id,
            layoutUpdatedAt: deleted.layout.updatedAt,
            terminalUpdatedAt: deleted.terminal.updatedAt,
            initialCommand: ''
          },
          terminalState: deleted.teardown,
          persistence: deleted.persisted
        }
      } catch (error) {
        return translateStoreError(error)
      }
    }
  }
}
