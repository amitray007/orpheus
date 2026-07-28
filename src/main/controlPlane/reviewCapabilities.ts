import type { LocalReviewComment } from '../../shared/types'
import type {
  ControlContext,
  ControlDescriptor,
  ReviewCapabilityHandlers,
  ReviewListInput,
  ReviewSetResolvedInput
} from './types'
import type { ReviewMutationService } from './reviewMutation'

export const REVIEW_LIST_CONTROL_ID = 'reviews.list'
export const REVIEW_SET_RESOLVED_CONTROL_ID = 'reviews.setResolved'

const REVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'workspaceId',
    'prNumber',
    'path',
    'line',
    'startLine',
    'side',
    'body',
    'author',
    'resolved',
    'createdAt',
    'updatedAt'
  ],
  properties: {
    id: { type: 'string', minLength: 1 },
    workspaceId: { type: 'string', minLength: 1 },
    prNumber: { type: ['number', 'null'] },
    path: { type: 'string' },
    line: { type: ['number', 'null'] },
    startLine: { type: ['number', 'null'] },
    side: { enum: ['LEFT', 'RIGHT', null] },
    body: { type: 'string' },
    author: { type: 'string' },
    resolved: { type: 'boolean' },
    createdAt: { type: 'number' },
    updatedAt: { type: 'number' }
  }
} as const

function isReviewListInput(input: unknown, context: ControlContext): input is ReviewListInput {
  if (input == null || typeof input !== 'object') return false
  const record = input as Record<string, unknown>
  const workspaceId = record['workspaceId']
  return (
    typeof workspaceId === 'string' &&
    (context.consumer !== 'mcp' || workspaceId.length > 0) &&
    Object.keys(record).every((key) => key === 'workspaceId')
  )
}

function isReviewSetResolvedInput(
  input: unknown,
  context: ControlContext
): input is ReviewSetResolvedInput {
  if (input == null || typeof input !== 'object') return false
  const record = input as Record<string, unknown>
  const id = record['id']
  return (
    typeof id === 'string' &&
    (context.consumer !== 'mcp' || (id.length >= 1 && id.length <= 128 && id.trim() === id)) &&
    typeof record['resolved'] === 'boolean' &&
    Object.keys(record).every((key) => key === 'id' || key === 'resolved')
  )
}

export function createReviewCapabilities(
  handlers: ReviewCapabilityHandlers,
  options?: {
    mcpRead?: boolean
    mcpMutation?: Pick<ReviewMutationService, 'setResolved'>
  }
): [
  ControlDescriptor<ReviewListInput, LocalReviewComment[]>,
  ControlDescriptor<ReviewSetResolvedInput, LocalReviewComment>
] {
  return [
    {
      id: REVIEW_LIST_CONTROL_ID,
      version: 1,
      kind: 'query',
      description: 'List local review comments for a workspace.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['workspaceId'],
        properties: { workspaceId: { type: 'string', minLength: 1 } }
      },
      outputSchema: { type: 'array', items: REVIEW_OUTPUT_SCHEMA },
      allowedSurfaces:
        options?.mcpRead === true
          ? ['renderer', 'command-socket', 'mcp']
          : ['renderer', 'command-socket'],
      permission: 'reviews.read',
      scope: { kind: 'workspace', inputField: 'workspaceId' },
      risk: { tier: 0, label: 'read' },
      validateInput: isReviewListInput,
      handler: (input, context) => handlers.listByWorkspace(input.workspaceId, context)
    },
    {
      id: REVIEW_SET_RESOLVED_CONTROL_ID,
      version: 1,
      kind: 'mutation',
      description: 'Set the resolved state of a local review comment.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'resolved'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 128 },
          resolved: { type: 'boolean' }
        }
      },
      outputSchema: REVIEW_OUTPUT_SCHEMA,
      allowedSurfaces:
        options?.mcpMutation != null
          ? ['renderer', 'command-socket', 'mcp']
          : ['renderer', 'command-socket'],
      permission: 'reviews.resolve',
      scope: { kind: 'resource', inputField: 'id' },
      risk: { tier: 2, label: 'scoped mutation' },
      declaredEffects: ['db.write'],
      validateInput: (input, context) => isReviewSetResolvedInput(input, context),
      handler: (input, context) =>
        context.consumer === 'mcp'
          ? (options?.mcpMutation?.setResolved(input, context) ??
            Promise.reject(new Error('Review mutation service is unavailable.')))
          : handlers.setResolved(input.id, input.resolved, context)
    }
  ]
}
