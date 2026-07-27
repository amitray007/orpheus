import type { TerminalObservationEvent } from './types'

export const MAX_TERMINAL_EVENTS = 512
export const MAX_TERMINAL_WAITERS = 64
export const MAX_EVENTS_PER_RESPONSE = 100

type Waiter = {
  afterRevision: number
  terminalIds: ReadonlySet<string> | null
  resolve: () => void
  timeout: NodeJS.Timeout
}

function matches(
  event: TerminalObservationEvent,
  terminalIds: ReadonlySet<string> | null
): boolean {
  return terminalIds == null || terminalIds.has(event.terminalId)
}

export class TerminalObservationJournal {
  private revision = 0
  private readonly events: TerminalObservationEvent[] = []
  private readonly waiters = new Set<Waiter>()
  private disposed = false

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEvents = MAX_TERMINAL_EVENTS,
    private readonly maxWaiters = MAX_TERMINAL_WAITERS
  ) {}

  currentRevision(): number {
    return this.revision
  }

  oldestRevision(): number {
    return this.events[0]?.revision ?? this.revision + 1
  }

  waiterCount(): number {
    return this.waiters.size
  }

  size(): number {
    return this.events.length
  }

  append(
    terminalId: string,
    kind: TerminalObservationEvent['kind'],
    source: TerminalObservationEvent['source'],
    state: Record<string, unknown>
  ): TerminalObservationEvent {
    const event: TerminalObservationEvent = Object.freeze({
      revision: ++this.revision,
      terminalId,
      kind,
      observedAt: this.now(),
      source,
      state: Object.freeze({ ...state })
    })
    this.events.push(event)
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents)
    }
    for (const waiter of [...this.waiters]) {
      if (event.revision > waiter.afterRevision && matches(event, waiter.terminalIds)) {
        this.finishWaiter(waiter)
      }
    }
    return event
  }

  read(
    afterRevision: number,
    terminalIds: ReadonlySet<string> | null,
    maxEvents: number
  ): {
    events: readonly TerminalObservationEvent[]
    overflowed: boolean
    cursor: number
    oldestRevision: number
  } {
    const oldestRevision = this.oldestRevision()
    const overflowed =
      afterRevision > this.currentRevision() ||
      (this.events.length > 0 && afterRevision < Math.max(0, oldestRevision - 1))
    const boundedMax = Math.max(1, Math.min(maxEvents, MAX_EVENTS_PER_RESPONSE))
    const events = overflowed
      ? []
      : this.events
          .filter((event) => event.revision > afterRevision && matches(event, terminalIds))
          .slice(0, boundedMax)
    const cursor =
      events.length === boundedMax
        ? (events.at(-1)?.revision ?? afterRevision)
        : this.currentRevision()
    return { events, overflowed, cursor, oldestRevision }
  }

  async waitForChange(
    afterRevision: number,
    terminalIds: ReadonlySet<string> | null,
    timeoutMs: number
  ): Promise<'changed' | 'timeout' | 'capacity'> {
    if (this.disposed) return 'timeout'
    const immediate = this.read(afterRevision, terminalIds, 1)
    if (immediate.overflowed || immediate.events.length > 0) return 'changed'
    if (this.waiters.size >= this.maxWaiters) return 'capacity'

    return new Promise((resolve) => {
      let settled = false
      const waiter: Waiter = {
        afterRevision,
        terminalIds,
        resolve: () => {
          if (settled) return
          settled = true
          resolve('changed')
        },
        timeout: setTimeout(() => {
          if (settled) return
          settled = true
          this.waiters.delete(waiter)
          resolve('timeout')
        }, timeoutMs)
      }
      this.waiters.add(waiter)
    })
  }

  dispose(): void {
    this.disposed = true
    for (const waiter of [...this.waiters]) this.finishWaiter(waiter)
    this.events.length = 0
  }

  private finishWaiter(waiter: Waiter): void {
    if (!this.waiters.delete(waiter)) return
    clearTimeout(waiter.timeout)
    waiter.resolve()
  }
}
