// ---------------------------------------------------------------------------
// src/main/routingProxy/supervisor.ts
//
// Pure, electron-free decision logic for auto-supervising the managed
// routing-proxy child process: respawn-on-unexpected-exit with exponential
// backoff, a recurring health watchdog that restarts a hung-but-alive
// process, and a give-up threshold after too many consecutive failures.
//
// Deliberately mirrors health.ts's HealthCheckDeps / RoutingProxyReadyDeps
// and orphan.ts's OrphanReclaimDeps shape: every side effect (spawn, kill,
// health probe, logging, sleep, clock, scheduling) is an injected callback,
// so this module has NO import of `electron`, `node:child_process` spawn
// APIs, or any real timer — only `setTimeout`/`setInterval` TYPES are used
// via injected deps, never called directly. This is what lets
// scripts/verify-routing-proxy.ts (which cannot import `electron`, see that
// script's own header comment) unit-test the respawn/backoff/watchdog/
// give-up logic directly and deterministically, with fake clocks.
//
// manager.ts (which CAN import electron) constructs a RoutingProxySupervisor
// with REAL implementations (real startRoutingProxy/stopRoutingProxy/
// checkRoutingProxyHealth/console.log/setTimeout/setInterval) and calls its
// lifecycle hooks from the right places — see manager.ts's own comments at
// each call site for exactly which hook fires where.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Backoff schedule — pure, no state.
// ---------------------------------------------------------------------------

/** Base delay (ms) before the first respawn attempt. */
export const RESPAWN_BASE_DELAY_MS = 1000

/** Hard cap (ms) the backoff delay never exceeds. */
export const RESPAWN_MAX_DELAY_MS = 30_000

/** Consecutive failed respawn attempts allowed before giving up entirely. */
export const MAX_CONSECUTIVE_RESPAWN_FAILURES = 5

/** Health-watchdog polling cadence. */
export const HEALTH_WATCHDOG_INTERVAL_MS = 30_000

/**
 * attempt 0 -> 1s, 1 -> 2s, 2 -> 4s, 3 -> 8s, 4 -> 16s, 5+ -> 30s (capped).
 * `attempt` is the 0-indexed count of respawn attempts already made since
 * the last successful start (or since the failure counter was last reset).
 */
export function respawnBackoffDelayMs(attempt: number): number {
  const uncapped = RESPAWN_BASE_DELAY_MS * 2 ** Math.max(0, attempt)
  return Math.min(uncapped, RESPAWN_MAX_DELAY_MS)
}

// ---------------------------------------------------------------------------
// Respawn decision — pure function of current supervisor state.
// ---------------------------------------------------------------------------

export interface RespawnDecisionInput {
  /** Whether the user currently wants the proxy running
   *  (AppUiState.routingProxyEnabled). */
  enabled: boolean
  /** True if this exit was preceded by a markExpectedShutdown() call
   *  (manual stop/restart/app-quit) — never respawn those. */
  expectedShutdown: boolean
  /** True if a manual restart() is already in flight — never race it. */
  restarting: boolean
  /** Consecutive failed respawn attempts so far (0 right after a success or
   *  a counter reset). */
  consecutiveFailures: number
}

export type RespawnDecision =
  | { action: 'respawn'; delayMs: number; attempt: number }
  | { action: 'give-up'; reason: string }
  | { action: 'skip'; reason: string }

/**
 * Decide what the supervisor should do in response to an unexpected child
 * exit. Never mutates anything — callers apply the decision (schedule a
 * timer, update the failure counter, patch the snapshot) themselves.
 */
export function decideRespawnAction(input: RespawnDecisionInput): RespawnDecision {
  if (!input.enabled) {
    return { action: 'skip', reason: 'routing proxy is disabled — not supervising' }
  }
  if (input.expectedShutdown) {
    return { action: 'skip', reason: 'exit was expected (manual stop/restart/quit)' }
  }
  if (input.restarting) {
    return { action: 'skip', reason: 'a manual restart is already in flight' }
  }
  if (input.consecutiveFailures >= MAX_CONSECUTIVE_RESPAWN_FAILURES) {
    return {
      action: 'give-up',
      reason: `gave up after ${MAX_CONSECUTIVE_RESPAWN_FAILURES} consecutive failed respawn attempts`
    }
  }
  return {
    action: 'respawn',
    delayMs: respawnBackoffDelayMs(input.consecutiveFailures),
    attempt: input.consecutiveFailures + 1
  }
}

// ---------------------------------------------------------------------------
// Watchdog decision — pure function over a health-check result.
// ---------------------------------------------------------------------------

export interface WatchdogDecisionInput {
  enabled: boolean
  expectedShutdown: boolean
  restarting: boolean
  /** Is the child process currently believed to be running at all? A
   *  watchdog tick with nothing running has nothing to restart — the
   *  respawn-on-exit path already owns that case. */
  isRunning: boolean
  healthy: boolean
}

export type WatchdogDecision =
  | { action: 'restart'; reason: string }
  | { action: 'skip'; reason: string }

export function decideWatchdogAction(input: WatchdogDecisionInput): WatchdogDecision {
  if (!input.enabled) return { action: 'skip', reason: 'routing proxy is disabled' }
  if (input.expectedShutdown) return { action: 'skip', reason: 'shutdown in progress' }
  if (input.restarting) return { action: 'skip', reason: 'a manual restart is already in flight' }
  if (!input.isRunning) return { action: 'skip', reason: 'nothing currently running to check' }
  if (input.healthy) return { action: 'skip', reason: 'healthy' }
  return { action: 'restart', reason: 'process is running but not answering the health probe' }
}

// ---------------------------------------------------------------------------
// Injected dependencies — the real implementations manager.ts wires; a test
// harness substitutes fakes for all of these (fake clock/sleep/timers, stub
// health probe, no real process spawn/kill).
// ---------------------------------------------------------------------------

export interface RoutingProxySupervisorDeps {
  /** Start (or restart) the managed child process. Mirrors manager.ts's
   *  start() — resolves once the start attempt has settled (success or
   *  recorded failure); never throws. */
  startProxy: () => Promise<void>
  /** Forcefully stop/kill the child so it can't linger as an orphan the
   *  supervisor doesn't know about (used on the hung-but-alive watchdog
   *  path before respawning). Mirrors lifecycle.ts's killRoutingProxySync. */
  killProxy: () => void
  /** Is the child currently believed to be running? Mirrors
   *  lifecycle.ts's isRunning(). */
  isRunning: () => boolean
  /** Is a manual restart() already in flight? Mirrors manager.ts's
   *  isRestarting(). */
  isRestarting: () => boolean
  /** Is the routing proxy currently enabled by the user? Mirrors
   *  getAppUiState().routingProxyEnabled. */
  isEnabled: () => boolean
  /** Real reachability probe — same shape/contract as health.ts's
   *  checkRoutingProxyHealth, supplied pre-bound to the live base URL +
   *  management secret so this module never needs to know either. */
  checkHealth: () => Promise<{ healthy: boolean; reason?: string }>
  /** Called when the supervisor gives up after too many consecutive
   *  respawn failures — the wiring updates the snapshot to `'error'` with a
   *  clear message here. */
  onGiveUp: (message: string) => void
  /** setTimeout, injected so the harness can drive backoff without real
   *  delays. Returns an opaque handle passed back to clearTimer. */
  setTimer: (cb: () => void, delayMs: number) => unknown
  /** clearTimeout/clearInterval, injected for the same reason. */
  clearTimer: (handle: unknown) => void
  /** setInterval, injected for the same reason as setTimer. */
  setRepeatingTimer: (cb: () => void, intervalMs: number) => unknown
  logger: SupervisorLogger
}

export interface SupervisorLogger {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

const LOG_PREFIX = '[routing-proxy]'

export function defaultSupervisorLogger(): SupervisorLogger {
  return {
    info: (message) => console.log(`${LOG_PREFIX} ${message}`),
    warn: (message) => console.warn(`${LOG_PREFIX} ${message}`),
    error: (message) => console.error(`${LOG_PREFIX} ${message}`)
  }
}

// ---------------------------------------------------------------------------
// Stateful orchestration — ties backoff + watchdog + give-up together. All
// side effects are the injected deps above; this class only owns small,
// serializable bits of state (failure counter, expected-shutdown flag,
// outstanding timer handles, single-flight watchdog guard).
// ---------------------------------------------------------------------------

export class RoutingProxySupervisor {
  private deps: RoutingProxySupervisorDeps
  private consecutiveFailures = 0
  private expectedShutdown = false
  private respawnTimer: unknown = null
  private watchdogTimer: unknown = null
  private watchdogCheckInFlight = false
  private gaveUp = false

  constructor(deps: RoutingProxySupervisorDeps) {
    this.deps = deps
  }

  /** Call BEFORE the underlying stop/kill so the ensuing child exit is
   *  correctly classified as expected and does not trigger a respawn.
   *  Mirrors manager.ts's stop()/restart()/shutdownRoutingProxySync() call
   *  sites — all three must call this first. */
  markExpectedShutdown(): void {
    this.expectedShutdown = true
  }

  /** Call once a fresh start (manual or supervised) has begun — clears the
   *  expected-shutdown flag so a SUBSEQUENT unexpected exit is correctly
   *  classified again. */
  markStarted(): void {
    this.expectedShutdown = false
  }

  /** Reset the consecutive-failure counter and un-give-up. Manual restart()
   *  completing successfully, and setEnabled() toggling on, both call this. */
  resetFailureCount(): void {
    this.consecutiveFailures = 0
    this.gaveUp = false
  }

  /** True once the supervisor has given up after MAX_CONSECUTIVE_RESPAWN_FAILURES. */
  hasGivenUp(): boolean {
    return this.gaveUp
  }

  /**
   * Handle an unexpected child exit (lifecycle.ts's onExit, only when NOT
   * preceded by markExpectedShutdown()). Decides whether to respawn (via a
   * backoff timer calling deps.startProxy), give up, or skip.
   */
  onUnexpectedExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.expectedShutdown) return
    this.deps.logger.warn(`unexpected exit (code=${String(code)}, signal=${String(signal)})`)
    this.clearRespawnTimer()

    const decision = decideRespawnAction({
      enabled: this.deps.isEnabled(),
      expectedShutdown: this.expectedShutdown,
      restarting: this.deps.isRestarting(),
      consecutiveFailures: this.consecutiveFailures
    })
    this.applyRespawnDecision(decision)
  }

  private applyRespawnDecision(decision: RespawnDecision): void {
    if (decision.action === 'skip') {
      this.deps.logger.info(`not respawning: ${decision.reason}`)
      return
    }
    if (decision.action === 'give-up') {
      this.gaveUp = true
      this.deps.logger.error(decision.reason)
      this.deps.onGiveUp(decision.reason)
      return
    }
    this.deps.logger.info(`respawn attempt ${decision.attempt} scheduled in ${decision.delayMs}ms`)
    this.respawnTimer = this.deps.setTimer(() => {
      this.respawnTimer = null
      this.consecutiveFailures += 1
      void this.attemptRespawn()
    }, decision.delayMs)
  }

  private async attemptRespawn(): Promise<void> {
    try {
      await this.deps.startProxy()
      if (this.deps.isRunning()) {
        this.deps.logger.info(`respawn succeeded (attempt ${this.consecutiveFailures})`)
        this.consecutiveFailures = 0
        return
      }
      // startProxy() resolved but the process isn't up (e.g. it failed to
      // bind / became unreachable) — treat exactly like another failed
      // attempt and let the normal decision function decide next steps.
      this.applyRespawnDecision(
        decideRespawnAction({
          enabled: this.deps.isEnabled(),
          expectedShutdown: this.expectedShutdown,
          restarting: this.deps.isRestarting(),
          consecutiveFailures: this.consecutiveFailures
        })
      )
    } catch (err) {
      this.deps.logger.error(
        `respawn attempt failed: ${err instanceof Error ? err.message : String(err)}`
      )
      this.applyRespawnDecision(
        decideRespawnAction({
          enabled: this.deps.isEnabled(),
          expectedShutdown: this.expectedShutdown,
          restarting: this.deps.isRestarting(),
          consecutiveFailures: this.consecutiveFailures
        })
      )
    }
  }

  private clearRespawnTimer(): void {
    if (this.respawnTimer !== null) {
      this.deps.clearTimer(this.respawnTimer)
      this.respawnTimer = null
    }
  }

  /** Start the 30s recurring health watchdog. Call once the proxy reaches
   *  'running' status. Idempotent — calling twice without an intervening
   *  stopWatchdog() just clears+recreates the interval. */
  startWatchdog(): void {
    this.stopWatchdog()
    this.watchdogTimer = this.deps.setRepeatingTimer(() => {
      void this.runWatchdogTick()
    }, HEALTH_WATCHDOG_INTERVAL_MS)
  }

  /** Stop the health watchdog. Call on stop()/shutdownRoutingProxySync(). */
  stopWatchdog(): void {
    if (this.watchdogTimer !== null) {
      this.deps.clearTimer(this.watchdogTimer)
      this.watchdogTimer = null
    }
  }

  /** Single-flight: a slow probe must not stack additional probes while one
   *  is outstanding. */
  private async runWatchdogTick(): Promise<void> {
    if (this.watchdogCheckInFlight) return
    this.watchdogCheckInFlight = true
    try {
      const result = await this.deps.checkHealth()
      const decision = decideWatchdogAction({
        enabled: this.deps.isEnabled(),
        expectedShutdown: this.expectedShutdown,
        restarting: this.deps.isRestarting(),
        isRunning: this.deps.isRunning(),
        healthy: result.healthy
      })
      if (decision.action === 'skip') return
      this.deps.logger.warn(`health watchdog: ${decision.reason} — killing and respawning`)
      // Explicitly kill first: a hung-but-bound process must not linger as
      // an orphan the supervisor doesn't know about (waitForRoutingProxyReady
      // failing in start() leaves the child alive — see manager.ts's start()
      // doc comment). killProxy() triggers lifecycle.ts's real child 'exit'
      // event, which manager.ts's onExit wires back to onUnexpectedExit()
      // above — so the normal respawn/backoff path picks it up from there;
      // this call only needs to ensure the kill actually happens.
      this.deps.killProxy()
    } catch (err) {
      this.deps.logger.error(
        `health watchdog probe failed: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      this.watchdogCheckInFlight = false
    }
  }

  /** Full teardown — clears both timers. Call on shutdownRoutingProxySync()
   *  (app quit) in addition to markExpectedShutdown(). */
  dispose(): void {
    this.clearRespawnTimer()
    this.stopWatchdog()
  }
}

/** Real setTimeout/setInterval/console-backed deps factory. `startProxy`/
 *  `killProxy`/`isRunning`/`isRestarting`/`isEnabled`/`checkHealth`/
 *  `onGiveUp` must still be supplied by the caller (manager.ts) — those are
 *  the pieces that require electron/DB/lifecycle.ts access this module must
 *  never import directly. */
export function defaultSupervisorTimerDeps(): Pick<
  RoutingProxySupervisorDeps,
  'setTimer' | 'clearTimer' | 'setRepeatingTimer' | 'logger'
> {
  return {
    setTimer: (cb, delayMs) => setTimeout(cb, delayMs),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    setRepeatingTimer: (cb, intervalMs) => setInterval(cb, intervalMs),
    logger: defaultSupervisorLogger()
  }
}
