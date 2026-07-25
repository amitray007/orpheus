import { createRequire } from 'node:module'
import type { AppUiState, RoutingProxyPortMode, RoutingProxyRuntime } from '../../shared/types'

declare const __ORPHEUS_MODE__: 'development' | 'production' | 'worktree'

const require = createRequire(import.meta.url)

export const AUTOMATIC_PORT_MIN = 18765
export const AUTOMATIC_PORT_MAX = 18799

export interface RoutingProxyVariantContext {
  mode: 'production' | 'development' | 'worktree'
}

type RoutingProxyPortState = Pick<
  AppUiState,
  'routingProxyPortMode' | 'routingProxyCustomPort' | 'routingProxyEffectivePort'
>

function defaultVariantContext(): RoutingProxyVariantContext {
  return { mode: __ORPHEUS_MODE__ }
}

export function getPreferredRoutingProxyPort(context: RoutingProxyVariantContext): number {
  if (context.mode === 'worktree') return 18767
  if (context.mode === 'development') return 18766
  return 18765
}

export function assertValidAutomaticRoutingProxyEffectivePort(port: number): number {
  if (!Number.isInteger(port) || port < AUTOMATIC_PORT_MIN || port > AUTOMATIC_PORT_MAX) {
    throw new Error(
      `uiState: routingProxyEffectivePort must be an integer between ${AUTOMATIC_PORT_MIN} and ${AUTOMATIC_PORT_MAX} or null`
    )
  }
  return port
}

export function automaticPortCandidates(
  effectivePort: number | null,
  preferredPort: number
): number[] {
  const candidates: number[] = []
  const add = (port: number): void => {
    if (
      Number.isInteger(port) &&
      port >= AUTOMATIC_PORT_MIN &&
      port <= AUTOMATIC_PORT_MAX &&
      !candidates.includes(port)
    ) {
      candidates.push(port)
    }
  }
  if (effectivePort !== null) add(effectivePort)
  add(preferredPort)
  for (let port = AUTOMATIC_PORT_MIN; port <= AUTOMATIC_PORT_MAX; port++) add(port)
  return candidates
}

function runtimeForEnvironment(url: string): RoutingProxyRuntime {
  const parsed = new URL(url)
  return {
    source: 'environment',
    url,
    host: parsed.hostname,
    port:
      parsed.port === '' ? Number(parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port),
    portConfigurationLocked: true
  }
}

function runtimeForPort(source: RoutingProxyPortMode, port: number): RoutingProxyRuntime {
  return {
    source,
    url: `http://127.0.0.1:${port}`,
    host: '127.0.0.1',
    port,
    portConfigurationLocked: false
  }
}

export function getRoutingProxyRuntime(state?: RoutingProxyPortState): RoutingProxyRuntime {
  const environmentUrl = process.env.ORPHEUS_ROUTING_PROXY_URL
  if (environmentUrl) return runtimeForEnvironment(environmentUrl)

  const current: RoutingProxyPortState =
    state ?? (require('../uiState') as { getAppUiState: () => AppUiState }).getAppUiState()
  if (current.routingProxyPortMode === 'custom') {
    const customPort = current.routingProxyCustomPort
    if (
      typeof customPort !== 'number' ||
      !Number.isInteger(customPort) ||
      customPort < 1024 ||
      customPort > 65535
    ) {
      throw new Error('Custom routing proxy port must be an integer between 1024 and 65535')
    }
    return runtimeForPort('custom', customPort)
  }
  if (current.routingProxyEffectivePort !== null) {
    const effectivePort = assertValidAutomaticRoutingProxyEffectivePort(
      current.routingProxyEffectivePort
    )
    return runtimeForPort('automatic', effectivePort)
  }
  return { source: 'automatic', url: null, host: null, port: null, portConfigurationLocked: false }
}

export function getCurrentRoutingProxyVariantContext(): RoutingProxyVariantContext {
  return defaultVariantContext()
}
