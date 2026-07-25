# Routing Proxy Persistent Port Allocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Orpheus app variant a durable, collision-safe managed routing-proxy port while preserving strict ownership, authenticated readiness, and the full environment override URL.

**Architecture:** Freeze shared persistence and runtime-resolution contracts before implementation fan-out. Keep endpoint selection, candidate allocation, macOS listener/process evidence, and strict readiness in focused `routingProxy/` modules; `manager.ts` remains the orchestration façade that uses those contracts for every lifecycle path. The renderer receives a complete snapshot through existing typed IPC and never reconstructs endpoint defaults or environment state itself.

**Tech Stack:** TypeScript, Electron main/preload/React renderer, `better-sqlite3`, Bun, macOS `lsof` and `ps`, existing offline assertion scripts.

## Global Constraints

- Work serially in the shared worktree: one fresh Sonnet builder per task, then review and integrate its result before dispatching the next task. The top-level agent only orchestrates, reviews, and integrates; it never writes feature code.
- Task 1 is the stable-interface foundation. It creates `docs/superpowers/plans/INTERFACES.md`; do not start Tasks 2–7 until its contracts are accepted unchanged.
- Do not add a general test runner. Extend `scripts/verify-routing-proxy.ts` and `scripts/verify-migration-engine.ts` only.
- Automatic loopback TCP allocation is inclusive `18765–18799`; preferred ports are Production `18765`, Development `18766`, and worktree `18767`.
- Custom ports are integers `1024–65535`; automatic allocation must never select port `0`, an ephemeral port, or a port outside the defined range.
- Endpoint precedence is non-empty `ORPHEUS_ROUTING_PROXY_URL`, then Custom, then Automatic. Resolve it afresh for every operation; never cache an environment-derived URL.
- `ORPHEUS_ROUTING_PROXY_URL` remains a strict managed-child override. Preserve its entire URL verbatim for `ANTHROPIC_BASE_URL`, use its parsed host/port for config and management, never persist it, and lock only port-selection UI controls.
- Keep `MANAGEMENT_PASSWORD` and the client `ANTHROPIC_AUTH_TOKEN` in memory and child environment only. Never add either to generated config, snapshot, log, test fixture output, or database state.
- Never kill, signal, adopt, or treat as healthy an unrelated, uninspectable, foreign-variant, foreign-worktree, or unknown listener. Reclaim requires exact executable-path and `-config <exact configPath>` evidence.
- A managed start/health/routed-workspace gate is healthy only when the spawned child is alive, it is the sole listener PID, and an authenticated management request returns 2xx. TCP reachability may remain diagnostic only.
- All runtime failures are explicit: invalid/occupied environment and Custom addresses never fall back; only Automatic advances candidates. Preserve a prior automatic effective port if all candidates fail.
- Keep existing supervision constants and behavior: `RESPAWN_BASE_DELAY_MS = 1000`, `RESPAWN_MAX_DELAY_MS = 30_000`, `MAX_CONSECUTIVE_RESPAWN_FAILURES = 5`, `HEALTH_WATCHDOG_INTERVAL_MS = 30_000`.
- Use typed `handle()` IPC registration, update `InvokeChannelMap` first, and expose through the typed preload helper. Do not use raw `ipcMain.handle`.
- Use conventional commits with no `Co-Authored-By` trailer. Do not build production locally; final manual verification uses `bun run build:unpack` and `open -g` only.

---

## File Responsibility Map

| File | Responsibility |
| --- | --- |
| `docs/superpowers/plans/INTERFACES.md` | Frozen contracts from the foundation task; later builders consume but do not redefine them. |
| `src/shared/types.ts` | Shared port-mode, configuration request, app state, and renderer snapshot types. |
| `src/main/db/schema.ts` | Declarative `app_ui_state` columns/defaults/check constraint. |
| `src/main/uiState.ts` | DB row mapping, patch validation, and SQL column mapping for durable port settings. |
| `src/main/routingProxy/runtime.ts` | Current endpoint precedence, URL parsing, variant preference, and candidate sequence. |
| `src/main/modelRouting.ts` | Compatibility URL accessor and routed launch env backed by the runtime resolver. |
| `src/main/routingProxy/inspection.ts` | Injected macOS listener/PID/executable/argv inspection and exact ownership predicates. |
| `src/main/routingProxy/allocator.ts` | Automatic candidate loop and strict explicit-mode attempt selection. |
| `src/main/routingProxy/orphan.ts` | Safe reclaim of only a proven same-variant stale listener. |
| `src/main/routingProxy/lifecycle.ts` | Spawned attempt handle/PID, fresh in-memory secrets, and targeted attempt termination. |
| `src/main/routingProxy/health.ts` | Strict authenticated/PID ownership readiness and managed health; separately named diagnostic TCP probe. |
| `src/main/routingProxy/manager.ts` | One mode-aware start protocol for enable/restart/reconcile/supervisor/watchdog/config/OAuth/routing gate. |
| `src/main/routingProxy/supervisor.ts` | Existing pure backoff/watchdog policy, consuming the manager’s strict start/health callbacks. |
| `src/shared/ipc.ts`, `src/main/ipc/routingProxy.ts`, `src/preload/index.ts` | Typed `setPortConfiguration` request end-to-end. |
| `src/renderer/src/components/dashboard/settings/OrpheusModelRoutingSection.tsx` | Existing Model Routing UI extended with snapshot-driven port configuration/status. |
| `scripts/verify-routing-proxy.ts` | Offline regression tests for resolution, allocator, ownership, readiness, lifecycle integration, and supervision. |
| `scripts/verify-migration-engine.ts` | Fresh-schema/default/migration-convergence assertions for durable settings. |

## Integration Order

1. Foundation contracts, persistence, resolver, and frozen interface artifact.
2. macOS inspection plus safe orphan proof.
3. Lifecycle attempt identity plus strict managed readiness/health.
4. Allocator and manager/supervisor lifecycle integration.
5. Typed IPC and existing settings section.
6. Serial final integration, full checks, background Dev build, and safe dual-variant validation.

## Task 1: Freeze Persistence and Runtime Interfaces

**Files:**
- Create: `docs/superpowers/plans/INTERFACES.md`
- Create: `src/main/routingProxy/runtime.ts`
- Modify: `src/shared/types.ts:359-374, 2353-2371`
- Modify: `src/main/db/schema.ts:560-571`
- Modify: `src/main/uiState.ts:28-140, 143-273, 402-635`
- Modify: `src/main/modelRouting.ts:28-38, 97-110`
- Modify: `scripts/verify-migration-engine.ts`
- Modify: `scripts/verify-routing-proxy.ts`

**Interfaces:**
- Produces the frozen shared contracts used unchanged by all later tasks:

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

- `RoutingProxySnapshot` gains `source`, `effectiveUrl`, `effectivePort`, `portMode`, `customPort`, and `portConfigurationLocked`.

- [ ] **Step 1: Write migration and resolver assertions first.** Add harness cases for a fresh `app_ui_state` table with `routing_proxy_port_mode = 'automatic'`, Custom/effective `NULL`, a legacy row converging without losing existing fields, and an idempotent second migration plan. Add proxy-harness assertions for preferred production/development/worktree ports, deduplicated persisted-first candidates, environment > custom > automatic precedence, and exact override preservation.

```ts
assert.deepEqual(automaticPortCandidates(18770, 18766).slice(0, 3), [18770, 18766, 18765])
assert.deepEqual(getRoutingProxyRuntime({
  routingProxyPortMode: 'custom', routingProxyCustomPort: 4567, routingProxyEffectivePort: null
}), {
  source: 'custom', url: 'http://127.0.0.1:4567', host: '127.0.0.1', port: 4567,
  portConfigurationLocked: false
})
```

- [ ] **Step 2: Run the tests and confirm they fail for missing columns/contracts.**

Run: `bun run test:db && bun run test:proxy`

Expected: FAIL with missing `routing_proxy_port_mode`/runtime exports or assertions still observing fixed `18765` behavior.

- [ ] **Step 3: Add only the declarative durable setting surface.** Add schema columns exactly as `routing_proxy_port_mode TEXT NOT NULL DEFAULT 'automatic' CHECK (...)`, nullable `routing_proxy_custom_port`, and nullable `routing_proxy_effective_port`. Extend `AppUiStateRow`, `AppUiState`, row mapping, validation, and `columnMap`; accept Custom only when mode is `custom`, require an integer `1024–65535`, and normalize automatic mode to a null custom port. Do not put environment state in SQLite.

```ts
routing_proxy_port_mode: {
  type: 'TEXT', notNull: true, default: "'automatic'",
  check: enumCheck('routing_proxy_port_mode', ['automatic', 'custom'])
},
routing_proxy_custom_port: 'INTEGER',
routing_proxy_effective_port: 'INTEGER'
```

- [ ] **Step 4: Add the single current runtime resolver.** Make `runtime.ts` read current UI state at invocation when no state is injected, use a non-empty environment string first, validate with `new URL`, preserve the original override string in `url`, parse its host/explicit-or-protocol-default port, resolve Custom to loopback, and return Automatic with `null` URL/host/port before allocation. Detect app variant through an injected/testable context derived from packaged app name/development/worktree state; do not hardcode machine paths.

- [ ] **Step 5: Redirect compatibility consumers.** Make `getRoutingProxyUrl()` delegate to `getRoutingProxyRuntime()` and throw a clear no-effective-automatic-port configuration error when `url === null`. Ensure `computeRoutingEnv()` reads this accessor at launch and retains the full environment string byte-for-byte.

- [ ] **Step 6: Write `INTERFACES.md` as the contract freeze.** Include the exact types above, snapshot additions, port validation constants, strict-mode rule, and the Task 2–5 seams below. State: later tasks may add implementation but may not rename, widen, or replace these signatures without stopping and replanning.

- [ ] **Step 7: Run focused checks.**

Run: `bun run test:db && bun run test:proxy && bun run typecheck`

Expected: PASS; database defaults/convergence and runtime resolution assertions pass.

- [ ] **Step 8: Focused review gate.** Verify schema uses only the declarative engine, no environment value reaches `updateAppUiState`, the full override survives `computeRoutingEnv`, and no resolver caches a URL.

- [ ] **Step 9: Commit the foundation.**

```bash
git add docs/superpowers/plans/INTERFACES.md src/shared/types.ts src/main/db/schema.ts src/main/uiState.ts src/main/routingProxy/runtime.ts src/main/modelRouting.ts scripts/verify-migration-engine.ts scripts/verify-routing-proxy.ts
git commit -m "feat(routing-proxy): add persistent port contracts"
```

## Task 2: Add Inspectable Listener Ownership and Safe Reclaim

**Files:**
- Create: `src/main/routingProxy/inspection.ts`
- Modify: `src/main/routingProxy/orphan.ts`
- Modify: `scripts/verify-routing-proxy.ts`
- Read: `docs/superpowers/plans/INTERFACES.md`

**Interfaces:**
- Consumes `RoutingProxyRuntime` and installed variant `binaryPath(version)`/`configPath(version)`.
- Produces:

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
export function isSameVariantRoutingProxy(
  process: ListeningProcess, binary: string, config: string
): boolean
export async function reclaimProvenOrphan(
  port: number, binary: string, config: string, deps: ListenerInspectionDeps
): Promise<{ reclaimed: boolean; killedPids: number[]; reason?: string }>
```

- [ ] **Step 1: Replace unsafe reclaim tests with proof tests.** Remove expectations that every listener PID is killed. Add fakes for unknown executable, null argv, unrelated executable, exact binary with wrong config, another variant’s config, multiple owners, and exact same-variant stale listener.

```ts
assert.equal(isSameVariantRoutingProxy(
  { pid: 41, executablePath: binary, argv: [binary, '-config', config] }, binary, config
), true)
assert.deepEqual(killedPids, [41])
assert.deepEqual(unrelatedKilledPids, [])
```

- [ ] **Step 2: Run the focused harness and confirm unsafe legacy behavior fails.**

Run: `bun run test:proxy`

Expected: FAIL because current orphan logic calls `killPid` for every listener and has no executable/config evidence.

- [ ] **Step 3: Implement a macOS inspection seam.** Use `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fp` to obtain listener PIDs, `ps -p <pid> -o command=` for command evidence, and `lsof -p <pid>` to derive executable-path evidence. Parse failures as `null` evidence, never guesses. Keep all shell details behind `inspection.ts` and inject fakes into the harness.

- [ ] **Step 4: Make reclaim proof-only.** Reclaim exactly one listener only when it has the exact expected executable path and an argv token `-config` immediately followed by the exact expected config path. Reinspect after signalling and report not reclaimed if it remains bound. For Custom mode, manager callers will not invoke reclaim; environment/Automatic may invoke only this proof path.

- [ ] **Step 5: Run focused passing checks.**

Run: `bun run test:proxy && bun run typecheck`

Expected: PASS; only the proven same-variant orphan is signalled, and every unknown/foreign listener remains untouched.

- [ ] **Step 6: Focused review gate.** Confirm no `killPid` loop remains, process identity requires both predicates, and no code treats TCP reachability as proof of ownership.

- [ ] **Step 7: Commit.**

```bash
git add src/main/routingProxy/inspection.ts src/main/routingProxy/orphan.ts scripts/verify-routing-proxy.ts
git commit -m "fix(routing-proxy): reclaim only proven variant orphans"
```

## Task 3: Prove Spawn Ownership and Authenticated Readiness

**Files:**
- Modify: `src/main/routingProxy/lifecycle.ts`
- Modify: `src/main/routingProxy/health.ts`
- Modify: `src/main/routingProxy/orphan.ts`
- Modify: `scripts/verify-routing-proxy.ts`
- Read: `docs/superpowers/plans/INTERFACES.md`, `src/main/routingProxy/inspection.ts`

**Interfaces:**
- Produces the frozen strict proof seam:

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

- [ ] **Step 1: Write strict-readiness regressions.** Cover success only for an alive spawned PID as the sole listener plus 2xx; reject TCP-only, 401, 403, 404, 500, timeout, malformed/false management result, missing owner, foreign owner, two owner PIDs, and exited child. Preserve a separately named diagnostic TCP probe test that cannot return managed healthy.

```ts
const result = await waitForManagedRoutingProxyReady(runtime, spawnedAttempt, {}, {
  inspectListeners: async () => [{ pid: 999, executablePath: binary, argv: [] }],
  managementProbe: async () => true, sleep: async () => {}, now: () => 0
})
assert.deepEqual(result, { healthy: false, reason: 'listener is not the spawned child' })
```

- [ ] **Step 2: Run the harness and confirm failure.**

Run: `bun run test:proxy`

Expected: FAIL because current readiness is TCP-only and health accepts `res.status < 500` with TCP fallback.

- [ ] **Step 3: Evolve lifecycle attempt identity.** Return PID, management secret, `isAlive`, and a terminator tied to the `ChildProcess` spawned by that invocation. Keep module-level normal stop for the current owned child, but an allocation failure must terminate only its returned attempt handle. Continue generating fresh secrets and never log/persist them.

- [ ] **Step 4: Implement strict management and ownership polling.** Make the real management probe return true only for 2xx. Poll boundedly with the existing backoff timing, but on each success candidate require `attempt.isAlive()`, exactly one listener PID equal to `attempt.pid`, and authenticated 2xx. Leave raw TCP as `probeRoutingProxyTcpReachability()` or equivalent diagnostic API that no manager/supervisor/gate calls for health.

- [ ] **Step 5: Redirect `checkRoutingProxyHealth` and `ensureHealthyForRouting`.** Require a current runtime and owned attempt/PID evidence plus management secret; return clear reasons for each proof failure. Do not silently downgrade to TCP.

- [ ] **Step 6: Run passing checks.**

Run: `bun run test:proxy && bun run typecheck`

Expected: PASS; 2xx/sole-PID path succeeds and all weak/foreign signals fail.

- [ ] **Step 7: Focused review gate.** Inspect every `healthy: true` branch: it must require owned child + sole listener + authenticated 2xx. Verify the only process terminator accepts a captured attempt/child handle, not a discovered arbitrary PID.

- [ ] **Step 8: Commit.**

```bash
git add src/main/routingProxy/lifecycle.ts src/main/routingProxy/health.ts src/main/routingProxy/orphan.ts scripts/verify-routing-proxy.ts
git commit -m "fix(routing-proxy): require owned authenticated readiness"
```

## Task 4: Allocate Ports and Integrate All Managed Lifecycle Paths

**Files:**
- Create: `src/main/routingProxy/allocator.ts`
- Modify: `src/main/routingProxy/manager.ts:96-129, 332-415, 750-1034, 1119-1271`
- Modify: `src/main/routingProxy/supervisor.ts`
- Modify: `scripts/verify-routing-proxy.ts`
- Read: `docs/superpowers/plans/INTERFACES.md`

**Interfaces:**
- Consumes frozen runtime/inspection/lifecycle/readiness interfaces.
- Produces:

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

- [ ] **Step 1: Add allocator/manager integration tests.** Verify Automatic tries persisted effective first, then preferred, then ascending range; skips an occupied foreign listener; reclaims only a proof-safe stale Automatic/environment orphan; retries next Automatic candidate after a bind TOCTOU failure; persists only proof-success port; and retains the old persisted effective port after total exhaustion.

```ts
assert.deepEqual(attemptedPorts, [18770, 18766, 18765])
assert.equal(updatedState.routingProxyEffectivePort, 18765)
assert.match(snapshot.error ?? '', /18765–18799.*bind EADDRINUSE/)
```

Also cover Custom invalid/occupied failure with no reclaim/no alternate attempt and environment invalid/occupied/failed-proof with no fallback. Cover changing Custom while enabled: stop old owned child, try just new port, leave stopped on failure. Cover selecting Automatic clearing Custom while retaining prior automatic effective port.

- [ ] **Step 2: Run the focused tests and confirm they fail.**

Run: `bun run test:proxy`

Expected: FAIL because `manager.ts` still parses a fixed URL independently, reclaims indiscriminately before start, persists no effective port, and only TCP-checks readiness.

- [ ] **Step 3: Implement candidate selection without endpoint drift.** `allocator.ts` obtains fresh runtime at attempt time. Automatic creates a candidate-specific runtime URL using loopback and tries only the prescribed deduplicated order. Custom/environment each make one strict attempt. Config rendering receives that same runtime’s parsed host/port; routed clients continue receiving that runtime’s unmodified URL.

- [ ] **Step 4: Centralize manager start protocol.** Replace `proxyHost()`, `proxyPort()`, direct `getRoutingProxyUrl()` start/reclaim use, and TCP readiness with one internal start operation: resolve candidate; inspect/reclaim only where policy permits; render config; spawn; strict proof; terminate failed attempt; persist effective port only after proof; start auth refresh/watchdog only after success. Ensure install/config-regeneration, auth-files/model-cache operations, OAuth methods, and `ensureHealthyForRouting()` read a fresh resolver result rather than old captured URL.

- [ ] **Step 5: Route every lifecycle entry through it.** Use this protocol for initial enable, `restart`, `reconcileRoutingProxy`, boot/resume/unlock reconcile, unexpected-exit supervisor retry, and watchdog recovery. Do not add a second start path. Update snapshots from current runtime after each state change, including `source`, effective URL/port, mode, custom value, and lock flag.

- [ ] **Step 6: Preserve supervisor policy while strengthening callbacks.** Keep exported constants and pure decision APIs unchanged. Bind `startProxy` to the unified start operation and `checkHealth` to strict owned health. Automatic respawn starts at persisted port and may reallocate; Custom/environment errors count as failed respawns and never select another port.

- [ ] **Step 7: Run passing checks.**

Run: `bun run test:proxy && bun run test:db && bun run typecheck`

Expected: PASS; allocation, strict modes, no unsafe reclaim, and supervisor reallocation tests pass.

- [ ] **Step 8: Focused review gate.** Search `manager.ts` for independent `new URL(getRoutingProxyUrl())`, `proxyHost`, `proxyPort`, TCP-only readiness, and blanket orphan calls; none may remain. Confirm every port persistence write happens after strict proof.

- [ ] **Step 9: Commit.**

```bash
git add src/main/routingProxy/allocator.ts src/main/routingProxy/manager.ts src/main/routingProxy/supervisor.ts scripts/verify-routing-proxy.ts
git commit -m "feat(routing-proxy): allocate and supervise managed ports"
```

## Task 5: Add Typed Port-Configuration IPC and Snapshot-Driven UI

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `src/main/ipc/routingProxy.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/components/dashboard/settings/OrpheusModelRoutingSection.tsx`
- Modify: `scripts/verify-routing-proxy.ts`
- Read: `docs/superpowers/plans/INTERFACES.md`

**Interfaces:**
- Consumes:

```ts
export type RoutingProxyPortConfiguration =
  | { mode: 'automatic' }
  | { mode: 'custom'; port: number }
export async function setPortConfiguration(
  request: RoutingProxyPortConfiguration
): Promise<RoutingProxySnapshot>
```

- Produces typed channel:

```ts
'routingProxy:setPortConfiguration': {
  req: [{ mode: 'automatic' } | { mode: 'custom'; port: number }]
  res: RoutingProxySnapshot
}
```

- [ ] **Step 1: Add compile-facing IPC and UI behavior tests.** Extend the proxy harness/static assertions to require the channel map, `handle('routingProxy:setPortConfiguration', ...)`, typed preload method, and the section’s use of `snapshot.portConfigurationLocked`, `effectiveUrl`, and `effectivePort`. Add an interaction-level pure assertion/fixture for Custom request payload `{ mode: 'custom', port: 18777 }` and Automatic request `{ mode: 'automatic' }`.

- [ ] **Step 2: Run checks to establish failure.**

Run: `bun run test:proxy && bun run typecheck`

Expected: FAIL because the channel/preload method and snapshot-driven port controls do not exist.

- [ ] **Step 3: Wire the typed request end-to-end.** Add the exact map entry before handler registration, call manager `setPortConfiguration` through `handle()`, and expose preload `setPortConfiguration(configuration)` through generic `invoke()`. Reuse existing `routingProxy:snapshot`; add no push channel.

- [ ] **Step 4: Extend only the existing Model Routing section.** Add Automatic/Custom control and a numeric Custom input. Submit the typed request, keep an in-flight UI guard, and update local state from returned/pushed snapshot. Render selected mode and exact snapshot `effectiveUrl`/`effectivePort`, or exactly `No effective port allocated` before Automatic success. Render snapshot errors without guessing defaults.

```tsx
{snapshot.portConfigurationLocked ? (
  <p>Port controlled by ORPHEUS_ROUTING_PROXY_URL</p>
) : (
  <button onClick={() => void applyPortMode('automatic')}>Automatic</button>
)}
```

- [ ] **Step 5: Implement environment locked display precisely.** When locked, show exactly `Port controlled by ORPHEUS_ROUTING_PROXY_URL`, the exact effective URL, and copy that the environment supplies URL/host/port binding while Orpheus still manages lifecycle. Disable mode/custom controls only; leave enable, restart, status, install, and maintenance controls usable.

- [ ] **Step 6: Run passing checks.**

Run: `bun run test:proxy && bun run typecheck && bun run check`

Expected: PASS; IPC typing and renderer compilation succeed with no lint/architecture/duplication regression.

- [ ] **Step 7: Focused review gate.** Verify no raw IPC, no renderer `process.env`, no renderer default-port inference, no extra settings surface, and exact locked-mode notice text.

- [ ] **Step 8: Commit.**

```bash
git add src/shared/ipc.ts src/main/ipc/routingProxy.ts src/preload/index.ts src/renderer/src/components/dashboard/settings/OrpheusModelRoutingSection.tsx scripts/verify-routing-proxy.ts
git commit -m "feat(routing-proxy): configure managed proxy ports"
```

## Task 6: Serial Final Integration and Real Dev Verification

**Files:**
- Modify only files required by concrete failures found in this task.
- Read: `docs/superpowers/plans/INTERFACES.md`, all Task 1–5 changed files.

**Interfaces:**
- Consumes all frozen interfaces. Produces no interface changes; any contract inconsistency stops this task and requires re-planning rather than an ad hoc interface rewrite.

- [ ] **Step 1: Run all offline and static gates.**

Run: `bun run test:db && bun run test:proxy && bun run typecheck && bun run check`

Expected: PASS.

- [ ] **Step 2: Perform a serial cross-path review.** Trace each of initial enable, manual restart, reconcile, process exit respawn, watchdog restart, configuration regeneration, OAuth operation, and routed workspace mount. For each, verify fresh runtime resolution, strict managed health where health is asserted, and no Custom/environment fallback.

- [ ] **Step 3: Build and launch only the background Dev variant.**

Run:

```bash
osascript -e 'tell application "Orpheus Dev" to quit' 2>/dev/null; sleep 1
pkill -x "Orpheus Dev" 2>/dev/null; true
bun run build:unpack
open -g "/Applications/Orpheus Dev.app"
pgrep -lf "Orpheus Dev.app/Contents/MacOS/Orpheus Dev" | head -1
```

Expected: `build:unpack` succeeds and `pgrep` prints the Dev executable. Never use `bun run dev`, `build:mac`, an `ORPHEUS_ALLOW_PROD_INSTALL` override, or foreground `open`.

- [ ] **Step 4: Manually verify Settings > Orpheus > Model Routing in Dev.** Verify Automatic begins with `No effective port allocated` when never started, then displays the actual allocated endpoint after enabling. Select Custom with a free permitted port and verify it displays after strict start. Select an occupied Custom port and verify a concrete error, stopped proxy, unchanged stored effective port, and no automatic fallback.

- [ ] **Step 5: Safely validate environment override and dual-variant ownership.** Launch Dev with a non-empty valid `ORPHEUS_ROUTING_PROXY_URL` only in a controlled local test environment; verify exact locked notice, exact full URL display, and managed lifecycle on parsed binding. If Production Orpheus is already installed and neither proxy is active, enable Production and Dev serially, inspect their listening PIDs/config evidence with `lsof`/`ps`, and verify separate preferred/effective ports. Do not kill either process except through its owning app’s normal disable/quit control; if the setup cannot be safely established, record it as not run rather than creating/killing listeners.

- [ ] **Step 6: Final focused review gate.** Check `git diff --check`, inspect only this task’s concrete fixes, and confirm no secret literals, generated binaries, database files, or production artifacts are staged.

- [ ] **Step 7: Commit any verified final correction only if needed.**

```bash
git add <only-files-fixed-by-final-verification>
git commit -m "fix(routing-proxy): complete port allocation integration"
```

If no correction was necessary, make no empty commit.

## Final Acceptance Matrix

- [ ] Fresh and migrated databases have automatic/null/null port settings and converge idempotently.
- [ ] Production/Dev/worktree preferred ports and Automatic candidate ordering are proven offline.
- [ ] Environment URL has exact client-string preservation, parsed config binding, strict managed lifecycle, and locked port UI only.
- [ ] Custom and environment failures never select another port; Custom changes stop old owned child and leave it stopped when the new attempt fails.
- [ ] Automatic uses persisted port first, safely reclaims only exact same-variant stale children, handles bind races, persists only strict proof successes, and preserves old effective port after total failure.
- [ ] TCP-only, 4xx, 5xx, missing/multiple/foreign listener, timeout, malformed management response, and exited child cannot establish managed readiness/health/routed gating.
- [ ] Supervisor keeps current backoff/give-up constants; Automatic can reallocate, explicit modes do not.
- [ ] IPC/preload/renderer use the exact request/snapshot contracts and only existing settings section/push channel.
- [ ] `bun run test:db`, `bun run test:proxy`, `bun run typecheck`, `bun run check`, and the Dev build/background launch pass.
