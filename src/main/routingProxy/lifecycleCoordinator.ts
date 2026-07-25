export const START_SUPERSEDED = 'start was superseded'

/**
 * Serializes manager lifecycle side effects while allowing a new intent to
 * invalidate an already-running operation. Callers must check ownership after
 * every await; queued work never overlaps config, spawn, persistence, or UI
 * publication with another lifecycle operation.
 */
export class RoutingProxyLifecycleCoordinator {
  private generation = 0
  private tail: Promise<void> = Promise.resolve()

  beginIntent(): number {
    this.generation += 1
    return this.generation
  }

  owns(generation: number): boolean {
    return generation === this.generation
  }

  async run<T>(
    generation: number,
    operation: () => Promise<T>
  ): Promise<T | typeof START_SUPERSEDED> {
    let resolveTurn!: () => void
    const previous = this.tail
    this.tail = new Promise<void>((resolve) => {
      resolveTurn = resolve
    })
    await previous
    try {
      if (!this.owns(generation)) return START_SUPERSEDED
      return await operation()
    } finally {
      resolveTurn()
    }
  }
}
