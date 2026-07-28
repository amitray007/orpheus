import type {
  AutomationDefinitionDraft,
  AutomationManualRetryReason,
  AutomationRunStatus,
  AutomationRunWithEligibility
} from '../../shared/types'
import { AUTOMATION_LIMITS } from '../automations'
import { isAutomationDraftShape } from '../automations/validation'
import type { ControlDescriptor } from './types'
import type { AutomationManagementService } from './automationManagementService'

export const AUTOMATION_MANAGEMENT_OPERATION_IDS = Object.freeze([
  'automations.catalog',
  'automations.list',
  'automations.get',
  'automations.create',
  'automations.update',
  'automations.setEnabled',
  'automations.delete',
  'automations.listRuns',
  'automations.retryRun'
] as const)

const AUTOMATION_MANAGEMENT_PERMISSION = 'automations.manage'
const SCOPED_WRITE_RISK = Object.freeze({ tier: 2 as const, label: 'scoped write' })
const AUTOMATION_RUN_STATUSES = Object.freeze([
  'queued',
  'running',
  'retry_wait',
  'succeeded',
  'failed',
  'timed_out',
  'interrupted',
  'cancelled',
  'budget_exhausted'
] satisfies AutomationRunStatus[])
const AUTOMATION_MANUAL_RETRY_REASONS = Object.freeze([
  'eligible',
  'definition_not_found',
  'definition_disabled',
  'idempotency_unsupported',
  'run_not_terminal_failure',
  'not_latest_generation',
  'definition_not_current'
] satisfies AutomationManualRetryReason[])

type EmptyInput = Readonly<Record<string, never>>
type ListInput = Readonly<{ enabledOnly?: boolean }>
type IdInput = Readonly<{ id: string }>
type CreateInput = Readonly<{ draft: AutomationDefinitionDraft }>
type UpdateInput = Readonly<{
  id: string
  expectedUpdatedAt: number
  draft: AutomationDefinitionDraft
}>
type SetEnabledInput = Readonly<{
  id: string
  expectedUpdatedAt: number
  enabled: boolean
}>
type DeleteInput = Readonly<{ id: string; expectedUpdatedAt: number }>
type ListRunsInput = Readonly<{ automationId?: string; limit?: number }>
type RetryRunInput = Readonly<{ runId: string }>

const EMPTY_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {}
} as const
const ID_PROPERTY = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9._:-]+$'
} as const
const REVISION_PROPERTY = { type: 'integer', minimum: 0 } as const
const TRIGGER_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'intervalMs'],
      properties: {
        kind: { const: 'schedule' },
        intervalMs: {
          type: 'integer',
          minimum: AUTOMATION_LIMITS.minIntervalMs,
          maximum: AUTOMATION_LIMITS.maxIntervalMs
        },
        startAt: { type: 'integer', minimum: 0 }
      }
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'eventType'],
      properties: {
        kind: { const: 'event' },
        eventType: {
          type: 'string',
          minLength: 1,
          maxLength: AUTOMATION_LIMITS.maxEventTypeLength
        }
      }
    }
  ]
} as const
const WORKSPACE_SCOPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'projectId', 'workspaceId'],
  properties: {
    kind: { const: 'workspace' },
    projectId: ID_PROPERTY,
    workspaceId: ID_PROPERTY
  },
  description: 'Must exactly match the projectId and workspaceId in the calling trusted runtime.'
} as const
const RETRY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['maxAttempts', 'baseDelayMs', 'maxDelayMs', 'maxElapsedMs'],
  properties: {
    maxAttempts: {
      type: 'integer',
      minimum: 1,
      maximum: AUTOMATION_LIMITS.maxAttempts
    },
    baseDelayMs: {
      type: 'integer',
      minimum: AUTOMATION_LIMITS.minRetryDelayMs,
      maximum: AUTOMATION_LIMITS.maxRetryBaseDelayMs
    },
    maxDelayMs: {
      type: 'integer',
      minimum: AUTOMATION_LIMITS.minRetryDelayMs,
      maximum: AUTOMATION_LIMITS.maxRetryDelayMs
    },
    maxElapsedMs: {
      type: 'integer',
      minimum: AUTOMATION_LIMITS.minTimeoutMs,
      maximum: AUTOMATION_LIMITS.maxRunElapsedMs
    }
  }
} as const
const ROLLING_BUDGET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['windowMs', 'maxStarts'],
  properties: {
    windowMs: {
      type: 'integer',
      minimum: AUTOMATION_LIMITS.minRollingWindowMs,
      maximum: AUTOMATION_LIMITS.maxRollingWindowMs
    },
    maxStarts: {
      type: 'integer',
      minimum: 1,
      maximum: AUTOMATION_LIMITS.maxRollingStarts
    }
  }
} as const
const AUTOMATION_DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'name',
    'trigger',
    'operationId',
    'params',
    'scope',
    'idempotency',
    'timeoutMs',
    'concurrencyLimit',
    'retry',
    'rollingBudget'
  ],
  properties: {
    name: {
      type: 'string',
      minLength: 1,
      maxLength: AUTOMATION_LIMITS.maxNameLength
    },
    trigger: TRIGGER_SCHEMA,
    operationId: ID_PROPERTY,
    params: {
      type: ['object'],
      description:
        'Operation parameters. Use the selected catalog operation inputSchema; secret-bearing fields are rejected.'
    },
    scope: WORKSPACE_SCOPE_SCHEMA,
    enabled: {
      type: 'boolean',
      description:
        'Accepted for shape compatibility but ignored; create and update persist disabled.'
    },
    idempotency: { enum: ['none', 'keyed', 'natural'] },
    timeoutMs: {
      type: 'integer',
      minimum: AUTOMATION_LIMITS.minTimeoutMs,
      maximum: AUTOMATION_LIMITS.maxTimeoutMs
    },
    concurrencyLimit: {
      type: 'integer',
      minimum: 1,
      maximum: AUTOMATION_LIMITS.maxConcurrency
    },
    retry: RETRY_SCHEMA,
    rollingBudget: ROLLING_BUDGET_SCHEMA
  }
} as const
const DEFINITION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'name',
    'trigger',
    'operationId',
    'params',
    'scope',
    'operationVersion',
    'enabled',
    'idempotency',
    'timeoutMs',
    'concurrencyLimit',
    'retry',
    'rollingBudget',
    'nextRunAt',
    'createdAt',
    'updatedAt'
  ],
  properties: {
    id: ID_PROPERTY,
    name: AUTOMATION_DRAFT_SCHEMA.properties.name,
    trigger: TRIGGER_SCHEMA,
    operationId: ID_PROPERTY,
    params: AUTOMATION_DRAFT_SCHEMA.properties.params,
    scope: WORKSPACE_SCOPE_SCHEMA,
    operationVersion: { const: 1 },
    enabled: { type: 'boolean' },
    idempotency: { enum: ['none', 'keyed', 'natural'] },
    timeoutMs: AUTOMATION_DRAFT_SCHEMA.properties.timeoutMs,
    concurrencyLimit: AUTOMATION_DRAFT_SCHEMA.properties.concurrencyLimit,
    retry: RETRY_SCHEMA,
    rollingBudget: ROLLING_BUDGET_SCHEMA,
    nextRunAt: { type: ['integer', 'null'] },
    createdAt: { type: 'integer' },
    updatedAt: { type: 'integer' }
  }
} as const
const RUN_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'automationId',
    'trigger',
    'retryGeneration',
    'retryOfRunId',
    'status',
    'attempt',
    'queuedAt',
    'startedAt',
    'finishedAt',
    'nextAttemptAt',
    'resultCode',
    'hasResult',
    'hasError',
    'manualRetry'
  ],
  properties: {
    id: ID_PROPERTY,
    automationId: ID_PROPERTY,
    trigger: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'occurredAt'],
      properties: {
        kind: { enum: ['schedule', 'event'] },
        occurredAt: { type: 'integer', minimum: 0 }
      }
    },
    retryGeneration: { type: 'integer', minimum: 0 },
    retryOfRunId: { type: ['string', 'null'] },
    status: { enum: AUTOMATION_RUN_STATUSES },
    attempt: { type: 'integer', minimum: 0 },
    queuedAt: { type: 'integer' },
    startedAt: { type: ['integer', 'null'] },
    finishedAt: { type: ['integer', 'null'] },
    nextAttemptAt: { type: ['integer', 'null'] },
    resultCode: { type: ['string', 'null'] },
    hasResult: { type: 'boolean' },
    hasError: { type: 'boolean' },
    manualRetry: {
      type: 'object',
      additionalProperties: false,
      required: ['eligible', 'reason'],
      properties: {
        eligible: { type: 'boolean' },
        reason: { enum: AUTOMATION_MANUAL_RETRY_REASONS }
      }
    }
  }
} as const
const NUMERIC_RANGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['min', 'max'],
  properties: {
    min: { type: 'integer' },
    max: { type: 'integer' }
  }
} as const
const CATALOG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['operations', 'eventTypes', 'limits', 'defaults'],
  properties: {
    operations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'version',
          'kind',
          'description',
          'inputSchema',
          'outputSchema',
          'permission',
          'scope',
          'risk',
          'declaredEffects',
          'idempotency'
        ],
        properties: {
          id: ID_PROPERTY,
          version: { const: 1 },
          kind: { enum: ['query', 'mutation'] },
          description: { type: 'string' },
          inputSchema: {
            description: 'The automation operation input JSON Schema.'
          },
          outputSchema: {
            description: 'The automation operation output JSON Schema.'
          },
          permission: { type: 'string' },
          scope: {
            type: 'object',
            additionalProperties: false,
            required: ['kind'],
            properties: {
              kind: { enum: ['self', 'project', 'workspace', 'resource'] },
              inputField: { type: 'string' }
            }
          },
          risk: {
            type: 'object',
            additionalProperties: false,
            required: ['tier', 'label'],
            properties: {
              tier: { type: 'integer', minimum: 0, maximum: 3 },
              label: { type: 'string' }
            }
          },
          declaredEffects: { type: 'array', items: { type: 'string' } },
          idempotency: { enum: ['none', 'keyed', 'natural'] }
        }
      }
    },
    eventTypes: { type: 'array', items: { type: 'string' } },
    limits: {
      type: 'object',
      additionalProperties: false,
      required: [
        'intervalMs',
        'timeoutMs',
        'concurrencyLimit',
        'retryMaxAttempts',
        'retryBaseDelayMs',
        'retryMaxDelayMs',
        'runMaxElapsedMs',
        'rollingWindowMs',
        'rollingMaxStarts'
      ],
      properties: {
        intervalMs: NUMERIC_RANGE_SCHEMA,
        timeoutMs: NUMERIC_RANGE_SCHEMA,
        concurrencyLimit: NUMERIC_RANGE_SCHEMA,
        retryMaxAttempts: NUMERIC_RANGE_SCHEMA,
        retryBaseDelayMs: NUMERIC_RANGE_SCHEMA,
        retryMaxDelayMs: NUMERIC_RANGE_SCHEMA,
        runMaxElapsedMs: NUMERIC_RANGE_SCHEMA,
        rollingWindowMs: NUMERIC_RANGE_SCHEMA,
        rollingMaxStarts: NUMERIC_RANGE_SCHEMA
      }
    },
    defaults: {
      type: 'object',
      additionalProperties: false,
      required: ['timeoutMs', 'concurrencyLimit', 'retry', 'rollingBudget'],
      properties: {
        timeoutMs: { type: 'integer' },
        concurrencyLimit: { type: 'integer' },
        retry: RETRY_SCHEMA,
        rollingBudget: ROLLING_BUDGET_SCHEMA
      }
    }
  }
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
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

function isEmptyInput(value: unknown): value is EmptyInput {
  return isRecord(value) && Object.keys(value).length === 0
}

function isListInput(value: unknown): value is ListInput {
  return (
    isRecord(value) &&
    onlyKeys(value, ['enabledOnly']) &&
    (value['enabledOnly'] === undefined || typeof value['enabledOnly'] === 'boolean')
  )
}

function isIdInput(value: unknown): value is IdInput {
  return isRecord(value) && Object.keys(value).length === 1 && isId(value['id'])
}

function isCreateInput(value: unknown): value is CreateInput {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    isAutomationDraftShape(value['draft']) &&
    isRecord(value['draft'].params)
  )
}

function isUpdateInput(value: unknown): value is UpdateInput {
  return (
    isRecord(value) &&
    onlyKeys(value, ['id', 'expectedUpdatedAt', 'draft']) &&
    Object.keys(value).length === 3 &&
    isId(value['id']) &&
    isRevision(value['expectedUpdatedAt']) &&
    isAutomationDraftShape(value['draft']) &&
    isRecord(value['draft'].params)
  )
}

function isSetEnabledInput(value: unknown): value is SetEnabledInput {
  return (
    isRecord(value) &&
    onlyKeys(value, ['id', 'expectedUpdatedAt', 'enabled']) &&
    Object.keys(value).length === 3 &&
    isId(value['id']) &&
    isRevision(value['expectedUpdatedAt']) &&
    typeof value['enabled'] === 'boolean'
  )
}

function isDeleteInput(value: unknown): value is DeleteInput {
  return (
    isRecord(value) &&
    onlyKeys(value, ['id', 'expectedUpdatedAt']) &&
    Object.keys(value).length === 2 &&
    isId(value['id']) &&
    isRevision(value['expectedUpdatedAt'])
  )
}

function isListRunsInput(value: unknown): value is ListRunsInput {
  return (
    isRecord(value) &&
    onlyKeys(value, ['automationId', 'limit']) &&
    (value['automationId'] === undefined || isId(value['automationId'])) &&
    (value['limit'] === undefined ||
      (typeof value['limit'] === 'number' &&
        Number.isSafeInteger(value['limit']) &&
        value['limit'] >= 1 &&
        value['limit'] <= 200))
  )
}

function isRetryRunInput(value: unknown): value is RetryRunInput {
  return isRecord(value) && Object.keys(value).length === 1 && isId(value['runId'])
}

function draftInputSchema(extra: Record<string, unknown> = {}): Readonly<Record<string, unknown>> {
  return {
    type: 'object',
    additionalProperties: false,
    required: [...Object.keys(extra), 'draft'],
    properties: {
      ...Object.fromEntries(Object.entries(extra).map(([key, schema]) => [key, schema])),
      draft: {
        ...AUTOMATION_DRAFT_SCHEMA
      }
    }
  }
}

export function createAutomationManagementCapabilities(
  service: AutomationManagementService
): readonly ControlDescriptor<unknown, unknown>[] {
  return [
    {
      id: 'automations.catalog',
      version: 1,
      kind: 'query',
      description:
        'List automation-eligible Orpheus operations, safe schemas, event types, limits, and defaults.',
      inputSchema: EMPTY_INPUT_SCHEMA,
      outputSchema: CATALOG_SCHEMA,
      allowedSurfaces: ['mcp'],
      permission: AUTOMATION_MANAGEMENT_PERMISSION,
      scope: { kind: 'self' },
      risk: { tier: 0, label: 'read' },
      validateInput: (input): input is EmptyInput => isEmptyInput(input),
      handler: (_input, context) => service.catalog(context)
    },
    {
      id: 'automations.list',
      version: 1,
      kind: 'query',
      description: 'List automations scoped exactly to the calling workspace.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { enabledOnly: { type: 'boolean' } }
      },
      outputSchema: { type: 'array', items: DEFINITION_SCHEMA },
      allowedSurfaces: ['mcp'],
      permission: AUTOMATION_MANAGEMENT_PERMISSION,
      scope: { kind: 'self' },
      risk: { tier: 0, label: 'read' },
      validateInput: (input): input is ListInput => isListInput(input),
      handler: (input, context) => service.list((input as ListInput).enabledOnly ?? false, context)
    },
    {
      id: 'automations.get',
      version: 1,
      kind: 'query',
      description: 'Get one automation when it belongs to the calling workspace.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: { id: ID_PROPERTY }
      },
      outputSchema: DEFINITION_SCHEMA,
      allowedSurfaces: ['mcp'],
      permission: AUTOMATION_MANAGEMENT_PERMISSION,
      scope: { kind: 'resource', inputField: 'id' },
      risk: { tier: 0, label: 'read' },
      validateInput: (input): input is IdInput => isIdInput(input),
      handler: (input, context) => service.get((input as IdInput).id, context)
    },
    {
      id: 'automations.create',
      version: 1,
      kind: 'mutation',
      description: 'Create a disabled automation scoped exactly to the calling workspace.',
      inputSchema: draftInputSchema(),
      outputSchema: DEFINITION_SCHEMA,
      allowedSurfaces: ['mcp'],
      permission: AUTOMATION_MANAGEMENT_PERMISSION,
      scope: { kind: 'self' },
      risk: SCOPED_WRITE_RISK,
      declaredEffects: ['db.write'],
      validateInput: (input): input is CreateInput => isCreateInput(input),
      handler: (input, context) => service.create((input as CreateInput).draft, context)
    },
    {
      id: 'automations.update',
      version: 1,
      kind: 'mutation',
      description: 'Replace a disabled automation using its current updatedAt revision.',
      inputSchema: draftInputSchema({
        id: ID_PROPERTY,
        expectedUpdatedAt: REVISION_PROPERTY
      }),
      outputSchema: DEFINITION_SCHEMA,
      allowedSurfaces: ['mcp'],
      permission: AUTOMATION_MANAGEMENT_PERMISSION,
      scope: { kind: 'resource', inputField: 'id' },
      risk: SCOPED_WRITE_RISK,
      declaredEffects: ['db.write'],
      validateInput: (input): input is UpdateInput => isUpdateInput(input),
      handler: (input, context) => {
        const update = input as UpdateInput
        return service.update(update.id, update.expectedUpdatedAt, update.draft, context)
      }
    },
    {
      id: 'automations.setEnabled',
      version: 1,
      kind: 'mutation',
      description: 'Enable or disable a workspace automation using its current updatedAt revision.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'expectedUpdatedAt', 'enabled'],
        properties: {
          id: ID_PROPERTY,
          expectedUpdatedAt: REVISION_PROPERTY,
          enabled: { type: 'boolean' }
        }
      },
      outputSchema: DEFINITION_SCHEMA,
      allowedSurfaces: ['mcp'],
      permission: AUTOMATION_MANAGEMENT_PERMISSION,
      scope: { kind: 'resource', inputField: 'id' },
      risk: SCOPED_WRITE_RISK,
      declaredEffects: ['db.write'],
      validateInput: (input): input is SetEnabledInput => isSetEnabledInput(input),
      handler: (input, context) => {
        const update = input as SetEnabledInput
        return service.setEnabled(update.id, update.expectedUpdatedAt, update.enabled, context)
      }
    },
    {
      id: 'automations.delete',
      version: 1,
      kind: 'mutation',
      description: 'Delete a disabled workspace automation using its current updatedAt revision.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'expectedUpdatedAt'],
        properties: { id: ID_PROPERTY, expectedUpdatedAt: REVISION_PROPERTY }
      },
      outputSchema: DEFINITION_SCHEMA,
      allowedSurfaces: ['mcp'],
      permission: AUTOMATION_MANAGEMENT_PERMISSION,
      scope: { kind: 'resource', inputField: 'id' },
      risk: SCOPED_WRITE_RISK,
      declaredEffects: ['db.write'],
      validateInput: (input): input is DeleteInput => isDeleteInput(input),
      handler: (input, context) => {
        const deletion = input as DeleteInput
        return service.delete(deletion.id, deletion.expectedUpdatedAt, context)
      }
    },
    {
      id: 'automations.listRuns',
      version: 1,
      kind: 'query',
      description:
        'List redacted run summaries for one or all automations in the calling workspace.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          automationId: ID_PROPERTY,
          limit: { type: 'integer', minimum: 1, maximum: 200 }
        }
      },
      outputSchema: { type: 'array', items: RUN_SUMMARY_SCHEMA },
      allowedSurfaces: ['mcp'],
      permission: AUTOMATION_MANAGEMENT_PERMISSION,
      scope: { kind: 'self' },
      risk: { tier: 0, label: 'read' },
      validateInput: (input): input is ListRunsInput => isListRunsInput(input),
      handler: (input, context) => {
        const request = input as ListRunsInput
        return service.listRuns(request.automationId, request.limit ?? 100, context)
      }
    },
    {
      id: 'automations.retryRun',
      version: 1,
      kind: 'mutation',
      description:
        'Retry the latest eligible failed run of an enabled automation in the calling workspace.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['runId'],
        properties: { runId: ID_PROPERTY }
      },
      outputSchema: RUN_SUMMARY_SCHEMA,
      allowedSurfaces: ['mcp'],
      permission: AUTOMATION_MANAGEMENT_PERMISSION,
      scope: { kind: 'resource', inputField: 'runId' },
      risk: SCOPED_WRITE_RISK,
      declaredEffects: ['db.write'],
      validateInput: (input): input is RetryRunInput => isRetryRunInput(input),
      handler: (input, context): Promise<AutomationRunWithEligibility> =>
        service.retryRun((input as RetryRunInput).runId, context)
    }
  ]
}

export function isAutomationManagementOperation(operationId: string): boolean {
  return (AUTOMATION_MANAGEMENT_OPERATION_IDS as readonly string[]).includes(operationId)
}
