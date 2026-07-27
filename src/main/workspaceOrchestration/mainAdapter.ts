import * as path from 'node:path'
import { getDb } from '../db'
import { createControlAuditStore } from '../controlPlane/controlAudit'
import type { RuntimeLeaseRegistry } from '../controlPlane/runtimeLeases'
import { getClaudeGlobalSettings } from '../claudeSettings'
import { resolveOfferedModes } from '../orpheusConfig'
import { getProject } from '../projects'
import {
  closeWorkspace,
  createWorkspace,
  getWorkspace,
  listChildWorkspaces,
  openWorkspace,
  removeWorkspaceRecord,
  renameWorkspace,
  reopenWorkspace
} from '../workspaces'
import {
  branchExists,
  createWorktree,
  isWorktreeDirty,
  readWorktreeBaseRef,
  removeWorktree,
  resolveMainWorktree,
  withRepoLock,
  worktreeSlug
} from '../worktrees'
import { getTitle, withInjectLock } from '../workspaceResources'
import { WorkspaceOrchestrationService } from './service'
import { WorkspaceRuntimeCoordinator } from './runtimeCoordinator'
import { MainWorkspaceWaitEngine } from './waitEngine'
import type {
  ProjectSnapshot,
  WorkspaceMutationLease,
  WorkspaceMutationLeasePort,
  WorkspaceOperationActor,
  WorkspaceSnapshot,
  WorkspaceStorePort,
  WorkspaceWorktreePort
} from './types'

type SurfacePhase = 'none' | 'hidden' | 'attached' | 'visible' | 'freeing'

export type MainWorkspaceOrchestrationDeps = {
  runtimeLeases: RuntimeLeaseRegistry
  requestOpenWorkspace: (workspaceId: string, focus?: boolean) => void
  getSurfacePhase: (workspaceId: string) => SurfacePhase
  isWorkspaceSessionReady: (workspaceId: string) => boolean
  canInject: (workspaceId: string) => boolean
  sendInput: (
    workspaceId: string,
    text: string
  ) => {
    ok: boolean
    code?: string
    error?: string
  }
  submit: (workspaceId: string) => { ok: boolean; code?: string; error?: string }
  destroyWorkspaceRuntime: (workspaceId: string) => void | Promise<void>
}

export type MainWorkspaceOrchestration = {
  service: WorkspaceOrchestrationService
  waits: MainWorkspaceWaitEngine
}

function workspaceRevision(workspace: {
  name: string
  cwd: string
  lastOpenedAt: number | null
  closedAt: number | null
  archivedAt: number | null
  parentWorkspaceId: string | null
  worktreeParentCwd: string | null
  worktreeBranch: string | null
}): string {
  return JSON.stringify([
    workspace.name,
    workspace.cwd,
    workspace.lastOpenedAt,
    workspace.closedAt,
    workspace.archivedAt,
    workspace.parentWorkspaceId,
    workspace.worktreeParentCwd,
    workspace.worktreeBranch
  ])
}

function workspaceSnapshot(workspaceId: string): WorkspaceSnapshot | null {
  const workspace = getWorkspace(workspaceId)
  if (workspace == null) return null
  return {
    workspaceId: workspace.id,
    projectId: workspace.projectId,
    name: workspace.name,
    mode: workspace.worktreeParentCwd == null ? 'local' : 'worktree',
    cwd: workspace.cwd,
    parentWorkspaceId: workspace.parentWorkspaceId,
    closedAt: workspace.closedAt,
    archivedAt: workspace.archivedAt,
    revision: workspaceRevision(workspace),
    claudeConversationId: workspace.claudeSessionId,
    forkedFromConversationId: workspace.forkedFromSessionId,
    worktreeParentCwd: workspace.worktreeParentCwd,
    worktreeBranch: workspace.worktreeBranch
  }
}

function projectSnapshot(projectId: string): ProjectSnapshot | null {
  const project = getProject(projectId)
  if (project == null) return null
  return {
    projectId: project.id,
    cwd: project.path,
    revision: JSON.stringify([project.path, project.lastOpenedAt])
  }
}

function unchanged(workspaceId: string, revision: string): boolean {
  return workspaceSnapshot(workspaceId)?.revision === revision
}

function createStorePort(
  takeLastTitle: (workspaceId: string) => string | null
): WorkspaceStorePort {
  return {
    getProject: projectSnapshot,
    getWorkspace: workspaceSnapshot,
    listChildren: (workspaceId) =>
      listChildWorkspaces(workspaceId)
        .map((workspace) => workspaceSnapshot(workspace.id))
        .filter((workspace): workspace is WorkspaceSnapshot => workspace != null),
    create: async (record) => {
      const worktreeParentCwd =
        record.worktreeBranch == null ? null : await resolveMainWorktree(record.cwd)
      const created = createWorkspace({
        id: record.workspaceId,
        projectId: record.projectId,
        name: record.name,
        nameIsAuto: record.nameIsAuto,
        cwd: record.cwd,
        parentWorkspaceId: record.parentWorkspaceId,
        forkedFromSessionId: record.forkedFromConversationId,
        worktreeParentCwd,
        worktreeBranch: record.worktreeBranch
      })
      const snapshot = workspaceSnapshot(created.id)
      if (snapshot == null) throw new Error('Created workspace could not be read back.')
      return snapshot
    },
    markOpened: (workspaceId, expectedRevision) => {
      if (!unchanged(workspaceId, expectedRevision)) return null
      openWorkspace(workspaceId)
      return workspaceSnapshot(workspaceId)
    },
    close: (workspaceId, expectedRevision) => {
      if (!unchanged(workspaceId, expectedRevision)) return null
      closeWorkspace(workspaceId, takeLastTitle(workspaceId))
      return workspaceSnapshot(workspaceId)
    },
    reopen: (workspaceId, expectedRevision) => {
      if (!unchanged(workspaceId, expectedRevision)) return null
      reopenWorkspace(workspaceId)
      return workspaceSnapshot(workspaceId)
    },
    rename: (workspaceId, name, expectedRevision) => {
      if (!unchanged(workspaceId, expectedRevision)) return null
      renameWorkspace(workspaceId, name)
      return workspaceSnapshot(workspaceId)
    },
    remove: (workspaceId, expectedRevision) => {
      if (!unchanged(workspaceId, expectedRevision)) return false
      takeLastTitle(workspaceId)
      return removeWorkspaceRecord(workspaceId)
    }
  }
}

function createWorktreePort(): WorkspaceWorktreePort {
  return {
    derivePath: ({ project, workspaceId, name }) =>
      path.join(
        project.cwd,
        '.claude',
        'worktrees',
        `${worktreeSlug(name)}-${workspaceId.slice(0, 8)}`
      ),
    create: async ({ project, path: requestedPath, branch }) => {
      const repoRoot = await resolveMainWorktree(project.cwd)
      const offeredModes = await resolveOfferedModes(project.cwd, true)
      if (!offeredModes.worktree) {
        throw new Error('Worktree workspaces are disabled for this project.')
      }
      const slug = path.basename(requestedPath)
      const requestedBranch = branch ?? `worktree-${slug}`
      return withRepoLock(repoRoot, async () =>
        createWorktree({
          repoRoot,
          slug,
          branch: requestedBranch,
          mode: (await branchExists(repoRoot, requestedBranch)) ? 'existing' : 'new',
          baseRef: await readWorktreeBaseRef()
        })
      )
    },
    rollbackCreate: async ({ project, path: worktreePath }) => {
      const repoRoot = await resolveMainWorktree(project.cwd)
      const result = await withRepoLock(repoRoot, () =>
        removeWorktree({ path: worktreePath, repoRoot, force: true })
      )
      return result.removed
    },
    preflightRemove: async (workspace) => {
      const dirty = await isWorktreeDirty(workspace.cwd)
      return {
        safe: !dirty && workspace.worktreeParentCwd != null,
        dirty,
        ...(workspace.worktreeParentCwd == null
          ? { reason: 'Managed worktree root is unavailable.' }
          : {})
      }
    },
    remove: async (workspace) => {
      if (workspace.worktreeParentCwd == null) return false
      const result = await withRepoLock(workspace.worktreeParentCwd, () =>
        removeWorktree({
          path: workspace.cwd,
          repoRoot: workspace.worktreeParentCwd ?? undefined,
          force: false
        })
      )
      return result.removed
    }
  }
}

class ProjectMutationLeases implements WorkspaceMutationLeasePort {
  private readonly owners = new Map<string, string>()
  private readonly waiters = new Map<
    string,
    Array<{ requestId: string; resolve: (lease: WorkspaceMutationLease) => void }>
  >()

  acquire(key: string, requestId: string): WorkspaceMutationLease | null {
    if (this.owners.has(key)) return null
    this.owners.set(key, requestId)
    return this.createLease(key, requestId)
  }

  acquireWhenAvailable(key: string, requestId: string): Promise<WorkspaceMutationLease> {
    const acquired = this.acquire(key, requestId)
    if (acquired != null) return Promise.resolve(acquired)
    return new Promise((resolve) => {
      const queue = this.waiters.get(key) ?? []
      queue.push({ requestId, resolve })
      this.waiters.set(key, queue)
    })
  }

  private createLease(key: string, requestId: string): WorkspaceMutationLease {
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        if (this.owners.get(key) !== requestId) return
        this.owners.delete(key)
        const queue = this.waiters.get(key)
        const next = queue?.shift()
        if (queue?.length === 0) this.waiters.delete(key)
        if (next == null) return
        this.owners.set(key, next.requestId)
        next.resolve(this.createLease(key, next.requestId))
      }
    }
  }
}

function canAct(
  actor: WorkspaceOperationActor,
  runtimeLeases: RuntimeLeaseRegistry,
  projectId: string,
  workspaceIds: readonly string[],
  permission: WorkspaceOperationActor['permissions'][number]
): boolean {
  if (!actor.permissions.includes(permission) || actor.boundProjectId !== projectId) return false
  if (workspaceIds.some((workspaceId) => workspaceSnapshot(workspaceId)?.projectId !== projectId)) {
    return false
  }
  if (actor.consumer !== 'mcp') return true
  const runtimeId = actor.principal.runtimeId
  const binding = runtimeId == null ? null : runtimeLeases.getByRuntimeId(runtimeId)
  return (
    binding != null &&
    binding.projectId === projectId &&
    actor.boundWorkspaceId === binding.workspaceId
  )
}

export function createMainWorkspaceOrchestration(
  deps: MainWorkspaceOrchestrationDeps
): MainWorkspaceOrchestration {
  const waits = new MainWorkspaceWaitEngine()
  const lastTerminalTitles = new Map<string, string | null>()
  const runtime = new WorkspaceRuntimeCoordinator({
    requestOpen: (workspaceId) => deps.requestOpenWorkspace(workspaceId, false),
    getSurfacePhase: deps.getSurfacePhase,
    isSessionReady: deps.isWorkspaceSessionReady,
    canInject: deps.canInject,
    sendInput: deps.sendInput,
    submit: deps.submit,
    withInjectLock,
    destroyRuntime: async (workspaceId) => {
      lastTerminalTitles.set(workspaceId, getTitle(workspaceId) ?? null)
      await deps.destroyWorkspaceRuntime(workspaceId)
    }
  })
  const settings = getClaudeGlobalSettings()
  const service = new WorkspaceOrchestrationService({
    store: createStorePort((workspaceId) => {
      const title = lastTerminalTitles.get(workspaceId) ?? getTitle(workspaceId) ?? null
      lastTerminalTitles.delete(workspaceId)
      return title
    }),
    runtime,
    worktrees: createWorktreePort(),
    presentation: {
      focus: (workspaceId) => deps.requestOpenWorkspace(workspaceId, true)
    },
    waits,
    authorization: {
      revalidate: ({ actor, projectId, workspaceIds, permission }) =>
        canAct(actor, deps.runtimeLeases, projectId, workspaceIds, permission) ? 'allow' : 'deny',
      isRuntimeLeaseActive: (runtimeId) => deps.runtimeLeases.getByRuntimeId(runtimeId) != null
    },
    leases: new ProjectMutationLeases(),
    audit: createControlAuditStore(getDb()),
    onAuditFailure: (error, record) => {
      console.error('[controlAudit] append failed:', record.auditId, error)
    },
    maxLineageDepth: settings.maxWorkspaceDepth ?? 3,
    maxChildrenPerWorkspace: settings.maxWorkspaceChildren ?? 10
  })
  return { service, waits }
}
