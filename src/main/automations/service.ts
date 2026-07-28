import { randomUUID } from 'node:crypto'
import type { AutomationGrantPolicy } from '../controlPlane/automationPolicy'
import type {
  ControlContext,
  ControlDescription,
  TrustedAutomationBinding
} from '../controlPlane/types'
import {
  AUTOMATION_DEFAULTS,
  AUTOMATION_LIMITS,
  type AutomationAuditPort,
  type AutomationDefinition,
  type AutomationDefinitionDraft,
  type AutomationEvent,
  type AutomationEditorConfiguration,
  type AutomationManagementAction,
  type AutomationManagementContext,
  type AutomationManualRetryReason,
  type AutomationRegistry,
  type AutomationRun,
  type AutomationRunWithEligibility,
  type AutomationScope,
  type AutomationStore
} from './types'
import {
  eventMatchesScope,
  validateAutomationDescriptor,
  validateAutomationDraft,
  validateAutomationScope
} from './validation'

const MANUAL_RETRY_STATUSES = new Set<AutomationRun['status']>([
  'failed',
  'timed_out',
  'interrupted',
  'budget_exhausted'
])
const CONCURRENT_DEFINITION_CHANGE = 'Automation definition changed concurrently.'

function definitionAuditMetadata(
  draft: Pick<AutomationDefinitionDraft, 'operationId' | 'trigger' | 'scope' | 'idempotency'>
): Readonly<Record<string, unknown>> {
  return {
    operationId: draft.operationId,
    triggerKind: draft.trigger.kind,
    scopeKind: draft.scope.kind,
    idempotency: draft.idempotency
  }
}

function validationContext(
  automationId: string,
  scope: AutomationScope,
  now: number,
  timeoutMs: number
): ControlContext {
  const controller = new AbortController()
  return {
    principal: { type: 'automation', id: automationId },
    consumer: 'automation',
    workspaceId: scope.kind === 'workspace' ? scope.workspaceId : null,
    projectId: scope.kind === 'app' ? null : scope.projectId,
    requestId: `definition:${automationId}`,
    automationRunId: 'definition-validation',
    idempotencyKey: 'definition-validation',
    deadlineAt: now + timeoutMs,
    signal: controller.signal
  }
}

export class AutomationDefinitionError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'forbidden' | 'conflict' | 'failed',
    message: string
  ) {
    super(message)
    this.name = 'AutomationDefinitionError'
  }
}

export type AutomationServicePorts = {
  store: AutomationStore
  registry: AutomationRegistry
  grants: AutomationGrantPolicy
  audit: AutomationAuditPort
  allowedEventTypes: ReadonlySet<string>
  now?: () => number
  generateId?: () => string
}

export class AutomationService {
  private readonly now: () => number
  private readonly generateId: () => string

  constructor(private readonly ports: AutomationServicePorts) {
    this.now = ports.now ?? Date.now
    this.generateId = ports.generateId ?? randomUUID
  }

  async createDefinition(
    draft: AutomationDefinitionDraft,
    management: AutomationManagementContext
  ): Promise<AutomationDefinition> {
    this.validateManagementContext(management)
    const id = this.generateId()
    const now = this.now()
    let definition: AutomationDefinition
    try {
      definition = await this.prepareDefinition(draft, id, now)
    } catch (error) {
      this.auditManagementFailure({
        action: 'automations.createDefinition',
        definitionId: id,
        management,
        scope: validateAutomationScope(draft.scope) ? draft.scope : null,
        params: definitionAuditMetadata(draft),
        error,
        effectStatus: 'skipped'
      })
      throw error
    }

    try {
      this.ports.store.transaction(() => {
        if (this.ports.store.countDefinitions() >= AUTOMATION_LIMITS.maxDefinitions) {
          throw new AutomationDefinitionError(
            'forbidden',
            `Automation definition limit reached (${AUTOMATION_LIMITS.maxDefinitions}).`
          )
        }
        this.ports.store.insertDefinition(definition)
        this.ports.audit.appendManagement({
          auditId: this.generateId(),
          requestId: management.requestId,
          occurredAt: now,
          action: 'automations.createDefinition',
          definitionId: id,
          principal: management.principal,
          consumer: management.consumer,
          scope: definition.scope,
          decision: 'allow',
          resultCode: 'completed',
          params: definitionAuditMetadata(definition),
          receipts: [{ effect: 'db.write', status: 'applied', resourceId: id }],
          correlation: { created: true, enabled: definition.enabled }
        })
      })
      return definition
    } catch (error) {
      this.auditManagementFailure({
        action: 'automations.createDefinition',
        definitionId: id,
        management,
        scope: definition.scope,
        params: definitionAuditMetadata(definition),
        error,
        effectStatus: 'failed'
      })
      throw this.normalizeError(error)
    }
  }

  private async prepareDefinition(
    draft: AutomationDefinitionDraft,
    id: string,
    now: number
  ): Promise<AutomationDefinition> {
    const validationError = validateAutomationDraft(draft, this.ports.allowedEventTypes)
    if (validationError != null) throw new AutomationDefinitionError('invalid', validationError)
    const description = this.ports.registry.describe(draft.operationId)
    const descriptorError = validateAutomationDescriptor(description, draft.idempotency)
    if (descriptorError != null || description == null) {
      throw new AutomationDefinitionError('invalid', descriptorError ?? 'Operation was not found.')
    }
    const context = validationContext(id, draft.scope, now, draft.timeoutMs)
    if (!this.ports.registry.validateInput(draft.operationId, draft.params, context)) {
      throw new AutomationDefinitionError(
        'invalid',
        'Automation params do not match the operation schema.'
      )
    }
    const binding = await this.ports.grants.resolve(id, draft.scope, description, draft.params)
    if (binding == null) {
      throw new AutomationDefinitionError(
        'forbidden',
        'No server-owned grant allows this operation and scope.'
      )
    }
    return {
      ...draft,
      id,
      operationVersion: 1,
      enabled: draft.enabled ?? false,
      nextRunAt:
        draft.trigger.kind === 'schedule'
          ? (draft.trigger.startAt ?? now + draft.trigger.intervalMs)
          : null,
      createdAt: now,
      updatedAt: now
    }
  }

  getDefinition(id: string): AutomationDefinition {
    const definition = this.ports.store.getDefinition(id)
    if (definition == null) {
      throw new AutomationDefinitionError('not_found', 'Automation definition was not found.')
    }
    return definition
  }

  listDefinitions(enabledOnly = false): AutomationDefinition[] {
    return this.ports.store.listDefinitions(enabledOnly)
  }

  listRuns(automationId?: string, limit = 100): AutomationRun[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new AutomationDefinitionError('invalid', 'Run history limit is invalid.')
    }
    if (automationId != null && this.ports.store.getDefinition(automationId) == null) {
      throw new AutomationDefinitionError('not_found', 'Automation definition was not found.')
    }
    return this.ports.store.listRuns({ automationId, order: 'recent', limit })
  }

  listRunsForAutomations(automationIds: readonly string[], limit = 100): AutomationRun[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > AUTOMATION_LIMITS.maxListLimit) {
      throw new AutomationDefinitionError('invalid', 'Run history limit is invalid.')
    }
    if (automationIds.length === 0) return []
    const uniqueIds = [...new Set(automationIds)]
    return this.ports.store.listRuns({
      automationIds: uniqueIds,
      order: 'recent',
      limit
    })
  }

  getRun(id: string): AutomationRun {
    const run = this.ports.store.getRun(id)
    if (run == null)
      throw new AutomationDefinitionError('not_found', 'Automation run was not found.')
    return run
  }

  async summarizeRun(run: AutomationRun): Promise<AutomationRunWithEligibility> {
    const [summary] = await this.summarizeRuns([run])
    if (summary == null)
      throw new AutomationDefinitionError('failed', 'Run summary was unavailable.')
    return summary
  }

  async summarizeRuns(runs: readonly AutomationRun[]): Promise<AutomationRunWithEligibility[]> {
    const definitionIds = [...new Set(runs.map((run) => run.automationId))]
    const definitions = new Map(
      this.ports.store
        .listDefinitionsByIds(definitionIds)
        .map((definition) => [definition.id, definition])
    )
    const latestCandidates = runs.filter((run) => {
      const definition = definitions.get(run.automationId)
      return (
        definition?.enabled === true &&
        definition.idempotency !== 'none' &&
        MANUAL_RETRY_STATUSES.has(run.status)
      )
    })
    const latestRuns = this.ports.store.listLatestRunsForIdempotencyKeys(
      latestCandidates.map(({ automationId, idempotencyKey }) => ({
        automationId,
        idempotencyKey
      }))
    )
    const latestIds = new Set(latestRuns.map((run) => run.id))
    const currentDefinitions = new Map<string, boolean>()
    await Promise.all(
      [
        ...new Set(
          latestCandidates.filter((run) => latestIds.has(run.id)).map((run) => run.automationId)
        )
      ].map(async (definitionId) => {
        const definition = definitions.get(definitionId)
        if (definition == null) return
        try {
          await this.resolveBinding(definition)
          currentDefinitions.set(definitionId, true)
        } catch {
          currentDefinitions.set(definitionId, false)
        }
      })
    )
    return runs.map((run) => {
      const definition = definitions.get(run.automationId)
      let manualRetry: { eligible: boolean; reason: AutomationManualRetryReason }
      if (definition == null) {
        manualRetry = { eligible: false, reason: 'definition_not_found' }
      } else if (!definition.enabled) {
        manualRetry = { eligible: false, reason: 'definition_disabled' }
      } else if (definition.idempotency === 'none') {
        manualRetry = { eligible: false, reason: 'idempotency_unsupported' }
      } else if (!MANUAL_RETRY_STATUSES.has(run.status)) {
        manualRetry = { eligible: false, reason: 'run_not_terminal_failure' }
      } else if (!latestIds.has(run.id)) {
        manualRetry = { eligible: false, reason: 'not_latest_generation' }
      } else {
        manualRetry =
          currentDefinitions.get(run.automationId) === true
            ? { eligible: true, reason: 'eligible' }
            : { eligible: false, reason: 'definition_not_current' }
      }
      return {
        id: run.id,
        automationId: run.automationId,
        trigger: {
          kind: run.trigger.kind,
          occurredAt: run.trigger.occurredAt
        },
        retryGeneration: run.retryGeneration ?? 0,
        retryOfRunId: run.retryOfRunId ?? null,
        status: run.status,
        attempt: run.attempt,
        queuedAt: run.queuedAt,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        nextAttemptAt: run.nextAttemptAt,
        resultCode: run.resultCode,
        hasResult: run.result != null,
        hasError: run.error != null,
        manualRetry
      }
    })
  }

  editorConfiguration(): AutomationEditorConfiguration {
    return {
      eventTypes: [...this.ports.allowedEventTypes].sort(),
      limits: {
        intervalMs: {
          min: AUTOMATION_LIMITS.minIntervalMs,
          max: AUTOMATION_LIMITS.maxIntervalMs
        },
        timeoutMs: {
          min: AUTOMATION_LIMITS.minTimeoutMs,
          max: AUTOMATION_LIMITS.maxTimeoutMs
        },
        concurrencyLimit: { min: 1, max: AUTOMATION_LIMITS.maxConcurrency },
        retryMaxAttempts: { min: 1, max: AUTOMATION_LIMITS.maxAttempts },
        retryBaseDelayMs: {
          min: AUTOMATION_LIMITS.minRetryDelayMs,
          max: AUTOMATION_LIMITS.maxRetryBaseDelayMs
        },
        retryMaxDelayMs: {
          min: AUTOMATION_LIMITS.minRetryDelayMs,
          max: AUTOMATION_LIMITS.maxRetryDelayMs
        },
        runMaxElapsedMs: {
          min: AUTOMATION_LIMITS.minTimeoutMs,
          max: AUTOMATION_LIMITS.maxRunElapsedMs
        },
        rollingWindowMs: {
          min: AUTOMATION_LIMITS.minRollingWindowMs,
          max: AUTOMATION_LIMITS.maxRollingWindowMs
        },
        rollingMaxStarts: { min: 1, max: AUTOMATION_LIMITS.maxRollingStarts }
      },
      defaults: AUTOMATION_DEFAULTS
    }
  }

  async manualRetryEligibility(
    run: AutomationRun
  ): Promise<{ eligible: boolean; reason: AutomationManualRetryReason }> {
    const [summary] = await this.summarizeRuns([run])
    return summary?.manualRetry ?? { eligible: false, reason: 'definition_not_found' }
  }

  async updateDefinition(
    id: string,
    expectedUpdatedAt: number,
    draft: AutomationDefinitionDraft,
    management: AutomationManagementContext
  ): Promise<AutomationDefinition> {
    this.validateManagementContext(management)
    this.validateExpectedUpdatedAt(expectedUpdatedAt)
    let current: AutomationDefinition | null = null
    let updated: AutomationDefinition | null = null
    try {
      current = this.getDefinition(id)
      if (current.updatedAt !== expectedUpdatedAt) {
        throw new AutomationDefinitionError('conflict', CONCURRENT_DEFINITION_CHANGE)
      }
      if (current.enabled) {
        throw new AutomationDefinitionError(
          'conflict',
          'Disable the automation before updating it.'
        )
      }
      const updatedAt = this.nextUpdatedAt(current.updatedAt)
      const prepared = await this.prepareDefinition({ ...draft, enabled: false }, id, updatedAt)
      updated = {
        ...prepared,
        enabled: false,
        createdAt: current.createdAt,
        updatedAt
      }
      const changed = this.ports.store.updateDefinition(updated, current.updatedAt, () => {
        this.ports.audit.appendManagement({
          auditId: this.generateId(),
          requestId: management.requestId,
          occurredAt: updatedAt,
          action: 'automations.updateDefinition',
          definitionId: id,
          principal: management.principal,
          consumer: management.consumer,
          scope: updated?.scope ?? null,
          decision: 'allow',
          resultCode: 'completed',
          params: definitionAuditMetadata(updated ?? draft),
          receipts: [{ effect: 'db.write', status: 'applied', resourceId: id }],
          correlation: { previousUpdatedAt: current?.updatedAt, updatedAt }
        })
      })
      if (!changed) {
        throw new AutomationDefinitionError('conflict', CONCURRENT_DEFINITION_CHANGE)
      }
      return updated
    } catch (error) {
      this.auditManagementFailure({
        action: 'automations.updateDefinition',
        definitionId: id,
        management,
        scope: updated?.scope ?? current?.scope ?? null,
        params: definitionAuditMetadata(updated ?? draft),
        error,
        effectStatus: 'skipped'
      })
      throw this.normalizeError(error)
    }
  }

  deleteDefinition(
    id: string,
    management: AutomationManagementContext,
    expectedUpdatedAt?: number
  ): AutomationDefinition {
    this.validateManagementContext(management)
    if (expectedUpdatedAt !== undefined) this.validateExpectedUpdatedAt(expectedUpdatedAt)
    let current: AutomationDefinition | null = null
    try {
      current = this.getDefinition(id)
      if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) {
        throw new AutomationDefinitionError('conflict', CONCURRENT_DEFINITION_CHANGE)
      }
      if (current.enabled) {
        throw new AutomationDefinitionError(
          'conflict',
          'Disable the automation before deleting it.'
        )
      }
      const now = this.now()
      if (
        !this.ports.store.deleteDefinition(id, current.updatedAt, () => {
          this.ports.audit.appendManagement({
            auditId: this.generateId(),
            requestId: management.requestId,
            occurredAt: now,
            action: 'automations.deleteDefinition',
            definitionId: id,
            principal: management.principal,
            consumer: management.consumer,
            scope: current?.scope ?? null,
            decision: 'allow',
            resultCode: 'completed',
            params: {},
            receipts: [{ effect: 'db.write', status: 'applied', resourceId: id }],
            correlation: { deleted: true, previousUpdatedAt: current?.updatedAt }
          })
        })
      ) {
        throw new AutomationDefinitionError('conflict', CONCURRENT_DEFINITION_CHANGE)
      }
      return current
    } catch (error) {
      this.auditManagementFailure({
        action: 'automations.deleteDefinition',
        definitionId: id,
        management,
        scope: current?.scope ?? null,
        params: {},
        error,
        effectStatus: current == null ? 'skipped' : 'failed'
      })
      throw this.normalizeError(error)
    }
  }

  async setEnabled(
    id: string,
    enabled: boolean,
    management: AutomationManagementContext,
    expectedUpdatedAt?: number
  ): Promise<AutomationDefinition> {
    this.validateManagementContext(management)
    if (expectedUpdatedAt !== undefined) this.validateExpectedUpdatedAt(expectedUpdatedAt)
    let current: AutomationDefinition | null = null
    try {
      current = this.getDefinition(id)
      if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) {
        throw new AutomationDefinitionError('conflict', CONCURRENT_DEFINITION_CHANGE)
      }
      if (current.enabled === enabled) return current
      if (enabled) await this.resolveBinding(current)
    } catch (error) {
      this.auditManagementFailure({
        action: 'automations.setEnabled',
        definitionId: id,
        management,
        scope: current?.scope ?? null,
        params: { enabled },
        error,
        effectStatus: 'skipped'
      })
      throw error
    }
    if (current == null) {
      throw new AutomationDefinitionError('not_found', 'Automation definition was not found.')
    }
    const now = this.nextUpdatedAt(current.updatedAt)
    const nextRunAt =
      enabled && current.trigger.kind === 'schedule'
        ? (current.nextRunAt ?? now + current.trigger.intervalMs)
        : null
    let changed: boolean
    try {
      changed = this.ports.store.setDefinitionEnabled(
        id,
        current.enabled,
        current.updatedAt,
        enabled,
        now,
        nextRunAt,
        () => {
          this.ports.audit.appendManagement({
            auditId: this.generateId(),
            requestId: management.requestId,
            occurredAt: now,
            action: 'automations.setEnabled',
            definitionId: id,
            principal: management.principal,
            consumer: management.consumer,
            scope: current.scope,
            decision: 'allow',
            resultCode: 'completed',
            params: { enabled },
            receipts: [{ effect: 'db.write', status: 'applied', resourceId: id }],
            correlation: {
              previousEnabled: current.enabled,
              enabled,
              cancelledPendingRuns: !enabled
            }
          })
        }
      )
    } catch (error) {
      this.auditManagementFailure({
        action: 'automations.setEnabled',
        definitionId: id,
        management,
        scope: current.scope,
        params: { enabled },
        error,
        effectStatus: 'failed'
      })
      throw this.normalizeError(error)
    }
    if (!changed) {
      const conflict = new AutomationDefinitionError('conflict', CONCURRENT_DEFINITION_CHANGE)
      this.auditManagementFailure({
        action: 'automations.setEnabled',
        definitionId: id,
        management,
        scope: current.scope,
        params: { enabled },
        error: conflict,
        effectStatus: 'skipped'
      })
      throw conflict
    }
    return this.getDefinition(id)
  }

  async retryRun(runId: string, management: AutomationManagementContext): Promise<AutomationRun> {
    this.validateManagementContext(management)
    let source: AutomationRun | null = null
    let definition: AutomationDefinition | null = null
    const retryId = this.generateId()
    try {
      source = this.ports.store.getRun(runId)
      if (source == null) {
        throw new AutomationDefinitionError('not_found', 'Automation run was not found.')
      }
      definition = this.getDefinition(source.automationId)
      this.assertManualRetryEligible(source, definition)
      await this.resolveBinding(definition)
      const now = this.now()
      const retryGeneration = (source.retryGeneration ?? 0) + 1
      const retry: AutomationRun = {
        id: retryId,
        automationId: definition.id,
        trigger: source.trigger,
        idempotencyKey: source.idempotencyKey,
        retryGeneration,
        retryOfRunId: source.id,
        status: 'queued',
        attempt: 0,
        queuedAt: now,
        startedAt: null,
        finishedAt: null,
        nextAttemptAt: null,
        resultCode: null,
        result: null,
        error: null,
        requestId: null,
        auditId: null
      }
      const expectedDefinitionUpdatedAt = definition.updatedAt
      const retryDefinition = definition
      const retrySource = source
      this.ports.store.transaction(() => {
        const currentDefinition = this.ports.store.getDefinition(retryDefinition.id)
        const latest = this.ports.store.getLatestRunByIdempotencyKey(
          retrySource.automationId,
          retrySource.idempotencyKey
        )
        if (
          currentDefinition == null ||
          !currentDefinition.enabled ||
          currentDefinition.updatedAt !== expectedDefinitionUpdatedAt ||
          latest == null ||
          latest.id !== retrySource.id ||
          !MANUAL_RETRY_STATUSES.has(latest.status)
        ) {
          throw new AutomationDefinitionError(
            'conflict',
            'Automation or run changed before retry could be queued.'
          )
        }
        if (!this.ports.store.insertRun(retry)) {
          throw new AutomationDefinitionError('conflict', 'Automation run was already retried.')
        }
        this.ports.audit.appendManagement({
          auditId: this.generateId(),
          requestId: management.requestId,
          occurredAt: now,
          action: 'automations.retryRun',
          definitionId: retryDefinition.id,
          principal: management.principal,
          consumer: management.consumer,
          scope: retryDefinition.scope,
          decision: 'allow',
          resultCode: 'completed',
          params: { runId },
          receipts: [{ effect: 'db.write', status: 'applied', resourceId: retry.id }],
          correlation: {
            retryRunId: retry.id,
            retryOfRunId: retrySource.id,
            retryGeneration,
            idempotencyMode: retryDefinition.idempotency
          }
        })
      })
      return retry
    } catch (error) {
      this.auditManagementFailure({
        action: 'automations.retryRun',
        definitionId: definition?.id ?? source?.automationId ?? 'unknown',
        management,
        scope: definition?.scope ?? null,
        params: { runId },
        error,
        effectStatus: 'skipped'
      })
      throw this.normalizeError(error)
    }
  }

  private assertManualRetryEligible(run: AutomationRun, definition: AutomationDefinition): void {
    if (!definition.enabled) {
      throw new AutomationDefinitionError('forbidden', 'Automation definition is disabled.')
    }
    if (definition.idempotency === 'none') {
      throw new AutomationDefinitionError(
        'forbidden',
        'Manual retry requires keyed or natural idempotency.'
      )
    }
    if (!MANUAL_RETRY_STATUSES.has(run.status)) {
      throw new AutomationDefinitionError('conflict', 'Automation run is not retryable.')
    }
    const latest = this.ports.store.getLatestRunByIdempotencyKey(
      run.automationId,
      run.idempotencyKey
    )
    if (latest?.id !== run.id) {
      throw new AutomationDefinitionError(
        'conflict',
        'Only the latest run generation can be retried.'
      )
    }
  }

  private validateManagementContext(context: AutomationManagementContext): void {
    const validId = (value: string): boolean =>
      value.length >= 1 && value.length <= 128 && value.trim() === value
    if (!validId(context.requestId) || !validId(context.principal.id)) {
      throw new AutomationDefinitionError('invalid', 'Automation management context is invalid.')
    }
  }

  private validateExpectedUpdatedAt(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new AutomationDefinitionError('invalid', 'Expected update revision is invalid.')
    }
  }

  private nextUpdatedAt(previous: number): number {
    return Math.max(this.now(), previous + 1)
  }

  auditManagementDenial(input: {
    action: AutomationManagementAction
    definitionId: string
    management: AutomationManagementContext
    scope: AutomationScope | null
    params: Readonly<Record<string, unknown>>
    code: 'invalid' | 'not_found' | 'forbidden'
  }): void {
    this.auditManagementFailure({
      action: input.action,
      definitionId: input.definitionId,
      management: input.management,
      scope: input.scope,
      params: input.params,
      error: new AutomationDefinitionError(input.code, 'Automation management request denied.'),
      effectStatus: 'skipped'
    })
  }

  private auditManagementFailure(input: {
    action: AutomationManagementAction
    definitionId: string
    management: AutomationManagementContext
    scope: AutomationScope | null
    params: unknown
    error: unknown
    effectStatus: 'skipped' | 'failed'
  }): void {
    const error = this.normalizeError(input.error)
    try {
      this.ports.audit.appendManagement({
        auditId: this.generateId(),
        requestId: input.management.requestId,
        occurredAt: this.now(),
        action: input.action,
        definitionId: input.definitionId,
        principal: input.management.principal,
        consumer: input.management.consumer,
        scope: input.scope,
        decision: 'deny',
        resultCode: error.code,
        params: input.params,
        receipts: [
          {
            effect: 'db.write',
            status: input.effectStatus,
            resourceId: input.definitionId
          }
        ],
        correlation: { errorCode: error.code }
      })
    } catch {
      throw new AutomationDefinitionError(
        'failed',
        'Automation management audit could not be persisted.'
      )
    }
  }

  private normalizeError(error: unknown): AutomationDefinitionError {
    return error instanceof AutomationDefinitionError
      ? error
      : new AutomationDefinitionError('failed', 'Automation management operation failed.')
  }

  validateEvent(event: AutomationEvent): void {
    if (
      event.id.length < 1 ||
      event.id.length > 128 ||
      event.id.trim() !== event.id ||
      !/^[A-Za-z0-9._:-]+$/.test(event.id) ||
      event.type.length < 1 ||
      event.type.length > 128 ||
      event.type.trim() !== event.type ||
      !Number.isSafeInteger(event.occurredAt) ||
      event.occurredAt < 0 ||
      (event.projectId !== undefined &&
        (event.projectId.length < 1 ||
          event.projectId.length > 128 ||
          event.projectId.trim() !== event.projectId)) ||
      (event.workspaceId !== undefined &&
        (event.projectId === undefined ||
          event.workspaceId.length < 1 ||
          event.workspaceId.length > 128 ||
          event.workspaceId.trim() !== event.workspaceId)) ||
      !this.ports.allowedEventTypes.has(event.type)
    ) {
      throw new AutomationDefinitionError('invalid', 'Automation event is invalid.')
    }
  }

  matchingEventDefinitions(
    event: AutomationEvent,
    enabledDefinitions: readonly AutomationDefinition[] = this.ports.store.listDefinitions(true)
  ): AutomationDefinition[] {
    this.validateEvent(event)
    const matching = enabledDefinitions.filter(
      (definition) =>
        definition.enabled &&
        definition.trigger.kind === 'event' &&
        definition.trigger.eventType === event.type &&
        eventMatchesScope(event, definition.scope)
    )
    if (matching.length > AUTOMATION_LIMITS.maxEventFanout) {
      throw new AutomationDefinitionError('invalid', 'Automation event fan-out exceeds the limit.')
    }
    return matching
  }

  async resolveBinding(
    definition: AutomationDefinition
  ): Promise<{ binding: TrustedAutomationBinding; description: ControlDescription }> {
    let validationError: string | null
    try {
      validationError = validateAutomationDraft(definition, this.ports.allowedEventTypes)
    } catch {
      validationError = 'Persisted automation definition is invalid.'
    }
    if (validationError != null) {
      throw new AutomationDefinitionError('invalid', validationError)
    }
    const description = this.ports.registry.describe(definition.operationId)
    const descriptorError = validateAutomationDescriptor(description, definition.idempotency)
    if (
      descriptorError != null ||
      description == null ||
      definition.operationVersion !== description.version
    ) {
      throw new AutomationDefinitionError('invalid', descriptorError ?? 'Operation was not found.')
    }
    const context = validationContext(
      definition.id,
      definition.scope,
      this.now(),
      definition.timeoutMs
    )
    if (!this.ports.registry.validateInput(definition.operationId, definition.params, context)) {
      throw new AutomationDefinitionError(
        'invalid',
        'Persisted automation params no longer match the operation schema.'
      )
    }
    const binding = await this.ports.grants.resolve(
      definition.id,
      definition.scope,
      description,
      definition.params
    )
    if (binding == null) {
      throw new AutomationDefinitionError(
        'forbidden',
        'The server-owned automation grant is absent or insufficient.'
      )
    }
    return { binding, description }
  }
}
