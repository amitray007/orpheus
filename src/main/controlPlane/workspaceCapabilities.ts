import type {
  ArchiveWorkspaceInput,
  CloseWorkspaceInput,
  CreateWorkspaceInput,
  GetLineageInput,
  OpenWorkspaceInput,
  RenameWorkspaceInput,
  SendWorkspaceInput,
  StartTaskInput,
  WaitWorkspacesInput,
  WorkspaceOperationActor
} from '../workspaceOrchestration/types'
import type { WorkspaceOrchestrationService } from '../workspaceOrchestration/service'
import type {
  ControlContext,
  ControlDescriptor,
  ControlPermission,
  ControlRejectionAuditor,
  ControlSchema
} from './types'

const WORKSPACES_OPEN_ID = 'workspaces.open'
const WORKSPACES_SEND_ID = 'workspaces.send'

export const WORKSPACE_OPERATION_IDS = [
  'workspaces.getLineage',
  'workspaces.create',
  'workspaces.startTask',
  WORKSPACES_OPEN_ID,
  WORKSPACES_SEND_ID,
  'workspaces.wait',
  'workspaces.close',
  'workspaces.reopen',
  'workspaces.rename',
  'workspaces.archive'
] as const

const ID_SCHEMA = { type: 'string', minLength: 1, maxLength: 128 } as const
const PRESENTATION_SCHEMA = { enum: ['background', 'focus'] } as const
const TEXT_SCHEMA = { type: 'string', minLength: 1, maxLength: 65_536 } as const
const MUTATION_SURFACES = ['renderer', 'command-socket', 'mcp'] as const
const QUERY_SURFACES = ['renderer', 'command-socket', 'mcp'] as const

const WORKSPACE_REF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'workspaceId',
    'projectId',
    'name',
    'mode',
    'cwd',
    'parentWorkspaceId',
    'closedAt',
    'archivedAt'
  ],
  properties: {
    workspaceId: ID_SCHEMA,
    projectId: ID_SCHEMA,
    name: { type: 'string' },
    mode: { enum: ['local', 'worktree'] },
    cwd: { type: 'string', minLength: 1 },
    parentWorkspaceId: { type: ['string', 'null'] },
    closedAt: { type: ['number', 'null'] },
    archivedAt: { type: ['number', 'null'] }
  }
} as const

const EFFECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['effect', 'status'],
  properties: {
    effect: { type: 'string', minLength: 1 },
    status: { enum: ['applied', 'skipped', 'failed'] },
    workspaceId: ID_SCHEMA,
    resourceId: { type: 'string' },
    message: { type: 'string' }
  }
} as const

const START_TASK_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['workspaceId', 'accepted', 'submitted'],
  properties: {
    workspaceId: ID_SCHEMA,
    accepted: { const: true },
    submitted: { const: true }
  }
} as const

const SEND_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['workspaceId', 'accepted', 'submitted'],
  properties: {
    workspaceId: ID_SCHEMA,
    accepted: { const: true },
    submitted: { type: 'boolean' }
  }
} as const

const OPEN_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['workspace', 'presentation', 'runtimeState'],
  properties: {
    workspace: WORKSPACE_REF_SCHEMA,
    presentation: PRESENTATION_SCHEMA,
    runtimeState: { enum: ['retained', 'started'] }
  }
} as const

function lifecycleValueSchema(field: 'closed', value: boolean): ControlSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['workspace', field],
    properties: {
      workspace: WORKSPACE_REF_SCHEMA,
      [field]: { const: value }
    }
  }
}

const RENAME_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['workspace', 'previousName'],
  properties: {
    workspace: WORKSPACE_REF_SCHEMA,
    previousName: { type: 'string' }
  }
} as const

const WAIT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'requestedUntil', 'timedOut', 'results'],
  properties: {
    schemaVersion: { const: 1 },
    requestedUntil: { enum: ['done', 'input', 'idle'] },
    timedOut: { type: 'boolean' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['workspaceId', 'outcome', 'status', 'observedAt'],
        properties: {
          workspaceId: ID_SCHEMA,
          outcome: {
            enum: ['done', 'blocked_permission', 'blocked_input', 'died', 'timeout', 'not_found']
          },
          status: { type: ['string', 'null'] },
          observedAt: { type: 'number' }
        }
      }
    }
  }
} as const

const ARCHIVE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rootWorkspaceId', 'recursive', 'order', 'workspaces'],
  properties: {
    rootWorkspaceId: ID_SCHEMA,
    recursive: { type: 'boolean' },
    order: { type: 'array', items: ID_SCHEMA },
    workspaces: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['workspaceId', 'status', 'persistedRecord'],
        properties: {
          workspaceId: ID_SCHEMA,
          status: { enum: ['archived', 'skipped', 'failed'] },
          persistedRecord: { enum: ['removed', 'retained'] }
        }
      }
    }
  }
} as const

function receiptSchema(value: ControlSchema): ControlSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'schemaVersion',
      'requestId',
      'operationId',
      'status',
      'target',
      'value',
      'effects',
      'auditId'
    ],
    properties: {
      schemaVersion: { const: 1 },
      requestId: ID_SCHEMA,
      operationId: ID_SCHEMA,
      status: { enum: ['completed', 'partial'] },
      target: {
        type: 'object',
        additionalProperties: false,
        required: ['projectId', 'workspaceId'],
        properties: {
          projectId: ID_SCHEMA,
          workspaceId: { type: ['string', 'null'] }
        }
      },
      value,
      effects: { type: 'array', items: EFFECT_SCHEMA },
      auditId: ID_SCHEMA
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128
}

function isOptionalId(value: unknown): value is string | undefined {
  return value === undefined || isId(value)
}

function isPresentation(value: unknown): value is 'background' | 'focus' | undefined {
  return value === undefined || value === 'background' || value === 'focus'
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean'
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 65_536
}

export function workspaceActorFromContext(
  context: ControlContext,
  permission: ControlPermission
): WorkspaceOperationActor {
  const binding = context.trustedRuntime ?? null
  const automation = context.trustedAutomation ?? null
  if (context.consumer === 'mcp' && binding == null) {
    throw new Error('Trusted runtime binding missing after authorization.')
  }
  return {
    requestId: context.requestId,
    consumer: context.consumer,
    principal: {
      kind: binding == null ? context.principal.type : 'orpheus_runtime',
      runtimeId: binding?.runtimeId ?? null
    },
    boundProjectId:
      binding?.projectId ??
      (automation?.scope.kind === 'app' ? null : automation?.scope.projectId) ??
      context.projectId,
    boundWorkspaceId:
      binding?.workspaceId ??
      (automation?.scope.kind === 'workspace' ? automation.scope.workspaceId : null) ??
      context.workspaceId,
    permissions: binding?.permissions ?? automation?.permissions ?? [permission],
    ...(automation != null && context.automationRunId != null && context.idempotencyKey != null
      ? {
          correlation: {
            automationId: automation.automationId,
            runId: context.automationRunId,
            idempotencyKey: context.idempotencyKey
          }
        }
      : {})
  }
}

export function createWorkspaceRejectionAuditor(
  service: WorkspaceOrchestrationService
): ControlRejectionAuditor {
  return {
    auditRejected: ({ description, params, context, code, decision }) =>
      service.auditRejected(
        {
          id: description.id,
          permission: description.permission,
          tier: description.risk.tier,
          effects: description.declaredEffects ?? []
        },
        params,
        workspaceActorFromContext(context, description.permission),
        code,
        decision
      )
  }
}

function isCreateInput(value: unknown): value is CreateWorkspaceInput {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ['mode', 'name', 'parentWorkspaceId', 'fork', 'branch', 'presentation']) ||
    (value['mode'] !== 'local' && value['mode'] !== 'worktree') ||
    !isOptionalId(value['parentWorkspaceId']) ||
    !isOptionalBoolean(value['fork']) ||
    !isPresentation(value['presentation'])
  ) {
    return false
  }
  const name = value['name']
  if (
    name !== undefined &&
    (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 120)
  ) {
    return false
  }
  const branch = value['branch']
  if (
    branch !== undefined &&
    (value['mode'] !== 'worktree' ||
      typeof branch !== 'string' ||
      branch.trim().length < 1 ||
      branch.trim().length > 255)
  ) {
    return false
  }
  return true
}

function isStartTaskInput(value: unknown): value is StartTaskInput {
  return (
    isRecord(value) &&
    onlyKeys(value, ['workspaceId', 'text', 'presentation']) &&
    isOptionalId(value['workspaceId']) &&
    isText(value['text']) &&
    isPresentation(value['presentation'])
  )
}

function isOpenInput(value: unknown): value is OpenWorkspaceInput {
  return (
    isRecord(value) &&
    onlyKeys(value, ['workspaceId', 'presentation']) &&
    isOptionalId(value['workspaceId']) &&
    isPresentation(value['presentation'])
  )
}

function isSendInput(value: unknown): value is SendWorkspaceInput {
  return (
    isRecord(value) &&
    onlyKeys(value, ['workspaceId', 'text', 'submit', 'presentation']) &&
    isOptionalId(value['workspaceId']) &&
    isText(value['text']) &&
    isOptionalBoolean(value['submit']) &&
    isPresentation(value['presentation'])
  )
}

function isWaitInput(value: unknown, context: ControlContext): value is WaitWorkspacesInput {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ['workspaceIds', 'until', 'timeoutMs']) ||
    !['done', 'input', 'idle', undefined].includes(value['until'] as string | undefined)
  ) {
    return false
  }
  const ids = value['workspaceIds']
  if (
    ids !== undefined &&
    (!Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > 32 ||
      !ids.every(isId) ||
      new Set(ids).size !== ids.length)
  ) {
    return false
  }
  const timeout = value['timeoutMs']
  const maximum = context.consumer === 'mcp' ? 25_000 : Number.MAX_SAFE_INTEGER
  return (
    timeout === undefined ||
    (typeof timeout === 'number' &&
      Number.isSafeInteger(timeout) &&
      timeout >= 1 &&
      timeout <= maximum)
  )
}

function requiredWorkspaceInput(value: unknown): value is CloseWorkspaceInput {
  return isRecord(value) && onlyKeys(value, ['workspaceId']) && isId(value['workspaceId'])
}

function isRenameInput(value: unknown): value is RenameWorkspaceInput {
  return (
    isRecord(value) &&
    onlyKeys(value, ['workspaceId', 'name']) &&
    isOptionalId(value['workspaceId']) &&
    typeof value['name'] === 'string' &&
    value['name'].trim().length >= 1 &&
    value['name'].trim().length <= 120
  )
}

function isArchiveInput(value: unknown): value is ArchiveWorkspaceInput {
  return (
    isRecord(value) &&
    onlyKeys(value, ['workspaceId', 'recursive']) &&
    isId(value['workspaceId']) &&
    isOptionalBoolean(value['recursive'])
  )
}

function isLineageInput(value: unknown): value is GetLineageInput {
  return isRecord(value) && onlyKeys(value, ['workspaceId']) && isOptionalId(value['workspaceId'])
}

const optionalWorkspaceSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { workspaceId: ID_SCHEMA }
} as const

const requiredWorkspaceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['workspaceId'],
  properties: { workspaceId: ID_SCHEMA }
} as const

function mutationDescriptor<TInput, TOutput>(
  descriptor: ControlDescriptor<TInput, TOutput>
): ControlDescriptor<TInput, TOutput> {
  return descriptor
}

// The tuple preserves each descriptor's distinct input/output generic.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createWorkspaceCapabilities(service: WorkspaceOrchestrationService) {
  const getLineage: ControlDescriptor<
    GetLineageInput,
    Awaited<ReturnType<typeof service.getLineage>>
  > = {
    id: 'workspaces.getLineage',
    version: 1,
    kind: 'query',
    description: 'Read persisted ancestors and direct children for a workspace.',
    inputSchema: optionalWorkspaceSchema,
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['workspace', 'ancestors', 'children'],
      properties: {
        workspace: WORKSPACE_REF_SCHEMA,
        ancestors: { type: 'array', items: WORKSPACE_REF_SCHEMA },
        children: { type: 'array', items: WORKSPACE_REF_SCHEMA }
      }
    },
    allowedSurfaces: QUERY_SURFACES,
    permission: 'workspaces.read',
    scope: { kind: 'workspace', inputField: 'workspaceId' },
    risk: { tier: 0, label: 'read' },
    declaredEffects: [],
    validateInput: isLineageInput,
    handler: (input, context) =>
      service.getLineage(input, workspaceActorFromContext(context, 'workspaces.read'))
  }

  const create = mutationDescriptor({
    id: 'workspaces.create',
    version: 1,
    kind: 'mutation',
    description: 'Create a local or managed-worktree workspace with optional lineage.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['mode'],
      properties: {
        mode: { enum: ['local', 'worktree'] },
        name: { type: 'string', minLength: 1, maxLength: 120 },
        parentWorkspaceId: ID_SCHEMA,
        fork: { type: 'boolean' },
        branch: { type: 'string', minLength: 1, maxLength: 255 },
        presentation: PRESENTATION_SCHEMA
      },
      oneOf: [
        {
          properties: { mode: { const: 'local' } },
          required: ['mode'],
          not: { required: ['branch'] }
        },
        {
          properties: { mode: { const: 'worktree' } },
          required: ['mode']
        }
      ]
    },
    outputSchema: receiptSchema({
      type: 'object',
      additionalProperties: false,
      required: ['workspace', 'lineage', 'presentation'],
      properties: {
        workspace: WORKSPACE_REF_SCHEMA,
        lineage: {
          type: 'object',
          additionalProperties: false,
          required: ['parentWorkspaceId', 'forkedFromConversationId'],
          properties: {
            parentWorkspaceId: { type: ['string', 'null'] },
            forkedFromConversationId: { type: ['string', 'null'] }
          }
        },
        presentation: PRESENTATION_SCHEMA
      }
    }),
    allowedSurfaces: MUTATION_SURFACES,
    permission: 'workspaces.create',
    scope: { kind: 'project' },
    risk: { tier: 2, label: 'write' },
    declaredEffects: [
      'db.write',
      'git.worktree.create',
      'filesystem.write',
      'surface.mount',
      'process.spawn',
      'ui.focus'
    ],
    validateInput: isCreateInput,
    handler: (input, context) =>
      service.create(input, workspaceActorFromContext(context, 'workspaces.create'))
  })

  const startTask = mutationDescriptor({
    id: 'workspaces.startTask',
    version: 1,
    kind: 'mutation',
    description: 'Start a workspace task after bounded runtime readiness.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        workspaceId: ID_SCHEMA,
        text: TEXT_SCHEMA,
        presentation: PRESENTATION_SCHEMA
      }
    },
    outputSchema: receiptSchema(START_TASK_VALUE_SCHEMA),
    allowedSurfaces: MUTATION_SURFACES,
    permission: WORKSPACES_SEND_ID,
    scope: { kind: 'workspace', inputField: 'workspaceId' },
    risk: { tier: 2, label: 'terminal input' },
    declaredEffects: ['surface.mount', 'process.spawn', 'terminal.input', 'ui.focus'],
    validateInput: isStartTaskInput,
    handler: (input, context) =>
      service.startTask(input, workspaceActorFromContext(context, WORKSPACES_SEND_ID))
  })

  const open = mutationDescriptor({
    id: WORKSPACES_OPEN_ID,
    version: 1,
    kind: 'mutation',
    description: 'Mount or retain a workspace runtime and optionally focus it.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { workspaceId: ID_SCHEMA, presentation: PRESENTATION_SCHEMA }
    },
    outputSchema: receiptSchema(OPEN_VALUE_SCHEMA),
    allowedSurfaces: MUTATION_SURFACES,
    permission: WORKSPACES_OPEN_ID,
    scope: { kind: 'workspace', inputField: 'workspaceId' },
    risk: { tier: 1, label: 'presentation' },
    declaredEffects: ['surface.mount', 'process.spawn', 'db.write', 'ui.focus'],
    validateInput: isOpenInput,
    handler: (input, context) =>
      service.open(input, workspaceActorFromContext(context, WORKSPACES_OPEN_ID))
  })

  const send = mutationDescriptor({
    id: WORKSPACES_SEND_ID,
    version: 1,
    kind: 'mutation',
    description: 'Send text to an authorized workspace and optionally submit it.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        workspaceId: ID_SCHEMA,
        text: TEXT_SCHEMA,
        submit: { type: 'boolean' },
        presentation: PRESENTATION_SCHEMA
      }
    },
    outputSchema: receiptSchema(SEND_VALUE_SCHEMA),
    allowedSurfaces: MUTATION_SURFACES,
    permission: WORKSPACES_SEND_ID,
    scope: { kind: 'workspace', inputField: 'workspaceId' },
    risk: { tier: 2, label: 'terminal input' },
    declaredEffects: ['surface.mount', 'process.spawn', 'terminal.input', 'ui.focus'],
    validateInput: isSendInput,
    handler: (input, context) =>
      service.send(input, workspaceActorFromContext(context, WORKSPACES_SEND_ID))
  })

  const wait: ControlDescriptor<WaitWorkspacesInput, Awaited<ReturnType<typeof service.wait>>> = {
    id: 'workspaces.wait',
    version: 1,
    kind: 'query',
    description: 'Wait once for authorized workspace terminal conditions.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        workspaceIds: {
          type: 'array',
          minItems: 1,
          maxItems: 32,
          uniqueItems: true,
          items: ID_SCHEMA
        },
        until: { enum: ['done', 'input', 'idle'] },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 25_000 }
      }
    },
    outputSchema: WAIT_OUTPUT_SCHEMA,
    allowedSurfaces: QUERY_SURFACES,
    permission: 'workspaces.wait',
    scope: { kind: 'workspace', inputField: 'workspaceIds' },
    risk: { tier: 0, label: 'read' },
    declaredEffects: [],
    validateInput: isWaitInput,
    handler: (input, context) =>
      service.wait(input, workspaceActorFromContext(context, 'workspaces.wait'))
  }

  const close = mutationDescriptor({
    id: 'workspaces.close',
    version: 1,
    kind: 'mutation',
    description: 'Close another workspace and tear down its runtime.',
    inputSchema: requiredWorkspaceSchema,
    outputSchema: receiptSchema(lifecycleValueSchema('closed', true)),
    allowedSurfaces: MUTATION_SURFACES,
    permission: 'workspaces.close',
    scope: { kind: 'workspace', inputField: 'workspaceId' },
    risk: { tier: 2, label: 'lifecycle' },
    declaredEffects: ['surface.destroy', 'process.terminate', 'db.write'],
    validateInput: requiredWorkspaceInput,
    handler: (input, context) =>
      service.close(input, workspaceActorFromContext(context, 'workspaces.close'))
  })

  const reopen = mutationDescriptor({
    id: 'workspaces.reopen',
    version: 1,
    kind: 'mutation',
    description: 'Clear a workspace closed state without presenting it.',
    inputSchema: requiredWorkspaceSchema,
    outputSchema: receiptSchema(lifecycleValueSchema('closed', false)),
    allowedSurfaces: MUTATION_SURFACES,
    permission: WORKSPACES_OPEN_ID,
    scope: { kind: 'workspace', inputField: 'workspaceId' },
    risk: { tier: 1, label: 'lifecycle' },
    declaredEffects: ['db.write'],
    validateInput: requiredWorkspaceInput,
    handler: (input, context) =>
      service.reopen(input, workspaceActorFromContext(context, WORKSPACES_OPEN_ID))
  })

  const rename = mutationDescriptor({
    id: 'workspaces.rename',
    version: 1,
    kind: 'mutation',
    description: 'Rename workspace display metadata only.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: { workspaceId: ID_SCHEMA, name: { type: 'string', minLength: 1, maxLength: 120 } }
    },
    outputSchema: receiptSchema(RENAME_VALUE_SCHEMA),
    allowedSurfaces: MUTATION_SURFACES,
    permission: 'workspaces.rename',
    scope: { kind: 'workspace', inputField: 'workspaceId' },
    risk: { tier: 2, label: 'write' },
    declaredEffects: ['db.write'],
    validateInput: isRenameInput,
    handler: (input, context) =>
      service.rename(input, workspaceActorFromContext(context, 'workspaces.rename'))
  })

  const archive = mutationDescriptor({
    id: 'workspaces.archive',
    version: 1,
    kind: 'mutation',
    description: 'Preflight and archive a workspace or complete subtree.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['workspaceId'],
      properties: { workspaceId: ID_SCHEMA, recursive: { type: 'boolean' } }
    },
    outputSchema: receiptSchema(ARCHIVE_VALUE_SCHEMA),
    allowedSurfaces: MUTATION_SURFACES,
    permission: 'workspaces.archive',
    scope: { kind: 'workspace', inputField: 'workspaceId' },
    risk: { tier: 3, label: 'destructive' },
    declaredEffects: [
      'surface.destroy',
      'process.terminate',
      'git.worktree.remove',
      'filesystem.delete',
      'workspace.delete',
      'db.write'
    ],
    validateInput: isArchiveInput,
    handler: (input, context) =>
      service.archive(input, workspaceActorFromContext(context, 'workspaces.archive'))
  })

  return [getLineage, create, startTask, open, send, wait, close, reopen, rename, archive] as const
}
