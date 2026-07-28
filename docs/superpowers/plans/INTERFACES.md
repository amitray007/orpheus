# Routing proxy port-allocation interfaces

This is the frozen contract for the routing-proxy port-allocation work. Later tasks may add implementation, but may not rename, widen, or replace these signatures without stopping and replanning.

## Shared contracts

```ts
export type RoutingProxyPortMode = 'automatic' | 'custom'
export type RoutingProxySource = 'environment' | 'custom' | 'automatic'
export type RoutingProxyPortConfiguration =
  | { mode: 'automatic' }
  | { mode: 'custom'; port: number }

export interface RoutingProxyRuntime {
  source: RoutingProxySource
  url: string | null
  host: string | null
  port: number | null
  portConfigurationLocked: boolean
}

export const AUTOMATIC_PORT_MIN = 18765
export const AUTOMATIC_PORT_MAX = 18799
export function getRoutingProxyRuntime(state?: Pick<AppUiState, 'routingProxyPortMode' | 'routingProxyCustomPort' | 'routingProxyEffectivePort'>): RoutingProxyRuntime
export function getPreferredRoutingProxyPort(context: RoutingProxyVariantContext): number
export function automaticPortCandidates(effectivePort: number | null, preferredPort: number): number[]
```

`RoutingProxyVariantContext` identifies the derived app variant as `production`, `development`, or `worktree`. Its production implementation is derived from app packaging/name/development/worktree state; tests inject it. Preferred ports are respectively `18765`, `18766`, and `18767`.

Automatic allocation is exclusively the inclusive range `18765–18799`. Custom ports must be integers in `1024–65535`. Selecting automatic normalizes `routingProxyCustomPort` to `null`; environment configuration is never persisted.

Endpoint resolution is current-state only, with strict precedence: non-empty `ORPHEUS_ROUTING_PROXY_URL`, Custom, then Automatic. Environment and Custom configurations never fall back. The environment URL is preserved byte-for-byte for the routed client while its parsed host and port are used for managed binding.

`RoutingProxySnapshot` includes `source`, `effectiveUrl`, `effectivePort`, `portMode`, `customPort`, and `portConfigurationLocked`. `portConfigurationLocked` only locks port selection when the environment URL is active; it never transfers lifecycle ownership.

## Task 2 listener inspection seam

```ts
export interface ListeningProcess {
  pid: number
  executablePath: string | null
  argv: string[] | null
}
export interface ListenerInspectionDeps {
  listListeners: (port: number) => Promise<ListeningProcess[]>
  signalProcess: (pid: number, signal: NodeJS.Signals) => void
  sleep: (ms: number) => Promise<void>
}
export function isSameVariantRoutingProxy(process: ListeningProcess, binary: string, config: string): boolean
export async function reclaimProvenOrphan(
  port: number, binary: string, config: string, deps: ListenerInspectionDeps
): Promise<{ reclaimed: boolean; killedPids: number[]; reason?: string }>
```

## Task 3 strict readiness seam

```ts
export interface RoutingProxySpawnAttempt {
  pid: number
  managementSecret: string
  isAlive: () => boolean
  terminate: () => void
}
export function startRoutingProxy(options: StartOptions): RoutingProxySpawnAttempt
export interface ManagedReadinessDeps {
  inspectListeners: (port: number) => Promise<ListeningProcess[]>
  managementProbe: (baseUrl: string, secret: string, timeoutMs: number) => Promise<boolean>
  sleep: (ms: number) => Promise<void>
  now: () => number
}
export async function waitForManagedRoutingProxyReady(
  runtime: RoutingProxyRuntime, attempt: RoutingProxySpawnAttempt, options?: RoutingProxyReadyOptions,
  deps?: ManagedReadinessDeps
): Promise<HealthCheckResult>
```

## Task 4 allocation seam

```ts
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
export async function startAtResolvedRoutingProxyPort(deps: RoutingProxyAllocatorDeps): Promise<StartCandidateResult>
export async function setPortConfiguration(
  request: RoutingProxyPortConfiguration
): Promise<RoutingProxySnapshot>
```

## Task 5 IPC seam

```ts
'routingProxy:setPortConfiguration': {
  req: [{ mode: 'automatic' } | { mode: 'custom'; port: number }]
  res: RoutingProxySnapshot
}
```

The existing `routingProxy:snapshot` push channel remains the only snapshot push channel.
