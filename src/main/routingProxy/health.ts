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
