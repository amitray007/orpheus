import { CLAUDE_EFFORT_VALUES } from '../../shared/types'
import type { ControlDescriptor, ControlRejectionAuditor, ControlSchema } from './types'
import {
  RESOURCES_LIST_PROJECT_METADATA_ID,
  SETTINGS_GET_EFFECTIVE_ID,
  SETTINGS_PATCH_WORKSPACE_ID,
  SETTINGS_RESOURCE_OPERATION_IDS,
  type GetEffectiveSettingsInput,
  type ListProjectResourceMetadataInput,
  type PatchWorkspaceSettingsInput,
  type ProjectResourceKind,
  type SettingsResourceService
} from './settingsResourceService'

const ID_SCHEMA = { type: 'string', minLength: 1, maxLength: 128 } as const
const MODEL_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 255,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'
} as const
const EFFORT_SCHEMA = { enum: [...CLAUDE_EFFORT_VALUES] } as const
const RESOURCE_KINDS = ['mcp_server', 'hook', 'slash_command', 'subagent'] as const
const SETTINGS_RESOURCE_OPERATIONS = new Set<string>(SETTINGS_RESOURCE_OPERATION_IDS)
const READ_SURFACES = ['mcp', 'automation'] as const
const MCP_SURFACE = ['mcp'] as const
const MUTATION_SURFACES = ['mcp', 'automation'] as const
const MAX_METADATA_LENGTH = 512
const MAX_METADATA_ITEMS = 64
const MAX_PUBLISHED_RESOURCES = 256
const METADATA_STRING_SCHEMA = { type: 'string', maxLength: MAX_METADATA_LENGTH } as const

const STRING_PROVENANCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['global', 'projectOverride', 'workspaceOverride', 'effective', 'source'],
  properties: {
    global: MODEL_SCHEMA,
    projectOverride: { anyOf: [MODEL_SCHEMA, { type: 'null' }] },
    workspaceOverride: { anyOf: [MODEL_SCHEMA, { type: 'null' }] },
    effective: MODEL_SCHEMA,
    source: { enum: ['global', 'project', 'workspace'] }
  }
} as const

const EFFORT_PROVENANCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['global', 'projectOverride', 'workspaceOverride', 'effective', 'source'],
  properties: {
    global: EFFORT_SCHEMA,
    projectOverride: { anyOf: [EFFORT_SCHEMA, { type: 'null' }] },
    workspaceOverride: { anyOf: [EFFORT_SCHEMA, { type: 'null' }] },
    effective: EFFORT_SCHEMA,
    source: { enum: ['global', 'project', 'workspace'] }
  }
} as const

const EFFECTIVE_SETTINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'projectId',
    'workspaceId',
    'settings',
    'orpheus',
    'restartRequired',
    'source',
    'observedAt',
    'updatedAt'
  ],
  properties: {
    schemaVersion: { const: 1 },
    projectId: ID_SCHEMA,
    workspaceId: ID_SCHEMA,
    settings: {
      type: 'object',
      additionalProperties: false,
      required: ['model', 'effort'],
      properties: {
        model: STRING_PROVENANCE_SCHEMA,
        effort: EFFORT_PROVENANCE_SCHEMA
      }
    },
    orpheus: {
      type: 'object',
      additionalProperties: false,
      required: ['maxWorkspaceDepth', 'maxWorkspaceChildren'],
      properties: {
        maxWorkspaceDepth: { type: 'integer', minimum: 1 },
        maxWorkspaceChildren: { type: 'integer', minimum: 1 }
      }
    },
    restartRequired: { type: 'boolean' },
    source: { const: 'composeClaudeLaunch' },
    observedAt: { type: 'number' },
    updatedAt: {
      type: 'object',
      additionalProperties: false,
      required: ['global', 'project', 'workspace'],
      properties: {
        global: { type: 'number' },
        project: { type: 'number' },
        workspace: { type: 'number' }
      }
    }
  }
} as const

const SETTINGS_PATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    model: { anyOf: [MODEL_SCHEMA, { type: 'null' }] },
    effort: { anyOf: [EFFORT_SCHEMA, { type: 'null' }] }
  }
} as const

const RESOURCE_BASE_PROPERTIES = {
  source: { const: 'project' },
  projectId: ID_SCHEMA
} as const

const RESOURCE_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'source', 'projectId', 'name', 'transport'],
      properties: {
        ...RESOURCE_BASE_PROPERTIES,
        kind: { const: 'mcp_server' },
        name: METADATA_STRING_SCHEMA,
        transport: { enum: ['stdio', 'http', 'sse', 'unknown'] }
      }
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'source', 'projectId', 'event', 'matcher', 'type'],
      properties: {
        ...RESOURCE_BASE_PROPERTIES,
        kind: { const: 'hook' },
        event: METADATA_STRING_SCHEMA,
        matcher: { anyOf: [METADATA_STRING_SCHEMA, { type: 'null' }] },
        type: METADATA_STRING_SCHEMA
      }
    },
    {
      type: 'object',
      additionalProperties: false,
      required: [
        'kind',
        'source',
        'projectId',
        'name',
        'description',
        'allowedTools',
        'argumentHint'
      ],
      properties: {
        ...RESOURCE_BASE_PROPERTIES,
        kind: { const: 'slash_command' },
        name: METADATA_STRING_SCHEMA,
        description: { anyOf: [METADATA_STRING_SCHEMA, { type: 'null' }] },
        allowedTools: {
          anyOf: [
            {
              type: 'array',
              maxItems: MAX_METADATA_ITEMS,
              items: METADATA_STRING_SCHEMA
            },
            { type: 'null' }
          ]
        },
        argumentHint: { anyOf: [METADATA_STRING_SCHEMA, { type: 'null' }] }
      }
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'source', 'projectId', 'name', 'description', 'tools', 'model'],
      properties: {
        ...RESOURCE_BASE_PROPERTIES,
        kind: { const: 'subagent' },
        name: METADATA_STRING_SCHEMA,
        description: { anyOf: [METADATA_STRING_SCHEMA, { type: 'null' }] },
        tools: {
          anyOf: [
            {
              type: 'array',
              maxItems: MAX_METADATA_ITEMS,
              items: METADATA_STRING_SCHEMA
            },
            { type: 'null' }
          ]
        },
        model: { anyOf: [METADATA_STRING_SCHEMA, { type: 'null' }] }
      }
    }
  ]
} as const

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

function isModel(value: unknown): value is string | null | undefined {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' &&
      value === value.trim() &&
      /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/.test(value))
  )
}

function isEffort(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' &&
      CLAUDE_EFFORT_VALUES.includes(value as (typeof CLAUDE_EFFORT_VALUES)[number]))
  )
}

function isEffectiveInput(value: unknown): value is GetEffectiveSettingsInput {
  return isRecord(value) && onlyKeys(value, ['workspaceId']) && isOptionalId(value['workspaceId'])
}

function isPatchInput(value: unknown): value is PatchWorkspaceSettingsInput {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ['workspaceId', 'patch']) ||
    !isOptionalId(value['workspaceId']) ||
    !isRecord(value['patch']) ||
    !onlyKeys(value['patch'], ['model', 'effort'])
  ) {
    return false
  }
  const patch = value['patch']
  return Object.keys(patch).length > 0 && isModel(patch['model']) && isEffort(patch['effort'])
}

function isResourceKind(value: unknown): value is ProjectResourceKind {
  return typeof value === 'string' && RESOURCE_KINDS.includes(value as ProjectResourceKind)
}

function isResourceListInput(value: unknown): value is ListProjectResourceMetadataInput {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ['projectId', 'kinds']) ||
    !isOptionalId(value['projectId'])
  ) {
    return false
  }
  const kinds = value['kinds']
  return (
    kinds === undefined ||
    (Array.isArray(kinds) &&
      kinds.length >= 1 &&
      kinds.length <= RESOURCE_KINDS.length &&
      kinds.every(isResourceKind) &&
      new Set(kinds).size === kinds.length)
  )
}

function patchOutputSchema(): ControlSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'schemaVersion',
      'requestId',
      'operationId',
      'projectId',
      'workspaceId',
      'applied',
      'effective',
      'restartRequired',
      'effects',
      'auditId'
    ],
    properties: {
      schemaVersion: { const: 1 },
      requestId: ID_SCHEMA,
      operationId: { const: SETTINGS_PATCH_WORKSPACE_ID },
      projectId: ID_SCHEMA,
      workspaceId: ID_SCHEMA,
      applied: SETTINGS_PATCH_SCHEMA,
      effective: EFFECTIVE_SETTINGS_SCHEMA,
      restartRequired: { type: 'boolean' },
      effects: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['effect', 'status'],
          properties: {
            effect: { enum: ['db.write', 'workspace.dirty.recompute'] },
            status: { enum: ['applied', 'skipped'] }
          }
        }
      },
      auditId: ID_SCHEMA
    }
  }
}

export function createSettingsResourceRejectionAuditor(
  service: SettingsResourceService
): ControlRejectionAuditor {
  return {
    auditRejected: ({ description, params, context, code }) => {
      if (!SETTINGS_RESOURCE_OPERATIONS.has(description.id)) return
      return service.auditRejected({
        meta: {
          id: description.id,
          permission: description.permission,
          tier: description.risk.tier,
          effects: description.declaredEffects ?? []
        },
        params,
        context,
        code
      })
    }
  }
}

// The tuple preserves each descriptor's distinct input/output generic.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createSettingsResourceCapabilities(service: SettingsResourceService) {
  const effective: ControlDescriptor<
    GetEffectiveSettingsInput,
    ReturnType<typeof service.getEffective>
  > = {
    id: SETTINGS_GET_EFFECTIVE_ID,
    version: 1,
    kind: 'query',
    description:
      'Read allowlisted effective model and effort with global/project/workspace provenance.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { workspaceId: ID_SCHEMA }
    },
    outputSchema: EFFECTIVE_SETTINGS_SCHEMA,
    allowedSurfaces: READ_SURFACES,
    permission: 'settings.read',
    scope: { kind: 'workspace', inputField: 'workspaceId' },
    risk: { tier: 0, label: 'read' },
    declaredEffects: [],
    idempotency: 'natural',
    validateInput: isEffectiveInput,
    handler: (input, context) => service.getEffective(input, context)
  }

  const patch: ControlDescriptor<
    PatchWorkspaceSettingsInput,
    Awaited<ReturnType<typeof service.patchWorkspace>>
  > = {
    id: SETTINGS_PATCH_WORKSPACE_ID,
    version: 1,
    kind: 'mutation',
    description:
      'Naturally idempotent patch of model and effort overrides for the exact bound workspace.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['patch'],
      properties: {
        workspaceId: ID_SCHEMA,
        patch: SETTINGS_PATCH_SCHEMA
      }
    },
    outputSchema: patchOutputSchema(),
    allowedSurfaces: MUTATION_SURFACES,
    permission: 'settings.workspace.patch',
    scope: { kind: 'workspace', inputField: 'workspaceId' },
    risk: { tier: 2, label: 'write' },
    declaredEffects: ['db.write', 'workspace.dirty.recompute'],
    idempotency: 'natural',
    validateInput: isPatchInput,
    handler: (input, context) => service.patchWorkspace(input, context)
  }

  const resources: ControlDescriptor<
    ListProjectResourceMetadataInput,
    ReturnType<typeof service.listProjectMetadata>
  > = {
    id: RESOURCES_LIST_PROJECT_METADATA_ID,
    version: 1,
    kind: 'query',
    description:
      'List sanitized MCP server, hook, slash-command, and subagent metadata for the bound project.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        projectId: ID_SCHEMA,
        kinds: {
          type: 'array',
          minItems: 1,
          maxItems: RESOURCE_KINDS.length,
          uniqueItems: true,
          items: { enum: RESOURCE_KINDS }
        }
      }
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['schemaVersion', 'projectId', 'source', 'observedAt', 'truncated', 'resources'],
      properties: {
        schemaVersion: { const: 1 },
        projectId: ID_SCHEMA,
        source: { const: 'project-files' },
        observedAt: { type: 'number' },
        truncated: { type: 'boolean' },
        resources: {
          type: 'array',
          maxItems: MAX_PUBLISHED_RESOURCES,
          items: RESOURCE_SCHEMA
        }
      }
    },
    // Project-file discovery is synchronous today. Keep it available to an
    // explicit MCP request, but do not let a scheduled automation repeatedly
    // scan the main-process filesystem on a cold cache.
    allowedSurfaces: MCP_SURFACE,
    permission: 'resources.read',
    scope: { kind: 'project', inputField: 'projectId' },
    risk: { tier: 0, label: 'read' },
    declaredEffects: [],
    idempotency: 'natural',
    validateInput: isResourceListInput,
    handler: (input, context) => service.listProjectMetadata(input, context)
  }

  return [effective, patch, resources] as const
}
