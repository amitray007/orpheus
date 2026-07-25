import { createRequire } from 'node:module'
import type { AppUiState, RoutingProxyPortMode, RoutingProxyRuntime } from '../../shared/types'
import {
  AUTOMATIC_PORT_MAX,
  AUTOMATIC_PORT_MIN,
  assertValidAutomaticRoutingProxyEffectivePort
} from './ports'

export {
  AUTOMATIC_PORT_MAX,
  AUTOMATIC_PORT_MIN,
  assertValidAutomaticRoutingProxyEffectivePort
} from './ports'

declare const __ORPHEUS_MODE__: 'development' | 'production' | 'worktree'

const require = createRequire(import.meta.url)

export interface RoutingProxyVariantContext {
  mode: 'production' | 'development' | 'worktree'
}

type RoutingProxyPortState = Pick<
  AppUiState,
  'routingProxyPortMode' | 'routingProxyCustomPort' | 'routingProxyEffectivePort'
>

function defaultVariantContext(): RoutingProxyVariantContext {
  // The Electron/Vite build replaces this constant. Keep the offline assertion
  // harness importable without fabricating a second environment mechanism.
  return { mode: typeof __ORPHEUS_MODE__ === 'undefined' ? 'development' : __ORPHEUS_MODE__ }
}

export function getPreferredRoutingProxyPort(context: RoutingProxyVariantContext): number {
  if (context.mode === 'worktree') return 18767
  if (context.mode === 'development') return 18766
  return 18765
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

export interface RoutingProxyEndpoint {
  url: string
  host: string
  port: number
}

/**
 * Parses the only endpoint shapes a managed routing proxy can bind and serve.
 * Callers retain the original URL for client routing while sharing one parsed
 * host/port interpretation for config, health, and diagnostics.
 */
export function parseRoutingProxyEndpoint(url: string): RoutingProxyEndpoint {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('must be a valid http: or https: URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('must use the http: or https: scheme')
  }
  return {
    url,
    host: parsed.hostname,
    port: parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port)
  }
}

function runtimeForEnvironment(url: string): RoutingProxyRuntime {
  const endpoint = parseRoutingProxyEndpoint(url)
  return {
    source: 'environment',
    ...endpoint,
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
