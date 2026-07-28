import type {
  ControlContext,
  LastTurnReadModel,
  TranscriptReadModel,
  WorkspaceStatusReadModel
} from '../controlPlane/types'

export type TerminalKind = 'workspace_claude' | 'workbench' | 'pane'
export type NativeSurfacePhase = 'none' | 'hidden' | 'attached' | 'visible' | 'freeing'
export type ObservationAvailability = 'available' | 'unavailable' | 'unsupported' | 'offline'
export type ObservationFreshness = 'live' | 'current' | 'stale' | 'offline' | 'unknown'
export type TerminalObservationSource =
  | 'live'
  | 'sqlite'
  | 'native-surface-registry'
  | 'claude-session-file'
  | 'claude-jsonl'
  | 'configured-runtime'
  | 'authoritative-text-stream'

export type TerminalObservation<T> = {
  value: T | null
  source: TerminalObservationSource
  observedAt: number
  sourceUpdatedAt: number | null
  freshness: ObservationFreshness
  availability: ObservationAvailability
  reason?: string
}

export type WorkspaceClaudeTarget = {
  kind: 'workspace_claude'
  workspaceId?: string
}

export type WorkbenchTarget = {
  kind: 'workbench'
  workspaceId: string
  terminalId: number
}

export type PaneTarget = {
  kind: 'pane'
  layoutId: string
  paneId: string
}

export type TerminalTarget = WorkspaceClaudeTarget | WorkbenchTarget | PaneTarget

export type ResolvedTerminalTarget =
  | {
      kind: 'workspace_claude'
      terminalId: string
      surfaceId: string
      workspaceId: string
      projectId: string
    }
  | {
      kind: 'workbench'
      terminalId: string
      surfaceId: string
      workspaceId: string
      projectId: string
      workbenchTerminalId: number
    }
  | {
      kind: 'pane'
      terminalId: string
      surfaceId: string
      layoutId: string
      paneId: string
    }

export type TerminalSummary = {
  terminalId: string
  kind: TerminalKind
  workspaceId: string | null
  projectId: string | null
  layoutId: string | null
  paneId: string | null
  surfaceRegistered: boolean
}

export type TerminalListModel = {
  terminals: readonly TerminalSummary[]
  truncated: boolean
}

export type TerminalLifecycleModel = {
  registered: boolean
  phase: NativeSurfacePhase
}

export type TerminalRuntimeModel = {
  running: boolean | null
  ready: boolean | null
  runtimeId: string | null
  pid: number | null
}

export type TerminalConfigurationModel = {
  command: string
  cwd: string
}

export type TerminalActivityModel = {
  activity: string
  persistedStatus: string
  liveStatus: WorkspaceStatusReadModel['liveStatus']
  waitingFor: string | null
}

export type ClaudeSessionMetadataModel = {
  claudeConversationId: string
  pid: number | null
  version: string | null
  cwd: string | null
  status: 'busy' | 'idle' | 'waiting' | 'shell' | 'starting' | 'unknown'
  waitingFor: string | null
  statusUpdatedAt: number | null
}

export type TerminalSnapshot = {
  schemaVersion: 1
  terminal: TerminalSummary
  lifecycle: TerminalObservation<TerminalLifecycleModel>
  runtime: TerminalObservation<TerminalRuntimeModel>
  activity: TerminalObservation<TerminalActivityModel>
  configuration: TerminalObservation<TerminalConfigurationModel>
  claudeSession: TerminalObservation<ClaudeSessionMetadataModel>
}

export type ClaudeSessionSnapshot = {
  schemaVersion: 1
  workspaceId: string
  session: TerminalObservation<ClaudeSessionMetadataModel>
  transcript: TerminalObservation<TranscriptReadModel>
  lastTurn: TerminalObservation<LastTurnReadModel>
}

export type OutputTailModel = {
  text: string
  bytes: number
  lines: number
  truncated: boolean
}

export type TerminalEventKind = 'lifecycle' | 'runtime' | 'readiness' | 'activity'

export type TerminalObservationEvent = {
  revision: number
  terminalId: string
  kind: TerminalEventKind
  observedAt: number
  source: TerminalObservationSource
  state: Record<string, unknown>
}

export type TerminalSubscriptionSnapshot = {
  terminalId: string
  snapshot: TerminalSnapshot
}

export type TerminalSubscriptionResult = {
  schemaVersion: 1
  cursor: number
  oldestRevision: number
  timedOut: boolean
  resyncRequired: boolean
  capacityLimited: boolean
  snapshots: readonly TerminalSubscriptionSnapshot[]
  events: readonly TerminalObservationEvent[]
}

export type ListTerminalsInput = Record<string, never>
export type GetTerminalInput = { target?: TerminalTarget }
export type GetClaudeSessionInput = {
  workspaceId?: string
  transcriptLimit?: number
  includeToolActivity?: boolean
}
export type GetOutputTailInput = {
  target?: TerminalTarget
  maxBytes?: number
  maxLines?: number
}
export type SubscribeTerminalsInput = {
  target?: TerminalTarget
  afterRevision?: number
  timeoutMs?: number
  maxEvents?: number
}

export type AuthoritativeOutputProvider = {
  readTail: (
    target: ResolvedTerminalTarget,
    limits: { maxBytes: number; maxLines: number },
    observedAt: number
  ) => TerminalObservation<OutputTailModel> | Promise<TerminalObservation<OutputTailModel>>
}

export type TerminalObservationHandlers = {
  list: (
    context: ControlContext
  ) => TerminalObservation<TerminalListModel> | Promise<TerminalObservation<TerminalListModel>>
  get: (
    input: GetTerminalInput,
    context: ControlContext
  ) => TerminalSnapshot | Promise<TerminalSnapshot>
  getClaudeSession: (
    input: GetClaudeSessionInput,
    context: ControlContext
  ) => ClaudeSessionSnapshot | Promise<ClaudeSessionSnapshot>
  getOutputTail: (
    input: GetOutputTailInput,
    context: ControlContext
  ) => TerminalObservation<OutputTailModel> | Promise<TerminalObservation<OutputTailModel>>
  subscribe: (
    input: SubscribeTerminalsInput,
    context: ControlContext
  ) => TerminalSubscriptionResult | Promise<TerminalSubscriptionResult>
}
