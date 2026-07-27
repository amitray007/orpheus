import type {
  ControlAuthorizationPolicy,
  ControlDescriptor,
  ControlDescription,
  ControlInvocation,
  ControlRejectionAuditor,
  ControlResult,
  ControlSurface
} from './types'
import { WorkspaceOrchestrationError } from '../workspaceOrchestration/errors'

type StoredDescriptor = ControlDescriptor<unknown, unknown>

const COMPATIBILITY_POLICY: ControlAuthorizationPolicy = {
  canDiscover: (_description, context) => context.consumer !== 'mcp',
  authorize: (_description, _input, context) =>
    context.consumer === 'mcp'
      ? {
          allowed: false,
          code: 'forbidden',
          error: 'MCP control requires a trusted runtime authorization policy.'
        }
      : { allowed: true }
}

function surfaceForConsumer(
  consumer: ControlInvocation['context']['consumer']
): ControlSurface | null {
  if (consumer === 'renderer-ipc') return 'renderer'
  if (consumer === 'command-socket' || consumer === 'mcp') return consumer
  if (consumer === 'automation') return 'automation'
  return null
}

export class ControlRegistry {
  private readonly descriptors = new Map<string, StoredDescriptor>()

  constructor(
    private readonly authorization: ControlAuthorizationPolicy = COMPATIBILITY_POLICY,
    private readonly rejectionAuditor?: ControlRejectionAuditor
  ) {}

  register<TInput, TOutput>(descriptor: ControlDescriptor<TInput, TOutput>): void {
    if (this.descriptors.has(descriptor.id)) {
      throw new Error(`Control capability already registered: ${descriptor.id}`)
    }
    this.descriptors.set(descriptor.id, descriptor as StoredDescriptor)
  }

  describe(id: string): ControlDescription | null {
    const descriptor = this.descriptors.get(id)
    if (descriptor == null) return null
    return {
      id: descriptor.id,
      version: descriptor.version,
      kind: descriptor.kind,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      outputSchema: descriptor.outputSchema,
      allowedSurfaces: descriptor.allowedSurfaces,
      permission: descriptor.permission,
      scope: descriptor.scope,
      risk: descriptor.risk,
      declaredEffects: descriptor.declaredEffects ?? [],
      idempotency: descriptor.idempotency
    }
  }

  list(): ControlDescription[] {
    return [...this.descriptors.keys()]
      .sort()
      .map((id) => this.describe(id))
      .filter((description): description is ControlDescription => description != null)
  }

  describeForContext(id: string, context: ControlInvocation['context']): ControlDescription | null {
    const description = this.describe(id)
    if (description == null) return null
    const surface = surfaceForConsumer(context.consumer)
    if (surface == null || !description.allowedSurfaces.includes(surface)) return null
    return this.authorization.canDiscover(description, context) ? description : null
  }

  listForContext(context: ControlInvocation['context']): ControlDescription[] {
    return [...this.descriptors.keys()]
      .sort()
      .map((id) => this.describeForContext(id, context))
      .filter((description): description is ControlDescription => description != null)
  }

  validateInput(id: string, input: unknown, context: ControlInvocation['context']): boolean {
    const descriptor = this.descriptors.get(id)
    if (descriptor == null) return false
    const surface = surfaceForConsumer(context.consumer)
    return (
      surface != null &&
      descriptor.allowedSurfaces.includes(surface) &&
      descriptor.validateInput(input, context)
    )
  }

  async invoke<T>(invocation: ControlInvocation): Promise<ControlResult<T>> {
    const descriptor = this.descriptors.get(invocation.id)
    if (descriptor == null) {
      return {
        ok: false,
        code: 'not_found',
        error: `Control capability not found: ${invocation.id}`
      }
    }

    const surface = surfaceForConsumer(invocation.context.consumer)
    if (surface == null || !descriptor.allowedSurfaces.includes(surface)) {
      return {
        ok: false,
        code: 'forbidden',
        error: `Control capability ${invocation.id} is not available to ${invocation.context.consumer}`
      }
    }

    const description = this.describe(invocation.id)
    if (description == null) {
      return {
        ok: false,
        code: 'not_found',
        error: `Control capability not found: ${invocation.id}`
      }
    }

    if (!descriptor.validateInput(invocation.input, invocation.context)) {
      await this.auditRejection(description, invocation, 'invalid')
      return {
        ok: false,
        code: 'invalid',
        error: `Invalid input for control capability: ${invocation.id}`
      }
    }

    try {
      const decision = await this.authorization.authorize(
        description,
        invocation.input,
        invocation.context
      )
      if (!decision.allowed) {
        await this.auditRejection(description, invocation, decision.code)
        return { ok: false, code: decision.code, error: decision.error }
      }
      const value = await descriptor.handler(invocation.input, invocation.context)
      return { ok: true, value: value as T }
    } catch (err) {
      if (err instanceof WorkspaceOrchestrationError) {
        return { ok: false, code: err.code, error: err.message }
      }
      return {
        ok: false,
        code: 'failed',
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }

  private async auditRejection(
    description: ControlDescription,
    invocation: ControlInvocation,
    code: 'invalid' | 'not_found' | 'forbidden'
  ): Promise<void> {
    if (description.risk.tier < 2 || this.rejectionAuditor == null) return
    await this.rejectionAuditor.auditRejected({
      description,
      params: invocation.input,
      context: invocation.context,
      code,
      decision: 'deny'
    })
  }
}

export function unwrapControlResult<T>(result: ControlResult<T>): T {
  if (result.ok) return result.value
  throw new Error(result.error)
}
