import { randomUUID } from 'node:crypto'
import type {
  AutomationCatalog,
  AutomationChangedEvent,
  AutomationDefinitionDraft,
  AutomationOperationCatalogEntry,
  AutomationRunSummary,
  AutomationRunWithEligibility
} from '../../shared/types'
import type { ControlDescription } from '../controlPlane/types'
import {
  AutomationService,
  type AutomationManagementContext,
  type AutomationRun as StoredAutomationRun
} from '../automations'
import { automationCatalogEntry, isAutomationDraftShape } from '../automations/validation'
import { handle } from './handle'

type AutomationCatalogProvider = () => readonly ControlDescription[]
type AutomationChangedBroadcaster = (event: AutomationChangedEvent) => void

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function isId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 128 &&
    value.trim() === value &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  )
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function rendererManagementContext(senderId: number): AutomationManagementContext {
  return {
    requestId: randomUUID(),
    principal: { type: 'renderer-user', id: `webContents:${senderId}` },
    consumer: 'renderer-ipc'
  }
}

function publicRun(run: StoredAutomationRun): AutomationRunSummary {
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
    hasError: run.error != null
  }
}

async function publicRunWithEligibility(
  service: AutomationService,
  run: StoredAutomationRun
): Promise<AutomationRunWithEligibility> {
  return {
    ...publicRun(run),
    manualRetry: await service.manualRetryEligibility(run)
  }
}

function assertListRequest(value: unknown): asserts value is { enabledOnly?: boolean } {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['enabledOnly']) ||
    (value['enabledOnly'] !== undefined && typeof value['enabledOnly'] !== 'boolean')
  ) {
    throw new Error('Invalid automation list request.')
  }
}

function assertIdRequest(value: unknown): asserts value is { id: string } {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isId(value['id'])) {
    throw new Error('Invalid automation id request.')
  }
}

function assertCreateRequest(
  value: unknown
): asserts value is { draft: AutomationDefinitionDraft } {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    !isAutomationDraftShape(value['draft'])
  ) {
    throw new Error('Invalid automation create request.')
  }
}

function assertUpdateRequest(value: unknown): asserts value is {
  id: string
  expectedUpdatedAt: number
  draft: AutomationDefinitionDraft
} {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['id', 'expectedUpdatedAt', 'draft']) ||
    Object.keys(value).length !== 3 ||
    !isId(value['id']) ||
    !isRevision(value['expectedUpdatedAt']) ||
    !isAutomationDraftShape(value['draft'])
  ) {
    throw new Error('Invalid automation update request.')
  }
}

function assertSetEnabledRequest(
  value: unknown
): asserts value is { id: string; expectedUpdatedAt: number; enabled: boolean } {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['id', 'expectedUpdatedAt', 'enabled']) ||
    Object.keys(value).length !== 3 ||
    !isId(value['id']) ||
    !isRevision(value['expectedUpdatedAt']) ||
    typeof value['enabled'] !== 'boolean'
  ) {
    throw new Error('Invalid automation enabled request.')
  }
}

function assertDeleteRequest(
  value: unknown
): asserts value is { id: string; expectedUpdatedAt: number } {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['id', 'expectedUpdatedAt']) ||
    Object.keys(value).length !== 2 ||
    !isId(value['id']) ||
    !isRevision(value['expectedUpdatedAt'])
  ) {
    throw new Error('Invalid automation delete request.')
  }
}

function assertListRunsRequest(
  value: unknown
): asserts value is { automationId?: string; limit?: number } {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['automationId', 'limit']) ||
    (value['automationId'] !== undefined && !isId(value['automationId'])) ||
    (value['limit'] !== undefined &&
      (typeof value['limit'] !== 'number' ||
        !Number.isSafeInteger(value['limit']) ||
        value['limit'] < 1 ||
        value['limit'] > 200))
  ) {
    throw new Error('Invalid automation run list request.')
  }
}

function assertRetryRequest(value: unknown): asserts value is { runId: string } {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isId(value['runId'])) {
    throw new Error('Invalid automation retry request.')
  }
}

export function registerAutomationsIpc(
  service: AutomationService,
  catalogProvider: AutomationCatalogProvider,
  broadcastChanged: AutomationChangedBroadcaster
): void {
  handle('automations:list', (_event, request) => {
    assertListRequest(request)
    return service.listDefinitions(request.enabledOnly ?? false)
  })
  handle('automations:get', (_event, request) => {
    assertIdRequest(request)
    return service.getDefinition(request.id)
  })
  handle('automations:catalog', () => {
    const operations = catalogProvider()
      .map(automationCatalogEntry)
      .filter((entry): entry is AutomationOperationCatalogEntry => entry != null)
      .sort((left, right) => left.id.localeCompare(right.id))
    return {
      ...service.editorConfiguration(),
      operations
    } satisfies AutomationCatalog
  })
  handle('automations:create', async (event, request) => {
    assertCreateRequest(request)
    const definition = await service.createDefinition(
      { ...request.draft, enabled: false },
      rendererManagementContext(event.sender.id)
    )
    broadcastChanged({
      kind: 'created',
      definitionId: definition.id,
      updatedAt: definition.updatedAt
    })
    return definition
  })
  handle('automations:update', async (event, request) => {
    assertUpdateRequest(request)
    const definition = await service.updateDefinition(
      request.id,
      request.expectedUpdatedAt,
      { ...request.draft, enabled: false },
      rendererManagementContext(event.sender.id)
    )
    broadcastChanged({
      kind: 'updated',
      definitionId: definition.id,
      updatedAt: definition.updatedAt
    })
    return definition
  })
  handle('automations:setEnabled', async (event, request) => {
    assertSetEnabledRequest(request)
    const definition = await service.setEnabled(
      request.id,
      request.enabled,
      rendererManagementContext(event.sender.id),
      request.expectedUpdatedAt
    )
    broadcastChanged({
      kind: 'enabled',
      definitionId: definition.id,
      updatedAt: definition.updatedAt
    })
    return definition
  })
  handle('automations:delete', (event, request) => {
    assertDeleteRequest(request)
    const definition = service.deleteDefinition(
      request.id,
      rendererManagementContext(event.sender.id),
      request.expectedUpdatedAt
    )
    broadcastChanged({
      kind: 'deleted',
      definitionId: definition.id,
      updatedAt: Date.now()
    })
    return definition
  })
  handle('automations:listRuns', async (_event, request) => {
    assertListRunsRequest(request)
    const runs = service.listRuns(request.automationId, request.limit ?? 100)
    return Promise.all(runs.map((run) => publicRunWithEligibility(service, run)))
  })
  handle('automations:retryRun', async (event, request) => {
    assertRetryRequest(request)
    const run = await service.retryRun(request.runId, rendererManagementContext(event.sender.id))
    const result = await publicRunWithEligibility(service, run)
    broadcastChanged({
      kind: 'run-retried',
      definitionId: result.automationId,
      updatedAt: result.queuedAt,
      runId: result.id
    })
    return result
  })
}
