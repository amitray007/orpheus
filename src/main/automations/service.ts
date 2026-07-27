import { randomUUID } from 'node:crypto'
import type { AutomationGrantPolicy } from '../controlPlane/automationPolicy'
import type { ControlDescription, TrustedAutomationBinding } from '../controlPlane/types'
import {
  AUTOMATION_LIMITS,
  type AutomationAuditPort,
  type AutomationDefinition,
  type AutomationDefinitionDraft,
  type AutomationEvent,
  type AutomationManagementContext,
  type AutomationRegistry,
  type AutomationRun,
  type AutomationScope,
  type AutomationStore
} from './types'
import {
  eventMatchesScope,
  validateAutomationDescriptor,
  validateAutomationDraft,
  validateAutomationScope
} from './validation'

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
        params: { definition: draft },
        error,
        effectStatus: 'skipped'
      })
      throw error
    }

    try {
      this.ports.store.transaction(() => {
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
          params: { definition: draft },
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
        params: { definition: draft },
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
    const binding = await this.ports.grants.resolve(id, draft.scope, description, draft.params)
    if (binding == null) {
      throw new AutomationDefinitionError(
        'forbidden',
        'No server-owned grant allows this operation and scope.'
      )
    }
    const controller = new AbortController()
    const context = {
      principal: { type: 'automation' as const, id },
      consumer: 'automation' as const,
      workspaceId: draft.scope.kind === 'workspace' ? draft.scope.workspaceId : null,
      projectId: draft.scope.kind === 'app' ? null : draft.scope.projectId,
      requestId: `definition:${id}`,
      trustedAutomation: binding,
      automationRunId: 'definition-validation',
      idempotencyKey: 'definition-validation',
      deadlineAt: now + draft.timeoutMs,
      signal: controller.signal
    }
    if (!this.ports.registry.validateInput(draft.operationId, draft.params, context)) {
      throw new AutomationDefinitionError(
        'invalid',
        'Automation params do not match the operation schema.'
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
    return this.ports.store.listRuns({ automationId, limit })
  }

  async setEnabled(
    id: string,
    enabled: boolean,
    management: AutomationManagementContext
  ): Promise<AutomationDefinition> {
    this.validateManagementContext(management)
    let current: AutomationDefinition | null = null
    try {
      current = this.getDefinition(id)
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
    const now = this.now()
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
      const conflict = new AutomationDefinitionError(
        'conflict',
        'Automation definition changed concurrently.'
      )
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

  private validateManagementContext(context: AutomationManagementContext): void {
    const validId = (value: string): boolean =>
      value.length >= 1 && value.length <= 128 && value.trim() === value
    if (!validId(context.requestId) || !validId(context.principal.id)) {
      throw new AutomationDefinitionError('invalid', 'Automation management context is invalid.')
    }
  }

  private auditManagementFailure(input: {
    action: 'automations.createDefinition' | 'automations.setEnabled'
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

  matchingEventDefinitions(event: AutomationEvent): AutomationDefinition[] {
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
    const matching = this.ports.store
      .listDefinitions(true)
      .filter(
        (definition) =>
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
    const controller = new AbortController()
    const context = {
      principal: { type: 'automation' as const, id: definition.id },
      consumer: 'automation' as const,
      workspaceId: definition.scope.kind === 'workspace' ? definition.scope.workspaceId : null,
      projectId: definition.scope.kind === 'app' ? null : definition.scope.projectId,
      requestId: `definition:${definition.id}`,
      trustedAutomation: binding,
      automationRunId: 'definition-validation',
      idempotencyKey: 'definition-validation',
      deadlineAt: this.now() + definition.timeoutMs,
      signal: controller.signal
    }
    if (!this.ports.registry.validateInput(definition.operationId, definition.params, context)) {
      throw new AutomationDefinitionError(
        'invalid',
        'Persisted automation params no longer match the operation schema.'
      )
    }
    return { binding, description }
  }
}
