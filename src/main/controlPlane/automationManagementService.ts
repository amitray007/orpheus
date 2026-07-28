import type {
  AutomationCatalog,
  AutomationChangedEvent,
  AutomationDefinition,
  AutomationDefinitionDraft,
  AutomationRunWithEligibility
} from '../../shared/types'
import {
  AutomationDefinitionError,
  AutomationService,
  type AutomationManagementAction,
  type AutomationManagementContext
} from '../automations'
import { automationCatalogEntry } from '../automations/validation'
import { orchestrationError } from '../workspaceOrchestration/errors'
import type {
  ControlAuthorizationDecision,
  ControlContext,
  ControlDescription,
  TrustedRuntimeBinding
} from './types'

const AUTOMATIONS_MANAGE_PERMISSION = 'automations.manage'
const AUTOMATION_NOT_FOUND = 'Automation was not found.'
const ALLOW = { allowed: true } as const

export type AutomationManagementServiceDeps = {
  service: AutomationService
  listOperations: () => readonly ControlDescription[]
  broadcastChanged: (event: AutomationChangedEvent) => void
}

function trustedManager(context: ControlContext): TrustedRuntimeBinding | null {
  const binding = context.trustedRuntime ?? null
  return context.consumer === 'mcp' &&
    context.principal.type === 'workspace-agent' &&
    binding?.runtimeKind === 'claude' &&
    binding.runtimeId === context.principal.id &&
    binding.workspaceId != null &&
    binding.projectId != null &&
    binding.permissions.includes(AUTOMATIONS_MANAGE_PERMISSION)
    ? binding
    : null
}

function managementContext(
  context: ControlContext,
  binding: TrustedRuntimeBinding
): AutomationManagementContext {
  return {
    requestId: context.requestId,
    principal: { type: 'workspace-agent', id: binding.runtimeId },
    consumer: 'mcp'
  }
}

function owns(definition: AutomationDefinition, binding: TrustedRuntimeBinding): boolean {
  return (
    definition.scope.kind === 'workspace' &&
    definition.scope.projectId === binding.projectId &&
    definition.scope.workspaceId === binding.workspaceId
  )
}

function safeId(input: unknown, field: 'id' | 'automationId' | 'runId'): string {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return ''
  const value = (input as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : ''
}

function safeAuditParams(
  action: AutomationManagementAction,
  input: unknown
): Readonly<Record<string, unknown>> {
  const record =
    input != null && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {}
  return {
    idPresent:
      typeof record['id'] === 'string' ||
      typeof record['runId'] === 'string' ||
      typeof record['automationId'] === 'string',
    ...(action === 'automations.setEnabled' && typeof record['enabled'] === 'boolean'
      ? { enabled: record['enabled'] }
      : {}),
    expectedUpdatedAtPresent: typeof record['expectedUpdatedAt'] === 'number',
    draftPresent: record['draft'] != null
  }
}

function mapAction(operationId: string): AutomationManagementAction | null {
  if (operationId === 'automations.create') return 'automations.createDefinition'
  if (operationId === 'automations.update') return 'automations.updateDefinition'
  if (operationId === 'automations.setEnabled') return 'automations.setEnabled'
  if (operationId === 'automations.delete') return 'automations.deleteDefinition'
  if (operationId === 'automations.retryRun') return 'automations.retryRun'
  return null
}

export class AutomationManagementService {
  constructor(private readonly deps: AutomationManagementServiceDeps) {}

  canDiscover(context: ControlContext): boolean {
    return trustedManager(context) != null
  }

  authorize(
    operationId: string,
    input: unknown,
    context: ControlContext
  ): ControlAuthorizationDecision {
    const binding = trustedManager(context)
    if (binding == null) {
      return {
        allowed: false,
        code: 'forbidden',
        error: 'A valid live Orpheus runtime with automations.manage is required.'
      }
    }
    if (operationId === 'automations.create') {
      const draft =
        input != null && typeof input === 'object' && !Array.isArray(input)
          ? (input as Record<string, unknown>)['draft']
          : null
      const scope =
        draft != null && typeof draft === 'object' && !Array.isArray(draft)
          ? (draft as Record<string, unknown>)['scope']
          : null
      return this.scopeMatches(scope, binding)
        ? ALLOW
        : {
            allowed: false,
            code: 'forbidden',
            error: 'MCP automations must be scoped to the calling workspace.'
          }
    }
    if (
      operationId === 'automations.get' ||
      operationId === 'automations.update' ||
      operationId === 'automations.setEnabled' ||
      operationId === 'automations.delete'
    ) {
      return this.definitionOwned(safeId(input, 'id'), binding) ? ALLOW : this.notFound()
    }
    if (operationId === 'automations.listRuns') {
      const automationId = safeId(input, 'automationId')
      return automationId.length === 0 || this.definitionOwned(automationId, binding)
        ? ALLOW
        : this.notFound()
    }
    if (operationId === 'automations.retryRun') {
      return this.runOwned(safeId(input, 'runId'), binding) ? ALLOW : this.notFound()
    }
    return ALLOW
  }

  catalog(context: ControlContext): AutomationCatalog {
    this.requireBinding(context)
    const operations = this.deps
      .listOperations()
      .map(automationCatalogEntry)
      .filter((entry): entry is NonNullable<typeof entry> => entry != null)
      .sort((left, right) => left.id.localeCompare(right.id))
    return { ...this.deps.service.editorConfiguration(), operations }
  }

  list(enabledOnly: boolean, context: ControlContext): AutomationDefinition[] {
    const binding = this.requireBinding(context)
    return this.deps.service
      .listDefinitions(enabledOnly)
      .filter((definition) => owns(definition, binding))
  }

  get(id: string, context: ControlContext): AutomationDefinition {
    const binding = this.requireBinding(context)
    return this.requireOwnedDefinition(id, binding)
  }

  async create(
    draft: AutomationDefinitionDraft,
    context: ControlContext
  ): Promise<AutomationDefinition> {
    const binding = this.requireBinding(context)
    if (!this.scopeMatches(draft.scope, binding)) {
      throw orchestrationError(
        'forbidden',
        'MCP automations must be scoped to the calling workspace.'
      )
    }
    const definition = await this.translate(() =>
      this.deps.service.createDefinition(
        { ...draft, enabled: false },
        managementContext(context, binding)
      )
    )
    this.broadcastChanged({
      kind: 'created',
      definitionId: definition.id,
      updatedAt: definition.updatedAt
    })
    return definition
  }

  async update(
    id: string,
    expectedUpdatedAt: number,
    draft: AutomationDefinitionDraft,
    context: ControlContext
  ): Promise<AutomationDefinition> {
    const binding = this.requireBinding(context)
    this.requireOwnedDefinition(id, binding)
    if (!this.scopeMatches(draft.scope, binding)) {
      throw orchestrationError(
        'forbidden',
        'MCP automations must remain scoped to the calling workspace.'
      )
    }
    const definition = await this.translate(() =>
      this.deps.service.updateDefinition(
        id,
        expectedUpdatedAt,
        { ...draft, enabled: false },
        managementContext(context, binding)
      )
    )
    this.broadcastChanged({
      kind: 'updated',
      definitionId: definition.id,
      updatedAt: definition.updatedAt
    })
    return definition
  }

  async setEnabled(
    id: string,
    expectedUpdatedAt: number,
    enabled: boolean,
    context: ControlContext
  ): Promise<AutomationDefinition> {
    const binding = this.requireBinding(context)
    this.requireOwnedDefinition(id, binding)
    const definition = await this.translate(() =>
      this.deps.service.setEnabled(
        id,
        enabled,
        managementContext(context, binding),
        expectedUpdatedAt
      )
    )
    this.broadcastChanged({
      kind: 'enabled',
      definitionId: definition.id,
      updatedAt: definition.updatedAt
    })
    return definition
  }

  delete(id: string, expectedUpdatedAt: number, context: ControlContext): AutomationDefinition {
    const binding = this.requireBinding(context)
    this.requireOwnedDefinition(id, binding)
    const definition = this.translateSync(() =>
      this.deps.service.deleteDefinition(id, managementContext(context, binding), expectedUpdatedAt)
    )
    this.broadcastChanged({
      kind: 'deleted',
      definitionId: definition.id,
      updatedAt: Date.now()
    })
    return definition
  }

  async listRuns(
    automationId: string | undefined,
    limit: number,
    context: ControlContext
  ): Promise<AutomationRunWithEligibility[]> {
    const binding = this.requireBinding(context)
    const definitions =
      automationId == null
        ? this.deps.service.listDefinitions().filter((definition) => owns(definition, binding))
        : [this.requireOwnedDefinition(automationId, binding)]
    const runs = definitions.flatMap((definition) =>
      this.deps.service.listRuns(definition.id, limit)
    )
    runs.sort((left, right) => right.queuedAt - left.queuedAt || right.id.localeCompare(left.id))
    return Promise.all(runs.slice(0, limit).map((run) => this.deps.service.summarizeRun(run)))
  }

  async retryRun(runId: string, context: ControlContext): Promise<AutomationRunWithEligibility> {
    const binding = this.requireBinding(context)
    const run = this.translateSync(() => this.deps.service.getRun(runId))
    this.requireOwnedDefinition(run.automationId, binding)
    const retried = await this.translate(() =>
      this.deps.service.retryRun(runId, managementContext(context, binding))
    )
    const result = await this.deps.service.summarizeRun(retried)
    this.broadcastChanged({
      kind: 'run-retried',
      definitionId: result.automationId,
      updatedAt: result.queuedAt,
      runId: result.id
    })
    return result
  }

  auditRejected(input: {
    operationId: string
    params: unknown
    context: ControlContext
    code: 'invalid' | 'not_found' | 'forbidden'
  }): void {
    const action = mapAction(input.operationId)
    if (action == null) return
    const binding = input.context.trustedRuntime ?? null
    const management: AutomationManagementContext = {
      requestId: input.context.requestId,
      principal: { type: 'workspace-agent', id: input.context.principal.id },
      consumer: 'mcp'
    }
    const definitionId =
      safeId(input.params, 'id') ||
      safeId(input.params, 'automationId') ||
      safeId(input.params, 'runId') ||
      'unresolved'
    this.deps.service.auditManagementDenial({
      action,
      definitionId,
      management,
      scope:
        binding?.workspaceId != null && binding.projectId != null
          ? {
              kind: 'workspace',
              projectId: binding.projectId,
              workspaceId: binding.workspaceId
            }
          : null,
      params: safeAuditParams(action, input.params),
      code: input.code
    })
  }

  private requireBinding(context: ControlContext): TrustedRuntimeBinding {
    const binding = trustedManager(context)
    if (binding == null) {
      throw orchestrationError(
        'forbidden',
        'A valid live Orpheus runtime with automations.manage is required.'
      )
    }
    return binding
  }

  private requireOwnedDefinition(id: string, binding: TrustedRuntimeBinding): AutomationDefinition {
    let definition: AutomationDefinition
    try {
      definition = this.deps.service.getDefinition(id)
    } catch {
      throw orchestrationError('not_found', AUTOMATION_NOT_FOUND)
    }
    if (!owns(definition, binding)) {
      throw orchestrationError('not_found', AUTOMATION_NOT_FOUND)
    }
    return definition
  }

  private definitionOwned(id: string, binding: TrustedRuntimeBinding): boolean {
    try {
      return owns(this.deps.service.getDefinition(id), binding)
    } catch {
      return false
    }
  }

  private runOwned(id: string, binding: TrustedRuntimeBinding): boolean {
    try {
      const run = this.deps.service.getRun(id)
      return this.definitionOwned(run.automationId, binding)
    } catch {
      return false
    }
  }

  private scopeMatches(scope: unknown, binding: TrustedRuntimeBinding): boolean {
    if (scope == null || typeof scope !== 'object' || Array.isArray(scope)) return false
    const record = scope as Record<string, unknown>
    return (
      record['kind'] === 'workspace' &&
      record['projectId'] === binding.projectId &&
      record['workspaceId'] === binding.workspaceId &&
      Object.keys(record).length === 3
    )
  }

  private notFound(): ControlAuthorizationDecision {
    return { allowed: false, code: 'not_found', error: AUTOMATION_NOT_FOUND }
  }

  private broadcastChanged(event: AutomationChangedEvent): void {
    try {
      this.deps.broadcastChanged(event)
    } catch {
      // Delivery is best-effort. A renderer race must not turn a committed
      // mutation into an apparent failure that an MCP client may retry.
    }
  }

  private async translate<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      throw this.mappedError(error)
    }
  }

  private translateSync<T>(work: () => T): T {
    try {
      return work()
    } catch (error) {
      throw this.mappedError(error)
    }
  }

  private mappedError(error: unknown): Error {
    return error instanceof AutomationDefinitionError
      ? orchestrationError(error.code, error.message)
      : orchestrationError('failed', 'Automation management operation failed.')
  }
}

export { AUTOMATIONS_MANAGE_PERMISSION, trustedManager }
