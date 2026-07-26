import type {
  ControlDescriptor,
  ControlDescription,
  ControlInvocation,
  ControlResult
} from './types'

type StoredDescriptor = ControlDescriptor<unknown, unknown>

function surfaceForConsumer(consumer: ControlInvocation['context']['consumer']): string {
  return consumer === 'renderer-ipc' ? 'renderer' : consumer
}

export class ControlRegistry {
  private readonly descriptors = new Map<string, StoredDescriptor>()

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
      risk: descriptor.risk
    }
  }

  list(): ControlDescription[] {
    return [...this.descriptors.keys()]
      .sort()
      .map((id) => this.describe(id))
      .filter((description): description is ControlDescription => description != null)
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
    if (!descriptor.allowedSurfaces.includes(surface as 'renderer' | 'command-socket')) {
      return {
        ok: false,
        code: 'forbidden',
        error: `Control capability ${invocation.id} is not available to ${invocation.context.consumer}`
      }
    }

    if (!descriptor.validateInput(invocation.input)) {
      return {
        ok: false,
        code: 'invalid',
        error: `Invalid input for control capability: ${invocation.id}`
      }
    }

    try {
      const value = await descriptor.handler(invocation.input, invocation.context)
      return { ok: true, value: value as T }
    } catch (err) {
      return {
        ok: false,
        code: 'failed',
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }
}

export function unwrapControlResult<T>(result: ControlResult<T>): T {
  if (result.ok) return result.value
  throw new Error(result.error)
}
