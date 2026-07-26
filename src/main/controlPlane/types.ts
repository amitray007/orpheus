import type { LocalReviewComment } from '../../shared/types'

export type ControlConsumer = 'renderer-ipc' | 'command-socket' | 'mcp' | 'automation'
export type ControlSurface = 'renderer' | 'command-socket'
export type ControlKind = 'query' | 'mutation'
export type ControlPermission = 'reviews.read' | 'reviews.resolve'
export type ControlErrorCode =
  | 'invalid'
  | 'not_found'
  | 'forbidden'
  | 'conflict'
  | 'busy'
  | 'unavailable'
  | 'timeout'
  | 'failed'

export type ControlContext = {
  principal: {
    type: 'renderer-user' | 'workspace-agent' | 'cli' | 'automation'
    id: string
  }
  consumer: ControlConsumer
  workspaceId: string | null
  projectId: string | null
  requestId: string
}

export type ControlResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ControlErrorCode; error: string }

export type ControlSchema = Readonly<Record<string, unknown>>

export type ControlDescriptor<TInput, TOutput> = {
  id: string
  version: 1
  kind: ControlKind
  description: string
  inputSchema: ControlSchema
  outputSchema: ControlSchema
  allowedSurfaces: readonly ControlSurface[]
  permission: ControlPermission
  scope: Readonly<{ kind: 'workspace' | 'resource'; inputField: string }>
  risk: Readonly<{ tier: 0 | 1 | 2 | 3; label: string }>
  validateInput: (input: unknown) => input is TInput
  handler: (input: TInput, context: ControlContext) => TOutput | Promise<TOutput>
}

export type ControlDescription = Omit<
  ControlDescriptor<unknown, unknown>,
  'validateInput' | 'handler'
>

export type ControlInvocation = {
  id: string
  input: unknown
  context: ControlContext
}

export type ControlInvoker = <T>(invocation: ControlInvocation) => Promise<ControlResult<T>>

export type ReviewListInput = { workspaceId: string }
export type ReviewSetResolvedInput = { id: string; resolved: boolean }

export type ReviewCapabilityHandlers = {
  listByWorkspace: (
    workspaceId: string,
    context: ControlContext
  ) => LocalReviewComment[] | Promise<LocalReviewComment[]>
  setResolved: (
    id: string,
    resolved: boolean,
    context: ControlContext
  ) => LocalReviewComment | Promise<LocalReviewComment>
}
