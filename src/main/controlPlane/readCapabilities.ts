import type {
  ControlDescriptor,
  ControlReadObservation,
  ControlSchema,
  EmptyReadInput,
  LastTurnReadModel,
  ProjectGetInput,
  ProjectReadModel,
  ReadCapabilityHandlers,
  SelfReadModel,
  TranscriptReadModel,
  TrustedRuntimeBinding,
  WorkspaceListInput,
  WorkspaceReadModel,
  WorkspaceStatusReadModel,
  WorkspaceTargetInput,
  WorkspaceTranscriptInput
} from './types'

export const SELF_GET_CONTROL_ID = 'self.get'
export const PROJECTS_LIST_CONTROL_ID = 'projects.list'
export const PROJECTS_GET_CONTROL_ID = 'projects.get'
export const WORKSPACES_LIST_CONTROL_ID = 'workspaces.list'
export const WORKSPACES_GET_CONTROL_ID = 'workspaces.get'
export const WORKSPACES_GET_STATUS_CONTROL_ID = 'workspaces.getStatus'
export const WORKSPACES_GET_TRANSCRIPT_CONTROL_ID = 'workspaces.getTranscript'
export const WORKSPACES_GET_LAST_TURN_CONTROL_ID = 'workspaces.getLastTurn'

const WORKSPACES_READ_PERMISSION = 'workspaces.read'

const EMPTY_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {}
} as const

const OPTIONAL_PROJECT_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { projectId: { type: 'string', minLength: 1 } }
} as const

const OPTIONAL_WORKSPACE_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { workspaceId: { type: 'string', minLength: 1 } }
} as const

const NON_EMPTY_STRING_SCHEMA = { type: 'string', minLength: 1 } as const
const NULLABLE_STRING_SCHEMA = { type: ['string', 'null'] } as const
const NULLABLE_NUMBER_SCHEMA = { type: ['number', 'null'] } as const

const PROJECT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'path', 'addedAt', 'lastOpenedAt', 'pinnedAt', 'classified', 'hidden'],
  properties: {
    id: NON_EMPTY_STRING_SCHEMA,
    name: { type: 'string' },
    path: NON_EMPTY_STRING_SCHEMA,
    addedAt: { type: 'number' },
    lastOpenedAt: NULLABLE_NUMBER_SCHEMA,
    pinnedAt: NULLABLE_NUMBER_SCHEMA,
    classified: { type: 'boolean' },
    hidden: { type: 'boolean' }
  }
} as const

const WORKSPACE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'projectId',
    'name',
    'cwd',
    'pinnedAt',
    'createdAt',
    'lastOpenedAt',
    'archivedAt',
    'closedAt',
    'status',
    'claudeConversationId',
    'parentWorkspaceId',
    'worktreeParentCwd',
    'worktreeBranch'
  ],
  properties: {
    id: NON_EMPTY_STRING_SCHEMA,
    projectId: NON_EMPTY_STRING_SCHEMA,
    name: { type: 'string' },
    cwd: NON_EMPTY_STRING_SCHEMA,
    pinnedAt: NULLABLE_NUMBER_SCHEMA,
    createdAt: { type: 'number' },
    lastOpenedAt: NULLABLE_NUMBER_SCHEMA,
    archivedAt: NULLABLE_NUMBER_SCHEMA,
    closedAt: NULLABLE_NUMBER_SCHEMA,
    status: NON_EMPTY_STRING_SCHEMA,
    claudeConversationId: NULLABLE_STRING_SCHEMA,
    parentWorkspaceId: NULLABLE_STRING_SCHEMA,
    worktreeParentCwd: NULLABLE_STRING_SCHEMA,
    worktreeBranch: NULLABLE_STRING_SCHEMA
  }
} as const

const SELF_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'principal',
    'runtime',
    'surface',
    'workspace',
    'project',
    'claudeConversation',
    'defaults',
    'capabilities'
  ],
  properties: {
    schemaVersion: { const: 1 },
    principal: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'assurance', 'runtimeId'],
      properties: {
        kind: { const: 'orpheus_runtime' },
        assurance: { const: 'runtime_lease' },
        runtimeId: NON_EMPTY_STRING_SCHEMA
      }
    },
    runtime: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'issuedAt'],
      properties: {
        kind: { enum: ['claude', 'workbench_shell', 'pane_shell'] },
        issuedAt: { type: 'number' }
      }
    },
    surface: {
      type: 'object',
      additionalProperties: false,
      required: ['surfaceId'],
      properties: { surfaceId: NON_EMPTY_STRING_SCHEMA }
    },
    workspace: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['workspaceId', 'projectId', 'cwd'],
          properties: {
            workspaceId: NON_EMPTY_STRING_SCHEMA,
            projectId: NON_EMPTY_STRING_SCHEMA,
            cwd: NON_EMPTY_STRING_SCHEMA
          }
        },
        { type: 'null' }
      ]
    },
    project: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['projectId', 'name'],
          properties: {
            projectId: NON_EMPTY_STRING_SCHEMA,
            name: { type: 'string' }
          }
        },
        { type: 'null' }
      ]
    },
    claudeConversation: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['claudeConversationId'],
          properties: { claudeConversationId: NON_EMPTY_STRING_SCHEMA }
        },
        { type: 'null' }
      ]
    },
    defaults: {
      type: 'object',
      additionalProperties: false,
      required: ['workspaceId', 'projectId', 'surfaceId'],
      properties: {
        workspaceId: NULLABLE_STRING_SCHEMA,
        projectId: NULLABLE_STRING_SCHEMA,
        surfaceId: NON_EMPTY_STRING_SCHEMA
      }
    },
    capabilities: {
      type: 'object',
      additionalProperties: false,
      required: ['allow'],
      properties: {
        allow: {
          type: 'array',
          uniqueItems: true,
          items: {
            enum: [
              'identity.read',
              'projects.read',
              'workspaces.read',
              'reviews.read',
              'reviews.resolve'
            ]
          }
        }
      }
    }
  }
} as const

const WORKSPACE_STATUS_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['persistedStatus', 'liveStatus'],
  properties: {
    persistedStatus: NON_EMPTY_STRING_SCHEMA,
    liveStatus: { enum: ['busy', 'idle', 'waiting', 'shell', 'unknown'] },
    waitingFor: { type: 'string' }
  }
} as const

const TRANSCRIPT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['turns', 'truncated', 'bytesRead'],
  properties: {
    turns: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['role', 'text', 'timestamp'],
        properties: {
          role: { enum: ['user', 'assistant'] },
          text: { type: 'string' },
          timestamp: NULLABLE_NUMBER_SCHEMA,
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
    bytesRead: { type: 'integer', minimum: 0 }
  }
} as const

const LAST_TURN_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['userText', 'assistantText', 'userAt', 'assistantAt'],
  properties: {
    userText: NULLABLE_STRING_SCHEMA,
    assistantText: NULLABLE_STRING_SCHEMA,
    userAt: NULLABLE_NUMBER_SCHEMA,
    assistantAt: NULLABLE_NUMBER_SCHEMA
  }
} as const

function observationSchema(valueSchema: Readonly<Record<string, unknown>>): ControlSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['value', 'source', 'observedAt', 'sourceUpdatedAt', 'availability', 'stale'],
    properties: {
      value: { oneOf: [valueSchema, { type: 'null' }] },
      source: {
        enum: ['live', 'sqlite', 'claude-jsonl', 'claude-session-file']
      },
      observedAt: { type: 'number' },
      sourceUpdatedAt: { type: ['number', 'null'] },
      availability: { enum: ['available', 'unavailable', 'unsupported'] },
      stale: { type: ['boolean', 'null'] },
      reason: { type: 'string' }
    }
  } as const
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input != null && typeof input === 'object' && !Array.isArray(input)
}

function hasOnlyKeys(input: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(input).every((key) => keys.includes(key))
}

function isOptionalId(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length > 0)
}

function isEmptyInput(input: unknown): input is EmptyReadInput {
  return isRecord(input) && Object.keys(input).length === 0
}

function isProjectGetInput(input: unknown): input is ProjectGetInput {
  return isRecord(input) && hasOnlyKeys(input, ['projectId']) && isOptionalId(input['projectId'])
}

function isWorkspaceListInput(input: unknown): input is WorkspaceListInput {
  if (!isRecord(input) || !hasOnlyKeys(input, ['projectId', 'scope'])) return false
  if (!isOptionalId(input['projectId'])) return false
  const scope = input['scope']
  return scope === undefined || scope === 'active' || scope === 'archived' || scope === 'all'
}

function isWorkspaceTargetInput(input: unknown): input is WorkspaceTargetInput {
  return (
    isRecord(input) && hasOnlyKeys(input, ['workspaceId']) && isOptionalId(input['workspaceId'])
  )
}

function isWorkspaceTranscriptInput(input: unknown): input is WorkspaceTranscriptInput {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, ['workspaceId', 'limit', 'role', 'since', 'includeToolActivity']) ||
    !isOptionalId(input['workspaceId'])
  ) {
    return false
  }
  const limit = input['limit']
  if (
    limit !== undefined &&
    (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100)
  ) {
    return false
  }
  const role = input['role']
  if (role !== undefined && role !== 'user' && role !== 'assistant') return false
  const since = input['since']
  if (since !== undefined && (typeof since !== 'number' || !Number.isFinite(since) || since < 0)) {
    return false
  }
  const includeToolActivity = input['includeToolActivity']
  return includeToolActivity === undefined || typeof includeToolActivity === 'boolean'
}

function requireBinding(
  context: Parameters<ReadCapabilityHandlers['getSelf']>[1]
): TrustedRuntimeBinding {
  const binding = context.trustedRuntime
  if (binding == null) throw new Error('Trusted runtime binding missing after authorization.')
  return binding
}

function projectTarget(projectId: string | undefined, binding: TrustedRuntimeBinding): string {
  const target = projectId ?? binding.projectId
  if (target == null) throw new Error('Project target missing after authorization.')
  return target
}

function workspaceTarget(workspaceId: string | undefined, binding: TrustedRuntimeBinding): string {
  const target = workspaceId ?? binding.workspaceId
  if (target == null) throw new Error('Workspace target missing after authorization.')
  return target
}

function transcriptOptions(
  input: WorkspaceTranscriptInput
): Omit<WorkspaceTranscriptInput, 'workspaceId'> {
  const options: Omit<WorkspaceTranscriptInput, 'workspaceId'> = {}
  if (input.limit !== undefined) options.limit = input.limit
  if (input.role !== undefined) options.role = input.role
  if (input.since !== undefined) options.since = input.since
  if (input.includeToolActivity !== undefined) {
    options.includeToolActivity = input.includeToolActivity
  }
  return options
}

export function createReadCapabilities(
  handlers: ReadCapabilityHandlers
): [
  ControlDescriptor<EmptyReadInput, ControlReadObservation<SelfReadModel>>,
  ControlDescriptor<EmptyReadInput, ControlReadObservation<readonly ProjectReadModel[]>>,
  ControlDescriptor<ProjectGetInput, ControlReadObservation<ProjectReadModel>>,
  ControlDescriptor<WorkspaceListInput, ControlReadObservation<readonly WorkspaceReadModel[]>>,
  ControlDescriptor<WorkspaceTargetInput, ControlReadObservation<WorkspaceReadModel>>,
  ControlDescriptor<WorkspaceTargetInput, ControlReadObservation<WorkspaceStatusReadModel>>,
  ControlDescriptor<WorkspaceTranscriptInput, ControlReadObservation<TranscriptReadModel>>,
  ControlDescriptor<WorkspaceTargetInput, ControlReadObservation<LastTurnReadModel>>
] {
  return [
    {
      id: SELF_GET_CONTROL_ID,
      version: 1,
      kind: 'query',
      description: 'Return the main-resolved identity and defaults for this Orpheus runtime.',
      inputSchema: EMPTY_INPUT_SCHEMA,
      outputSchema: observationSchema(SELF_OUTPUT_SCHEMA),
      allowedSurfaces: ['mcp'],
      permission: 'identity.read',
      scope: { kind: 'self' },
      risk: { tier: 0, label: 'read' },
      validateInput: isEmptyInput,
      handler: (_input, context) => handlers.getSelf(requireBinding(context), context)
    },
    {
      id: PROJECTS_LIST_CONTROL_ID,
      version: 1,
      kind: 'query',
      description: 'List projects visible to this runtime; Phase 2 is restricted to its project.',
      inputSchema: EMPTY_INPUT_SCHEMA,
      outputSchema: observationSchema({
        type: 'array',
        items: PROJECT_OUTPUT_SCHEMA
      }),
      allowedSurfaces: ['mcp'],
      permission: 'projects.read',
      scope: { kind: 'project' },
      risk: { tier: 0, label: 'read' },
      validateInput: isEmptyInput,
      handler: (_input, context) => {
        const binding = requireBinding(context)
        return handlers.listProjects(projectTarget(undefined, binding), context)
      }
    },
    {
      id: PROJECTS_GET_CONTROL_ID,
      version: 1,
      kind: 'query',
      description: 'Read project metadata, defaulting only to the trusted runtime project.',
      inputSchema: OPTIONAL_PROJECT_INPUT_SCHEMA,
      outputSchema: observationSchema(PROJECT_OUTPUT_SCHEMA),
      allowedSurfaces: ['mcp'],
      permission: 'projects.read',
      scope: { kind: 'project', inputField: 'projectId' },
      risk: { tier: 0, label: 'read' },
      validateInput: isProjectGetInput,
      handler: (input, context) => {
        const binding = requireBinding(context)
        return handlers.getProject(projectTarget(input.projectId, binding), context)
      }
    },
    {
      id: WORKSPACES_LIST_CONTROL_ID,
      version: 1,
      kind: 'query',
      description: 'List workspaces in the trusted runtime project.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          projectId: { type: 'string', minLength: 1 },
          scope: { enum: ['active', 'archived', 'all'] }
        }
      },
      outputSchema: observationSchema({
        type: 'array',
        items: WORKSPACE_OUTPUT_SCHEMA
      }),
      allowedSurfaces: ['mcp'],
      permission: WORKSPACES_READ_PERMISSION,
      scope: { kind: 'project', inputField: 'projectId' },
      risk: { tier: 0, label: 'read' },
      validateInput: isWorkspaceListInput,
      handler: (input, context) => {
        const binding = requireBinding(context)
        return handlers.listWorkspaces(
          projectTarget(input.projectId, binding),
          input.scope ?? 'active',
          context
        )
      }
    },
    {
      id: WORKSPACES_GET_CONTROL_ID,
      version: 1,
      kind: 'query',
      description: 'Read workspace metadata, defaulting only to the trusted runtime workspace.',
      inputSchema: OPTIONAL_WORKSPACE_INPUT_SCHEMA,
      outputSchema: observationSchema(WORKSPACE_OUTPUT_SCHEMA),
      allowedSurfaces: ['mcp'],
      permission: WORKSPACES_READ_PERMISSION,
      scope: { kind: 'workspace', inputField: 'workspaceId' },
      risk: { tier: 0, label: 'read' },
      validateInput: isWorkspaceTargetInput,
      handler: (input, context) => {
        const binding = requireBinding(context)
        return handlers.getWorkspace(workspaceTarget(input.workspaceId, binding), context)
      }
    },
    {
      id: WORKSPACES_GET_STATUS_CONTROL_ID,
      version: 1,
      kind: 'query',
      description: 'Read persisted and live Claude status for an authorized workspace.',
      inputSchema: OPTIONAL_WORKSPACE_INPUT_SCHEMA,
      outputSchema: observationSchema(WORKSPACE_STATUS_OUTPUT_SCHEMA),
      allowedSurfaces: ['mcp'],
      permission: WORKSPACES_READ_PERMISSION,
      scope: { kind: 'workspace', inputField: 'workspaceId' },
      risk: { tier: 0, label: 'read' },
      validateInput: isWorkspaceTargetInput,
      handler: (input, context) => {
        const binding = requireBinding(context)
        return handlers.getWorkspaceStatus(workspaceTarget(input.workspaceId, binding), context)
      }
    },
    {
      id: WORKSPACES_GET_TRANSCRIPT_CONTROL_ID,
      version: 1,
      kind: 'query',
      description: 'Read up to 100 bounded Claude transcript turns for an authorized workspace.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workspaceId: { type: 'string', minLength: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          role: { enum: ['user', 'assistant'] },
          since: { type: 'number', minimum: 0 },
          includeToolActivity: { type: 'boolean' }
        }
      },
      outputSchema: observationSchema(TRANSCRIPT_OUTPUT_SCHEMA),
      allowedSurfaces: ['mcp'],
      permission: WORKSPACES_READ_PERMISSION,
      scope: { kind: 'workspace', inputField: 'workspaceId' },
      risk: { tier: 0, label: 'read' },
      validateInput: isWorkspaceTranscriptInput,
      handler: (input, context) => {
        const binding = requireBinding(context)
        return handlers.getWorkspaceTranscript(
          workspaceTarget(input.workspaceId, binding),
          transcriptOptions(input),
          context
        )
      }
    },
    {
      id: WORKSPACES_GET_LAST_TURN_CONTROL_ID,
      version: 1,
      kind: 'query',
      description: 'Read the latest Claude user and assistant turn for an authorized workspace.',
      inputSchema: OPTIONAL_WORKSPACE_INPUT_SCHEMA,
      outputSchema: observationSchema(LAST_TURN_OUTPUT_SCHEMA),
      allowedSurfaces: ['mcp'],
      permission: WORKSPACES_READ_PERMISSION,
      scope: { kind: 'workspace', inputField: 'workspaceId' },
      risk: { tier: 0, label: 'read' },
      validateInput: isWorkspaceTargetInput,
      handler: (input, context) => {
        const binding = requireBinding(context)
        return handlers.getWorkspaceLastTurn(workspaceTarget(input.workspaceId, binding), context)
      }
    }
  ]
}
