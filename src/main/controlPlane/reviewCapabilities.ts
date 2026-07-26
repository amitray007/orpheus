import type { LocalReviewComment } from '../../shared/types'
import type {
  ControlDescriptor,
  ReviewCapabilityHandlers,
  ReviewListInput,
  ReviewSetResolvedInput
} from './types'

export const REVIEW_LIST_CONTROL_ID = 'reviews.list'
export const REVIEW_SET_RESOLVED_CONTROL_ID = 'reviews.setResolved'

const REVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  ref: 'LocalReviewComment'
} as const

function isReviewListInput(input: unknown): input is ReviewListInput {
  if (input == null || typeof input !== 'object') return false
  return typeof (input as Record<string, unknown>)['workspaceId'] === 'string'
}

function isReviewSetResolvedInput(input: unknown): input is ReviewSetResolvedInput {
  if (input == null || typeof input !== 'object') return false
  const record = input as Record<string, unknown>
  return typeof record['id'] === 'string' && typeof record['resolved'] === 'boolean'
}

export function createReviewCapabilities(
  handlers: ReviewCapabilityHandlers
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
        required: ['workspaceId'],
        properties: { workspaceId: { type: 'string' } }
      },
      outputSchema: { type: 'array', items: REVIEW_OUTPUT_SCHEMA },
      allowedSurfaces: ['renderer', 'command-socket'],
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
        required: ['id', 'resolved'],
        properties: {
          id: { type: 'string' },
          resolved: { type: 'boolean' }
        }
      },
      outputSchema: REVIEW_OUTPUT_SCHEMA,
      allowedSurfaces: ['renderer', 'command-socket'],
      permission: 'reviews.resolve',
      scope: { kind: 'resource', inputField: 'id' },
      risk: { tier: 2, label: 'scoped mutation' },
      validateInput: isReviewSetResolvedInput,
      handler: (input, context) => handlers.setResolved(input.id, input.resolved, context)
    }
  ]
}
