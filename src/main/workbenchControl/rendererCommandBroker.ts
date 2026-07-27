import type {
  RendererControlAck,
  RendererControlCommand,
  RendererControlRequest
} from '../../shared/workbenchControl'

export type RendererCommandTransport = {
  isAvailable: () => boolean
  send: (request: RendererControlRequest) => boolean
}

export class RendererCommandError extends Error {
  constructor(
    readonly code: RendererControlAck['status'] | 'timeout',
    message: string
  ) {
    super(message)
  }
}

type Pending = {
  generation: number
  timer: ReturnType<typeof setTimeout>
  resolve: (ack: RendererControlAck) => void
  reject: (error: RendererCommandError) => void
}

export class RendererCommandBroker {
  private generation = 0
  private readonly pending = new Map<string, Pending>()

  constructor(
    private readonly transport: RendererCommandTransport,
    private readonly timeoutMs = 5_000
  ) {}

  execute(requestId: string, command: RendererControlCommand): Promise<RendererControlAck> {
    if (!this.transport.isAvailable()) {
      return Promise.reject(new RendererCommandError('unavailable', 'Renderer is unavailable.'))
    }
    if (this.pending.has(requestId)) {
      return Promise.reject(new RendererCommandError('conflict', 'Request is already pending.'))
    }
    const generation = ++this.generation
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new RendererCommandError('timeout', 'Renderer command timed out.'))
      }, this.timeoutMs)
      timer.unref?.()
      this.pending.set(requestId, { generation, timer, resolve, reject })
      try {
        if (!this.transport.send({ requestId, generation, command })) {
          this.rejectPending(
            requestId,
            new RendererCommandError('unavailable', 'Renderer is unavailable.')
          )
        }
      } catch {
        this.rejectPending(
          requestId,
          new RendererCommandError('unavailable', 'Renderer is unavailable.')
        )
      }
    })
  }

  acknowledge(ack: RendererControlAck): boolean {
    const pending = this.pending.get(ack.requestId)
    if (pending == null || pending.generation !== ack.generation) return false
    this.pending.delete(ack.requestId)
    clearTimeout(pending.timer)
    if (ack.status === 'completed') pending.resolve(ack)
    else pending.reject(new RendererCommandError(ack.status, ack.error ?? ack.status))
    return true
  }

  rejectAll(reason = 'Renderer became unavailable.'): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new RendererCommandError('unavailable', reason))
      this.pending.delete(requestId)
    }
  }

  private rejectPending(requestId: string, error: RendererCommandError): void {
    const pending = this.pending.get(requestId)
    if (pending == null) return
    this.pending.delete(requestId)
    clearTimeout(pending.timer)
    pending.reject(error)
  }
}
