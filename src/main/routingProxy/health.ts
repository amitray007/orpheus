import * as net from 'node:net'
import type { RoutingProxyRuntime } from '../../shared/types'
import { defaultListenerInspectionDeps, type ListeningProcess } from './inspection'
import type { RoutingProxySpawnAttempt } from './lifecycle'

export type HealthCheckResult = { healthy: true } | { healthy: false; reason: string }

export interface HealthCheckDeps {
  tcpProbe: (host: string, port: number, timeoutMs: number) => Promise<boolean>
  managementProbe: (
    baseUrl: string,
    managementSecret: string | null,
    timeoutMs: number
  ) => Promise<boolean>
}

export interface ManagedReadinessDeps {
  inspectListeners: (port: number) => Promise<ListeningProcess[]>
  managementProbe: (baseUrl: string, secret: string, timeoutMs: number) => Promise<boolean>
  sleep: (ms: number) => Promise<void>
  now: () => number
}

export interface RoutingProxyReadyOptions {
  probeTimeoutMs?: number
  initialDelayMs?: number
  maxDelayMs?: number
  backoffFactor?: number
  deadlineMs?: number
}

export interface RoutingProxyReadyDeps {
  tcpProbe: HealthCheckDeps['tcpProbe']
  sleep: (ms: number) => Promise<void>
  now: () => number
}

const DEFAULT_READY_PROBE_TIMEOUT_MS = 200
const DEFAULT_READY_INITIAL_DELAY_MS = 50
const DEFAULT_READY_MAX_DELAY_MS = 500
const DEFAULT_READY_BACKOFF_FACTOR = 2
const DEFAULT_READY_DEADLINE_MS = 15_000

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
  if (!managementSecret) return false
  try {
    const res = await fetch(new URL('/v0/management/auth-files', baseUrl), {
      method: 'GET',
      headers: { Authorization: `Bearer ${managementSecret}` },
      signal: AbortSignal.timeout(timeoutMs)
    })
    return res.status >= 200 && res.status < 300
  } catch {
    return false
  }
}

export function defaultHealthCheckDeps(): HealthCheckDeps {
  return { tcpProbe: realTcpProbe, managementProbe: realManagementProbe }
}

export function defaultManagedReadinessDeps(): ManagedReadinessDeps {
  return {
    inspectListeners: defaultListenerInspectionDeps().listListeners,
    managementProbe: (baseUrl, secret, timeoutMs) =>
      realManagementProbe(baseUrl, secret, timeoutMs),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now()
  }
}

export function defaultRoutingProxyReadyDeps(): RoutingProxyReadyDeps {
  return {
    tcpProbe: realTcpProbe,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now()
  }
}

function runtimeUrlAndPort(runtime: RoutingProxyRuntime): { url: string; port: number } | null {
  if (!runtime.url || runtime.port === null) return null
  return { url: runtime.url, port: runtime.port }
}

function ownershipFailure(
  attempt: RoutingProxySpawnAttempt,
  listeners: ListeningProcess[]
): string | null {
  if (!attempt.isAlive()) return 'spawned child exited'
  if (listeners.length === 0 || listeners[0]?.pid !== attempt.pid) {
    return 'listener is not the spawned child'
  }
  if (listeners.length !== 1) return 'listener ownership is ambiguous'
  return null
}

/**
 * Proves readiness of this specific spawn attempt. A listening port alone is
 * deliberately insufficient: it could belong to another local process.
 */
export async function waitForManagedRoutingProxyReady(
  runtime: RoutingProxyRuntime,
  attempt: RoutingProxySpawnAttempt,
  options: RoutingProxyReadyOptions = {},
  deps: ManagedReadinessDeps = defaultManagedReadinessDeps()
): Promise<HealthCheckResult> {
  const target = runtimeUrlAndPort(runtime)
  if (!target)
    return { healthy: false, reason: 'routing proxy runtime has no managed URL and port' }

  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_READY_PROBE_TIMEOUT_MS
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_READY_INITIAL_DELAY_MS
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_READY_MAX_DELAY_MS
  const backoffFactor = options.backoffFactor ?? DEFAULT_READY_BACKOFF_FACTOR
  const deadline = deps.now() + (options.deadlineMs ?? DEFAULT_READY_DEADLINE_MS)
  let delay = initialDelayMs

  while (true) {
    const listeners = await deps.inspectListeners(target.port)
    const ownerFailure = ownershipFailure(attempt, listeners)
    if (ownerFailure) return { healthy: false, reason: ownerFailure }
    const managementOk = await deps.managementProbe(
      target.url,
      attempt.managementSecret,
      probeTimeoutMs
    )
    if (managementOk) return { healthy: true }
    if (deps.now() >= deadline) {
      return { healthy: false, reason: 'management API did not return authenticated 2xx' }
    }
    await deps.sleep(delay)
    delay = Math.min(delay * backoffFactor, maxDelayMs)
  }
}

/** TCP is diagnostic only and must not be used as a routing health decision. */
export async function probeRoutingProxyTcpReachability(
  baseUrl: string,
  deps: Pick<HealthCheckDeps, 'tcpProbe'> = defaultHealthCheckDeps(),
  timeoutMs = 2000
): Promise<boolean> {
  try {
    const url = new URL(baseUrl)
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    return await deps.tcpProbe(url.hostname, port, timeoutMs)
  } catch {
    return false
  }
}

/** @deprecated Diagnostic compatibility helper; never use as a managed health gate. */
export async function waitForRoutingProxyTcpDiagnostic(
  baseUrl: string,
  options: RoutingProxyReadyOptions = {},
  deps: RoutingProxyReadyDeps = defaultRoutingProxyReadyDeps()
): Promise<boolean> {
  const timeoutMs = options.probeTimeoutMs ?? DEFAULT_READY_PROBE_TIMEOUT_MS
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_READY_INITIAL_DELAY_MS
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_READY_MAX_DELAY_MS
  const backoffFactor = options.backoffFactor ?? DEFAULT_READY_BACKOFF_FACTOR
  const deadline = deps.now() + (options.deadlineMs ?? DEFAULT_READY_DEADLINE_MS)
  let delay = initialDelayMs
  while (true) {
    if (await probeRoutingProxyTcpReachability(baseUrl, deps, timeoutMs)) return true
    if (deps.now() >= deadline) return false
    await deps.sleep(delay)
    delay = Math.min(delay * backoffFactor, maxDelayMs)
  }
}

export async function checkRoutingProxyHealth(
  runtime: RoutingProxyRuntime,
  attempt: RoutingProxySpawnAttempt,
  options?: RoutingProxyReadyOptions,
  deps?: ManagedReadinessDeps
): Promise<HealthCheckResult> {
  return waitForManagedRoutingProxyReady(runtime, attempt, options, deps)
}

export async function ensureHealthyForRouting(
  runtime: RoutingProxyRuntime,
  attempt: RoutingProxySpawnAttempt,
  options?: RoutingProxyReadyOptions,
  deps?: ManagedReadinessDeps
): Promise<void> {
  const result = await checkRoutingProxyHealth(runtime, attempt, options, deps)
  if (!result.healthy) throw new Error(`Routing proxy is not healthy (${result.reason}).`)
}
