import type { ControlConsumer, ControlPermission } from '../controlPlane/types'

export type WorkspacePresentation = 'background' | 'focus'
export type WorkspaceMode = 'local' | 'worktree'
export type WorkspaceWaitUntil = 'done' | 'input' | 'idle'
export type WorkspaceOperationStatus = 'completed' | 'partial'
export type EffectStatus = 'applied' | 'skipped' | 'failed'

export type WorkspaceRef = {
  workspaceId: string
  projectId: string
  name: string
  mode: WorkspaceMode
  cwd: string
  parentWorkspaceId: string | null
  closedAt: number | null
  archivedAt: number | null
}

export type WorkspaceSnapshot = WorkspaceRef & {
  revision: string
  claudeConversationId: string | null
  forkedFromConversationId: string | null
  worktreeParentCwd: string | null
  worktreeBranch: string | null
}

export type ProjectSnapshot = {
  projectId: string
  cwd: string
  revision: string
}

export type EffectReceipt = {
  effect: string
  status: EffectStatus
  workspaceId?: string
  resourceId?: string
  message?: string
}

export type WorkspaceOperationReceipt<T> = {
  schemaVersion: 1
  requestId: string
  operationId: string
  status: WorkspaceOperationStatus
  target: {
    projectId: string
    workspaceId: string | null
  }
  value: T
  effects: EffectReceipt[]
  auditId: string
}

export type WorkspaceOperationActor = {
  requestId: string
  consumer: ControlConsumer
  principal: {
    kind: string
    runtimeId: string | null
  }
  boundProjectId: string | null
  boundWorkspaceId: string | null
  permissions: readonly ControlPermission[]
  correlation?: Readonly<{
    automationId: string
    runId: string
    idempotencyKey: string
  }>
}

export type CreateWorkspaceInput = {
  mode: WorkspaceMode
  name?: string
  parentWorkspaceId?: string
  fork?: boolean
  branch?: string
  presentation?: WorkspacePresentation
}

export type StartTaskInput = {
  workspaceId?: string
  text: string
  presentation?: WorkspacePresentation
}

export type OpenWorkspaceInput = {
  workspaceId?: string
  presentation?: WorkspacePresentation
}

export type SendWorkspaceInput = {
  workspaceId?: string
  text: string
  submit?: boolean
  presentation?: WorkspacePresentation
}

export type WaitWorkspacesInput = {
  workspaceIds?: string[]
  until?: WorkspaceWaitUntil
  timeoutMs?: number
}

export type CloseWorkspaceInput = { workspaceId: string }
export type ReopenWorkspaceInput = { workspaceId: string }
export type RenameWorkspaceInput = { workspaceId?: string; name: string }
export type ArchiveWorkspaceInput = { workspaceId: string; recursive?: boolean }
export type GetLineageInput = { workspaceId?: string }

export type CreateWorkspaceValue = {
  workspace: WorkspaceRef
  lineage: {
    parentWorkspaceId: string | null
    forkedFromConversationId: string | null
  }
  presentation: WorkspacePresentation
}

export type StartTaskValue = {
  workspaceId: string
  accepted: true
  submitted: true
}

export type OpenWorkspaceValue = {
  workspace: WorkspaceRef
  presentation: WorkspacePresentation
  runtimeState: 'retained' | 'started'
}

export type SendWorkspaceValue = {
  workspaceId: string
  accepted: true
  submitted: boolean
}

export type WaitWorkspaceResult = {
  workspaceId: string
  outcome: 'done' | 'blocked_permission' | 'blocked_input' | 'died' | 'timeout' | 'not_found'
  status: string | null
  observedAt: number
}

export type WaitWorkspacesOutput = {
  schemaVersion: 1
  requestedUntil: WorkspaceWaitUntil
  timedOut: boolean
  results: WaitWorkspaceResult[]
}

export type CloseWorkspaceValue = { workspace: WorkspaceRef; closed: true }
export type ReopenWorkspaceValue = { workspace: WorkspaceRef; closed: false }
export type RenameWorkspaceValue = { workspace: WorkspaceRef; previousName: string }

export type ArchiveWorkspaceValue = {
  rootWorkspaceId: string
  recursive: boolean
  order: string[]
  workspaces: Array<{
    workspaceId: string
    status: 'archived' | 'skipped' | 'failed'
    persistedRecord: 'removed' | 'retained'
  }>
}

export type GetLineageOutput = {
  workspace: WorkspaceRef
  ancestors: WorkspaceRef[]
  children: WorkspaceRef[]
}

export type WorkspaceCreateRecord = {
  workspaceId: string
  projectId: string
  name: string
  nameIsAuto: boolean
  cwd: string
  parentWorkspaceId: string | null
  forkedFromConversationId: string | null
  worktreeParentCwd: string | null
  worktreeBranch: string | null
}

export type WorkspaceStorePort = {
  getProject: (projectId: string) => ProjectSnapshot | null | Promise<ProjectSnapshot | null>
  getWorkspace: (
    workspaceId: string
  ) => WorkspaceSnapshot | null | Promise<WorkspaceSnapshot | null>
  listChildren: (
    workspaceId: string
  ) => readonly WorkspaceSnapshot[] | Promise<readonly WorkspaceSnapshot[]>
  create: (record: WorkspaceCreateRecord) => WorkspaceSnapshot | Promise<WorkspaceSnapshot>
  markOpened: (
    workspaceId: string,
    expectedRevision: string
  ) => WorkspaceSnapshot | null | Promise<WorkspaceSnapshot | null>
  close: (
    workspaceId: string,
    expectedRevision: string
  ) => WorkspaceSnapshot | null | Promise<WorkspaceSnapshot | null>
  reopen: (
    workspaceId: string,
    expectedRevision: string
  ) => WorkspaceSnapshot | null | Promise<WorkspaceSnapshot | null>
  rename: (
    workspaceId: string,
    name: string,
    expectedRevision: string
  ) => WorkspaceSnapshot | null | Promise<WorkspaceSnapshot | null>
  remove: (workspaceId: string, expectedRevision: string) => boolean | Promise<boolean>
}

export type WorkspaceRuntimePort = {
  ensureOpen: (
    workspace: WorkspaceSnapshot
  ) =>
    | { runtimeState: 'retained' | 'started'; effects: EffectReceipt[] }
    | Promise<{ runtimeState: 'retained' | 'started'; effects: EffectReceipt[] }>
  waitUntilReady: (workspaceId: string, deadlineAt: number) => boolean | Promise<boolean>
  sendText: (workspaceId: string, text: string, submit: boolean) => void | Promise<void>
  canTeardown: (workspaceId: string) => boolean | Promise<boolean>
  teardown: (
    workspaceId: string
  ) => { effects: EffectReceipt[] } | Promise<{ effects: EffectReceipt[] }>
}

export type WorktreePreflight = {
  safe: boolean
  dirty: boolean
  reason?: string
}

export type WorkspaceWorktreePort = {
  derivePath: (input: { project: ProjectSnapshot; workspaceId: string; name: string }) => string
  create: (input: {
    project: ProjectSnapshot
    path: string
    branch?: string
  }) => { path: string; branch: string } | Promise<{ path: string; branch: string }>
  rollbackCreate: (input: {
    project: ProjectSnapshot
    path: string
    branch: string
  }) => boolean | Promise<boolean>
  preflightRemove: (workspace: WorkspaceSnapshot) => WorktreePreflight | Promise<WorktreePreflight>
  remove: (workspace: WorkspaceSnapshot) => boolean | Promise<boolean>
}

export type WorkspacePresentationPort = {
  focus: (workspaceId: string) => void | Promise<void>
}

export type WorkspaceWaitObservation = {
  status: string | null
  outcome?: 'done' | 'blocked_permission' | 'blocked_input' | 'died'
}

export type WorkspaceWaitSession = {
  observe: (
    workspaceId: string
  ) => WorkspaceWaitObservation | null | Promise<WorkspaceWaitObservation | null>
  waitForChange: (workspaceIds: readonly string[], deadlineAt: number) => void | Promise<void>
  dispose: () => void
}

export type WorkspaceWaitPort = {
  createSession: (workspaceIds: readonly string[]) => WorkspaceWaitSession
}

export type WorkspaceAuthorizationRequest = {
  actor: WorkspaceOperationActor
  operationId: string
  permission: ControlPermission
  tier: 0 | 1 | 2 | 3
  declaredEffects: readonly string[]
  projectId: string
  workspaceIds: readonly string[]
}

export type WorkspaceAuthorizationPort = {
  revalidate: (
    request: WorkspaceAuthorizationRequest
  ) => 'allow' | 'ask' | 'deny' | Promise<'allow' | 'ask' | 'deny'>
  isRuntimeLeaseActive: (runtimeId: string) => boolean | Promise<boolean>
}

export type WorkspaceMutationLease = { release: () => void | Promise<void> }

export type WorkspaceMutationLeasePort = {
  acquire: (
    key: string,
    requestId: string
  ) => WorkspaceMutationLease | null | Promise<WorkspaceMutationLease | null>
  acquireWhenAvailable: (
    key: string,
    requestId: string
  ) => WorkspaceMutationLease | Promise<WorkspaceMutationLease>
}

export type WorkspaceControlAuditRecord = {
  schemaVersion: 1
  auditId: string
  requestId: string
  occurredAt: number
  consumer: 'mcp' | 'renderer' | 'cli' | 'automation'
  operation: { id: string; version: 1 }
  principal: {
    kind: string
    runtimeId: string | null
  }
  target: {
    projectId: string | null
    workspaceIds: string[]
  }
  permission: string
  tier: 0 | 1 | 2 | 3
  decision: 'allow' | 'ask' | 'deny'
  declaredEffects: string[]
  redactedParams: Record<string, unknown>
  receipts: EffectReceipt[]
  result: {
    code:
      | 'completed'
      | 'partial'
      | 'invalid'
      | 'not_found'
      | 'forbidden'
      | 'conflict'
      | 'busy'
      | 'unavailable'
      | 'timeout'
      | 'failed'
  }
  correlation?: Record<string, unknown>
}

export type WorkspaceAuditPort = {
  append: (record: WorkspaceControlAuditRecord) => void | Promise<void>
}

export type WorkspaceOrchestrationPorts = {
  store: WorkspaceStorePort
  runtime: WorkspaceRuntimePort
  worktrees: WorkspaceWorktreePort
  presentation: WorkspacePresentationPort
  waits: WorkspaceWaitPort
  authorization: WorkspaceAuthorizationPort
  leases: WorkspaceMutationLeasePort
  audit: WorkspaceAuditPort
  onAuditFailure?: (error: unknown, record: WorkspaceControlAuditRecord) => void | Promise<void>
  now?: () => number
  generateId?: () => string
  readinessTimeoutMs?: number
  maxLineageDepth?: number
  maxChildrenPerWorkspace?: number
}
