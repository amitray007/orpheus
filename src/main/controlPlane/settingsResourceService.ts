import { randomUUID } from 'node:crypto'
import type {
  ClaudeEffort,
  ClaudeGlobalSettings,
  ClaudeHookEntry,
  ClaudeProjectSettings,
  ClaudeSlashCommand,
  ClaudeSubagent,
  ClaudeWorkspaceSettings,
  ClaudeWorkspaceSettingsOverrides,
  DiscoveredMcpServer,
  ProjectRecord,
  WorkspaceRecord
} from '../../shared/types'
import { CLAUDE_EFFORT_VALUES } from '../../shared/types'
import { findFlagValue } from '../../shared/cliFlags'
import type { ClaudeLaunch } from '../claudeSettings'
import type {
  EffectReceipt,
  WorkspaceAuditPort,
  WorkspaceControlAuditRecord
} from '../workspaceOrchestration/types'
import { recursivelyRedact } from '../workspaceOrchestration/redaction'
import type { ControlContext, ControlErrorCode, ControlPermission } from './types'

export const SETTINGS_GET_EFFECTIVE_ID = 'settings.getEffective'
export const SETTINGS_PATCH_WORKSPACE_ID = 'settings.patchWorkspace'
export const RESOURCES_LIST_PROJECT_METADATA_ID = 'resources.listProjectMetadata'

export const SETTINGS_RESOURCE_OPERATION_IDS = [
  SETTINGS_GET_EFFECTIVE_ID,
  SETTINGS_PATCH_WORKSPACE_ID,
  RESOURCES_LIST_PROJECT_METADATA_ID
] as const

export type GetEffectiveSettingsInput = { workspaceId?: string }

export type SettingProvenance<T> = {
  global: T
  projectOverride: T | null
  workspaceOverride: T | null
  effective: T
  source: 'global' | 'project' | 'workspace'
}

export type GetEffectiveSettingsOutput = {
  schemaVersion: 1
  projectId: string
  workspaceId: string
  settings: {
    model: SettingProvenance<string>
    effort: SettingProvenance<ClaudeEffort>
  }
  orpheus: {
    maxWorkspaceDepth: number
    maxWorkspaceChildren: number
  }
  restartRequired: boolean
  source: 'composeClaudeLaunch'
  observedAt: number
  updatedAt: {
    global: number
    project: number
    workspace: number
  }
}

export type PatchWorkspaceSettingsInput = {
  workspaceId?: string
  patch: {
    model?: string | null
    effort?: ClaudeEffort | null
  }
}

export type PatchWorkspaceSettingsOutput = {
  schemaVersion: 1
  requestId: string
  operationId: typeof SETTINGS_PATCH_WORKSPACE_ID
  projectId: string
  workspaceId: string
  applied: PatchWorkspaceSettingsInput['patch']
  effective: GetEffectiveSettingsOutput
  restartRequired: boolean
  effects: Array<{
    effect: 'db.write' | 'workspace.dirty.recompute'
    status: 'applied'
  }>
  auditId: string
}

export type ProjectResourceKind = 'mcp_server' | 'hook' | 'slash_command' | 'subagent'

export type ListProjectResourceMetadataInput = {
  projectId?: string
  kinds?: ProjectResourceKind[]
}

type ProjectResourceBase = {
  source: 'project'
  projectId: string
}

export type ProjectResourceMetadata =
  | (ProjectResourceBase & {
      kind: 'mcp_server'
      name: string
      transport: DiscoveredMcpServer['transport']
    })
  | (ProjectResourceBase & {
      kind: 'hook'
      event: string
      matcher: string | null
      type: string
    })
  | (ProjectResourceBase & {
      kind: 'slash_command'
      name: string
      description: string | null
      allowedTools: string[] | null
      argumentHint: string | null
    })
  | (ProjectResourceBase & {
      kind: 'subagent'
      name: string
      description: string | null
      tools: string[] | null
      model: string | null
    })

export type ListProjectResourceMetadataOutput = {
  schemaVersion: 1
  projectId: string
  source: 'project-files'
  observedAt: number
  resources: ProjectResourceMetadata[]
}

export type SettingsResourceServiceDeps = {
  getWorkspace: (workspaceId: string) => WorkspaceRecord | null
  getProject: (projectId: string) => ProjectRecord | null
  getGlobalSettings: () => ClaudeGlobalSettings
  getProjectSettings: (projectId: string) => ClaudeProjectSettings
  getWorkspaceSettings: (workspaceId: string) => ClaudeWorkspaceSettings
  composeLaunch: (
    projectId?: string,
    workspaceId?: string,
    precomputedGlobal?: ClaudeGlobalSettings
  ) => ClaudeLaunch
  updateWorkspaceSettings: (
    workspaceId: string,
    patch: ClaudeWorkspaceSettingsOverrides
  ) => ClaudeWorkspaceSettings
  reconcileEffort: <T extends { model?: string; effort?: ClaudeEffort }>(
    patch: T,
    projectId: string | undefined,
    workspaceId: string | undefined
  ) => T
  recomputeDirty: () => void
  isDirty: (workspaceId: string) => boolean
  listProjectMcpServers: (projectId: string) => DiscoveredMcpServer[]
  listProjectHooks: (projectId: string) => ClaudeHookEntry[]
  listProjectSlashCommands: (projectId: string) => ClaudeSlashCommand[]
  listProjectSubagents: (projectId: string) => ClaudeSubagent[]
  audit: WorkspaceAuditPort
  now?: () => number
  generateId?: () => string
}

type OperationAuditMeta = {
  id: string
  permission: ControlPermission
  tier: 0 | 1 | 2 | 3
  effects: readonly string[]
}

const RESOURCE_KIND_ORDER: readonly ProjectResourceKind[] = [
  'mcp_server',
  'hook',
  'slash_command',
  'subagent'
]
const SECRET_VALUE =
  /(?:bearer\s+\S+|(?:api[_-]?key|token|secret|password|authorization|cookie|lease)\s*[:=]\s*\S+|(?:sk|ghp|github_pat|xox[aboprs])[-_][A-Za-z0-9_-]{8,})/i
const SENSITIVE_LOCATION =
  /(?:\b[a-z][a-z0-9+.-]*:\/\/\S+|\b(?:file|ssh):\S+|(?:^|[\s("'`])(?:~\/|\/(?!\/)\S*|[A-Za-z]:[\\/]\S*))/i
const MAX_METADATA_LENGTH = 512
const MAX_METADATA_ITEMS = 64
const MAX_PUBLISHED_RESOURCES = 256
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/
const DB_WRITE_EFFECT = 'db.write' as const
const DIRTY_RECOMPUTE_EFFECT = 'workspace.dirty.recompute' as const
const APPLIED = 'applied' as const

export class SettingsResourceError extends Error {
  constructor(
    readonly code: ControlErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'SettingsResourceError'
  }
}

function stableNotFound(): SettingsResourceError {
  return new SettingsResourceError('not_found', 'Requested resource was not found.')
}

function sourceForOverride(
  projectValue: unknown,
  workspaceValue: unknown
): 'global' | 'project' | 'workspace' {
  if (workspaceValue !== undefined) return 'workspace'
  if (projectValue !== undefined) return 'project'
  return 'global'
}

function sanitizeMetadataString(value: string | null): string | null {
  if (value == null) return null
  if (SECRET_VALUE.test(value) || SENSITIVE_LOCATION.test(value)) return '[REDACTED]'
  return value.length <= MAX_METADATA_LENGTH ? value : `${value.slice(0, MAX_METADATA_LENGTH - 1)}…`
}

function sanitizeMetadataStrings(values: string[] | null): string[] | null {
  if (values == null) return null
  return values.slice(0, MAX_METADATA_ITEMS).map((value) => sanitizeMetadataString(value) ?? '')
}

function isEffort(value: unknown): value is ClaudeEffort {
  return (
    typeof value === 'string' &&
    CLAUDE_EFFORT_VALUES.includes(value as (typeof CLAUDE_EFFORT_VALUES)[number])
  )
}

function isModel(value: unknown): value is string {
  return typeof value === 'string' && MODEL_PATTERN.test(value)
}

function auditConsumer(
  consumer: ControlContext['consumer']
): WorkspaceControlAuditRecord['consumer'] {
  if (consumer === 'renderer-ipc') return 'renderer'
  if (consumer === 'command-socket') return 'cli'
  return consumer
}

export class SettingsResourceService {
  private readonly now: () => number
  private readonly generateId: () => string

  constructor(private readonly deps: SettingsResourceServiceDeps) {
    this.now = deps.now ?? Date.now
    this.generateId = deps.generateId ?? randomUUID
  }

  targetAllowed(operationId: string, input: unknown, context: ControlContext): boolean {
    try {
      if (operationId === SETTINGS_PATCH_WORKSPACE_ID) {
        const workspaceId = (input as PatchWorkspaceSettingsInput).workspaceId
        this.resolveWorkspace(workspaceId, context, true)
        return true
      }
      if (operationId === SETTINGS_GET_EFFECTIVE_ID) {
        const workspaceId = (input as GetEffectiveSettingsInput).workspaceId
        this.resolveWorkspace(workspaceId, context, false)
        return true
      }
      if (operationId === RESOURCES_LIST_PROJECT_METADATA_ID) {
        const projectId = (input as ListProjectResourceMetadataInput).projectId
        this.resolveProject(projectId, context)
        return true
      }
      return false
    } catch {
      return false
    }
  }

  getEffective(
    input: GetEffectiveSettingsInput,
    context: ControlContext
  ): GetEffectiveSettingsOutput {
    try {
      const workspace = this.resolveWorkspace(input.workspaceId, context, false)
      return this.effectiveForWorkspace(workspace)
    } catch (error) {
      if (error instanceof SettingsResourceError) throw error
      throw new SettingsResourceError('unavailable', 'Effective settings are unavailable.')
    }
  }

  listProjectMetadata(
    input: ListProjectResourceMetadataInput,
    context: ControlContext
  ): ListProjectResourceMetadataOutput {
    try {
      const projectId = this.resolveProject(input.projectId, context)
      const requested = new Set<ProjectResourceKind>(input.kinds ?? RESOURCE_KIND_ORDER)
      const resources: ProjectResourceMetadata[] = []

      if (requested.has('mcp_server')) {
        for (const server of this.deps.listProjectMcpServers(projectId)) {
          resources.push({
            kind: 'mcp_server',
            source: 'project',
            projectId,
            name: sanitizeMetadataString(server.name) ?? '',
            transport: server.transport
          })
        }
      }
      if (requested.has('hook')) {
        for (const hook of this.deps.listProjectHooks(projectId)) {
          resources.push({
            kind: 'hook',
            source: 'project',
            projectId,
            event: sanitizeMetadataString(hook.event) ?? '',
            matcher: sanitizeMetadataString(hook.matcher),
            type: sanitizeMetadataString(hook.type) ?? ''
          })
        }
      }
      if (requested.has('slash_command')) {
        for (const command of this.deps.listProjectSlashCommands(projectId)) {
          resources.push({
            kind: 'slash_command',
            source: 'project',
            projectId,
            name: sanitizeMetadataString(command.name) ?? '',
            description: sanitizeMetadataString(command.description),
            allowedTools: sanitizeMetadataStrings(command.allowedTools),
            argumentHint: sanitizeMetadataString(command.argumentHint)
          })
        }
      }
      if (requested.has('subagent')) {
        for (const subagent of this.deps.listProjectSubagents(projectId)) {
          resources.push({
            kind: 'subagent',
            source: 'project',
            projectId,
            name: sanitizeMetadataString(subagent.name) ?? '',
            description: sanitizeMetadataString(subagent.description),
            tools: sanitizeMetadataStrings(subagent.tools),
            model: sanitizeMetadataString(subagent.model)
          })
        }
      }

      const kindRank = (kind: ProjectResourceKind): number => RESOURCE_KIND_ORDER.indexOf(kind)
      resources.sort((a, b) => {
        const rank = kindRank(a.kind) - kindRank(b.kind)
        if (rank !== 0) return rank
        return JSON.stringify(a).localeCompare(JSON.stringify(b))
      })

      return {
        schemaVersion: 1,
        projectId,
        source: 'project-files',
        observedAt: this.now(),
        resources: resources.slice(0, MAX_PUBLISHED_RESOURCES)
      }
    } catch (error) {
      if (error instanceof SettingsResourceError) throw error
      throw new SettingsResourceError('unavailable', 'Project resource metadata is unavailable.')
    }
  }

  async patchWorkspace(
    input: PatchWorkspaceSettingsInput,
    context: ControlContext
  ): Promise<PatchWorkspaceSettingsOutput> {
    const auditId = this.generateId()
    let workspace: WorkspaceRecord | null = null
    let decision: 'allow' | 'deny' = 'deny'
    const receipts: EffectReceipt[] = []
    let dirtyRecomputeStarted = false
    try {
      workspace = this.resolveWorkspace(input.workspaceId, context, true)
      decision = 'allow'
      const storePatch = this.storePatch(input.patch, workspace)

      this.deps.updateWorkspaceSettings(workspace.id, storePatch)
      receipts.push({ effect: DB_WRITE_EFFECT, status: APPLIED, workspaceId: workspace.id })
      dirtyRecomputeStarted = true
      this.deps.recomputeDirty()
      receipts.push({
        effect: DIRTY_RECOMPUTE_EFFECT,
        status: APPLIED,
        workspaceId: workspace.id
      })
      const effective = this.effectiveForWorkspace(workspace)
      const output: PatchWorkspaceSettingsOutput = {
        schemaVersion: 1,
        requestId: context.requestId,
        operationId: SETTINGS_PATCH_WORKSPACE_ID,
        projectId: workspace.projectId,
        workspaceId: workspace.id,
        applied: { ...input.patch },
        effective,
        restartRequired: effective.restartRequired,
        effects: [
          { effect: DB_WRITE_EFFECT, status: APPLIED },
          { effect: DIRTY_RECOMPUTE_EFFECT, status: APPLIED }
        ],
        auditId
      }
      await this.appendAudit(
        auditId,
        {
          id: SETTINGS_PATCH_WORKSPACE_ID,
          permission: 'settings.workspace.patch',
          tier: 2,
          effects: [DB_WRITE_EFFECT, DIRTY_RECOMPUTE_EFFECT]
        },
        input,
        context,
        workspace.projectId,
        [workspace.id],
        'allow',
        'completed',
        receipts
      )
      return output
    } catch (error) {
      if (
        dirtyRecomputeStarted &&
        !receipts.some((receipt) => receipt.effect === DIRTY_RECOMPUTE_EFFECT)
      ) {
        receipts.push({
          effect: DIRTY_RECOMPUTE_EFFECT,
          status: 'failed',
          ...(workspace == null ? {} : { workspaceId: workspace.id })
        })
      }
      await this.appendAudit(
        auditId,
        {
          id: SETTINGS_PATCH_WORKSPACE_ID,
          permission: 'settings.workspace.patch',
          tier: 2,
          effects: [DB_WRITE_EFFECT, DIRTY_RECOMPUTE_EFFECT]
        },
        input,
        context,
        workspace?.projectId ?? context.trustedRuntime?.projectId ?? null,
        workspace == null ? [] : [workspace.id],
        decision,
        error instanceof SettingsResourceError ? error.code : 'failed',
        receipts
      )
      if (error instanceof SettingsResourceError) throw error
      throw new SettingsResourceError('failed', 'Workspace settings update failed.')
    }
  }

  async auditRejected(input: {
    meta: OperationAuditMeta
    params: unknown
    context: ControlContext
    code: 'invalid' | 'not_found' | 'forbidden'
  }): Promise<void> {
    await this.appendAudit(
      this.generateId(),
      input.meta,
      input.params,
      input.context,
      input.context.trustedRuntime?.projectId ?? null,
      [],
      'deny',
      input.code
    )
  }

  private effectiveForWorkspace(workspace: WorkspaceRecord): GetEffectiveSettingsOutput {
    const global = this.deps.getGlobalSettings()
    const project = this.deps.getProjectSettings(workspace.projectId)
    const scopedWorkspace = this.deps.getWorkspaceSettings(workspace.id)
    const launch = this.deps.composeLaunch(workspace.projectId, workspace.id, global)
    const composedEffort = findFlagValue(launch.flags, '--effort') ?? 'auto'
    if (
      !isModel(global.model) ||
      !isModel(launch.model) ||
      (project.overrides.model !== undefined && !isModel(project.overrides.model)) ||
      (scopedWorkspace.overrides.model !== undefined &&
        !isModel(scopedWorkspace.overrides.model)) ||
      !isEffort(global.effort) ||
      !isEffort(composedEffort) ||
      (project.overrides.effort !== undefined && !isEffort(project.overrides.effort)) ||
      (scopedWorkspace.overrides.effort !== undefined &&
        !isEffort(scopedWorkspace.overrides.effort))
    ) {
      throw new SettingsResourceError('unavailable', 'Effective settings are unavailable.')
    }

    const projectModel = project.overrides.model
    const workspaceModel = scopedWorkspace.overrides.model
    const projectEffort = project.overrides.effort
    const workspaceEffort = scopedWorkspace.overrides.effort

    return {
      schemaVersion: 1,
      projectId: workspace.projectId,
      workspaceId: workspace.id,
      settings: {
        model: {
          global: global.model,
          projectOverride: projectModel ?? null,
          workspaceOverride: workspaceModel ?? null,
          effective: launch.model,
          source: sourceForOverride(projectModel, workspaceModel)
        },
        effort: {
          global: global.effort,
          projectOverride: projectEffort ?? null,
          workspaceOverride: workspaceEffort ?? null,
          effective: composedEffort,
          source: sourceForOverride(projectEffort, workspaceEffort)
        }
      },
      orpheus: {
        maxWorkspaceDepth: global.maxWorkspaceDepth,
        maxWorkspaceChildren: global.maxWorkspaceChildren
      },
      restartRequired: this.deps.isDirty(workspace.id),
      source: 'composeClaudeLaunch',
      observedAt: this.now(),
      updatedAt: {
        global: global.updatedAt,
        project: project.updatedAt,
        workspace: scopedWorkspace.updatedAt
      }
    }
  }

  private resolveWorkspace(
    workspaceId: string | undefined,
    context: ControlContext,
    selfOnly: boolean
  ): WorkspaceRecord {
    const binding = context.trustedRuntime
    if (binding?.workspaceId == null || binding.projectId == null) throw stableNotFound()
    const targetId = workspaceId ?? binding.workspaceId
    if (selfOnly && targetId !== binding.workspaceId) throw stableNotFound()
    const workspace = this.deps.getWorkspace(targetId)
    if (workspace == null || workspace.projectId !== binding.projectId) throw stableNotFound()
    return workspace
  }

  private resolveProject(projectId: string | undefined, context: ControlContext): string {
    const binding = context.trustedRuntime
    if (binding?.projectId == null) throw stableNotFound()
    const targetId = projectId ?? binding.projectId
    if (targetId !== binding.projectId || this.deps.getProject(targetId) == null) {
      throw stableNotFound()
    }
    return targetId
  }

  private storePatch(
    patch: PatchWorkspaceSettingsInput['patch'],
    workspace: WorkspaceRecord
  ): ClaudeWorkspaceSettingsOverrides {
    const storePatch: ClaudeWorkspaceSettingsOverrides = {}
    if (Object.hasOwn(patch, 'model')) {
      storePatch.model = patch.model ?? undefined
    }
    if (Object.hasOwn(patch, 'effort')) {
      storePatch.effort = patch.effort ?? undefined
    }
    if (typeof storePatch.model === 'string') {
      return this.deps.reconcileEffort(storePatch, workspace.projectId, workspace.id)
    }
    if (patch.model === null && !Object.hasOwn(patch, 'effort')) {
      const global = this.deps.getGlobalSettings()
      const project = this.deps.getProjectSettings(workspace.projectId)
      const inheritedModel = project.overrides.model ?? global.model
      if (!isModel(inheritedModel)) {
        throw new SettingsResourceError('unavailable', 'Effective settings are unavailable.')
      }
      const inheritedPatch: { model: string; effort?: ClaudeEffort } = {
        model: inheritedModel
      }
      const reconciled = this.deps.reconcileEffort(
        inheritedPatch,
        workspace.projectId,
        workspace.id
      )
      if (reconciled.effort !== undefined) storePatch.effort = reconciled.effort
    }
    return storePatch
  }

  private async appendAudit(
    auditId: string,
    meta: OperationAuditMeta,
    params: unknown,
    context: ControlContext,
    projectId: string | null,
    workspaceIds: string[],
    decision: 'allow' | 'deny',
    result: WorkspaceControlAuditRecord['result']['code'],
    receipts: EffectReceipt[] = []
  ): Promise<void> {
    const binding = context.trustedRuntime
    const record: WorkspaceControlAuditRecord = {
      schemaVersion: 1,
      auditId,
      requestId: context.requestId,
      occurredAt: this.now(),
      consumer: auditConsumer(context.consumer),
      operation: { id: meta.id, version: 1 },
      principal: {
        kind: binding == null ? context.principal.type : 'orpheus_runtime',
        runtimeId: binding?.runtimeId ?? null
      },
      target: { projectId, workspaceIds },
      permission: meta.permission,
      tier: meta.tier,
      decision,
      declaredEffects: [...meta.effects],
      redactedParams: recursivelyRedact(params),
      receipts,
      result: { code: result },
      correlation: { requestId: context.requestId }
    }
    try {
      await this.deps.audit.append(record)
    } catch {
      // Audit diagnostics must not expose secret-bearing internal exceptions or
      // change the already-authorized domain result.
    }
  }
}
