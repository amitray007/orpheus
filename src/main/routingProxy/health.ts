// ---------------------------------------------------------------------------
// src/main/routingProxy/health.ts
//
// Real reachability probe for the managed proxy. THERE IS NO /health
// ENDPOINT on CLIProxyAPI (GET /health -> 404, verified) — probing it would
// always report unhealthy. Instead this probes the management API
// (GET /v0/management/auth-files with the management secret), which is a
// cheap, real request that only succeeds once the proxy is actually up and
// serving. Falls back to a bare TCP connect if no management secret is
// available (e.g. before the child's env is known) — still a real
// reachability signal, just a weaker one (confirms "something is listening
// on the port", not "the proxy answered a real request").
//
// FAIL-CLOSED: ensureHealthyForRouting() is the gate callers (routing mount
// path, or a later unit) must call before trusting the proxy. An unreachable
// proxy makes Claude Code hang ~44-128s silently (measured) if a workspace
// is launched against it anyway — this function turns that into an
// immediate, clear error instead.
// ---------------------------------------------------------------------------

import * as net from 'node:net'

export type HealthCheckResult = { healthy: true } | { healthy: false; reason: string }

export interface HealthCheckDeps {
  /** Attempt a bare TCP connect to host:port. Resolves true if a connection opens. */
  tcpProbe: (host: string, port: number, timeoutMs: number) => Promise<boolean>
  /** Attempt a management-API request. Resolves true only on a genuine 2xx/401/403
   *  (any of those proves something CLIProxyAPI-shaped is listening and routing
   *  HTTP — a 401/403 still proves reachability, just with a bad/missing secret). */
  managementProbe: (
    baseUrl: string,
    managementSecret: string | null,
    timeoutMs: number
  ) => Promise<boolean>
}

function realTcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.connect(port, host)
  })
}

async function realManagementProbe(
  baseUrl: string,
  managementSecret: string | null,
  timeoutMs: number
): Promise<boolean> {
  try {
    const headers: Record<string, string> = {}
    if (managementSecret) headers['Authorization'] = `Bearer ${managementSecret}`
    const res = await fetch(new URL('/v0/management/auth-files', baseUrl), {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    })
    // 5 failed AUTHS trigger a 30-min IP ban per the CLIProxyAPI docs — a
    // 401/403 here is exactly one auth attempt with the secret we hold, not
    // a blind retry loop, so it's safe to send once as a reachability probe.
    // Any response at all (2xx/401/403/404) proves the process is up and
    // answering HTTP; only a network-level failure means unreachable.
    return res.status < 500
  } catch {
    return false
  }
}

export function defaultHealthCheckDeps(): HealthCheckDeps {
  return { tcpProbe: realTcpProbe, managementProbe: realManagementProbe }
}

/**
 * Probe reachability of the proxy at `baseUrl`. Prefers the management API
 * (a real request) when a secret is supplied; otherwise falls back to a bare
 * TCP connect. Never throws — always resolves a HealthCheckResult.
 */
export async function checkRoutingProxyHealth(
  baseUrl: string,
  options: { managementSecret?: string | null; timeoutMs?: number } = {},
  deps: HealthCheckDeps = defaultHealthCheckDeps()
): Promise<HealthCheckResult> {
  const timeoutMs = options.timeoutMs ?? 2000
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return { healthy: false, reason: `invalid proxy URL: ${baseUrl}` }
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))

  if (options.managementSecret) {
    const ok = await deps.managementProbe(baseUrl, options.managementSecret, timeoutMs)
    if (ok) return { healthy: true }
    // Management probe failing doesn't necessarily mean unreachable (could
    // be a transient app-level error) — fall through to a raw TCP check
    // before declaring unhealthy, so a slow-but-alive process isn't
    // misreported.
  }

  const tcpOk = await deps.tcpProbe(url.hostname, port, timeoutMs)
  if (tcpOk) return { healthy: true }
  return { healthy: false, reason: `nothing reachable at ${url.hostname}:${port}` }
}

/**
 * Fail-closed gate: routing must call this (or a caller must, per unit 04's
 * scope note) before mounting a routed workspace against the proxy. Throws a
 * clear, immediate error instead of letting Claude Code hang silently for
 * 44-128s against an unreachable proxy (measured behavior).
 */
export async function ensureHealthyForRouting(
  baseUrl: string,
  options: { managementSecret?: string | null; timeoutMs?: number } = {},
  deps: HealthCheckDeps = defaultHealthCheckDeps()
): Promise<void> {
  const result = await checkRoutingProxyHealth(baseUrl, options, deps)
  if (!result.healthy) {
    throw new Error(
      `Routing proxy is not reachable at ${baseUrl} (${result.reason}). Start it from ` +
        `Settings > Orpheus > Model Routing before launching a routed-model workspace.`
    )
  }
}

// ---------------------------------------------------------------------------
// Readiness polling — used right after spawning the child (manager.ts's
// start()) to detect "the proxy is listening" as fast as possible.
//
// A local process either accepts a loopback TCP connection almost instantly
// once it's up, or it isn't up yet — there's no reason to wait a fixed
// interval between probes, and no reason to give any single probe 2000ms
// (checkRoutingProxyHealth's *default* timeoutMs, tuned for the management
// round-trip, not a bare TCP accept). This function:
//   - probes IMMEDIATELY after spawn (no initial sleep)
//   - uses TCP-only probing (deps.tcpProbe) — the cheapest true "is anything
//     listening on the port" signal, skipping the management-API round trip
//     entirely for readiness purposes (readiness just needs "the port is
//     open", not "the management API answered a real request")
//   - retries on a short backoff that grows from `initialDelayMs` to
//     `maxDelayMs`, rather than a flat interval
//   - is bounded by `deadlineMs` total, so a broken binary still can't spin
//     forever
//
// Clock/sleep are injected (RoutingProxyReadyDeps) so scripts/verify-routing-
// proxy.ts can assert the exact probe count/timing without any real delay.
// ---------------------------------------------------------------------------

export interface RoutingProxyReadyOptions {
  /** Per-probe TCP-connect timeout. Loopback accept/refuse is near-instant —
   *  this only needs to be long enough to not misreport a genuinely slow
   *  first probe as failure, not the 2000ms tuned for a real HTTP round trip. */
  probeTimeoutMs?: number
  /** Delay before the SECOND probe (the first fires immediately). */
  initialDelayMs?: number
  /** Upper bound the backoff grows to. */
  maxDelayMs?: number
  /** Multiplier applied to the delay after each failed probe. */
  backoffFactor?: number
  /** Total time budget across all probes. */
  deadlineMs?: number
}

export interface RoutingProxyReadyDeps {
  tcpProbe: HealthCheckDeps['tcpProbe']
  sleep: (ms: number) => Promise<void>
  now: () => number
}

export function defaultRoutingProxyReadyDeps(): RoutingProxyReadyDeps {
  return {
    tcpProbe: realTcpProbe,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now()
  }
}

const DEFAULT_READY_PROBE_TIMEOUT_MS = 200
const DEFAULT_READY_INITIAL_DELAY_MS = 50
const DEFAULT_READY_MAX_DELAY_MS = 500
const DEFAULT_READY_BACKOFF_FACTOR = 2
const DEFAULT_READY_DEADLINE_MS = 15_000

/**
 * Poll the loopback port with a fast, backing-off cadence until it accepts a
 * TCP connection (or the deadline elapses). Returns true as soon as the port
 * is reachable, false once the deadline is exhausted without success. Never
 * throws.
 */
export async function waitForRoutingProxyReady(
  baseUrl: string,
  options: RoutingProxyReadyOptions = {},
  deps: RoutingProxyReadyDeps = defaultRoutingProxyReadyDeps()
): Promise<boolean> {
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_READY_PROBE_TIMEOUT_MS
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_READY_INITIAL_DELAY_MS
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_READY_MAX_DELAY_MS
  const backoffFactor = options.backoffFactor ?? DEFAULT_READY_BACKOFF_FACTOR
  const deadlineMs = options.deadlineMs ?? DEFAULT_READY_DEADLINE_MS

  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return false
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  const deadline = deps.now() + deadlineMs

  let delay = initialDelayMs
  while (true) {
    const ok = await deps.tcpProbe(url.hostname, port, probeTimeoutMs)
    if (ok) return true
    if (deps.now() >= deadline) return false
    await deps.sleep(delay)
    delay = Math.min(delay * backoffFactor, maxDelayMs)
  }
}
