import type { LocalReviewComment } from '../../shared/types'

export type ControlConsumer = 'renderer-ipc' | 'command-socket' | 'mcp' | 'automation'
export type ControlSurface = 'renderer' | 'command-socket' | 'mcp'
export type ControlKind = 'query' | 'mutation'
export type ControlPermission =
  | 'identity.read'
  | 'projects.read'
  | 'workspaces.read'
  | 'workspaces.create'
  | 'workspaces.open'
  | 'workspaces.send'
  | 'workspaces.wait'
  | 'workspaces.close'
  | 'workspaces.rename'
  | 'workspaces.archive'
  | 'terminals.read'
  | 'reviews.read'
  | 'reviews.resolve'
  | 'ui.workbench.control'
  | 'terminals.control'
  | 'settings.read'
  | 'settings.workspace.patch'
  | 'resources.read'
export type ControlErrorCode =
  | 'invalid'
  | 'not_found'
  | 'forbidden'
  | 'conflict'
  | 'busy'
  | 'unavailable'
  | 'timeout'
  | 'failed'

export type TrustedRuntimeBinding = Readonly<{
  runtimeId: string
  runtimeKind: 'claude' | 'workbench_shell' | 'pane_shell'
  surfaceId: string
  workspaceId: string | null
  projectId: string | null
  claudeConversationId: string | null
  issuedAt: number
  permissions: readonly ControlPermission[]
  resourceScope?: Readonly<{
    selfOnly: true
    layoutIds: readonly string[]
    surfaceIds: readonly string[]
  }>
}>

export type ControlContext = {
  principal: {
    type: 'renderer-user' | 'workspace-agent' | 'cli' | 'automation'
    id: string
  }
  consumer: ControlConsumer
  workspaceId: string | null
  projectId: string | null
  requestId: string
  /**
   * Main-resolved identity for a runtime-scoped lease. Ambient workspace/project
   * fields above remain compatibility target hints and never populate this value.
   */
  trustedRuntime?: TrustedRuntimeBinding | null
}

export type ControlResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ControlErrorCode; error: string }

export type ControlSchema = Readonly<Record<string, unknown>>

export type ControlScope =
  | Readonly<{ kind: 'self' }>
  | Readonly<{ kind: 'project'; inputField?: string }>
  | Readonly<{ kind: 'workspace'; inputField?: string }>
  | Readonly<{ kind: 'resource'; inputField: string }>

export type ControlDescriptor<TInput, TOutput> = {
  id: string
  version: 1
  kind: ControlKind
  description: string
  inputSchema: ControlSchema
  outputSchema: ControlSchema
  allowedSurfaces: readonly ControlSurface[]
  permission: ControlPermission
  scope: ControlScope
  risk: Readonly<{ tier: 0 | 1 | 2 | 3; label: string }>
  /** Maximum effects possible for validated input. Empty for pure queries. */
  declaredEffects?: readonly string[]
  validateInput: (input: unknown, context: ControlContext) => input is TInput
  handler: (input: TInput, context: ControlContext) => TOutput | Promise<TOutput>
}

export type ControlDescription = Omit<
  ControlDescriptor<unknown, unknown>,
  'validateInput' | 'handler'
>

export type ControlInvocation = {
  id: string
  input: unknown
  context: ControlContext
}

export type ControlInvoker = <T>(invocation: ControlInvocation) => Promise<ControlResult<T>>

export type ControlAuthorizationDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; code: 'not_found' | 'forbidden'; error: string }>

export type ControlAuthorizationPolicy = {
  canDiscover: (description: ControlDescription, context: ControlContext) => boolean
  authorize: (
    description: ControlDescription,
    input: unknown,
    context: ControlContext
  ) => ControlAuthorizationDecision | Promise<ControlAuthorizationDecision>
}

export type ControlRejectionAuditor = {
  auditRejected: (input: {
    description: ControlDescription
    params: unknown
    context: ControlContext
    code: 'invalid' | 'not_found' | 'forbidden'
    decision: 'deny'
  }) => void | Promise<void>
}

export type ControlReadSource = 'live' | 'sqlite' | 'claude-jsonl' | 'claude-session-file'
export type ControlReadAvailability = 'available' | 'unavailable' | 'unsupported'

export type ControlReadObservation<T> = {
  value: T | null
  source: ControlReadSource
  observedAt: number
  sourceUpdatedAt: number | null
  availability: ControlReadAvailability
  stale: boolean | null
  reason?: string
}

export type SelfReadModel = {
  schemaVersion: 1
  principal: {
    kind: 'orpheus_runtime'
    assurance: 'runtime_lease'
    runtimeId: string
  }
  runtime: {
    kind: TrustedRuntimeBinding['runtimeKind']
    issuedAt: number
  }
  surface: { surfaceId: string }
  workspace: { workspaceId: string; projectId: string; cwd: string } | null
  project: { projectId: string; name: string } | null
  claudeConversation: { claudeConversationId: string } | null
  defaults: {
    workspaceId: string | null
    projectId: string | null
    surfaceId: string
  }
  capabilities: { allow: readonly ControlPermission[] }
}

export type ProjectReadModel = {
  id: string
  name: string
  path: string
  addedAt: number
  lastOpenedAt: number | null
  pinnedAt: number | null
  classified: boolean
  hidden: boolean
}

export type WorkspaceReadModel = {
  id: string
  projectId: string
  name: string
  cwd: string
  pinnedAt: number | null
  createdAt: number
  lastOpenedAt: number | null
  archivedAt: number | null
  closedAt: number | null
  status: string
  claudeConversationId: string | null
  parentWorkspaceId: string | null
  worktreeParentCwd: string | null
  worktreeBranch: string | null
}

export type WorkspaceStatusReadModel = {
  persistedStatus: string
  liveStatus: 'busy' | 'idle' | 'waiting' | 'shell' | 'unknown'
  waitingFor?: string
}

export type TranscriptTurnReadModel = {
  role: 'user' | 'assistant'
  text: string
  timestamp: number | null
  toolActivity?: readonly {
    kind: 'tool_use' | 'tool_result'
    name?: string
    summary: string
  }[]
}

export type TranscriptReadModel = {
  turns: readonly TranscriptTurnReadModel[]
  truncated: boolean
  bytesRead: number
}

export type LastTurnReadModel = {
  userText: string | null
  assistantText: string | null
  userAt: number | null
  assistantAt: number | null
}

export type EmptyReadInput = Record<string, never>
export type ProjectGetInput = { projectId?: string }
export type WorkspaceListInput = {
  projectId?: string
  scope?: 'active' | 'archived' | 'all'
}
export type WorkspaceTargetInput = { workspaceId?: string }
export type WorkspaceTranscriptInput = WorkspaceTargetInput & {
  limit?: number
  role?: 'user' | 'assistant'
  since?: number
  includeToolActivity?: boolean
}

export type ReadCapabilityHandlers = {
  getSelf: (
    binding: TrustedRuntimeBinding,
    context: ControlContext
  ) => ControlReadObservation<SelfReadModel> | Promise<ControlReadObservation<SelfReadModel>>
  listProjects: (
    projectId: string,
    context: ControlContext
  ) =>
    | ControlReadObservation<readonly ProjectReadModel[]>
    | Promise<ControlReadObservation<readonly ProjectReadModel[]>>
  getProject: (
    projectId: string,
    context: ControlContext
  ) => ControlReadObservation<ProjectReadModel> | Promise<ControlReadObservation<ProjectReadModel>>
  listWorkspaces: (
    projectId: string,
    scope: 'active' | 'archived' | 'all',
    context: ControlContext
  ) =>
    | ControlReadObservation<readonly WorkspaceReadModel[]>
    | Promise<ControlReadObservation<readonly WorkspaceReadModel[]>>
  getWorkspace: (
    workspaceId: string,
    context: ControlContext
  ) =>
    | ControlReadObservation<WorkspaceReadModel>
    | Promise<ControlReadObservation<WorkspaceReadModel>>
  getWorkspaceStatus: (
    workspaceId: string,
    context: ControlContext
  ) =>
    | ControlReadObservation<WorkspaceStatusReadModel>
    | Promise<ControlReadObservation<WorkspaceStatusReadModel>>
  getWorkspaceTranscript: (
    workspaceId: string,
    input: Omit<WorkspaceTranscriptInput, 'workspaceId'>,
    context: ControlContext
  ) =>
    | ControlReadObservation<TranscriptReadModel>
    | Promise<ControlReadObservation<TranscriptReadModel>>
  getWorkspaceLastTurn: (
    workspaceId: string,
    context: ControlContext
  ) =>
    | ControlReadObservation<LastTurnReadModel>
    | Promise<ControlReadObservation<LastTurnReadModel>>
  listReviewsByWorkspace: (
    workspaceId: string,
    context: ControlContext
  ) => LocalReviewComment[] | Promise<LocalReviewComment[]>
}

export type ReviewListInput = { workspaceId: string }
export type ReviewSetResolvedInput = { id: string; resolved: boolean }

export type ReviewCapabilityHandlers = {
  listByWorkspace: (
    workspaceId: string,
    context: ControlContext
  ) => LocalReviewComment[] | Promise<LocalReviewComment[]>
  setResolved: (
    id: string,
    resolved: boolean,
    context: ControlContext
  ) => LocalReviewComment | Promise<LocalReviewComment>
}
