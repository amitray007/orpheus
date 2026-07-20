// ---------------------------------------------------------------------------
// src/main/routingProxy/manager.ts
//
// Public orchestration surface for the managed routing-proxy component —
// the one module src/main/ipc/routingProxy.ts (IPC) and modelRouting.ts
// (fail-closed gate) actually call. Owns the module-level RoutingProxySnapshot
// (mirrors src/main/updates.ts's `snapshot` pattern) so it survives Settings
// panel navigation/re-mounts without re-deriving state.
// ---------------------------------------------------------------------------

import { existsSync } from 'node:fs'
import { BrowserWindow } from 'electron'
import { PUSH_CHANNELS } from '../../shared/ipc'
import type { PushChannel, PushPayload } from '../../shared/ipc'
import type {
  RoutingProxyAssetInfo,
  RoutingProxySnapshot,
  RoutingProxyUpdateCheckResult
} from '../../shared/types'
import { getAppUiState, updateAppUiState } from '../uiState'
import { getRoutingProxyUrl } from '../modelRouting'
import { PINNED_VERSION, assetNameFor, downloadUrlFor, PINNED_TAG } from './constants'
import { authDir, binaryPath, configPath, versionDir } from './paths'
import { installRoutingProxy, defaultInstallDeps, type InstallDeps } from './install'
import { writeRoutingProxyConfig } from './config'
import {
  checkRoutingProxyHealth,
  ensureHealthyForRouting as ensureHealthyForRoutingImpl
} from './health'
import {
  startRoutingProxy,
  stopRoutingProxy,
  isRunning,
  getManagementSecret,
  getLastError,
  killRoutingProxySync
} from './lifecycle'
import { fetchRoutingProxyAuthFiles } from './authFiles'
import { checkRoutingProxyUpdate } from './updateCheck'
import { cleanStoppedStatus, disableTransitionPatch } from './state'

// ---------------------------------------------------------------------------
// Snapshot state
// ---------------------------------------------------------------------------

let snapshot: RoutingProxySnapshot = {
  enabled: false,
  status: 'not_installed',
  installedVersion: null,
  pinnedVersion: PINNED_VERSION,
  installProgress: null,
  error: null,
  authFiles: [],
  authFilesCheckedAt: null
}

function setSnapshot(patch: Partial<RoutingProxySnapshot>): void {
  snapshot = { ...snapshot, ...patch }
  broadcast(PUSH_CHANNELS.routingProxySnapshot, snapshot)
}

function broadcast<C extends PushChannel>(channel: C, payload: PushPayload<C>): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(channel, payload)
  }
}

export function getRoutingProxySnapshot(): RoutingProxySnapshot {
  return snapshot
}

function proxyPort(): number {
  const url = new URL(getRoutingProxyUrl())
  return Number(url.port || 80)
}

function proxyHost(): string {
  return new URL(getRoutingProxyUrl()).hostname
}

// ---------------------------------------------------------------------------
// Install detection at boot — is the pinned version already on disk?
// ---------------------------------------------------------------------------

export function detectInstalledVersion(): string | null {
  try {
    return existsSync(binaryPath(PINNED_VERSION)) ? PINNED_VERSION : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Asset info — surfaced in Settings before an install (size, name)
// ---------------------------------------------------------------------------

export async function getAssetInfo(
  arch: string = process.arch
): Promise<RoutingProxyAssetInfo | null> {
  const assetName = assetNameFor(PINNED_VERSION, arch)
  if (!assetName) return null
  try {
    const url = downloadUrlFor(PINNED_TAG, assetName)
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(8000)
    })
    const len = res.headers.get('content-length')
    return { version: PINNED_VERSION, assetName, sizeBytes: len ? Number(len) : null }
  } catch {
    return { version: PINNED_VERSION, assetName, sizeBytes: null }
  }
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export async function install(deps: InstallDeps = defaultInstallDeps()): Promise<void> {
  setSnapshot({
    status: 'installing',
    error: null,
    installProgress: { phase: 'downloading', percent: null }
  })
  try {
    const result = await installRoutingProxy(
      {
        destDir: versionDir(PINNED_VERSION),
        onProgress: (phase) => setSnapshot({ installProgress: { phase, percent: null } })
      },
      deps
    )
    await writeRoutingProxyConfig(configPath(result.version), {
      host: proxyHost(),
      port: proxyPort(),
      authDir: authDir()
    })
    setSnapshot({
      status: 'stopped',
      installedVersion: result.version,
      installProgress: null,
      error: null
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    setSnapshot({ status: 'error', installProgress: null, error: message })
    throw err
  }
}

// ---------------------------------------------------------------------------
// Lifecycle: start/stop, wired to routingProxyEnabled via reconcile()
// ---------------------------------------------------------------------------

let authRefreshTimer: ReturnType<typeof setInterval> | null = null

async function refreshAuthFiles(): Promise<void> {
  const secret = getManagementSecret()
  if (!secret || !isRunning()) return
  const files = await fetchRoutingProxyAuthFiles(getRoutingProxyUrl(), secret)
  setSnapshot({ authFiles: files, authFilesCheckedAt: Date.now() })
}

/** IPC-facing manual refresh — returns the updated snapshot. */
export async function refreshAuthFilesNow(): Promise<RoutingProxySnapshot> {
  await refreshAuthFiles()
  return snapshot
}

export async function start(): Promise<void> {
  let version = snapshot.installedVersion ?? detectInstalledVersion()

  // Auto-install on enable: the toggle's own copy promises "When on,
  // Orpheus installs (if needed) and runs the proxy" — so enabling while
  // not installed must trigger the install itself rather than erroring out
  // and telling the user to do it manually via a control that (before this
  // fix) didn't even exist in that state. install() already sets its own
  // 'installing'/'error' snapshot states; a thrown error here (e.g. a
  // checksum mismatch or offline network) leaves status 'error' with
  // installedVersion still null, which canInstallOrRetry()/isInstalled()
  // keep reachable for a manual Retry — never a dead end.
  if (!version) {
    try {
      await install()
    } catch {
      // install() already recorded status: 'error' + a message; nothing
      // further to do here — just don't fall through to starting a
      // nonexistent binary.
      return
    }
    version = snapshot.installedVersion
    if (!version) return
  }

  setSnapshot({ status: 'starting', error: null })

  // Regenerate config on every start so it always reflects the current
  // getRoutingProxyUrl() (host/port never drift from a stale prior write).
  await writeRoutingProxyConfig(configPath(version), {
    host: proxyHost(),
    port: proxyPort(),
    authDir: authDir()
  })

  startRoutingProxy({
    binaryPath: binaryPath(version),
    configPath: configPath(version),
    onExit: () => {
      if (authRefreshTimer) {
        clearInterval(authRefreshTimer)
        authRefreshTimer = null
      }
      const err = getLastError()
      setSnapshot({ status: err ? 'error' : 'stopped', error: err, authFiles: [] })
    },
    onLog: () => {
      // Managed process output — intentionally not surfaced to the renderer
      // (no log viewer in scope for this unit); kept as a hook point so a
      // future unit can wire a LogDisclosure like OrpheusUpdatesSection's.
    }
  })

  // Poll health until reachable (bounded), then flip to running and start
  // polling auth-files. Bounded so a broken binary can't spin forever.
  const deadline = Date.now() + 15_000
  let healthy = false
  while (Date.now() < deadline) {
    const result = await checkRoutingProxyHealth(getRoutingProxyUrl(), {
      managementSecret: getManagementSecret(),
      timeoutMs: 1000
    })
    if (result.healthy) {
      healthy = true
      break
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  if (!healthy) {
    setSnapshot({ status: 'error', error: 'Proxy process started but never became reachable.' })
    return
  }

  setSnapshot({ status: 'running', error: null, installedVersion: version })
  await refreshAuthFiles()
  authRefreshTimer = setInterval(() => {
    void refreshAuthFiles()
  }, 30_000)
}

export async function stop(): Promise<void> {
  if (authRefreshTimer) {
    clearInterval(authRefreshTimer)
    authRefreshTimer = null
  }
  await stopRoutingProxy()
  setSnapshot({
    ...disableTransitionPatch(snapshot.installedVersion),
    authFiles: [],
    authFilesCheckedAt: null
  })
}

/**
 * Declarative reconcile — mirrors index.ts's reconcileHooks() exactly: reads
 * routingProxyEnabled from AppUiState and starts/stops the child process to
 * match. Safe to call multiple times; idempotent against the current state.
 */
export async function reconcileRoutingProxy(): Promise<void> {
  const enabled = getAppUiState().routingProxyEnabled
  setSnapshot({ enabled })
  if (enabled) {
    if (!isRunning()) await start()
  } else if (isRunning()) {
    await stop()
  } else {
    // The child process was never running (e.g. a prior enable attempt
    // failed before a binary was ever spawned — not installed, or install
    // itself failed) — stop()'s own cleanup wouldn't otherwise run in this
    // branch. Disabling must still be a clean, well-defined transition: a
    // stale 'error' status/message from that failed enable attempt must not
    // linger just because there was no process to actually stop.
    setSnapshot(disableTransitionPatch(snapshot.installedVersion))
  }
}

export async function setEnabled(enabled: boolean): Promise<RoutingProxySnapshot> {
  updateAppUiState({ routingProxyEnabled: enabled })
  await reconcileRoutingProxy()
  return snapshot
}

/** Wired into app quit — mirrors notifyServer/commandServer's will-quit cleanup in index.ts. */
export function shutdownRoutingProxySync(): void {
  if (authRefreshTimer) {
    clearInterval(authRefreshTimer)
    authRefreshTimer = null
  }
  killRoutingProxySync()
}

// ---------------------------------------------------------------------------
// Boot-time snapshot hydration — call once at startup before reconcile.
// ---------------------------------------------------------------------------

export function hydrateSnapshotAtBoot(): Promise<void> {
  const installedVersion = detectInstalledVersion()
  const enabled = getAppUiState().routingProxyEnabled
  setSnapshot({
    installedVersion,
    enabled,
    status: cleanStoppedStatus(installedVersion)
  })
  return Promise.resolve()
}

// ---------------------------------------------------------------------------
// Update check (component's own pinned version vs GitHub latest)
// ---------------------------------------------------------------------------

export async function checkForComponentUpdate(): Promise<RoutingProxyUpdateCheckResult> {
  return checkRoutingProxyUpdate(snapshot.installedVersion ?? PINNED_VERSION)
}

// ---------------------------------------------------------------------------
// Fail-closed gate — see health.ts's doc block. Re-exported here so callers
// only need to import from routingProxy/manager (or the barrel index.ts)
// rather than reaching into health.ts directly, and so this call site can
// supply the live management secret automatically.
// ---------------------------------------------------------------------------

export async function ensureHealthyForRouting(): Promise<void> {
  await ensureHealthyForRoutingImpl(getRoutingProxyUrl(), {
    managementSecret: getManagementSecret()
  })
}

// Re-export for convenience so scripts / other main modules importing the
// manager don't also need install.ts's InstallDeps type at a second import
// site.
export { versionDir }
export type { InstallDeps }
