import { randomUUID } from 'node:crypto'
import type { LocalReviewComment } from '../../shared/types'
import type { ReviewCommentOwnership } from '../reviewStore'
import { orchestrationError } from '../workspaceOrchestration/errors'
import type {
  EffectReceipt,
  WorkspaceAuditPort,
  WorkspaceControlAuditRecord
} from '../workspaceOrchestration/types'
import type {
  ControlAuthorizationPolicy,
  ControlContext,
  ControlDescription,
  ControlRejectionAuditor,
  ReviewSetResolvedInput,
  TrustedRuntimeBinding
} from './types'

const REVIEW_RESOLVE_PERMISSION = 'reviews.resolve'
const REVIEW_SET_RESOLVED_OPERATION = 'reviews.setResolved'
const REVIEW_NOT_FOUND = 'Review comment was not found.'
const REVIEW_EFFECTS = Object.freeze(['db.write'])

type AuthorizedTarget = {
  binding: TrustedRuntimeBinding
  ownership: ReviewCommentOwnership
}

export type ReviewMutationDeps = {
  resolveOwnership: (
    id: string
  ) => ReviewCommentOwnership | null | Promise<ReviewCommentOwnership | null>
  getWorkspaceProjectId: (workspaceId: string) => string | null | Promise<string | null>
  setResolved: (
    id: string,
    workspaceId: string,
    resolved: boolean
  ) => LocalReviewComment | null | Promise<LocalReviewComment | null>
  audit: WorkspaceAuditPort
  now?: () => number
  generateId?: () => string
}

type TargetDecision =
  | { allowed: true; target: AuthorizedTarget }
  | { allowed: false; code: 'not_found' | 'forbidden'; error: string }

function denyForbidden(error: string): TargetDecision {
  return { allowed: false, code: 'forbidden', error }
}

function denyNotFound(): TargetDecision {
  return { allowed: false, code: 'not_found', error: REVIEW_NOT_FOUND }
}

function trustedLiveRuntime(context: ControlContext): TrustedRuntimeBinding | null {
  const binding = context.trustedRuntime ?? null
  return context.consumer === 'mcp' &&
    context.principal.type === 'workspace-agent' &&
    binding?.runtimeKind === 'claude' &&
    binding.runtimeId === context.principal.id &&
    binding.workspaceId != null &&
    binding.projectId != null
    ? binding
    : null
}

function safeAuditParams(input: unknown): Record<string, unknown> {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { commentIdPresent: false }
  }
  const record = input as Record<string, unknown>
  return {
    commentIdPresent: typeof record['id'] === 'string' && record['id'].length > 0,
    ...(typeof record['resolved'] === 'boolean' ? { resolved: record['resolved'] } : {})
  }
}

export class ReviewMutationService {
  constructor(private readonly deps: ReviewMutationDeps) {}

  async authorizeTarget(id: string, context: ControlContext): Promise<TargetDecision> {
    const binding = trustedLiveRuntime(context)
    if (binding == null) {
      return denyForbidden('A valid live Orpheus runtime is required.')
    }
    if (!binding.permissions.includes(REVIEW_RESOLVE_PERMISSION)) {
      return denyForbidden(`Permission denied: ${REVIEW_RESOLVE_PERMISSION}`)
    }

    let ownership: ReviewCommentOwnership | null
    let projectId: string | null
    try {
      ownership = await this.deps.resolveOwnership(id)
      projectId =
        ownership == null ? null : await this.deps.getWorkspaceProjectId(ownership.workspaceId)
    } catch {
      return denyNotFound()
    }
    if (
      ownership == null ||
      ownership.workspaceId !== binding.workspaceId ||
      projectId == null ||
      projectId !== binding.projectId
    ) {
      return denyNotFound()
    }
    return { allowed: true, target: { binding, ownership } }
  }

  async setResolved(
    input: ReviewSetResolvedInput,
    context: ControlContext
  ): Promise<LocalReviewComment> {
    const decision = await this.authorizeTarget(input.id, context)
    if (!decision.allowed) {
      await this.audit(input, context, 'deny', decision.code, [])
      throw orchestrationError(decision.code, decision.error)
    }

    let updated: LocalReviewComment | null
    try {
      updated = await this.deps.setResolved(
        input.id,
        decision.target.ownership.workspaceId,
        input.resolved
      )
    } catch {
      updated = null
    }
    if (updated == null) {
      await this.audit(input, context, 'deny', 'not_found', [])
      throw orchestrationError('not_found', REVIEW_NOT_FOUND)
    }

    const receipts: EffectReceipt[] = [
      {
        effect: 'db.write',
        status: 'applied',
        workspaceId: decision.target.ownership.workspaceId
      }
    ]
    await this.audit(input, context, 'allow', 'completed', receipts)
    return updated
  }

  async auditRejected(input: {
    params: unknown
    context: ControlContext
    code: 'invalid' | 'not_found' | 'forbidden'
  }): Promise<void> {
    await this.audit(input.params, input.context, 'deny', input.code, [])
  }

  private async audit(
    params: unknown,
    context: ControlContext,
    decision: 'allow' | 'deny',
    result: WorkspaceControlAuditRecord['result']['code'],
    receipts: EffectReceipt[]
  ): Promise<void> {
    const binding = context.trustedRuntime ?? null
    const record: WorkspaceControlAuditRecord = {
      schemaVersion: 1,
      auditId: this.deps.generateId?.() ?? randomUUID(),
      requestId: context.requestId,
      occurredAt: this.deps.now?.() ?? Date.now(),
      consumer: 'mcp',
      operation: { id: REVIEW_SET_RESOLVED_OPERATION, version: 1 },
      principal: {
        kind: binding == null ? context.principal.type : 'orpheus_runtime',
        runtimeId: binding?.runtimeId ?? null
      },
      target: {
        projectId: binding?.projectId ?? null,
        workspaceIds: binding?.workspaceId == null ? [] : [binding.workspaceId]
      },
      permission: REVIEW_RESOLVE_PERMISSION,
      tier: 2,
      decision,
      declaredEffects: [...REVIEW_EFFECTS],
      redactedParams: safeAuditParams(params),
      receipts,
      result: { code: result },
      correlation: { requestId: context.requestId }
    }
    try {
      await this.deps.audit.append(record)
    } catch {
      // Audit diagnostics must not expose review content or change the result.
    }
  }
}

export function withReviewMutationPolicy(
  base: ControlAuthorizationPolicy,
  service: Pick<ReviewMutationService, 'authorizeTarget'>
): ControlAuthorizationPolicy {
  const isReviewMutation = (description: ControlDescription): boolean =>
    description.id === REVIEW_SET_RESOLVED_OPERATION
  return {
    canDiscover(description, context) {
      if (!isReviewMutation(description) || context.consumer !== 'mcp') {
        return base.canDiscover(description, context)
      }
      const binding = trustedLiveRuntime(context)
      return binding?.permissions.includes(REVIEW_RESOLVE_PERMISSION) === true
    },
    async authorize(description, input, context) {
      if (!isReviewMutation(description) || context.consumer !== 'mcp') {
        return base.authorize(description, input, context)
      }
      const id =
        input != null &&
        typeof input === 'object' &&
        !Array.isArray(input) &&
        typeof (input as Record<string, unknown>)['id'] === 'string'
          ? (input as Record<string, string>)['id']
          : ''
      const decision = await service.authorizeTarget(id, context)
      return decision.allowed
        ? { allowed: true }
        : { allowed: false, code: decision.code, error: decision.error }
    }
  }
}

export function createReviewMutationRejectionAuditor(
  service: Pick<ReviewMutationService, 'auditRejected'>
): ControlRejectionAuditor {
  return {
    auditRejected: (input) =>
      service.auditRejected({
        params: input.params,
        context: input.context,
        code: input.code
      })
  }
}
