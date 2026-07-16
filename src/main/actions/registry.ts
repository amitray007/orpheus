// ---------------------------------------------------------------------------
// actions/registry.ts — Central action registry for Quick Actions
//
// Actions are registered with a descriptor and invoked via a single entry
// point: registry.invoke(invocation, consumerHint) → ActionResult<T>
//
// Mutators write an audit entry (regardless of success/failure).
// Queries and subscriptions are never audited.
// ---------------------------------------------------------------------------

import type { ActionKind, ActionInvocation, ActionResult } from '../../shared/types'
import { recordAudit, redactAndSerialize } from './audit'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActionDescriptor<T = unknown> = {
  id: string
  kind: ActionKind
  /** Return true if the raw params object is valid for this action. */
  validate: (params: unknown) => boolean
  /** The actual implementation. Throws on unrecoverable error. */
  handler: (params: Record<string, unknown>, workspaceId: string) => Promise<ActionResult<T>>
}

// ---------------------------------------------------------------------------
// Registry state
// ---------------------------------------------------------------------------

const registry = new Map<string, ActionDescriptor>()

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function register(descriptor: ActionDescriptor): void {
  if (registry.has(descriptor.id)) {
    console.warn('[actions:registry] overwriting existing action:', descriptor.id)
  }
  registry.set(descriptor.id, descriptor)
}

export async function invoke(
  invocation: ActionInvocation,
  consumerHint: string
): Promise<ActionResult> {
  const { id, params, workspaceId } = invocation

  const descriptor = registry.get(id)
  if (!descriptor) {
    return { ok: false, code: 'not_found', error: `Action not found: ${id}` }
  }

  if (!descriptor.validate(params)) {
    return { ok: false, code: 'invalid', error: 'params failed validation' }
  }

  let result: ActionResult
  try {
    result = await descriptor.handler(params, workspaceId)
  } catch (err) {
    result = { ok: false, code: 'failed', error: String(err) }
  }

  // Audit mutators — always, regardless of success
  if (descriptor.kind === 'mutator') {
    try {
      recordAudit({
        workspaceId,
        actionId: id,
        paramsJson: redactAndSerialize(params),
        resultCode: result.ok ? 'ok' : (result as { code: string }).code,
        consumerHint,
        createdAt: Date.now()
      })
    } catch (auditErr) {
      console.error('[actions:registry] audit write failed:', auditErr)
    }
  }

  return result
}

export function list(): Array<{ id: string; kind: ActionKind }> {
  return Array.from(registry.values()).map((d) => ({ id: d.id, kind: d.kind }))
}
