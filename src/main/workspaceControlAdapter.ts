import type {
  ActionErrorCode,
  ActionResult,
  CreateWorktreeParams,
  ProjectRecord,
  WorkspaceForkParams,
  WorkspaceRecord
} from '../shared/types'
import type {
  ControlContext,
  ControlErrorCode,
  ControlInvoker,
  ControlResult
} from './controlPlane/types'
import type {
  ArchiveWorkspaceValue,
  CloseWorkspaceValue,
  CreateWorkspaceInput,
  CreateWorkspaceValue,
  RenameWorkspaceValue,
  ReopenWorkspaceValue,
  WorkspaceOperationReceipt
} from './workspaceOrchestration/types'

type LegacyArchiveResult = { archived: boolean; wasDirty: boolean }
type LegacyCloseResult =
  | { ok: true; workspace: WorkspaceRecord | null }
  | { ok: false; error: 'busy' }
type RendererCreateArgs = { projectId: string; name: string; cwd: string }

export type WorkspaceControlAdapterDeps = {
  invoke: ControlInvoker
  getProject: (projectId: string) => ProjectRecord | null
  getWorkspace: (workspaceId: string) => WorkspaceRecord | null
  isDirtyArchiveTarget: (workspaceId: string) => boolean | Promise<boolean>
  acknowledgeRendererOpen: (workspaceId: string) => unknown
}

export class WorkspaceControlAdapterError extends Error {
  constructor(
    readonly code: ControlErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'WorkspaceControlAdapterError'
  }
}

export function rendererWorkspaceContext(
  senderId: number,
  projectId: string,
  workspaceId: string | null
): ControlContext {
  return {
    principal: { type: 'renderer-user', id: `webContents:${senderId}` },
    consumer: 'renderer-ipc',
    workspaceId,
    projectId,
    requestId: crypto.randomUUID()
  }
}

function requireCompleted<T>(
  result: ControlResult<WorkspaceOperationReceipt<T>>
): WorkspaceOperationReceipt<T> {
  if (!result.ok) throw new WorkspaceControlAdapterError(result.code, result.error)
  if (result.value.status === 'partial') {
    throw new WorkspaceControlAdapterError(
      'failed',
      `Workspace operation completed partially: ${result.value.operationId}`
    )
  }
  return result.value
}

function actionError<T>(error: unknown): ActionResult<T> {
  if (!(error instanceof WorkspaceControlAdapterError)) {
    return {
      ok: false,
      code: 'failed',
      error: error instanceof Error ? error.message : String(error)
    }
  }
  const code: ActionErrorCode =
    error.code === 'busy' || error.code === 'not_found' || error.code === 'invalid'
      ? error.code
      : 'failed'
  return { ok: false, code, error: error.message }
}

export class WorkspaceControlAdapter {
  constructor(private readonly deps: WorkspaceControlAdapterDeps) {}

  async createLocal(senderId: number, args: RendererCreateArgs): Promise<WorkspaceRecord> {
    const project = this.requireProject(args.projectId)
    // `cwd` remains in the legacy IPC request for compatibility, but main derives
    // the actual cwd from the registered project through the orchestration service.
    void args.cwd
    return this.createAndRead(
      senderId,
      project,
      // `args.name` is always a renderer-generated placeholder ("Workspace N"),
      // never a deliberate user rename, so nameIsAuto must stay true here even
      // though a name is supplied — otherwise the title pipeline (terminal
      // title / lastTitle) gets permanently masked by resolveWorkspaceName's
      // manual-name early return.
      { mode: 'local', name: args.name, nameIsAuto: true, presentation: 'background' },
      null
    )
  }

  async createWorktree(
    senderId: number,
    projectId: string,
    params: CreateWorktreeParams
  ): Promise<WorkspaceRecord> {
    const project = this.requireProject(projectId)
    const branch = params.branch?.trim()
    return this.createAndRead(
      senderId,
      project,
      {
        mode: 'worktree',
        name: params.name,
        // Same reasoning as createLocal: params.name is a branch-derived
        // placeholder from the renderer, not a user-chosen name.
        nameIsAuto: true,
        ...(branch ? { branch } : {}),
        presentation: 'background'
      },
      null
    )
  }

  async close(senderId: number, workspaceId: string): Promise<WorkspaceRecord> {
    const workspace = this.requireWorkspace(workspaceId)
    const receipt = requireCompleted(
      await this.deps.invoke<WorkspaceOperationReceipt<CloseWorkspaceValue>>({
        id: 'workspaces.close',
        input: { workspaceId },
        context: rendererWorkspaceContext(senderId, workspace.projectId, workspaceId)
      })
    )
    return this.requireFullWorkspace(receipt.value.workspace.workspaceId)
  }

  async acknowledgeRendererOpen(workspaceId: string): Promise<WorkspaceRecord> {
    await this.deps.acknowledgeRendererOpen(workspaceId)
    return this.requireFullWorkspace(workspaceId)
  }

  async reopen(senderId: number, workspaceId: string): Promise<WorkspaceRecord> {
    const workspace = this.requireWorkspace(workspaceId)
    const receipt = requireCompleted(
      await this.deps.invoke<WorkspaceOperationReceipt<ReopenWorkspaceValue>>({
        id: 'workspaces.reopen',
        input: { workspaceId },
        context: rendererWorkspaceContext(senderId, workspace.projectId, workspaceId)
      })
    )
    return this.requireFullWorkspace(receipt.value.workspace.workspaceId)
  }

  async rename(senderId: number, workspaceId: string, name: string): Promise<WorkspaceRecord> {
    const workspace = this.requireWorkspace(workspaceId)
    const receipt = requireCompleted(
      await this.deps.invoke<WorkspaceOperationReceipt<RenameWorkspaceValue>>({
        id: 'workspaces.rename',
        input: { workspaceId, name },
        context: rendererWorkspaceContext(senderId, workspace.projectId, workspaceId)
      })
    )
    return this.requireFullWorkspace(receipt.value.workspace.workspaceId)
  }

  async archive(senderId: number, workspaceId: string): Promise<LegacyArchiveResult> {
    const workspace = this.requireWorkspace(workspaceId)
    const result = await this.deps.invoke<WorkspaceOperationReceipt<ArchiveWorkspaceValue>>({
      id: 'workspaces.archive',
      input: { workspaceId, recursive: false },
      context: rendererWorkspaceContext(senderId, workspace.projectId, workspaceId)
    })
    if (!result.ok) {
      if (result.code === 'conflict' && (await this.deps.isDirtyArchiveTarget(workspaceId))) {
        return { archived: false, wasDirty: true }
      }
      throw new WorkspaceControlAdapterError(result.code, result.error)
    }
    requireCompleted(result)
    return { archived: true, wasDirty: false }
  }

  async forkAction(
    senderId: number,
    params: Record<string, unknown>,
    workspaceId: string
  ): Promise<ActionResult<{ workspaceId: string }>> {
    try {
      const parent = this.requireWorkspace(workspaceId)
      if (!parent.claudeSessionId) {
        return {
          ok: false,
          code: 'invalid',
          error: 'Parent workspace has no session to fork from — use duplicate instead'
        }
      }
      const { name, worktree } = params as WorkspaceForkParams
      const newName = name ?? (parent.name ? `${parent.name} (fork)` : 'Forked workspace')
      const created = await this.createAndRead(
        senderId,
        this.requireProject(parent.projectId),
        {
          mode: worktree === true ? 'worktree' : 'local',
          name: newName,
          parentWorkspaceId: parent.id,
          fork: true,
          presentation: 'background'
        },
        parent.id
      )
      return { ok: true, value: { workspaceId: created.id } }
    } catch (error) {
      return actionError(error)
    }
  }

  async duplicateAction(
    senderId: number,
    params: Record<string, unknown>,
    workspaceId: string
  ): Promise<ActionResult<{ workspaceId: string }>> {
    try {
      const parent = this.requireWorkspace(workspaceId)
      let name: string
      if (typeof params['name'] === 'string') {
        name = params['name']
      } else if (typeof params['nameSuffix'] === 'string' && params['nameSuffix'].length > 0) {
        name = parent.name ? `${parent.name}${params['nameSuffix']}` : params['nameSuffix']
      } else {
        name = parent.name ? `${parent.name} (copy)` : 'Duplicate workspace'
      }
      // Deliberately use an unbound workspace context and omit parentWorkspaceId:
      // the service otherwise defaults an omitted parent from the bound workspace.
      const created = await this.createAndRead(
        senderId,
        this.requireProject(parent.projectId),
        { mode: 'local', name, presentation: 'background' },
        null
      )
      return { ok: true, value: { workspaceId: created.id } }
    } catch (error) {
      return actionError(error)
    }
  }

  async renameAction(
    senderId: number,
    params: Record<string, unknown>,
    workspaceId: string
  ): Promise<ActionResult<void>> {
    const name = params['name']
    if (typeof name !== 'string' || name.trim() === '') {
      return { ok: false, code: 'invalid', error: 'name must be a non-empty string' }
    }
    try {
      await this.rename(senderId, workspaceId, name.trim())
      return { ok: true }
    } catch (error) {
      return actionError(error)
    }
  }

  async archiveAction(
    senderId: number,
    workspaceId: string
  ): Promise<ActionResult<{ wasDirty: boolean }>> {
    try {
      const result = await this.archive(senderId, workspaceId)
      if (!result.archived) {
        return { ok: false, code: 'invalid', error: 'worktree_dirty' }
      }
      return { ok: true, value: { wasDirty: result.wasDirty } }
    } catch (error) {
      return actionError(error)
    }
  }

  private async createAndRead(
    senderId: number,
    project: ProjectRecord,
    input: CreateWorkspaceInput,
    contextWorkspaceId: string | null
  ): Promise<WorkspaceRecord> {
    const receipt = requireCompleted(
      await this.deps.invoke<WorkspaceOperationReceipt<CreateWorkspaceValue>>({
        id: 'workspaces.create',
        input,
        context: rendererWorkspaceContext(senderId, project.id, contextWorkspaceId)
      })
    )
    return this.requireFullWorkspace(receipt.value.workspace.workspaceId)
  }

  private requireProject(projectId: string): ProjectRecord {
    const project = this.deps.getProject(projectId)
    if (project == null) {
      throw new WorkspaceControlAdapterError('not_found', `Project not found: ${projectId}`)
    }
    return project
  }

  private requireWorkspace(workspaceId: string): WorkspaceRecord {
    const workspace = this.deps.getWorkspace(workspaceId)
    if (workspace == null) {
      throw new WorkspaceControlAdapterError('not_found', `Workspace not found: ${workspaceId}`)
    }
    return workspace
  }

  private requireFullWorkspace(workspaceId: string): WorkspaceRecord {
    const workspace = this.deps.getWorkspace(workspaceId)
    if (workspace == null) {
      throw new WorkspaceControlAdapterError(
        'failed',
        `Workspace result could not be resolved: ${workspaceId}`
      )
    }
    return workspace
  }
}

export async function closeWorkspaceForRenderer(
  workspaceControl: WorkspaceControlAdapter,
  senderId: number,
  workspaceId: string,
  activity: string
): Promise<LegacyCloseResult> {
  if (activity === 'in_progress') return { ok: false, error: 'busy' }
  try {
    return { ok: true, workspace: await workspaceControl.close(senderId, workspaceId) }
  } catch (error) {
    if (error instanceof WorkspaceControlAdapterError && error.code === 'not_found') {
      return { ok: true, workspace: null }
    }
    throw error
  }
}

export async function reopenWorkspaceForRenderer(
  workspaceControl: WorkspaceControlAdapter,
  senderId: number,
  workspaceId: string
): Promise<{ ok: true; workspace: WorkspaceRecord | null }> {
  try {
    return { ok: true, workspace: await workspaceControl.reopen(senderId, workspaceId) }
  } catch (error) {
    if (error instanceof WorkspaceControlAdapterError && error.code === 'not_found') {
      return { ok: true, workspace: null }
    }
    throw error
  }
}

export async function archiveWorkspaceForRenderer(
  workspaceControl: WorkspaceControlAdapter,
  performForcedArchive: (workspaceId: string) => Promise<LegacyArchiveResult>,
  senderId: number,
  workspaceId: string,
  force: boolean
): Promise<LegacyArchiveResult> {
  return force ? performForcedArchive(workspaceId) : workspaceControl.archive(senderId, workspaceId)
}
