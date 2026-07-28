const DEFAULT_MAX_AGE_MS = 1_000

/**
 * Shares active-operation reconciliation across all callers. Normal fs.watch
 * reconciliation remains the zero-work fast path; this gate only closes the
 * watcher-miss gap while a wait/open/seed operation is actively polling.
 */
export class SessionStateFreshnessGate {
  private flight: Promise<void> | null = null
  private lastCompletedAt: number | null = null

  constructor(
    private readonly reconcile: () => void | Promise<void>,
    private readonly now: () => number = Date.now
  ) {}

  markReconciled(): void {
    this.lastCompletedAt = this.now()
  }

  refresh(maxAgeMs = DEFAULT_MAX_AGE_MS): Promise<void> {
    const boundedMaxAgeMs =
      Number.isFinite(maxAgeMs) && maxAgeMs >= 0 ? maxAgeMs : DEFAULT_MAX_AGE_MS
    if (this.lastCompletedAt != null && this.now() - this.lastCompletedAt < boundedMaxAgeMs) {
      return Promise.resolve()
    }
    if (this.flight != null) return this.flight

    const flight = Promise.resolve()
      .then(() => this.reconcile())
      .then(() => this.markReconciled())
      .finally(() => {
        if (this.flight === flight) this.flight = null
      })
    this.flight = flight
    return flight
  }
}
