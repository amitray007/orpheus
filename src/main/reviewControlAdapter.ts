import type { LocalReviewComment } from '../shared/types'
import {
  REVIEW_LIST_CONTROL_ID,
  REVIEW_SET_RESOLVED_CONTROL_ID
} from './controlPlane/reviewCapabilities'
import { unwrapControlResult } from './controlPlane/registry'
import type {
  ControlContext,
  ControlInvoker,
  ReviewListInput,
  ReviewSetResolvedInput
} from './controlPlane/types'

type SocketContextHint = { workspaceId?: string }

export function rendererReviewContext(
  senderId: number,
  workspaceId: string | null
): ControlContext {
  return {
    principal: { type: 'renderer-user', id: `webContents:${senderId}` },
    consumer: 'renderer-ipc',
    workspaceId,
    projectId: null,
    requestId: crypto.randomUUID()
  }
}

export function commandReviewContext(workspaceIdHint: string | null): ControlContext {
  return {
    principal: { type: 'cli', id: 'command-socket' },
    consumer: 'command-socket',
    workspaceId: workspaceIdHint,
    projectId: null,
    requestId: crypto.randomUUID()
  }
}

export function resolveCommandReviewListInput(
  args: Record<string, unknown>,
  context: SocketContextHint
): ReviewListInput {
  const workspaceId =
    context.workspaceId ?? (typeof args.workspaceId === 'string' ? args.workspaceId : null)
  if (!workspaceId) throw new Error('workspaceId is required (no context workspace either)')
  return { workspaceId }
}

export function resolveCommandReviewSetResolvedInput(
  args: Record<string, unknown>,
  idRequiredError: string
): ReviewSetResolvedInput {
  if (typeof args.id !== 'string' || args.id === '') throw new Error(idRequiredError)
  if (typeof args.resolved !== 'boolean') {
    throw new Error('args.resolved is required (boolean)')
  }
  return { id: args.id, resolved: args.resolved }
}

export async function invokeReviewList(
  invoke: ControlInvoker,
  input: ReviewListInput,
  context: ControlContext
): Promise<LocalReviewComment[]> {
  return unwrapControlResult(
    await invoke<LocalReviewComment[]>({
      id: REVIEW_LIST_CONTROL_ID,
      input,
      context
    })
  )
}

export async function invokeReviewSetResolved(
  invoke: ControlInvoker,
  input: ReviewSetResolvedInput,
  context: ControlContext
): Promise<LocalReviewComment> {
  return unwrapControlResult(
    await invoke<LocalReviewComment>({
      id: REVIEW_SET_RESOLVED_CONTROL_ID,
      input,
      context
    })
  )
}
