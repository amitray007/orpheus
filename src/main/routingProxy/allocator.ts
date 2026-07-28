import type { RoutingProxyRuntime } from '../../shared/types'
import type { ListenerInspectionDeps } from './inspection'
import {
  AUTOMATIC_PORT_MAX,
  AUTOMATIC_PORT_MIN,
  getCurrentRoutingProxyVariantContext,
  getPreferredRoutingProxyPort
} from './runtime'

export interface StartCandidateResult {
  ok: boolean
  reason?: string
  effectivePort?: number
}

export interface RoutingProxyAllocatorDeps {
  runtime: () => RoutingProxyRuntime
  candidates: (effectivePort: number | null, preferredPort: number) => number[]
  inspect: ListenerInspectionDeps
  startCandidate: (runtime: RoutingProxyRuntime) => Promise<StartCandidateResult>
}

/**
 * The persistence boundary: only a strict-ready Automatic allocation may
 * replace the durable preferred candidate. Explicit endpoint modes and every
 * failed/exhausted attempt intentionally retain the previous value.
 */
export function effectiveAutomaticPortToPersist(
  initialRuntime: RoutingProxyRuntime,
  result: StartCandidateResult
): number | null {
  if (initialRuntime.source !== 'automatic' || !result.ok || result.effectivePort === undefined) {
    return null
  }
  return result.effectivePort
}

function runtimeAtAutomaticPort(port: number): RoutingProxyRuntime {
  return {
    source: 'automatic',
    url: `http://127.0.0.1:${port}`,
    host: '127.0.0.1',
    port,
    portConfigurationLocked: false
  }
}

/**
 * Attempts the currently resolved endpoint. Automatic mode walks its supplied
 * candidate order; custom and environment modes remain deliberately strict.
 * Listener handling belongs to startCandidate, which owns the binary/config
 * identity needed to decide whether reclaiming an occupied port is safe.
 */
export async function startAtResolvedRoutingProxyPort(
  deps: RoutingProxyAllocatorDeps
): Promise<StartCandidateResult> {
  const initial = deps.runtime()
  if (initial.source !== 'automatic') return deps.startCandidate(initial)

  const effectivePort = initial.port
  const preferredPort = getPreferredRoutingProxyPort(getCurrentRoutingProxyVariantContext())
  const candidates = deps.candidates(effectivePort, preferredPort)
  let lastFailure: StartCandidateResult = {
    ok: false,
    reason: 'no automatic routing proxy ports available'
  }
  for (const port of candidates) {
    const result = await deps.startCandidate(runtimeAtAutomaticPort(port))
    if (result.ok) return { ...result, effectivePort: port }
    if (
      result.reason === 'start was superseded' ||
      result.reason?.includes('did not release port')
    ) {
      return result
    }
    lastFailure = result
  }
  return {
    ok: false,
    reason: `Automatic routing proxy ports ${AUTOMATIC_PORT_MIN}–${AUTOMATIC_PORT_MAX} exhausted: ${lastFailure.reason ?? 'unknown failure'}`
  }
}
