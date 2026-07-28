import type { TerminalObservationEvent } from './types'

export const MAX_TERMINAL_EVENTS = 512
export const MAX_TERMINAL_WAITERS = 64
export const MAX_EVENTS_PER_RESPONSE = 100

type Waiter = {
  afterRevision: number
  matchesTerminal: (terminalId: string) => boolean
  resolve: () => void
  timeout: NodeJS.Timeout
}

function matchesSet(
  event: TerminalObservationEvent,
  terminalIds: ReadonlySet<string> | null
): boolean {
  return terminalIds == null || terminalIds.has(event.terminalId)
}

export class TerminalObservationJournal {
  private revision = 0
  private readonly events: TerminalObservationEvent[] = []
  private readonly waiters = new Set<Waiter>()
  private readonly lastStates = new Map<string, string>()
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
      if (event.revision > waiter.afterRevision && waiter.matchesTerminal(event.terminalId)) {
        this.finishWaiter(waiter)
      }
    }
    return event
  }

  /**
   * Appends only when the terminal/kind/source state actually changed. Runtime
   * session reconciliation is intentionally frequent; suppressing identical
   * observations avoids filling the bounded journal and waking long-poll
   * subscribers for no semantic change.
   */
  appendDistinct(
    terminalId: string,
    kind: TerminalObservationEvent['kind'],
    source: TerminalObservationEvent['source'],
    state: Record<string, unknown>
  ): TerminalObservationEvent | null {
    const key = `${terminalId}\u0000${kind}\u0000${source}`
    const fingerprint = JSON.stringify(state)
    if (this.lastStates.get(key) === fingerprint) return null
    this.lastStates.delete(key)
    this.lastStates.set(key, fingerprint)
    while (this.lastStates.size > this.maxEvents) {
      const oldest = this.lastStates.keys().next().value
      if (oldest == null) break
      this.lastStates.delete(oldest)
    }
    return this.append(terminalId, kind, source, state)
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
          .filter((event) => event.revision > afterRevision && matchesSet(event, terminalIds))
          .slice(0, boundedMax)
    const cursor =
      events.length === boundedMax
        ? (events.at(-1)?.revision ?? afterRevision)
        : this.currentRevision()
    return { events, overflowed, cursor, oldestRevision }
  }

  async waitForChange(
    afterRevision: number,
    terminalIds: ReadonlySet<string> | null | ((terminalId: string) => boolean),
    timeoutMs: number
  ): Promise<'changed' | 'timeout' | 'capacity'> {
    if (this.disposed) return 'timeout'
    const matchesTerminal =
      typeof terminalIds === 'function'
        ? terminalIds
        : (terminalId: string): boolean => terminalIds == null || terminalIds.has(terminalId)
    const oldestRevision = this.oldestRevision()
    if (
      afterRevision > this.currentRevision() ||
      (this.events.length > 0 && afterRevision < Math.max(0, oldestRevision - 1)) ||
      this.events.some(
        (event) => event.revision > afterRevision && matchesTerminal(event.terminalId)
      )
    ) {
      return 'changed'
    }
    if (this.waiters.size >= this.maxWaiters) return 'capacity'

    return new Promise((resolve) => {
      let settled = false
      const waiter: Waiter = {
        afterRevision,
        matchesTerminal,
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
    this.lastStates.clear()
  }

  private finishWaiter(waiter: Waiter): void {
    if (!this.waiters.delete(waiter)) return
    clearTimeout(waiter.timeout)
    waiter.resolve()
  }
}
