import * as os from 'node:os'
import * as path from 'node:path'
import type { LocalReviewComment, ProjectRecord, WorkspaceRecord } from '../../shared/types'
import { encodePathToClaudeDir } from '../claudeProjectDir'
import { observeTranscriptFile, type TranscriptFileObservation } from './transcriptObservation'
import type {
  ControlReadObservation,
  ProjectReadModel,
  ReadCapabilityHandlers,
  SelfReadModel,
  WorkspaceReadModel,
  WorkspaceStatusReadModel,
  WorkspaceTranscriptInput
} from './types'

type MaybePromise<T> = T | Promise<T>

export type MainReadHandlerDeps = {
  listProjects?: () => MaybePromise<ProjectRecord[]>
  getProject?: (projectId: string) => MaybePromise<ProjectRecord | null>
  listWorkspacesForProject?: (
    projectId: string,
    options: { scope: 'active' | 'archived' | 'all' }
  ) => MaybePromise<WorkspaceRecord[]>
  getWorkspace?: (workspaceId: string) => MaybePromise<WorkspaceRecord | null>
  listReviewsByWorkspace?: (workspaceId: string) => MaybePromise<LocalReviewComment[]>
  statusObservation?: (
    workspaceId: string,
    observedAt: number
  ) => MaybePromise<ControlReadObservation<WorkspaceStatusReadModel>>
  transcriptPathForWorkspace?: (workspace: WorkspaceRecord) => string | null
  observeTranscript?: (
    jsonlPath: string | null,
    options?: Omit<WorkspaceTranscriptInput, 'workspaceId'> & {
      observedAt?: number
      maxBytes?: number
    }
  ) => Promise<TranscriptFileObservation>
  now?: () => number
}

function toProjectReadModel(project: ProjectRecord): ProjectReadModel {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    addedAt: project.addedAt,
    lastOpenedAt: project.lastOpenedAt,
    pinnedAt: project.pinnedAt,
    classified: project.classified,
    hidden: project.hidden
  }
}

function toWorkspaceReadModel(workspace: WorkspaceRecord): WorkspaceReadModel {
  return {
    id: workspace.id,
    projectId: workspace.projectId,
    name: workspace.name,
    cwd: workspace.cwd,
    pinnedAt: workspace.pinnedAt,
    createdAt: workspace.createdAt,
    lastOpenedAt: workspace.lastOpenedAt,
    archivedAt: workspace.archivedAt,
    closedAt: workspace.closedAt,
    status: workspace.status,
    claudeConversationId: workspace.claudeSessionId,
    parentWorkspaceId: workspace.parentWorkspaceId,
    worktreeParentCwd: workspace.worktreeParentCwd,
    worktreeBranch: workspace.worktreeBranch
  }
}

function sqliteObservation<T>(
  value: T | null,
  observedAt: number,
  sourceUpdatedAt: number | null,
  reason?: string
): ControlReadObservation<T> {
  return {
    value,
    source: 'sqlite',
    observedAt,
    sourceUpdatedAt,
    availability: value == null ? 'unavailable' : 'available',
    stale: value == null ? null : false,
    ...(reason == null ? {} : { reason })
  }
}

function defaultTranscriptPath(workspace: WorkspaceRecord): string | null {
  if (workspace.claudeSessionId == null) return null
  return path.join(
    os.homedir(),
    '.claude',
    'projects',
    encodePathToClaudeDir(workspace.cwd),
    `${workspace.claudeSessionId}.jsonl`
  )
}

function maxProjectTimestamp(project: ProjectRecord): number {
  return Math.max(project.addedAt, project.lastOpenedAt ?? 0, project.pinnedAt ?? 0)
}

function maxWorkspaceTimestamp(workspace: WorkspaceRecord): number {
  return Math.max(
    workspace.createdAt,
    workspace.lastOpenedAt ?? 0,
    workspace.archivedAt ?? 0,
    workspace.closedAt ?? 0,
    workspace.pinnedAt ?? 0
  )
}

export function createMainReadHandlers(deps: MainReadHandlerDeps = {}): ReadCapabilityHandlers {
  const now = deps.now ?? Date.now
  const readProjects =
    deps.listProjects ?? (async () => (await import('../projects')).listProjects())
  const readProject =
    deps.getProject ??
    (async (projectId: string) => (await import('../projects')).getProject(projectId))
  const readWorkspaces =
    deps.listWorkspacesForProject ??
    (async (projectId: string, options: { scope: 'active' | 'archived' | 'all' }) =>
      (await import('../workspaces')).listWorkspacesForProject(projectId, options))
  const readWorkspace =
    deps.getWorkspace ??
    (async (workspaceId: string) => (await import('../workspaces')).getWorkspace(workspaceId))
  const readReviews =
    deps.listReviewsByWorkspace ??
    (async (workspaceId: string) => (await import('../reviewStore')).listByWorkspace(workspaceId))
  const transcriptPath = deps.transcriptPathForWorkspace ?? defaultTranscriptPath
  const observeTranscript = deps.observeTranscript ?? observeTranscriptFile

  return {
    async getSelf(binding): Promise<ControlReadObservation<SelfReadModel>> {
      const observedAt = now()
      const workspace =
        binding.workspaceId == null ? null : await readWorkspace(binding.workspaceId)
      const workspaceMatchesBinding =
        workspace != null &&
        (binding.projectId == null || workspace.projectId === binding.projectId)
      const safeWorkspace = workspaceMatchesBinding ? workspace : null
      const projectId = binding.projectId ?? safeWorkspace?.projectId ?? null
      const project = projectId == null ? null : await readProject(projectId)
      const value: SelfReadModel = {
        schemaVersion: 1,
        principal: {
          kind: 'orpheus_runtime',
          assurance: 'runtime_lease',
          runtimeId: binding.runtimeId
        },
        runtime: { kind: binding.runtimeKind, issuedAt: binding.issuedAt },
        surface: { surfaceId: binding.surfaceId },
        workspace:
          safeWorkspace == null
            ? null
            : {
                workspaceId: safeWorkspace.id,
                projectId: safeWorkspace.projectId,
                cwd: safeWorkspace.cwd
              },
        project:
          project == null
            ? null
            : {
                projectId: project.id,
                name: project.name
              },
        claudeConversation:
          binding.claudeConversationId == null
            ? null
            : { claudeConversationId: binding.claudeConversationId },
        defaults: {
          workspaceId: binding.workspaceId,
          projectId: binding.projectId,
          surfaceId: binding.surfaceId
        },
        capabilities: { allow: [...binding.permissions] }
      }
      const missingReason =
        workspace != null && !workspaceMatchesBinding
          ? 'Trusted runtime workspace/project binding did not match SQLite.'
          : binding.workspaceId != null && workspace == null
            ? 'Trusted runtime workspace was not found in SQLite.'
            : projectId != null && project == null
              ? 'Trusted runtime project was not found in SQLite.'
              : undefined
      return {
        value,
        source: 'live',
        observedAt,
        sourceUpdatedAt: null,
        availability: 'available',
        stale: false,
        ...(missingReason == null ? {} : { reason: missingReason })
      }
    },

    async listProjects(projectId): Promise<ControlReadObservation<readonly ProjectReadModel[]>> {
      const observedAt = now()
      const projects = (await readProjects()).filter((project) => project.id === projectId)
      return sqliteObservation(
        projects.map(toProjectReadModel),
        observedAt,
        projects.reduce((latest, project) => Math.max(latest, maxProjectTimestamp(project)), 0) ||
          null
      )
    },

    async getProject(projectId): Promise<ControlReadObservation<ProjectReadModel>> {
      const observedAt = now()
      const project = await readProject(projectId)
      return sqliteObservation(
        project == null ? null : toProjectReadModel(project),
        observedAt,
        project == null ? null : maxProjectTimestamp(project),
        project == null ? 'Project was not found.' : undefined
      )
    },

    async listWorkspaces(
      projectId,
      scope
    ): Promise<ControlReadObservation<readonly WorkspaceReadModel[]>> {
      const observedAt = now()
      const workspaces = (await readWorkspaces(projectId, { scope })).filter(
        (workspace) => workspace.projectId === projectId
      )
      return sqliteObservation(
        workspaces.map(toWorkspaceReadModel),
        observedAt,
        workspaces.reduce(
          (latest, workspace) => Math.max(latest, maxWorkspaceTimestamp(workspace)),
          0
        ) || null
      )
    },

    async getWorkspace(workspaceId): Promise<ControlReadObservation<WorkspaceReadModel>> {
      const observedAt = now()
      const workspace = await readWorkspace(workspaceId)
      return sqliteObservation(
        workspace == null ? null : toWorkspaceReadModel(workspace),
        observedAt,
        workspace == null ? null : maxWorkspaceTimestamp(workspace),
        workspace == null ? 'Workspace was not found.' : undefined
      )
    },

    async getWorkspaceStatus(
      workspaceId
    ): Promise<ControlReadObservation<WorkspaceStatusReadModel>> {
      const observedAt = now()
      if (deps.statusObservation != null) {
        return deps.statusObservation(workspaceId, observedAt)
      }
      const workspace = await readWorkspace(workspaceId)
      return {
        value:
          workspace == null ? null : { persistedStatus: workspace.status, liveStatus: 'unknown' },
        source: 'claude-session-file',
        observedAt,
        sourceUpdatedAt: null,
        availability: 'unsupported',
        stale: null,
        reason: 'Live workspace status observation was not configured.'
      }
    },

    async getWorkspaceTranscript(
      workspaceId,
      input
    ): Promise<TranscriptFileObservation['transcript']> {
      const observedAt = now()
      const workspace = await readWorkspace(workspaceId)
      if (workspace == null) {
        return {
          value: null,
          source: 'claude-jsonl',
          observedAt,
          sourceUpdatedAt: null,
          availability: 'unavailable',
          stale: null,
          reason: 'Workspace was not found.'
        }
      }
      const observation = await observeTranscript(transcriptPath(workspace), {
        ...input,
        observedAt
      })
      return observation.transcript
    },

    async getWorkspaceLastTurn(workspaceId): Promise<TranscriptFileObservation['lastTurn']> {
      const observedAt = now()
      const workspace = await readWorkspace(workspaceId)
      if (workspace == null) {
        return {
          value: null,
          source: 'claude-jsonl',
          observedAt,
          sourceUpdatedAt: null,
          availability: 'unavailable',
          stale: null,
          reason: 'Workspace was not found.'
        }
      }
      const observation = await observeTranscript(transcriptPath(workspace), {
        limit: 100,
        observedAt
      })
      return observation.lastTurn
    },

    listReviewsByWorkspace: async (workspaceId) => [...(await readReviews(workspaceId))]
  }
}
