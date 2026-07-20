// ---------------------------------------------------------------------------
// src/main/routingProxy/orphan.ts
//
// Detects and reclaims an ORPHAN routing-proxy process: a CLIProxyAPI binary
// still listening on our fixed loopback port (see modelRouting.ts's
// DEFAULT_ROUTING_PROXY_URL, 127.0.0.1:18765) from a PREVIOUS app run, whose
// child handle this process never held (lifecycle.ts's `child` is a
// module-level `let`, reset to null on every fresh boot — so a process this
// app spawned last session is invisible to isRunning() this session even
// though the OS process is still alive, e.g. the app was force-quit/crashed
// without reaching the will-quit handler that calls shutdownRoutingProxySync).
//
// POLICY: kill-and-respawn, not adopt. CLIProxyAPI's management API
// (auth-files, model list, OAuth) is gated by MANAGEMENT_PASSWORD, which
// lifecycle.ts generates fresh (crypto.randomBytes) on every startRoutingProxy()
// call and keeps ONLY in memory — never persisted to disk, never derivable
// from the outside. An orphan process was started with a DIFFERENT random
// secret from a prior run that no longer exists in memory anywhere, so this
// process has no way to authenticate to it even if we wanted to adopt it.
// Adoption is therefore not just undesirable but impossible without either
// persisting the secret (rejected — see lifecycle.ts's doc comment on why it
// stays in-memory-only) or falling back to an unauthenticated TCP-only
// health signal forever (which can never populate authFiles, since that
// endpoint requires the Bearer token). Kill-and-respawn is also what keeps
// lifecycle unambiguous per this unit's own requirement: after this runs,
// either nothing is listening, or the thing listening is a child this
// process's `lifecycle.ts` module holds a handle to and WILL kill on quit.
//
// macOS-only, matching the rest of this app (darwin-only asset naming in
// constants.ts, no cross-platform branching anywhere in routingProxy/).
// `lsof` ships with the OS.
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process'

export interface OrphanReclaimDeps {
  /** Bare TCP reachability probe — reuses health.ts's own shape so tests can
   *  inject the exact same stub deps used elsewhere in this package. */
  tcpProbe: (host: string, port: number, timeoutMs: number) => Promise<boolean>
  /** List PIDs with a listening socket on `port`. Real impl shells out to
   *  `lsof -ti tcp:<port> -sTCP:LISTEN`. Returns [] if nothing is listening
   *  or the lookup itself fails (never throws). */
  listPortOwners: (port: number) => Promise<number[]>
  /** Send SIGKILL to `pid`. Swallows ESRCH/EPERM (process already gone, or a
   *  permissions edge case) — best-effort by design, mirrored on
   *  lifecycle.ts's own killRoutingProxySync which also never throws. */
  killPid: (pid: number) => void
  /** Brief pause after killing, before re-probing, so the OS has time to
   *  actually free the socket. Injected so the harness never sleeps for real. */
  sleep: (ms: number) => Promise<void>
}

function realListPortOwners(port: number): Promise<number[]> {
  return new Promise((resolve) => {
    execFile('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], (err, stdout) => {
      if (err || !stdout) {
        resolve([])
        return
      }
      const pids = stdout
        .split('\n')
        .map((line) => Number(line.trim()))
        .filter((n) => Number.isInteger(n) && n > 0)
      resolve(pids)
    })
  })
}

function realKillPid(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already exited (ESRCH) or no permission (EPERM, e.g. not our uid) —
    // either way there's nothing more this call can do; the caller re-probes
    // the port afterwards to see whether it actually freed up.
  }
}

export function defaultOrphanReclaimDeps(
  tcpProbe: OrphanReclaimDeps['tcpProbe']
): OrphanReclaimDeps {
  return {
    tcpProbe,
    listPortOwners: realListPortOwners,
    killPid: realKillPid,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  }
}

export interface ReclaimOrphanResult {
  /** True iff a foreign process was found listening and killed. */
  reclaimed: boolean
  /** PIDs that were sent SIGKILL (empty when nothing was listening). */
  killedPids: number[]
}

/**
 * If something is listening on `host:port` that ISN'T a process this run
 * spawned (isRunning() already false is the caller's precondition — see
 * manager.ts's reconcileRoutingProxy), kill it so the port is free for a
 * fresh, credential-known respawn. No-op (reclaimed: false) if nothing is
 * listening — the common case on a clean boot. Never throws: every step is
 * best-effort, and a failure to detect/kill just means start()'s own
 * waitForRoutingProxyReady bind attempt will fail loudly afterward instead
 * (a broken port is still a visible 'error' status, not a silent hang).
 */
export async function reclaimOrphanRoutingProxyPort(
  host: string,
  port: number,
  deps: OrphanReclaimDeps
): Promise<ReclaimOrphanResult> {
  const listening = await deps.tcpProbe(host, port, 500)
  if (!listening) return { reclaimed: false, killedPids: [] }

  const pids = await deps.listPortOwners(port)
  if (pids.length === 0) {
    // Something answers TCP but lsof (or our uid's view of it) can't name a
    // PID — nothing safe to kill. Leave it; start()'s own bind attempt will
    // surface a clear 'error' status rather than this function guessing.
    return { reclaimed: false, killedPids: [] }
  }

  for (const pid of pids) deps.killPid(pid)
  await deps.sleep(150)
  return { reclaimed: true, killedPids: pids }
}
