import assert from 'node:assert/strict'
import { createConfiguredControlRegistry } from '../src/main/controlPlane/configuredRegistry.ts'
import {
  createReviewCapabilities,
  REVIEW_SET_RESOLVED_CONTROL_ID
} from '../src/main/controlPlane/reviewCapabilities.ts'
import { ReviewMutationService } from '../src/main/controlPlane/reviewMutation.ts'
import { createTrustedRuntimeReadPolicy } from '../src/main/controlPlane/readPolicy.ts'
import type {
  ControlContext,
  ReviewCapabilityHandlers,
  TrustedRuntimeBinding
} from '../src/main/controlPlane/types.ts'
import type { WorkspaceControlAuditRecord } from '../src/main/workspaceOrchestration/types.ts'
import type { LocalReviewComment } from '../src/shared/types.ts'

const workspaceProjects = new Map([
  ['workspace-1', 'project-1'],
  ['workspace-2', 'project-1'],
  ['workspace-cross-project', 'project-2']
])
const baseComment: LocalReviewComment = {
  id: 'comment-1',
  workspaceId: 'workspace-1',
  prNumber: null,
  path: 'src/private-name.ts',
  line: 7,
  startLine: null,
  side: 'RIGHT',
  body: 'Sensitive review body that must never enter audit.',
  author: 'reviewer',
  resolved: false,
  createdAt: 1,
  updatedAt: 1
}

function runtimeBinding(overrides: Partial<TrustedRuntimeBinding> = {}): TrustedRuntimeBinding {
  return {
    runtimeId: 'runtime-1',
    runtimeKind: 'claude',
    surfaceId: 'workspace-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    claudeConversationId: 'conversation-1',
    issuedAt: 1,
    permissions: ['reviews.resolve'],
    ...overrides
  }
}

function context(binding: TrustedRuntimeBinding | null = runtimeBinding()): ControlContext {
  return {
    principal: { type: 'workspace-agent', id: binding?.runtimeId ?? 'untrusted-runtime' },
    consumer: 'mcp',
    workspaceId: 'hostile-ambient-workspace',
    projectId: 'hostile-ambient-project',
    requestId: `request-${auditRecords.length + 1}`,
    trustedRuntime: binding
  }
}

const comments = new Map<string, LocalReviewComment>([[baseComment.id, baseComment]])
const auditRecords: WorkspaceControlAuditRecord[] = []
let ownershipLookups = 0
let mutationCalls = 0
let deleteOnSecondLookup = false
let auditId = 0

const reviewService = new ReviewMutationService({
  resolveOwnership: (id) => {
    ownershipLookups++
    if (deleteOnSecondLookup && ownershipLookups % 2 === 0) {
      comments.delete(id)
    }
    const comment = comments.get(id)
    return comment == null ? null : { id: comment.id, workspaceId: comment.workspaceId }
  },
  getWorkspaceProjectId: (workspaceId) => workspaceProjects.get(workspaceId) ?? null,
  setResolved: (id, workspaceId, resolved) => {
    mutationCalls++
    const comment = comments.get(id)
    if (comment == null || comment.workspaceId !== workspaceId) return null
    const updated = { ...comment, resolved, updatedAt: comment.updatedAt + 1 }
    comments.set(id, updated)
    return updated
  },
  audit: { append: (record) => auditRecords.push(record) },
  now: () => 100,
  generateId: () => `audit-${++auditId}`
})

const registry = createConfiguredControlRegistry({
  authorization: createTrustedRuntimeReadPolicy({
    getWorkspaceProjectId: (workspaceId) => workspaceProjects.get(workspaceId) ?? null
  }),
  reviewMutations: reviewService
})
const compatibilityHandlers: ReviewCapabilityHandlers = {
  listByWorkspace: () => [],
  setResolved: (id, resolved) => {
    const comment = comments.get(id)
    if (comment == null) throw new Error('compatibility target missing')
    return { ...comment, resolved }
  }
}
for (const descriptor of createReviewCapabilities(compatibilityHandlers, {
  mcpRead: true,
  mcpMutation: reviewService
})) {
  registry.register(descriptor)
}

// The mutation is visible only to a runtime carrying the exact permission.
assert.ok(registry.describeForContext(REVIEW_SET_RESOLVED_CONTROL_ID, context()))
assert.equal(
  registry.describeForContext(
    REVIEW_SET_RESOLVED_CONTROL_ID,
    context(runtimeBinding({ permissions: [] }))
  ),
  null
)

// MCP ids are strict even though legacy renderer/socket invocations retain
// their historical string validation behavior.
for (const id of ['', ' comment-1', 'x'.repeat(129)]) {
  ownershipLookups = 0
  const invalid = await registry.invoke({
    id: REVIEW_SET_RESOLVED_CONTROL_ID,
    input: { id, resolved: true },
    context: context()
  })
  assert.equal(invalid.ok, false)
  if (!invalid.ok) assert.equal(invalid.code, 'invalid')
  assert.equal(ownershipLookups, 0)
}
auditRecords.length = 0

// Same-workspace success performs two ownership reads (policy + immediate
// handler revalidation), one scoped mutation, and one content-free audit row.
const success = await registry.invoke<LocalReviewComment>({
  id: REVIEW_SET_RESOLVED_CONTROL_ID,
  input: { id: baseComment.id, resolved: true },
  context: context()
})
assert.equal(success.ok, true)
assert.equal(success.ok ? success.value.resolved : null, true)
assert.equal(ownershipLookups, 2)
assert.equal(mutationCalls, 1)
assert.equal(auditRecords.length, 1)
assert.equal(auditRecords[0]?.decision, 'allow')
assert.equal(auditRecords[0]?.result.code, 'completed')
assert.deepEqual(auditRecords[0]?.target, {
  projectId: 'project-1',
  workspaceIds: ['workspace-1']
})
assert.deepEqual(auditRecords[0]?.redactedParams, {
  commentIdPresent: true,
  resolved: true
})
assert.doesNotMatch(JSON.stringify(auditRecords[0]), /Sensitive review body|private-name/)

// A same-project sibling and a cross-project comment both collapse to the same
// not_found result. Neither target workspace nor comment id appears in the
// response or audit payload.
for (const [id, workspaceId] of [
  ['comment-sibling', 'workspace-2'],
  ['comment-cross-project', 'workspace-cross-project']
]) {
  comments.set(id, { ...baseComment, id, workspaceId })
  const result = await registry.invoke({
    id: REVIEW_SET_RESOLVED_CONTROL_ID,
    input: { id, resolved: true },
    context: context()
  })
  assert.deepEqual(result, {
    ok: false,
    code: 'not_found',
    error: 'Review comment was not found.'
  })
  const audit = auditRecords.at(-1)
  assert.equal(audit?.decision, 'deny')
  assert.deepEqual(audit?.target.workspaceIds, ['workspace-1'])
  assert.doesNotMatch(JSON.stringify(audit), new RegExp(id))
  assert.doesNotMatch(result.ok ? '' : result.error, /workspace-2|workspace-cross-project/)
}
assert.equal(mutationCalls, 1)

// A target deleted after policy authorization but before the handler reaches
// the effect boundary is denied and never calls the mutation primitive.
comments.set(baseComment.id, { ...baseComment, resolved: false })
ownershipLookups = 0
deleteOnSecondLookup = true
const stale = await registry.invoke({
  id: REVIEW_SET_RESOLVED_CONTROL_ID,
  input: { id: baseComment.id, resolved: true },
  context: context()
})
deleteOnSecondLookup = false
assert.deepEqual(stale, {
  ok: false,
  code: 'not_found',
  error: 'Review comment was not found.'
})
assert.equal(ownershipLookups, 2)
assert.equal(mutationCalls, 1)
assert.equal(auditRecords.at(-1)?.decision, 'deny')

// Missing and mismatched trusted leases fail before ownership resolution and
// produce a generic forbidden audit.
for (const invalidContext of [
  context(null),
  {
    ...context(),
    principal: { type: 'workspace-agent' as const, id: 'different-runtime' }
  }
]) {
  ownershipLookups = 0
  const result = await registry.invoke({
    id: REVIEW_SET_RESOLVED_CONTROL_ID,
    input: { id: 'unknown-comment', resolved: false },
    context: invalidContext
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'forbidden')
    assert.doesNotMatch(result.error, /unknown-comment/)
  }
  assert.equal(ownershipLookups, 0)
  assert.equal(auditRecords.at(-1)?.decision, 'deny')
}

console.log('Review MCP mutation verification passed.')
