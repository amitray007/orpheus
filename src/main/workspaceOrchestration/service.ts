import { randomUUID } from 'node:crypto'
import type { ControlErrorCode, ControlPermission } from '../controlPlane/types'
import { WorkspaceOrchestrationError, orchestrationError } from './errors'
import { recursivelyRedact } from './redaction'
import { isWaitTerminal } from './waitState'
import type {
  ArchiveWorkspaceInput,
  ArchiveWorkspaceValue,
  CloseWorkspaceInput,
  CloseWorkspaceValue,
  CreateWorkspaceInput,
  CreateWorkspaceValue,
  EffectReceipt,
  GetLineageInput,
  GetLineageOutput,
  OpenWorkspaceInput,
  OpenWorkspaceValue,
  ProjectSnapshot,
  RenameWorkspaceInput,
  RenameWorkspaceValue,
  ReopenWorkspaceInput,
  ReopenWorkspaceValue,
  SendWorkspaceInput,
  SendWorkspaceValue,
  StartTaskInput,
  StartTaskValue,
  WaitWorkspaceResult,
  WaitWorkspacesInput,
  WaitWorkspacesOutput,
  WorkspaceControlAuditRecord,
  WorkspaceMutationLease,
  WorkspaceOperationActor,
  WorkspaceOperationReceipt,
  WorkspaceOperationStatus,
  WorkspaceOrchestrationPorts,
  WorkspaceRef,
  WorkspaceSnapshot,
  WorkspaceWaitObservation,
  WorkspaceWaitSession
} from './types'

const READ_EFFECTS: readonly string[] = []
const CREATE_EFFECTS = [
  'db.write',
  'git.worktree.create',
  'filesystem.write',
  'surface.mount',
  'process.spawn',
  'ui.focus'
] as const
const SEND_EFFECTS = ['surface.mount', 'process.spawn', 'terminal.input', 'ui.focus'] as const
const OPEN_EFFECTS = ['surface.mount', 'process.spawn', 'db.write', 'ui.focus'] as const
const CLOSE_EFFECTS = ['surface.destroy', 'process.terminate', 'db.write'] as const
const REOPEN_EFFECTS = ['db.write'] as const
const RENAME_EFFECTS = ['db.write'] as const
const ARCHIVE_EFFECTS = [
  'surface.destroy',
  'process.terminate',
  'git.worktree.remove',
  'filesystem.delete',
  'workspace.delete',
  'db.write'
] as const

const DEFAULT_READINESS_TIMEOUT_MS = 25_000
const DEFAULT_MAX_LINEAGE_DEPTH = 32
const DEFAULT_MAX_CHILDREN = 32
const DEFAULT_WORKSPACE_NAME = 'New workspace'
const RESOURCE_NOT_FOUND = 'Requested resource was not found.'
const MAX_WAIT_OBSERVE_CONCURRENCY = 8

async function observeWorkspaces(
  workspaceIds: readonly string[],
  observe: WorkspaceWaitSession['observe']
): Promise<Map<string, WorkspaceWaitObservation | null>> {
  const results = new Map<string, WorkspaceWaitObservation | null>()
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < workspaceIds.length) {
      const index = cursor++
      const workspaceId = workspaceIds[index]
      if (workspaceId == null) continue
      results.set(workspaceId, await observe(workspaceId))
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(MAX_WAIT_OBSERVE_CONCURRENCY, workspaceIds.length) }, async () =>
      worker()
    )
  )
  return results
}

export type OperationMeta = {
  id: string
  permission: ControlPermission
  tier: 0 | 1 | 2 | 3
  effects: readonly string[]
}

type AuditState = {
  auditId: string
  actor: WorkspaceOperationActor
  meta: OperationMeta
  params: unknown
  projectId: string | null
  workspaceIds: string[]
  decision: 'allow' | 'ask' | 'deny'
  auditAttempted: boolean
}

type MutationResult<T> = {
  projectId: string
  workspaceId: string | null
  value: T
  effects: EffectReceipt[]
  status?: WorkspaceOperationStatus
  workspaceIds?: string[]
}

const OPERATIONS = {
  getLineage: {
    id: 'workspaces.getLineage',
    permission: 'workspaces.read',
    tier: 0,
    effects: READ_EFFECTS
  },
  create: {
    id: 'workspaces.create',
    permission: 'workspaces.create',
    tier: 2,
    effects: CREATE_EFFECTS
  },
  startTask: {
    id: 'workspaces.startTask',
    permission: 'workspaces.send',
    tier: 2,
    effects: SEND_EFFECTS
  },
  open: {
    id: 'workspaces.open',
    permission: 'workspaces.open',
    tier: 1,
    effects: OPEN_EFFECTS
  },
  send: {
    id: 'workspaces.send',
    permission: 'workspaces.send',
    tier: 2,
    effects: SEND_EFFECTS
  },
  wait: {
    id: 'workspaces.wait',
    permission: 'workspaces.wait',
    tier: 0,
    effects: READ_EFFECTS
  },
  close: {
    id: 'workspaces.close',
    permission: 'workspaces.close',
    tier: 2,
    effects: CLOSE_EFFECTS
  },
  reopen: {
    id: 'workspaces.reopen',
    permission: 'workspaces.open',
    tier: 1,
    effects: REOPEN_EFFECTS
  },
  rename: {
    id: 'workspaces.rename',
    permission: 'workspaces.rename',
    tier: 2,
    effects: RENAME_EFFECTS
  },
  archive: {
    id: 'workspaces.archive',
    permission: 'workspaces.archive',
    tier: 3,
    effects: ARCHIVE_EFFECTS
  }
} as const satisfies Record<string, OperationMeta>

function toRef(workspace: WorkspaceSnapshot): WorkspaceRef {
  return {
    workspaceId: workspace.workspaceId,
    projectId: workspace.projectId,
    name: workspace.name,
    mode: workspace.mode,
    cwd: workspace.cwd,
    parentWorkspaceId: workspace.parentWorkspaceId,
    closedAt: workspace.closedAt,
    archivedAt: workspace.archivedAt
  }
}

function consumerForAudit(
  consumer: WorkspaceOperationActor['consumer']
): WorkspaceControlAuditRecord['consumer'] {
  if (consumer === 'renderer-ipc') return 'renderer'
  if (consumer === 'command-socket') return 'cli'
  return consumer
}

function errorCode(error: unknown): ControlErrorCode {
  return error instanceof WorkspaceOrchestrationError ? error.code : 'failed'
}

function safeError(error: unknown): WorkspaceOrchestrationError {
  if (error instanceof WorkspaceOrchestrationError) return error
  return orchestrationError('failed', 'Workspace operation failed.')
}

function normalizeName(name: string): string {
  const controlCharacters = new RegExp(
    `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]+`,
    'g'
  )
  const normalized = name.replace(controlCharacters, ' ').replace(/\s+/g, ' ').trim()
  if (normalized.length === 0 || normalized.length > 120) {
    throw orchestrationError('invalid', 'Workspace name must contain 1 to 120 characters.')
  }
  return normalized
}

function receipt(
  effect: string,
  status: EffectReceipt['status'],
  workspaceId?: string,
  resourceId?: string,
  message?: string
): EffectReceipt {
  return {
    effect,
    status,
    ...(workspaceId == null ? {} : { workspaceId }),
    ...(resourceId == null ? {} : { resourceId }),
    ...(message == null ? {} : { message })
  }
}

function sortedIds(workspaces: readonly WorkspaceSnapshot[]): string[] {
  return workspaces.map((workspace) => workspace.workspaceId).sort()
}

export class WorkspaceOrchestrationService {
  private readonly now: () => number
  private readonly generateId: () => string
  private readonly readinessTimeoutMs: number
  private readonly maxLineageDepth: number
  private readonly maxChildrenPerWorkspace: number

  constructor(private readonly ports: WorkspaceOrchestrationPorts) {
    this.now = ports.now ?? Date.now
    this.generateId = ports.generateId ?? randomUUID
    this.readinessTimeoutMs = ports.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
    this.maxLineageDepth = ports.maxLineageDepth ?? DEFAULT_MAX_LINEAGE_DEPTH
    this.maxChildrenPerWorkspace = ports.maxChildrenPerWorkspace ?? DEFAULT_MAX_CHILDREN
  }

  async auditRejected(
    meta: OperationMeta,
    params: unknown,
    actor: WorkspaceOperationActor,
    code: 'invalid' | 'not_found' | 'forbidden',
    decision: 'deny'
  ): Promise<void> {
    const state = this.auditState(actor, meta, params)
    state.decision = decision
    const target =
      params != null &&
      typeof params === 'object' &&
      typeof (params as Record<string, unknown>)['workspaceId'] === 'string'
        ? String((params as Record<string, unknown>)['workspaceId'])
        : actor.boundWorkspaceId
    state.workspaceIds = target == null ? [] : [target]
    await this.audit(state, code, [])
  }

  async getLineage(
    input: GetLineageInput,
    actor: WorkspaceOperationActor
  ): Promise<GetLineageOutput> {
    const state = this.auditState(actor, OPERATIONS.getLineage, input)
    try {
      const workspace = await this.resolveWorkspace(input.workspaceId, actor)
      state.projectId = workspace.projectId
      state.workspaceIds = [workspace.workspaceId]
      await this.authorize(state, workspace.projectId, [workspace.workspaceId])
      const ancestors: WorkspaceRef[] = []
      const seen = new Set([workspace.workspaceId])
      let parentId = workspace.parentWorkspaceId
      while (parentId != null) {
        if (seen.has(parentId) || ancestors.length >= this.maxLineageDepth) {
          throw orchestrationError('conflict', 'Workspace lineage is inconsistent.')
        }
        const parent = await this.resolveWorkspaceInProject(parentId, workspace.projectId)
        seen.add(parent.workspaceId)
        ancestors.push(toRef(parent))
        parentId = parent.parentWorkspaceId
      }
      const children = await this.sameProjectChildren(workspace)
      await this.audit(state, 'completed', [])
      return { workspace: toRef(workspace), ancestors, children: children.map(toRef) }
    } catch (error) {
      await this.auditFailure(state, error)
      throw safeError(error)
    }
  }

  async create(
    input: CreateWorkspaceInput,
    actor: WorkspaceOperationActor
  ): Promise<WorkspaceOperationReceipt<CreateWorkspaceValue>> {
    // Creation intentionally keeps its worktree rollback and typed-partial
    // accounting in one journal-owning closure.
    // eslint-disable-next-line sonarjs/cognitive-complexity
    return this.runMutation(OPERATIONS.create, input, actor, async (state, effects) => {
      const project = await this.resolveProject(actor)
      state.projectId = project.projectId
      const parent = await this.resolveCreateParent(
        input.parentWorkspaceId,
        actor,
        project.projectId
      )
      if (parent != null) await this.preflightNewChild(parent)
      if (input.fork === true && parent?.claudeConversationId == null) {
        throw orchestrationError('conflict', 'The selected parent has no eligible conversation.')
      }
      const workspaceId = this.generateId()
      const name = normalizeName(input.name ?? DEFAULT_WORKSPACE_NAME)
      const presentation = input.presentation ?? 'background'
      const workspaceIds = parent == null ? [] : [parent.workspaceId]
      await this.authorize(state, project.projectId, workspaceIds)

      let cwd = project.cwd
      let branch: string | null = null
      let worktreeParentCwd: string | null = null
      if (input.mode === 'worktree') {
        const derivedPath = this.ports.worktrees.derivePath({ project, workspaceId, name })
        const created = await this.ports.worktrees.create({
          project,
          path: derivedPath,
          ...(input.branch == null ? {} : { branch: input.branch.trim() })
        })
        cwd = created.path
        branch = created.branch
        worktreeParentCwd = project.cwd
        effects.push(
          receipt('git.worktree.create', 'applied', workspaceId, branch),
          receipt('filesystem.write', 'applied', workspaceId, cwd)
        )
      }

      let workspace: WorkspaceSnapshot
      try {
        workspace = await this.ports.store.create({
          workspaceId,
          projectId: project.projectId,
          name,
          // Explicit `nameIsAuto` wins (renderer-supplied placeholder names
          // must not be mistaken for a deliberate user rename); when the
          // caller doesn't know about the field, fall back to inferring from
          // name presence so pre-existing callers keep their old behaviour.
          nameIsAuto: input.nameIsAuto ?? input.name == null,
          cwd,
          parentWorkspaceId: parent?.workspaceId ?? null,
          forkedFromConversationId:
            input.fork === true ? (parent?.claudeConversationId ?? null) : null,
          worktreeParentCwd,
          worktreeBranch: branch
        })
      } catch {
        effects.push(receipt('db.write', 'failed', workspaceId, undefined, 'Effect failed.'))
        if (input.mode === 'worktree' && branch != null) {
          let rolledBack = false
          try {
            rolledBack = await this.ports.worktrees.rollbackCreate({
              project,
              path: cwd,
              branch
            })
          } catch {
            rolledBack = false
          }
          effects.push(
            receipt('git.worktree.remove', rolledBack ? 'applied' : 'failed', workspaceId, branch),
            receipt('filesystem.delete', rolledBack ? 'applied' : 'failed', workspaceId, cwd)
          )
          if (!rolledBack) {
            return {
              projectId: project.projectId,
              workspaceId,
              workspaceIds: [workspaceId],
              status: 'partial',
              value: {
                workspace: {
                  workspaceId,
                  projectId: project.projectId,
                  name,
                  mode: 'worktree',
                  cwd,
                  parentWorkspaceId: parent?.workspaceId ?? null,
                  closedAt: null,
                  archivedAt: null
                },
                lineage: {
                  parentWorkspaceId: parent?.workspaceId ?? null,
                  forkedFromConversationId:
                    input.fork === true ? (parent?.claudeConversationId ?? null) : null
                },
                presentation
              },
              effects
            }
          }
        }
        throw orchestrationError('failed', 'Workspace record could not be created.')
      }
      effects.push(receipt('db.write', 'applied', workspaceId))
      if (presentation === 'focus') {
        await this.ensureRuntime(workspace, effects)
        await this.ports.presentation.focus(workspaceId)
        effects.push(receipt('ui.focus', 'applied', workspaceId))
      }
      return {
        projectId: project.projectId,
        workspaceId,
        workspaceIds: [workspaceId],
        value: {
          workspace: toRef(workspace),
          lineage: {
            parentWorkspaceId: workspace.parentWorkspaceId,
            forkedFromConversationId: workspace.forkedFromConversationId
          },
          presentation
        },
        effects
      }
    })
  }

  async startTask(
    input: StartTaskInput,
    actor: WorkspaceOperationActor
  ): Promise<WorkspaceOperationReceipt<StartTaskValue>> {
    const result = await this.sendInternal(OPERATIONS.startTask, input, actor, true)
    return {
      ...result,
      value: {
        workspaceId: result.value.workspaceId,
        accepted: true,
        submitted: true
      }
    }
  }

  async open(
    input: OpenWorkspaceInput,
    actor: WorkspaceOperationActor
  ): Promise<WorkspaceOperationReceipt<OpenWorkspaceValue>> {
    return this.runMutation(OPERATIONS.open, input, actor, async (state, effects) => {
      const workspace = await this.resolveWorkspace(input.workspaceId, actor)
      if (workspace.closedAt != null) {
        throw orchestrationError('conflict', 'Closed workspaces must be reopened before opening.')
      }
      await this.authorize(state, workspace.projectId, [workspace.workspaceId])
      const runtimeState = await this.ensureRuntime(workspace, effects)
      const updated = await this.ports.store.markOpened(workspace.workspaceId, workspace.revision)
      if (updated == null) throw orchestrationError('conflict', 'Workspace changed during open.')
      effects.push(receipt('db.write', 'applied', workspace.workspaceId))
      const presentation = input.presentation ?? 'background'
      if (presentation === 'focus') {
        await this.ports.presentation.focus(workspace.workspaceId)
        effects.push(receipt('ui.focus', 'applied', workspace.workspaceId))
      }
      return {
        projectId: workspace.projectId,
        workspaceId: workspace.workspaceId,
        value: {
          workspace: toRef(updated),
          presentation,
          runtimeState
        },
        effects
      }
    })
  }

  /**
   * Renderer acknowledgement for a main-requested open.
   *
   * This is deliberately not a catalog capability: it performs no presentation
   * request and therefore cannot recurse through workspace:requestOpen. It does
   * share the canonical per-project mutation lease so a renderer replay cannot
   * revise a row while close/archive is between runtime/worktree teardown and
   * its final DB write.
   */
  async acknowledgeRendererOpen(workspaceId: string): Promise<WorkspaceRef> {
    const initial = await this.ports.store.getWorkspace(workspaceId)
    if (initial == null) throw orchestrationError('not_found', RESOURCE_NOT_FOUND)
    const lease = await this.ports.leases.acquireWhenAvailable(
      `project:${initial.projectId}`,
      `renderer-open:${this.generateId()}`
    )
    try {
      let current = await this.ports.store.getWorkspace(workspaceId)
      if (current == null || current.projectId !== initial.projectId) {
        throw orchestrationError('not_found', RESOURCE_NOT_FOUND)
      }
      if (current.closedAt != null) {
        current = await this.ports.store.reopen(current.workspaceId, current.revision)
        if (current == null) {
          throw orchestrationError('conflict', 'Workspace changed during renderer open.')
        }
      }
      const opened = await this.ports.store.markOpened(current.workspaceId, current.revision)
      if (opened == null) {
        throw orchestrationError('conflict', 'Workspace changed during renderer open.')
      }
      return toRef(opened)
    } finally {
      await lease.release()
    }
  }

  async send(
    input: SendWorkspaceInput,
    actor: WorkspaceOperationActor
  ): Promise<WorkspaceOperationReceipt<SendWorkspaceValue>> {
    return this.sendInternal(OPERATIONS.send, input, actor, input.submit ?? true)
  }

  async wait(
    input: WaitWorkspacesInput,
    actor: WorkspaceOperationActor
  ): Promise<WaitWorkspacesOutput> {
    const state = this.auditState(actor, OPERATIONS.wait, input)
    try {
      const until = input.until ?? 'done'
      const timeoutMs = input.timeoutMs ?? 25_000
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
        throw orchestrationError('invalid', 'Wait timeout must be a positive integer.')
      }
      const requestedIds = input.workspaceIds ?? [this.defaultWorkspaceId(actor)]
      if (
        requestedIds.length === 0 ||
        requestedIds.length > 32 ||
        new Set(requestedIds).size !== requestedIds.length
      ) {
        throw orchestrationError('invalid', 'Wait targets must contain 1 to 32 unique workspaces.')
      }
      const workspaces = await Promise.all(
        requestedIds.map((workspaceId) => this.resolveWorkspace(workspaceId, actor))
      )
      const projectId = workspaces[0]?.projectId
      if (projectId == null || workspaces.some((workspace) => workspace.projectId !== projectId)) {
        throw orchestrationError('not_found', RESOURCE_NOT_FOUND)
      }
      state.projectId = projectId
      state.workspaceIds = [...requestedIds]
      await this.authorize(state, projectId, requestedIds)
      const deadlineAt = this.now() + timeoutMs
      const pending = new Set(requestedIds)
      const results = new Map<string, WaitWorkspaceResult>()
      const waitSession = this.ports.waits.createSession(requestedIds)

      try {
        while (pending.size > 0 && this.now() < deadlineAt) {
          await this.assertRuntimeStillActive(actor)
          const pendingIds = [...pending]
          const observations = await observeWorkspaces(pendingIds, waitSession.observe)
          for (const workspaceId of pendingIds) {
            const observation = observations.get(workspaceId) ?? null
            if (observation == null) {
              results.set(workspaceId, {
                workspaceId,
                outcome: 'not_found',
                status: null,
                observedAt: this.now()
              })
              pending.delete(workspaceId)
            } else if (isWaitTerminal(until, observation)) {
              results.set(workspaceId, {
                workspaceId,
                outcome: observation.outcome ?? 'done',
                status: observation.status,
                observedAt: this.now()
              })
              pending.delete(workspaceId)
            }
          }
          if (pending.size > 0 && this.now() < deadlineAt) {
            await waitSession.waitForChange([...pending], deadlineAt)
          }
        }
        const remainingIds = [...pending]
        const finalObservations = await observeWorkspaces(remainingIds, waitSession.observe)
        for (const workspaceId of remainingIds) {
          const observation = finalObservations.get(workspaceId) ?? null
          results.set(workspaceId, {
            workspaceId,
            outcome: observation == null ? 'not_found' : 'timeout',
            status: observation?.status ?? null,
            observedAt: this.now()
          })
        }
      } finally {
        waitSession.dispose()
      }
      const output: WaitWorkspacesOutput = {
        schemaVersion: 1,
        requestedUntil: until,
        timedOut: [...results.values()].some((result) => result.outcome === 'timeout'),
        results: requestedIds.map((workspaceId) => {
          const result = results.get(workspaceId)
          if (result == null) throw orchestrationError('failed', 'Wait result was incomplete.')
          return result
        })
      }
      await this.audit(state, 'completed', [])
      return output
    } catch (error) {
      await this.auditFailure(state, error)
      throw safeError(error)
    }
  }

  async close(
    input: CloseWorkspaceInput,
    actor: WorkspaceOperationActor
  ): Promise<WorkspaceOperationReceipt<CloseWorkspaceValue>> {
    return this.runMutation(OPERATIONS.close, input, actor, async (state, effects) => {
      const workspace = await this.resolveWorkspace(input.workspaceId, actor)
      this.assertNotSelf(workspace.workspaceId, actor)
      await this.authorize(state, workspace.projectId, [workspace.workspaceId])
      if (workspace.closedAt == null) {
        await this.teardownRuntime(workspace, effects)
      } else {
        // Already closed in the DB — store.close() below is skipped (it
        // would just re-stamp closed_at for no reason), which ALSO used to
        // skip its embedded tmux-kill as a side effect. But workspace.host
        // can attach a brand-new tmux session to a workspace that is
        // already closed (the TUI's "reattach to a closed workspace" flow),
        // so a repeat close on it must still guarantee no tmux session
        // survives. Call the standalone unhost step directly — it's the
        // same best-effort kill store.close() runs internally, just not
        // gated on a DB write happening. See mainAdapter.ts's `unhost` port
        // doc comment for the full reasoning.
        await this.ports.store.unhost(workspace.workspaceId)
      }
      const updated =
        workspace.closedAt == null
          ? await this.ports.store.close(workspace.workspaceId, workspace.revision)
          : workspace
      if (updated == null) throw orchestrationError('conflict', 'Workspace changed during close.')
      effects.push(
        receipt(
          'db.write',
          workspace.closedAt == null ? 'applied' : 'skipped',
          workspace.workspaceId
        )
      )
      return {
        projectId: workspace.projectId,
        workspaceId: workspace.workspaceId,
        value: { workspace: toRef(updated), closed: true },
        effects
      }
    })
  }

  async reopen(
    input: ReopenWorkspaceInput,
    actor: WorkspaceOperationActor
  ): Promise<WorkspaceOperationReceipt<ReopenWorkspaceValue>> {
    return this.runMutation(OPERATIONS.reopen, input, actor, async (state, effects) => {
      const workspace = await this.resolveWorkspace(input.workspaceId, actor)
      await this.authorize(state, workspace.projectId, [workspace.workspaceId])
      const updated =
        workspace.closedAt == null
          ? workspace
          : await this.ports.store.reopen(workspace.workspaceId, workspace.revision)
      if (updated == null) throw orchestrationError('conflict', 'Workspace changed during reopen.')
      effects.push(
        receipt(
          'db.write',
          workspace.closedAt == null ? 'skipped' : 'applied',
          workspace.workspaceId
        )
      )
      return {
        projectId: workspace.projectId,
        workspaceId: workspace.workspaceId,
        value: { workspace: toRef(updated), closed: false },
        effects
      }
    })
  }

  async rename(
    input: RenameWorkspaceInput,
    actor: WorkspaceOperationActor
  ): Promise<WorkspaceOperationReceipt<RenameWorkspaceValue>> {
    return this.runMutation(OPERATIONS.rename, input, actor, async (state, effects) => {
      const workspace = await this.resolveWorkspace(input.workspaceId, actor)
      const name = normalizeName(input.name)
      await this.authorize(state, workspace.projectId, [workspace.workspaceId])
      const updated =
        name === workspace.name
          ? workspace
          : await this.ports.store.rename(workspace.workspaceId, name, workspace.revision)
      if (updated == null) throw orchestrationError('conflict', 'Workspace changed during rename.')
      effects.push(
        receipt('db.write', name === workspace.name ? 'skipped' : 'applied', workspace.workspaceId)
      )
      return {
        projectId: workspace.projectId,
        workspaceId: workspace.workspaceId,
        value: { workspace: toRef(updated), previousName: workspace.name },
        effects
      }
    })
  }

  async archive(
    input: ArchiveWorkspaceInput,
    actor: WorkspaceOperationActor
  ): Promise<WorkspaceOperationReceipt<ArchiveWorkspaceValue>> {
    return this.runMutation(OPERATIONS.archive, input, actor, async (state, effects) => {
      const root = await this.resolveWorkspace(input.workspaceId, actor)
      const recursive = input.recursive ?? false
      const order = await this.resolveArchiveOrder(root, recursive)
      state.workspaceIds = order.map((workspace) => workspace.workspaceId)
      for (const workspace of order) this.assertNotSelf(workspace.workspaceId, actor)
      await this.preflightArchive(order, root.projectId)
      await this.authorize(state, root.projectId, state.workspaceIds)

      const workspaces: ArchiveWorkspaceValue['workspaces'] = []
      let partial = false
      for (const workspace of order) {
        if (partial) {
          workspaces.push({
            workspaceId: workspace.workspaceId,
            status: 'skipped',
            persistedRecord: 'retained'
          })
          continue
        }
        try {
          await this.teardownRuntime(workspace, effects)
          if (workspace.mode === 'worktree') {
            const removed = await this.ports.worktrees.remove(workspace)
            if (!removed) {
              effects.push(
                receipt(
                  'git.worktree.remove',
                  'failed',
                  workspace.workspaceId,
                  workspace.worktreeBranch ?? undefined,
                  'Effect failed.'
                )
              )
              throw new Error('worktree remove failed')
            }
            effects.push(
              receipt('git.worktree.remove', 'applied', workspace.workspaceId),
              receipt('filesystem.delete', 'applied', workspace.workspaceId, workspace.cwd)
            )
          }
          const removed = await this.ports.store.remove(workspace.workspaceId, workspace.revision)
          if (!removed) {
            effects.push(
              receipt(
                'workspace.delete',
                'failed',
                workspace.workspaceId,
                undefined,
                'Effect failed.'
              )
            )
            throw new Error('workspace record remove failed')
          }
          effects.push(
            receipt('workspace.delete', 'applied', workspace.workspaceId),
            receipt('db.write', 'applied', workspace.workspaceId)
          )
          workspaces.push({
            workspaceId: workspace.workspaceId,
            status: 'archived',
            persistedRecord: 'removed'
          })
        } catch {
          partial = true
          const hasFailedEffect = effects.some(
            (effect) => effect.workspaceId === workspace.workspaceId && effect.status === 'failed'
          )
          if (!hasFailedEffect) {
            effects.push(
              receipt(
                'workspace.delete',
                'failed',
                workspace.workspaceId,
                undefined,
                'Effect failed.'
              )
            )
          }
          workspaces.push({
            workspaceId: workspace.workspaceId,
            status: 'failed',
            persistedRecord: 'retained'
          })
        }
      }
      return {
        projectId: root.projectId,
        workspaceId: root.workspaceId,
        workspaceIds: state.workspaceIds,
        status: partial ? 'partial' : 'completed',
        value: {
          rootWorkspaceId: root.workspaceId,
          recursive,
          order: order.map((workspace) => workspace.workspaceId),
          workspaces
        },
        effects
      }
    })
  }

  private async sendInternal(
    meta: OperationMeta,
    input: StartTaskInput | SendWorkspaceInput,
    actor: WorkspaceOperationActor,
    submit: boolean
  ): Promise<WorkspaceOperationReceipt<StartTaskValue | SendWorkspaceValue>> {
    return this.runMutation(meta, input, actor, async (state, effects) => {
      const workspace = await this.resolveWorkspace(input.workspaceId, actor)
      if (workspace.closedAt != null) {
        throw orchestrationError('conflict', 'Closed workspaces cannot receive input.')
      }
      await this.authorize(state, workspace.projectId, [workspace.workspaceId])
      await this.ensureRuntime(workspace, effects)
      const ready = await this.ports.runtime.waitUntilReady(
        workspace.workspaceId,
        this.now() + this.readinessTimeoutMs
      )
      if (!ready) throw orchestrationError('timeout', 'Workspace runtime was not ready in time.')
      await this.ports.runtime.sendText(workspace.workspaceId, input.text, submit)
      effects.push(receipt('terminal.input', 'applied', workspace.workspaceId))
      const presentation = input.presentation ?? 'background'
      if (presentation === 'focus') {
        await this.ports.presentation.focus(workspace.workspaceId)
        effects.push(receipt('ui.focus', 'applied', workspace.workspaceId))
      }
      return {
        projectId: workspace.projectId,
        workspaceId: workspace.workspaceId,
        value: {
          workspaceId: workspace.workspaceId,
          accepted: true,
          submitted: submit
        },
        effects
      }
    })
  }

  private async ensureRuntime(
    workspace: WorkspaceSnapshot,
    effects: EffectReceipt[]
  ): Promise<'retained' | 'started'> {
    const result = await this.ports.runtime.ensureOpen(workspace)
    effects.push(...result.effects)
    return result.runtimeState
  }

  private async teardownRuntime(
    workspace: WorkspaceSnapshot,
    effects: EffectReceipt[]
  ): Promise<void> {
    const result = await this.ports.runtime.teardown(workspace.workspaceId)
    effects.push(...result.effects)
  }

  private async resolveProject(actor: WorkspaceOperationActor): Promise<ProjectSnapshot> {
    const projectId = actor.boundProjectId
    if (projectId == null) throw orchestrationError('not_found', RESOURCE_NOT_FOUND)
    const project = await this.ports.store.getProject(projectId)
    if (project == null) throw orchestrationError('not_found', RESOURCE_NOT_FOUND)
    return project
  }

  private defaultWorkspaceId(actor: WorkspaceOperationActor): string {
    if (actor.boundWorkspaceId == null) {
      throw orchestrationError('not_found', RESOURCE_NOT_FOUND)
    }
    return actor.boundWorkspaceId
  }

  private async resolveWorkspace(
    workspaceId: string | undefined,
    actor: WorkspaceOperationActor
  ): Promise<WorkspaceSnapshot> {
    const targetId = workspaceId ?? this.defaultWorkspaceId(actor)
    const workspace = await this.ports.store.getWorkspace(targetId)
    if (
      workspace == null ||
      actor.boundProjectId == null ||
      workspace.projectId !== actor.boundProjectId
    ) {
      throw orchestrationError('not_found', RESOURCE_NOT_FOUND)
    }
    return workspace
  }

  private async resolveWorkspaceInProject(
    workspaceId: string,
    projectId: string
  ): Promise<WorkspaceSnapshot> {
    const workspace = await this.ports.store.getWorkspace(workspaceId)
    if (workspace == null || workspace.projectId !== projectId) {
      throw orchestrationError('not_found', RESOURCE_NOT_FOUND)
    }
    return workspace
  }

  private async resolveCreateParent(
    explicitParentId: string | undefined,
    actor: WorkspaceOperationActor,
    projectId: string
  ): Promise<WorkspaceSnapshot | null> {
    const parentId = explicitParentId ?? actor.boundWorkspaceId
    if (parentId == null) return null
    return this.resolveWorkspaceInProject(parentId, projectId)
  }

  private async sameProjectChildren(workspace: WorkspaceSnapshot): Promise<WorkspaceSnapshot[]> {
    const children = [...(await this.ports.store.listChildren(workspace.workspaceId))]
    if (children.length > this.maxChildrenPerWorkspace) {
      throw orchestrationError('conflict', 'Workspace child limit was exceeded.')
    }
    if (
      children.some(
        (child) =>
          child.projectId !== workspace.projectId ||
          child.parentWorkspaceId !== workspace.workspaceId
      )
    ) {
      throw orchestrationError('conflict', 'Workspace lineage is inconsistent.')
    }
    return children
  }

  private async preflightNewChild(parent: WorkspaceSnapshot): Promise<void> {
    const children = await this.sameProjectChildren(parent)
    if (children.length >= this.maxChildrenPerWorkspace) {
      throw orchestrationError('conflict', 'Workspace child limit was exceeded.')
    }
    const seen = new Set([parent.workspaceId])
    let depth = 1
    let ancestorId = parent.parentWorkspaceId
    while (ancestorId != null) {
      if (seen.has(ancestorId) || depth >= this.maxLineageDepth) {
        throw orchestrationError('conflict', 'Workspace lineage depth limit was exceeded.')
      }
      const ancestor = await this.resolveWorkspaceInProject(ancestorId, parent.projectId)
      seen.add(ancestor.workspaceId)
      ancestorId = ancestor.parentWorkspaceId
      depth++
    }
  }

  private async resolveArchiveOrder(
    root: WorkspaceSnapshot,
    recursive: boolean
  ): Promise<WorkspaceSnapshot[]> {
    const children = await this.sameProjectChildren(root)
    if (!recursive && children.length > 0) {
      throw orchestrationError('conflict', 'Workspace has descendants.')
    }
    const order: WorkspaceSnapshot[] = []
    const visiting = new Set<string>()
    const visit = async (workspace: WorkspaceSnapshot, depth: number): Promise<void> => {
      if (depth > this.maxLineageDepth || visiting.has(workspace.workspaceId)) {
        throw orchestrationError('conflict', 'Workspace lineage is inconsistent.')
      }
      visiting.add(workspace.workspaceId)
      for (const child of await this.sameProjectChildren(workspace)) {
        await visit(child, depth + 1)
      }
      visiting.delete(workspace.workspaceId)
      order.push(workspace)
    }
    await visit(root, 0)
    return order
  }

  private async preflightArchive(
    order: readonly WorkspaceSnapshot[],
    projectId: string
  ): Promise<void> {
    for (const workspace of order) {
      if (workspace.projectId !== projectId) {
        throw orchestrationError('not_found', RESOURCE_NOT_FOUND)
      }
      const current = await this.ports.store.getWorkspace(workspace.workspaceId)
      if (current == null || current.projectId !== projectId) {
        throw orchestrationError('conflict', 'Workspace lineage changed during archive preflight.')
      }
      const currentChildren = await this.sameProjectChildren(current)
      const snapshotChildren = order.filter(
        (candidate) => candidate.parentWorkspaceId === workspace.workspaceId
      )
      if (
        current.revision !== workspace.revision ||
        JSON.stringify(sortedIds(currentChildren)) !== JSON.stringify(sortedIds(snapshotChildren))
      ) {
        throw orchestrationError('conflict', 'Workspace lineage changed during archive preflight.')
      }
      if (!(await this.ports.runtime.canTeardown(workspace.workspaceId))) {
        throw orchestrationError('unavailable', 'Workspace runtime cannot be safely terminated.')
      }
      if (workspace.mode === 'worktree') {
        const preflight = await this.ports.worktrees.preflightRemove(workspace)
        if (!preflight.safe || preflight.dirty) {
          throw orchestrationError('conflict', 'Managed worktree is not safe to remove.')
        }
      }
    }
  }

  private assertNotSelf(workspaceId: string, actor: WorkspaceOperationActor): void {
    if (actor.principal.runtimeId != null && actor.boundWorkspaceId === workspaceId) {
      throw orchestrationError('forbidden', 'A runtime cannot close or archive itself.')
    }
  }

  private async assertRuntimeStillActive(actor: WorkspaceOperationActor): Promise<void> {
    if (
      actor.consumer === 'mcp' &&
      (actor.principal.runtimeId == null ||
        !(await this.ports.authorization.isRuntimeLeaseActive(actor.principal.runtimeId)))
    ) {
      throw orchestrationError('forbidden', 'The trusted runtime lease is no longer active.')
    }
  }

  private async authorize(
    state: AuditState,
    projectId: string,
    workspaceIds: readonly string[]
  ): Promise<void> {
    state.projectId = projectId
    state.workspaceIds = [...workspaceIds]
    const decision = await this.ports.authorization.revalidate({
      actor: state.actor,
      operationId: state.meta.id,
      permission: state.meta.permission,
      tier: state.meta.tier,
      declaredEffects: state.meta.effects,
      projectId,
      workspaceIds
    })
    state.decision = decision
    if (decision !== 'allow') {
      throw orchestrationError('forbidden', `Permission denied: ${state.meta.permission}`)
    }
  }

  private auditState(
    actor: WorkspaceOperationActor,
    meta: OperationMeta,
    params: unknown
  ): AuditState {
    return {
      auditId: this.generateId(),
      actor,
      meta,
      params,
      projectId: actor.boundProjectId,
      workspaceIds: [],
      decision: 'deny',
      auditAttempted: false
    }
  }

  private async audit(
    state: AuditState,
    result: WorkspaceControlAuditRecord['result']['code'],
    receipts: EffectReceipt[]
  ): Promise<void> {
    if (state.auditAttempted) return
    state.auditAttempted = true
    const record: WorkspaceControlAuditRecord = {
      schemaVersion: 1,
      auditId: state.auditId,
      requestId: state.actor.requestId,
      occurredAt: this.now(),
      consumer: consumerForAudit(state.actor.consumer),
      operation: { id: state.meta.id, version: 1 },
      principal: state.actor.principal,
      target: {
        projectId: state.projectId,
        workspaceIds: [...state.workspaceIds]
      },
      permission: state.meta.permission,
      tier: state.meta.tier,
      decision: state.decision,
      declaredEffects: [...state.meta.effects],
      redactedParams: recursivelyRedact(state.params),
      receipts,
      result: { code: result },
      correlation: {
        requestId: state.actor.requestId,
        ...(state.actor.correlation ?? {})
      }
    }
    try {
      await this.ports.audit.append(record)
    } catch (error) {
      try {
        await this.ports.onAuditFailure?.(error, record)
      } catch {
        // Diagnostics must never change the already-applied operation outcome.
      }
    }
  }

  private async auditFailure(state: AuditState, error: unknown): Promise<void> {
    await this.audit(state, errorCode(error), [])
  }

  private async runMutation<T>(
    meta: OperationMeta,
    params: unknown,
    actor: WorkspaceOperationActor,
    action: (state: AuditState, effects: EffectReceipt[]) => Promise<MutationResult<T>>
  ): Promise<WorkspaceOperationReceipt<T>> {
    const state = this.auditState(actor, meta, params)
    const effects: EffectReceipt[] = []
    let lease: WorkspaceMutationLease | null = null
    try {
      const projectId = await this.resolveMutationProject(meta, params, actor)
      state.projectId = projectId
      lease = await this.ports.leases.acquire(`project:${projectId}`, actor.requestId)
      if (lease == null)
        throw orchestrationError('busy', 'A conflicting workspace operation is active.')
      const result = await action(state, effects)
      state.projectId = result.projectId
      state.workspaceIds =
        result.workspaceIds ?? (result.workspaceId == null ? [] : [result.workspaceId])
      const status = result.status ?? 'completed'
      await this.audit(state, status, effects)
      return {
        schemaVersion: 1,
        requestId: actor.requestId,
        operationId: meta.id,
        status,
        target: {
          projectId: result.projectId,
          workspaceId: result.workspaceId
        },
        value: result.value,
        effects,
        auditId: state.auditId
      }
    } catch (error) {
      await this.audit(state, effects.length === 0 ? errorCode(error) : 'partial', effects)
      throw safeError(error)
    } finally {
      await lease?.release()
    }
  }

  private async resolveMutationProject(
    meta: OperationMeta,
    params: unknown,
    actor: WorkspaceOperationActor
  ): Promise<string> {
    const project = await this.resolveProject(actor)
    const record =
      params != null && typeof params === 'object'
        ? (params as Record<string, unknown>)
        : ({} as Record<string, unknown>)
    const explicitWorkspaceId =
      typeof record['workspaceId'] === 'string' ? record['workspaceId'] : undefined
    if (meta.id === OPERATIONS.create.id) {
      const explicitParentId =
        typeof record['parentWorkspaceId'] === 'string' ? record['parentWorkspaceId'] : undefined
      if (explicitParentId != null) {
        await this.resolveWorkspaceInProject(explicitParentId, project.projectId)
      }
      return project.projectId
    }
    await this.resolveWorkspace(explicitWorkspaceId, actor)
    return project.projectId
  }
}
