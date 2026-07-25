# Routing proxy persistent port allocation — design

**Status:** approved design, ready for implementation
**Date:** 2026-07-25

## Problem

The managed CLIProxyAPI routing proxy has one fixed URL,
`http://127.0.0.1:18765`. That collides when production Orpheus, Orpheus Dev,
and a worktree build run on the same Mac. It also makes a stale or unrelated
listener indistinguishable from a proxy that this app instance started.

Port selection must be durable per app variant, strict when a user or the
environment explicitly configures an endpoint, and safe when a port is already
in use. `ORPHEUS_ROUTING_PROXY_URL` remains a managed-proxy endpoint override:
it controls the child binding/config address and routed client URL, but does not
transfer lifecycle ownership outside Orpheus. Every routing consumer must use
the same current URL: generated proxy configuration, management requests,
readiness, routing health, and the `ANTHROPIC_BASE_URL` injected into a routed
workspace.

## Decisions

### Variant defaults and allocation range

The preferred automatic port is determined by the running app variant:

| Variant | Preferred port |
| --- | ---: |
| Production (`Orpheus.app`) | 18765 |
| Development (`Orpheus Dev.app`) | 18766 |
| Worktree build | 18767 |

Automatic allocation uses only the inclusive loopback TCP range **18765–18799**.
That range is the complete automatic candidate set; it contains the three
variant defaults, is above privileged ports, and never permits port `0`, a
negative/non-integer value, a port above `65535`, or a port outside the range.
No system-reserved or arbitrary ephemeral port is selected automatically.

Each variant already owns a separate Electron `userData` directory and SQLite
database. The allocator is therefore persisted in that variant's existing
`app_ui_state` row: a production allocation cannot overwrite a development or
worktree allocation.

### Persisted setting model

Add these `AppUiState` fields and corresponding database columns:

```ts
routingProxyPortMode: 'automatic' | 'custom'
routingProxyCustomPort: number | null
routingProxyEffectivePort: number | null
```

Their database defaults are `'automatic'`, `NULL`, and `NULL`, respectively.
`routingProxyCustomPort` is non-null only in `custom` mode. An automatic mode
with no successfully allocated port has `routingProxyEffectivePort === null`.
A custom mode has `routingProxyEffectivePort === routingProxyCustomPort` only
after a child has successfully bound and passed authenticated management
health; before then it remains `null`.

The externally supplied `ORPHEUS_ROUTING_PROXY_URL` is not stored and does not
mutate any of these fields. Its complete URL is retained verbatim, including
scheme, host, explicit port, path, and any valid URL components already
supported by the current override behavior.

### URL precedence and single runtime source

The resolved routing endpoint has one precedence order, evaluated at every
operation rather than captured from a prior environment composition:

1. A non-empty `ORPHEUS_ROUTING_PROXY_URL` is the strict, highest-precedence
   effective URL and managed child binding address. Its port configuration is
   read-only in the UI, but Orpheus still owns the child lifecycle.
2. Otherwise, `routingProxyPortMode === 'custom'` resolves to
   `http://127.0.0.1:<routingProxyCustomPort>`.
3. Otherwise, automatic mode resolves to
   `http://127.0.0.1:<routingProxyEffectivePort>` after allocation. Before
   allocation it has no usable URL.

Replace the fixed default resolver with a single main-process runtime source of
truth, for example `getRoutingProxyRuntime(): RoutingProxyRuntime`, where:

```ts
export type RoutingProxySource = 'environment' | 'custom' | 'automatic'

export interface RoutingProxyRuntime {
  source: RoutingProxySource
  url: string | null
  host: string | null
  port: number | null
  portConfigurationLocked: boolean
}
```

`getRoutingProxyUrl()` remains the compatibility accessor for callers that
require a URL. It delegates to that runtime source and throws a clear
configuration error if automatic mode has not yet allocated a port. It must
never return a stale value from a cached environment merge.

`modelRouting.computeRoutingEnv`, routing-proxy config generation, lifecycle
start/restart/reconcile, management API clients, readiness, health checks, and
supervisor callbacks all obtain their endpoint from this one runtime source.
Consequently, generated `config.yaml` always binds the host/port parsed from the
same runtime URL that `modelRouting.computeRoutingEnv` emits unchanged as
`ANTHROPIC_BASE_URL`; neither consumer can drift to a stale prior value.

### Automatic allocation algorithm

Automatic allocation runs before every managed child spawn, including initial
enable, manual restart, resume/unlock reconciliation, unexpected-exit respawn,
and watchdog recovery.

1. Read the automatic setting and variant preferred port.
2. Build a de-duplicated candidate sequence: the persisted valid effective port
   first when present; then the preferred port if different; then every other
   port in ascending order from 18765 through 18799. The stored port is thus
   tried first across restarts.
3. For each candidate, determine whether it is free. If it is occupied, inspect
   its listener ownership before proceeding:
   - Reclaim only a stale CLIProxyAPI process for which **both** the executable
     path equals this variant's installed `binaryPath(version)` and the command
     line contains `-config` followed by exactly this variant's
     `configPath(version)`.
   - Treat every other listener as occupied: an unrelated process, an unknown
     process, a listener whose PID cannot be inspected, and a proxy belonging
     to production, development, or a different worktree. Never signal or kill
     those processes.
   - After reclaiming a proven same-variant stale proxy, verify the candidate is
     no longer listening before attempting spawn. If it remains occupied, move
     to the next candidate.
4. Render config for that candidate, spawn the managed child, and perform the
   ownership-and-readiness proof below.
5. Only after the proof succeeds, persist that candidate as
   `routingProxyEffectivePort`, publish a `running` snapshot, and begin auth
   refresh and watchdog work.
6. If spawn, bind, process ownership, or authenticated management health fails,
   terminate only the child handle spawned by this attempt, do not persist the
   port, and continue with the next candidate. This handles the time-of-check /
   time-of-use bind race.
7. If all 35 candidates fail, leave the prior persisted effective port unchanged,
   set snapshot status to `error`, and report that no automatic port in
   `18765–18799` could be started. The error includes the attempted range and
   last concrete failure reason.

An automatic port is persisted only after the child spawned for that candidate
has proven ownership and authenticated management health. A port that was
merely free during probing, merely spawned, merely accepted TCP, or was used by
an unverified process is never persisted as effective.

### Strict explicit configuration

`ORPHEUS_ROUTING_PROXY_URL` and Custom port are explicit modes and never fall
back to another candidate.

- For `ORPHEUS_ROUTING_PROXY_URL`, Orpheus parses and validates the supplied
  complete URL, preserves it verbatim as the routed client URL, and uses its
  parsed host and port for the generated local proxy config and child binding,
  exactly as the existing managed lifecycle does. Orpheus still writes config,
  spawns, owns, authenticated-health-checks, restarts, supervises, and may
  reclaim only a proven same-variant stale child on that address. An invalid URL
  or occupied address is a clear error with no automatic or Custom-port
  fallback. The override is not persisted and its UI port controls are read-only.
- For Custom port, the value must be an integer in `1024–65535`. It resolves to
  `http://127.0.0.1:<port>`. Before spawning, any listener is a clear occupied
  port error; Orpheus does not reclaim it, even if it appears to be an older
  same-variant proxy. An invalid or occupied custom port does not fall back to
  automatic allocation and does not change `routingProxyEffectivePort`.
- Selecting Automatic clears `routingProxyCustomPort`, retains the most recent
  automatic `routingProxyEffectivePort` as the first future automatic
  candidate, and immediately reconciles the managed child if routing is
  enabled.
- Changing a valid Custom port immediately reconciles the managed child if
  routing is enabled. It first stops the current child handle, then attempts
  only the newly configured port. A failed attempt leaves the proxy stopped and
  reports the strict error; it never resumes on the old port.

### Readiness and ownership proof

Every managed start, whether Automatic, Custom, or environment-overridden, is
stronger than a TCP connection. Its selected address succeeds only when all of
these conditions hold:

1. The `ChildProcess` returned by this spawn is still alive.
2. macOS listener inspection (`lsof -nP -iTCP:<port> -sTCP:LISTEN -Fp`) reports
   exactly that child PID as the only listener on the candidate port.
3. The management request to
   `GET /v0/management/auth-files` with the freshly generated in-memory
   `MANAGEMENT_PASSWORD` returns a **2xx** response.

A 4xx response is a failed ownership/readiness proof, because it can identify a
foreign CLIProxyAPI or a wrong credential but cannot prove this newly spawned
child is serving. A generic TCP listener is likewise insufficient. A 5xx,
timeout, malformed response, missing listener owner, multiple listener PIDs,
or child exit is failure.

Introduce an injected macOS process/listener seam that returns PID, executable
path, and argv/config-path evidence. Production uses `lsof` for listener PIDs
and `ps -p <pid> -o command=` plus the process executable path exposed by
`lsof -p <pid>` (or `/proc` is not used on macOS). Harness fakes supply the
same structured evidence without spawning Electron or real processes. The
spawn/lifecycle seam exposes the spawned child PID and targeted termination of
that handle, never an arbitrary PID.

Authenticated management health must be strict for managed startup and routing
health. The existing TCP-only fallback remains unavailable to managed start,
managed supervisor health, and routed-workspace fail-closed gating. It may
remain only as a diagnostic reachability helper whose result is never treated
as a healthy managed proxy.

### Supervision

The supervisor continues to use its existing backoff and give-up policy. Its
`startProxy` dependency performs the complete mode-aware start protocol above.

- In Automatic mode, each respawn starts with the persisted effective port and
  reallocates through the full candidate sequence if that port became occupied.
  A successful replacement persists the new effective port.
- In Custom and environment modes, a new conflict or failed ownership/readiness
  proof records a clear strict configuration error and counts as a failed
  respawn attempt; no alternate port is tried. In environment mode the address
  is always the parsed override host and port, and the full override URL remains
  the routed client URL.

## UI behavior

Extend the existing **Settings > Orpheus > Model Routing** section; do not add
or redesign a generic settings surface.

When `ORPHEUS_ROUTING_PROXY_URL` is non-empty, the port controls are replaced
by a read-only notice: **“Port controlled by ORPHEUS_ROUTING_PROXY_URL”**,
followed by the exact effective URL. The notice states that the URL and its
host/port binding configuration come from the environment; Orpheus continues to
manage the child lifecycle on that address. The mode control and Custom-port
field are disabled in this mode, while the existing managed enable, restart,
and status controls remain available.

Without the override, show:

- an **Automatic** / **Custom port** mode control;
- a numeric Custom port field only in Custom mode, constrained by the strict
  `1024–65535` rule;
- the current effective URL and port, or **“No effective port allocated”** in
  automatic mode before a successful start;
- the selected mode; and
- the latest conflict/configuration error from the snapshot.

The renderer does not infer a port from defaults or environment state. It
renders the `RoutingProxySnapshot` returned by typed IPC, so it always shows
the main process's effective endpoint and error.

## Persistence, IPC, and implementation boundaries

Follow the repository's declarative SQLite and typed IPC patterns:

- Add the three columns to `app_ui_state` in
  `src/main/db/schema.ts`, row/record mappings and validation in the existing
  UI-state store, and matching fields in `src/shared/types.ts`.
- Extend `RoutingProxySnapshot` with `source`, `effectiveUrl`, `effectivePort`,
  `portMode`, `customPort`, and `portConfigurationLocked`; snapshots carry the
  UI's sole runtime display data. `portConfigurationLocked` is true only when
  the environment override owns URL/port selection, never child lifecycle.
- Add one typed request channel for applying the user setting:

  ```ts
  'routingProxy:setPortConfiguration': {
    req: [{ mode: 'automatic' } | { mode: 'custom'; port: number }]
    res: RoutingProxySnapshot
  }
  ```

  Declare it in `src/shared/ipc.ts`, implement it through the existing
  `src/main/ipc/routingProxy.ts` `handle()` registration, and expose it from
  `src/preload/index.ts`. The existing snapshot push channel carries updates;
  no additional renderer push channel is needed.
- Keep allocation, ownership inspection, and mode resolution in focused
  `src/main/routingProxy/` modules. `manager.ts` orchestrates them but does not
  duplicate URL precedence or unsafe PID logic.
- Any schema change must extend `scripts/verify-migration-engine.ts` assertions
  and pass `bun run test:db`.

## Implementation plan

The first unit establishes stable interfaces and no later unit changes their
contracts. Each following unit is independently testable and lands only after
its listed acceptance check passes.

### Unit 1 — Foundation: settings and runtime contracts

Create the shared `RoutingProxyPortMode`, runtime-resolution, snapshot, and
port-configuration request types. Add the three declarative `app_ui_state`
columns, mapping/validation, and migration-engine assertions. Introduce the
single runtime resolver and variant detection with the exact defaults and
candidate range specified above; update all URL consumers to use it.

**Acceptance check:** `bun run test:db` proves fresh schema, migration, and
convergence; `bun run test:proxy` proves production/development/worktree
preferred ports, environment > custom > automatic precedence, preservation of
the full environment client URL, and matching parsed host/port for generated
config and routing runtime resolution.

### Unit 2 — Safe allocator, listener inspection, and strict health

Implement the injected candidate allocator and macOS process/listener seam.
Replace blanket orphan killing with same-variant executable-plus-`-config`
proof. Make managed readiness and health require the spawned-PID listener proof
and authenticated 2xx management response; retain the existing TCP probe only
as a diagnostic helper whose result cannot mark a managed proxy healthy.

**Acceptance check:** `bun run test:proxy` proves automatic persistence,
occupied automatic fallback, invalid/occupied Custom and environment failures,
no unrelated PID killing, own stale-orphan reclaim, bind-race retry, and that
TCP-only and 4xx management responses cannot pass managed readiness.

### Unit 3 — Manager and supervisor integration

Route initial start, restart, reconcile, resume/unlock, unexpected-exit
respawn, and watchdog recovery through the mode-aware allocator. Preserve
strict Custom and environment failures, make Automatic respawn reuse then safely
reallocate the persisted effective port, and retain the environment override's
managed lifecycle on its parsed host/port. Ensure snapshots update only from the
resolved runtime state.

**Acceptance check:** `bun run test:proxy` proves Automatic supervisor reuse and
reallocation after a new conflict, strict Custom failure without fallback, and
managed environment-mode spawn, authenticated health, restart, and supervisor
failure without fallback.

### Unit 4 — Typed IPC and settings UI

Wire `routingProxy:setPortConfiguration` through shared IPC, main IPC, preload,
and the existing Model Routing section. Render the exact effective URL/port,
mode, environment-controlled read-only port state, and conflict errors.

**Acceptance check:** `bun run typecheck` and `bun run check` pass. Build and
launch only the Dev variant with:

```bash
bun run build:unpack
open -g "/Applications/Orpheus Dev.app"
pgrep -lf "Orpheus Dev.app/Contents/MacOS/Orpheus Dev" | head -1
```

Verify in the background-launched Dev app that Automatic shows its effective
URL, Custom reports a deliberate occupied-port error without changing ports,
and an `ORPHEUS_ROUTING_PROXY_URL` launch shows the read-only
**“Port controlled by ORPHEUS_ROUTING_PROXY_URL”** notice, the exact URL, and a
managed proxy running on the override's parsed host/port.

## Verification matrix

Extend the existing offline assertion harnesses, principally
`scripts/verify-routing-proxy.ts`, rather than inventing a general test runner.
There is no general renderer test runner in this repository; none is added.
The completed suite covers:

1. production, development, and worktree preferred-port defaults;
2. environment > Custom > Automatic precedence and full environment URL
   preservation;
3. per-variant persistence and persisted-port-first automatic restart;
4. occupied automatic candidate fallback and persisted replacement;
5. invalid/occupied Custom and invalid/occupied environment address strict
   failures with no fallback;
6. no signal sent to unrelated, unknown, or other-variant listener PIDs;
7. reclaim of only a stale same-variant CLIProxyAPI with matching executable and
   `-config` path;
8. bind TOCTOU retry on the next automatic candidate;
9. spawned-PID listener ownership plus authenticated 2xx management health,
   including rejection of TCP-only, 4xx, 5xx, and foreign-listener cases;
10. supervisor reuse/reallocation in Automatic mode plus managed environment
    restart/supervision on its override address and strict Custom/environment
    failures without fallback;
11. `bun run test:db`, `bun run test:proxy`, `bun run typecheck`, and
    `bun run check`; and
12. the background Dev-app verification in Unit 4.

## Non-goals

- Selecting arbitrary OS-assigned or ephemeral ports outside 18765–18799.
- Killing or adopting an arbitrary existing listener.
- Persisting `ORPHEUS_ROUTING_PROXY_URL` or altering its full-URL semantics.
- Adding a general test runner or a generic settings redesign.
