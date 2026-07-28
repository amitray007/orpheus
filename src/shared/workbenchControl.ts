export type WorkbenchControlTab = 'git' | 'terminal' | 'files'
export type WorkbenchFileMode = 'viewer' | 'preview'

export type WorkbenchDiffTarget =
  | { kind: 'working-tree-file'; path: string }
  | { kind: 'local-review'; reviewId: string }

export type RendererControlCommand =
  | { kind: 'workbench.readState'; workspaceId: string }
  | { kind: 'workbench.selectTab'; workspaceId: string; tab: WorkbenchControlTab }
  | {
      kind: 'workbench.openFile'
      workspaceId: string
      path: string
      mode: WorkbenchFileMode
    }
  | { kind: 'workbench.openDiff'; workspaceId: string; target: WorkbenchDiffTarget }
  | { kind: 'panes.readState'; layoutId: string }
  | { kind: 'panes.selectLayout'; layoutId: string }
  | { kind: 'panes.validateTerminal'; layoutId: string; terminalId: string }
  | { kind: 'panes.presentTerminal'; layoutId: string; terminalId: string }
  | { kind: 'panes.presentCreatedTerminal'; layoutId: string; terminalId: string }
  | { kind: 'panes.reconcileDeletedLayout'; layoutId: string; panelId: string }
  | {
      kind: 'panes.commitTerminalState'
      layoutId: string
      terminalId: string
      desiredState: 'running' | 'stopped'
    }

export type RendererControlRequest = {
  requestId: string
  generation: number
  command: RendererControlCommand
}

export function rendererControlRequiresPresentation(command: RendererControlCommand): boolean {
  return (
    command.kind === 'workbench.selectTab' ||
    command.kind === 'workbench.openFile' ||
    command.kind === 'workbench.openDiff' ||
    command.kind === 'panes.selectLayout' ||
    command.kind === 'panes.presentTerminal' ||
    command.kind === 'panes.presentCreatedTerminal'
  )
}

export type RendererControlAck = {
  requestId: string
  generation: number
  status: 'completed' | 'unavailable' | 'conflict' | 'not_found' | 'failed'
  observedAt: number
  value?: unknown
  error?: string
}

export type WorkbenchStateV1 = {
  schemaVersion: 1
  workspaceId: string
  observedAt: number
  source: 'renderer-live'
  workbench: {
    state: 'dormant' | 'open' | 'expanded'
    activeTab: WorkbenchControlTab
  }
  file: { path: string; mode: WorkbenchFileMode } | null
  diff: {
    kind: WorkbenchDiffTarget['kind']
    path: string
    reviewId: string | null
  } | null
}

export type PaneStateV1 = {
  schemaVersion: 1
  observedAt: number
  source: 'renderer-live'
  layoutId: string
  panelId: string
  selected: boolean
  focusedTerminalId: string | null
  terminals: Array<{
    terminalId: string
    selected: boolean
    desiredState: 'running' | 'stopped'
  }>
}

export type PaneTerminalLayoutMutationV1 = {
  layoutId: string
  panelId: string
  terminalId: string
  layoutUpdatedAt: number
  terminalUpdatedAt: number
}

export type PaneLayoutDeletionStateV1 = {
  schemaVersion: 1
  observedAt: number
  source: 'renderer-live'
  deletedLayoutId: string
  selectedLayoutId: string | null
}
