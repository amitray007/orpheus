import type { ControlDescriptor, ControlSchema } from './types'
import type {
  ClaudeSessionSnapshot,
  GetClaudeSessionInput,
  GetOutputTailInput,
  GetTerminalInput,
  ListTerminalsInput,
  OutputTailModel,
  SubscribeTerminalsInput,
  TerminalListModel,
  TerminalObservation,
  TerminalObservationHandlers,
  TerminalSnapshot,
  TerminalSubscriptionResult,
  TerminalTarget
} from '../terminalObservation/types'
import { MAX_EVENTS_PER_RESPONSE } from '../terminalObservation/journal'

export const TERMINALS_LIST_CONTROL_ID = 'terminals.list'
export const TERMINALS_GET_CONTROL_ID = 'terminals.get'
export const TERMINALS_GET_CLAUDE_SESSION_CONTROL_ID = 'terminals.getClaudeSession'
export const TERMINALS_GET_OUTPUT_TAIL_CONTROL_ID = 'terminals.getOutputTail'
export const TERMINALS_SUBSCRIBE_CONTROL_ID = 'terminals.subscribe'

const NON_EMPTY_STRING = { type: 'string', minLength: 1 } as const
const NULLABLE_STRING = { type: ['string', 'null'] } as const
const NULLABLE_NUMBER = { type: ['number', 'null'] } as const
const NULLABLE_BOOLEAN = { type: ['boolean', 'null'] } as const
const SOURCE_SCHEMA = {
  enum: [
    'live',
    'sqlite',
    'native-surface-registry',
    'claude-session-file',
    'claude-jsonl',
    'configured-runtime',
    'authoritative-text-stream'
  ]
} as const
const FRESHNESS_SCHEMA = {
  enum: ['live', 'current', 'stale', 'offline', 'unknown']
} as const
const AVAILABILITY_SCHEMA = {
  enum: ['available', 'unavailable', 'unsupported', 'offline']
} as const

const TARGET_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: { const: 'workspace_claude' },
        workspaceId: NON_EMPTY_STRING
      }
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'workspaceId', 'terminalId'],
      properties: {
        kind: { const: 'workbench' },
        workspaceId: NON_EMPTY_STRING,
        terminalId: { type: 'integer', minimum: 0, maximum: 2_147_483_647 }
      }
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'layoutId', 'paneId'],
      properties: {
        kind: { const: 'pane' },
        layoutId: NON_EMPTY_STRING,
        paneId: NON_EMPTY_STRING
      }
    }
  ]
} as const

const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'terminalId',
    'kind',
    'workspaceId',
    'projectId',
    'layoutId',
    'paneId',
    'surfaceRegistered'
  ],
  properties: {
    terminalId: NON_EMPTY_STRING,
    kind: { enum: ['workspace_claude', 'workbench', 'pane'] },
    workspaceId: NULLABLE_STRING,
    projectId: NULLABLE_STRING,
    layoutId: NULLABLE_STRING,
    paneId: NULLABLE_STRING,
    surfaceRegistered: { type: 'boolean' }
  }
} as const

const LIFECYCLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['registered', 'phase'],
  properties: {
    registered: { type: 'boolean' },
    phase: { enum: ['none', 'hidden', 'attached', 'visible', 'freeing'] }
  }
} as const

const RUNTIME_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['running', 'ready', 'runtimeId', 'pid'],
  properties: {
    running: NULLABLE_BOOLEAN,
    ready: NULLABLE_BOOLEAN,
    runtimeId: NULLABLE_STRING,
    pid: NULLABLE_NUMBER
  }
} as const

const ACTIVITY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['activity', 'persistedStatus', 'liveStatus', 'waitingFor'],
  properties: {
    activity: { type: 'string' },
    persistedStatus: { type: 'string' },
    liveStatus: { enum: ['busy', 'idle', 'waiting', 'shell', 'unknown'] },
    waitingFor: NULLABLE_STRING
  }
} as const

const CONFIGURATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['command', 'cwd'],
  properties: {
    command: { type: 'string' },
    cwd: NON_EMPTY_STRING
  }
} as const

const SESSION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'claudeConversationId',
    'pid',
    'version',
    'cwd',
    'status',
    'waitingFor',
    'statusUpdatedAt'
  ],
  properties: {
    claudeConversationId: NON_EMPTY_STRING,
    pid: NULLABLE_NUMBER,
    version: NULLABLE_STRING,
    cwd: NULLABLE_STRING,
    status: { enum: ['busy', 'idle', 'waiting', 'shell', 'starting', 'unknown'] },
    waitingFor: NULLABLE_STRING,
    statusUpdatedAt: NULLABLE_NUMBER
  }
} as const

const TRANSCRIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['turns', 'truncated', 'bytesRead'],
  properties: {
    turns: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['role', 'text', 'timestamp'],
        properties: {
          role: { enum: ['user', 'assistant'] },
          text: { type: 'string' },
          timestamp: NULLABLE_NUMBER,
          toolActivity: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'summary'],
              properties: {
                kind: { enum: ['tool_use', 'tool_result'] },
                name: { type: 'string' },
                summary: { type: 'string' }
              }
            }
          }
        }
      }
    },
    truncated: { type: 'boolean' },
    bytesRead: { type: 'integer', minimum: 0, maximum: 4_194_304 }
  }
} as const

const LAST_TURN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['userText', 'assistantText', 'userAt', 'assistantAt'],
  properties: {
    userText: NULLABLE_STRING,
    assistantText: NULLABLE_STRING,
    userAt: NULLABLE_NUMBER,
    assistantAt: NULLABLE_NUMBER
  }
} as const

function observationSchema(valueSchema: ControlSchema): ControlSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['value', 'source', 'observedAt', 'sourceUpdatedAt', 'freshness', 'availability'],
    properties: {
      value: { oneOf: [valueSchema, { type: 'null' }] },
      source: SOURCE_SCHEMA,
      observedAt: { type: 'number' },
      sourceUpdatedAt: NULLABLE_NUMBER,
      freshness: FRESHNESS_SCHEMA,
      availability: AVAILABILITY_SCHEMA,
      reason: { type: 'string' }
    }
  }
}

const SNAPSHOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'terminal',
    'lifecycle',
    'runtime',
    'activity',
    'configuration',
    'claudeSession'
  ],
  properties: {
    schemaVersion: { const: 1 },
    terminal: SUMMARY_SCHEMA,
    lifecycle: observationSchema(LIFECYCLE_SCHEMA),
    runtime: observationSchema(RUNTIME_SCHEMA),
    activity: observationSchema(ACTIVITY_SCHEMA),
    configuration: observationSchema(CONFIGURATION_SCHEMA),
    claudeSession: observationSchema(SESSION_SCHEMA)
  }
} as const

const LIST_OUTPUT_SCHEMA = observationSchema({
  type: 'object',
  additionalProperties: false,
  required: ['terminals', 'truncated'],
  properties: {
    terminals: {
      type: 'array',
      maxItems: 256,
      items: SUMMARY_SCHEMA
    },
    truncated: { type: 'boolean' }
  }
})

const CLAUDE_SESSION_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'workspaceId', 'session', 'transcript', 'lastTurn'],
  properties: {
    schemaVersion: { const: 1 },
    workspaceId: NON_EMPTY_STRING,
    session: observationSchema(SESSION_SCHEMA),
    transcript: observationSchema(TRANSCRIPT_SCHEMA),
    lastTurn: observationSchema(LAST_TURN_SCHEMA)
  }
} as const

const TAIL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'bytes', 'lines', 'truncated'],
  properties: {
    text: { type: 'string' },
    bytes: { type: 'integer', minimum: 0, maximum: 65_536 },
    lines: { type: 'integer', minimum: 0, maximum: 200 },
    truncated: { type: 'boolean' }
  }
} as const

const EVENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['revision', 'terminalId', 'kind', 'observedAt', 'source', 'state'],
  properties: {
    revision: { type: 'integer', minimum: 1 },
    terminalId: NON_EMPTY_STRING,
    kind: { enum: ['lifecycle', 'runtime', 'readiness', 'activity'] },
    observedAt: { type: 'number' },
    source: SOURCE_SCHEMA,
    state: {
      type: 'object',
      additionalProperties: false,
      properties: {
        registered: { type: 'boolean' },
        phase: { enum: ['none', 'hidden', 'attached', 'visible', 'freeing'] },
        claudeConversationId: NON_EMPTY_STRING,
        pid: NULLABLE_NUMBER,
        version: NULLABLE_STRING,
        cwd: NULLABLE_STRING,
        status: { enum: ['busy', 'idle', 'waiting', 'shell', 'starting', 'unknown'] },
        waitingFor: NULLABLE_STRING,
        statusUpdatedAt: NULLABLE_NUMBER,
        availability: { enum: ['available', 'unavailable', 'offline'] },
        ready: { type: 'boolean' },
        activity: { type: 'string' }
      }
    }
  }
} as const

const SUBSCRIBE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'cursor',
    'oldestRevision',
    'timedOut',
    'resyncRequired',
    'capacityLimited',
    'snapshots',
    'events'
  ],
  properties: {
    schemaVersion: { const: 1 },
    cursor: { type: 'integer', minimum: 0 },
    oldestRevision: { type: 'integer', minimum: 1 },
    timedOut: { type: 'boolean' },
    resyncRequired: { type: 'boolean' },
    capacityLimited: { type: 'boolean' },
    snapshots: {
      type: 'array',
      maxItems: 256,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['terminalId', 'snapshot'],
        properties: {
          terminalId: NON_EMPTY_STRING,
          snapshot: SNAPSHOT_SCHEMA
        }
      }
    },
    events: {
      type: 'array',
      maxItems: 100,
      items: EVENT_SCHEMA
    }
  }
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function optionalInteger(
  value: unknown,
  minimum: number,
  maximum: number
): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum)
  )
}

function isTerminalTarget(value: unknown): value is TerminalTarget {
  if (!isRecord(value) || typeof value['kind'] !== 'string') return false
  if (value['kind'] === 'workspace_claude') {
    return (
      onlyKeys(value, ['kind', 'workspaceId']) &&
      (value['workspaceId'] === undefined || nonEmptyString(value['workspaceId']))
    )
  }
  if (value['kind'] === 'workbench') {
    return (
      onlyKeys(value, ['kind', 'workspaceId', 'terminalId']) &&
      nonEmptyString(value['workspaceId']) &&
      optionalInteger(value['terminalId'], 0, 2_147_483_647) &&
      value['terminalId'] !== undefined
    )
  }
  return (
    value['kind'] === 'pane' &&
    onlyKeys(value, ['kind', 'layoutId', 'paneId']) &&
    nonEmptyString(value['layoutId']) &&
    nonEmptyString(value['paneId'])
  )
}

function optionalTarget(value: unknown): value is TerminalTarget | undefined {
  return value === undefined || isTerminalTarget(value)
}

function isEmptyInput(input: unknown): input is ListTerminalsInput {
  return isRecord(input) && Object.keys(input).length === 0
}

function isGetInput(input: unknown): input is GetTerminalInput {
  return isRecord(input) && onlyKeys(input, ['target']) && optionalTarget(input['target'])
}

function isClaudeSessionInput(input: unknown): input is GetClaudeSessionInput {
  return (
    isRecord(input) &&
    onlyKeys(input, ['workspaceId', 'transcriptLimit', 'includeToolActivity']) &&
    (input['workspaceId'] === undefined || nonEmptyString(input['workspaceId'])) &&
    optionalInteger(input['transcriptLimit'], 1, 50) &&
    (input['includeToolActivity'] === undefined ||
      typeof input['includeToolActivity'] === 'boolean')
  )
}

function isTailInput(input: unknown): input is GetOutputTailInput {
  return (
    isRecord(input) &&
    onlyKeys(input, ['target', 'maxBytes', 'maxLines']) &&
    optionalTarget(input['target']) &&
    optionalInteger(input['maxBytes'], 1, 65_536) &&
    optionalInteger(input['maxLines'], 1, 200)
  )
}

function isSubscribeInput(input: unknown): input is SubscribeTerminalsInput {
  return (
    isRecord(input) &&
    onlyKeys(input, ['target', 'afterRevision', 'timeoutMs', 'maxEvents']) &&
    optionalTarget(input['target']) &&
    optionalInteger(input['afterRevision'], 0, Number.MAX_SAFE_INTEGER) &&
    optionalInteger(input['timeoutMs'], 1, 25_000) &&
    optionalInteger(input['maxEvents'], 1, MAX_EVENTS_PER_RESPONSE)
  )
}

function descriptor<TInput, TOutput>(input: {
  id: string
  description: string
  inputSchema: ControlSchema
  outputSchema: ControlSchema
  validateInput: (value: unknown) => value is TInput
  handler: (
    input: TInput,
    context: Parameters<TerminalObservationHandlers['list']>[0]
  ) => TOutput | Promise<TOutput>
}): ControlDescriptor<TInput, TOutput> {
  return {
    id: input.id,
    version: 1,
    kind: 'query',
    description: input.description,
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
    allowedSurfaces: ['mcp'],
    permission: 'terminals.read',
    scope: { kind: 'self' },
    risk: { tier: 0, label: 'read' },
    declaredEffects: [],
    validateInput: input.validateInput,
    handler: input.handler
  }
}

export function createTerminalObservationCapabilities(
  handlers: TerminalObservationHandlers
): [
  ControlDescriptor<ListTerminalsInput, TerminalObservation<TerminalListModel>>,
  ControlDescriptor<GetTerminalInput, TerminalSnapshot>,
  ControlDescriptor<GetClaudeSessionInput, ClaudeSessionSnapshot>,
  ControlDescriptor<GetOutputTailInput, TerminalObservation<OutputTailModel>>,
  ControlDescriptor<SubscribeTerminalsInput, TerminalSubscriptionResult>
] {
  return [
    descriptor({
      id: TERMINALS_LIST_CONTROL_ID,
      description: 'List bounded terminal summaries authorized for this runtime.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      outputSchema: LIST_OUTPUT_SCHEMA,
      validateInput: isEmptyInput,
      handler: (_input, context) => handlers.list(context)
    }),
    descriptor({
      id: TERMINALS_GET_CONTROL_ID,
      description:
        'Observe lifecycle, runtime, readiness, activity, configuration, and session metadata.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { target: TARGET_SCHEMA }
      },
      outputSchema: SNAPSHOT_SCHEMA,
      validateInput: isGetInput,
      handler: (input, context) => handlers.get(input, context)
    }),
    descriptor({
      id: TERMINALS_GET_CLAUDE_SESSION_CONTROL_ID,
      description: 'Read bounded Claude session metadata, transcript, and last turn.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workspaceId: NON_EMPTY_STRING,
          transcriptLimit: { type: 'integer', minimum: 1, maximum: 50 },
          includeToolActivity: { type: 'boolean' }
        }
      },
      outputSchema: CLAUDE_SESSION_OUTPUT_SCHEMA,
      validateInput: isClaudeSessionInput,
      handler: (input, context) => handlers.getClaudeSession(input, context)
    }),
    descriptor({
      id: TERMINALS_GET_OUTPUT_TAIL_CONTROL_ID,
      description: 'Read a bounded output tail only from a registered authoritative text stream.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: TARGET_SCHEMA,
          maxBytes: { type: 'integer', minimum: 1, maximum: 65_536 },
          maxLines: { type: 'integer', minimum: 1, maximum: 200 }
        }
      },
      outputSchema: observationSchema(TAIL_SCHEMA),
      validateInput: isTailInput,
      handler: (input, context) => handlers.getOutputTail(input, context)
    }),
    descriptor({
      id: TERMINALS_SUBSCRIBE_CONTROL_ID,
      description: 'Create a race-free snapshot cursor or long-poll bounded terminal transitions.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: TARGET_SCHEMA,
          afterRevision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          timeoutMs: { type: 'integer', minimum: 1, maximum: 25_000 },
          maxEvents: { type: 'integer', minimum: 1, maximum: 100 }
        }
      },
      outputSchema: SUBSCRIBE_OUTPUT_SCHEMA,
      validateInput: isSubscribeInput,
      handler: (input, context) => handlers.subscribe(input, context)
    })
  ]
}
