export const START_SUPERSEDED = 'start was superseded'
export const START_BLOCKED_BY_UNRESOLVED_CLEANUP = 'start blocked by unresolved candidate cleanup'

export interface UnresolvedCandidateCleanup {
  pid: number
  generation: number
  listenerReleased: () => Promise<boolean>
}

/**
 * Serializes manager lifecycle side effects while allowing a new intent to
 * invalidate an already-running operation. A cleanup timeout poisons later
 * turns until the exact candidate exit and a listener-release probe agree.
 */
export class RoutingProxyLifecycleCoordinator {
  private generation = 0
  private tail: Promise<void> = Promise.resolve()
  private unresolvedCleanup: (UnresolvedCandidateCleanup & { exited: boolean }) | null = null

  beginIntent(): number {
    this.generation += 1
    return this.generation
  }

  owns(generation: number): boolean {
    return generation === this.generation
  }

  blockUnresolvedCandidate(cleanup: UnresolvedCandidateCleanup): void {
    this.unresolvedCleanup = { ...cleanup, exited: false }
  }

  recordCandidateExit(pid: number, generation: number): void {
    const cleanup = this.unresolvedCleanup
    if (cleanup?.pid === pid && cleanup.generation === generation) cleanup.exited = true
  }

  private async cleanupIsResolved(): Promise<boolean> {
    const cleanup = this.unresolvedCleanup
    if (!cleanup) return true
    if (!cleanup.exited) return false
    try {
      if (!(await cleanup.listenerReleased())) return false
    } catch {
      return false
    }
    if (this.unresolvedCleanup === cleanup) this.unresolvedCleanup = null
    return true
  }

  async run<T>(
    generation: number,
    operation: () => Promise<T>
  ): Promise<T | typeof START_SUPERSEDED | typeof START_BLOCKED_BY_UNRESOLVED_CLEANUP> {
    let resolveTurn!: () => void
    const previous = this.tail
    this.tail = new Promise<void>((resolve) => {
      resolveTurn = resolve
    })
    await previous
    try {
      if (!this.owns(generation)) return START_SUPERSEDED
      if (!(await this.cleanupIsResolved())) return START_BLOCKED_BY_UNRESOLVED_CLEANUP
      return await operation()
    } finally {
      resolveTurn()
    }
  }
}
