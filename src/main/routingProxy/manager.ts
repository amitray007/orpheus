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
import { BrowserWindow, shell } from 'electron'
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
  ensureHealthyForRouting as ensureHealthyForRoutingImpl,
  waitForRoutingProxyReady
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
import {
  refreshCliProxyModelCache,
  listCliProxyModelCacheEntries,
  shouldRefreshCliProxyModelCache
} from '../models/sources/cliproxy'
import { listProviderConfigs } from './providers/storage'
import {
  startProviderLogin,
  pollAuthStatus,
  cancelProviderLogin as cancelProviderLoginImpl,
  eligibleOAuthProviderIds,
  OAuthUnauthorizedError,
  type StartLoginResult,
  type PollResult
} from './oauth'
import { isSafeExternalUrl } from '../ipc/validate'

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
      authDir: authDir(),
      providers: listProviderConfigs()
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
  // Best-effort — refreshCliProxyModelCache never throws (see its own doc
  // comment) and populates the model registry's cliProxyModelSource cache so
  // routed-provider models pick up real context/thinking facts once the
  // proxy is reachable. Piggybacks on the same 30s interval as auth-files
  // rather than a separate timer.
  void refreshCliProxyModelCache(getRoutingProxyUrl(), secret)
}

/** IPC-facing manual refresh — returns the updated snapshot. */
export async function refreshAuthFilesNow(): Promise<RoutingProxySnapshot> {
  await refreshAuthFiles()
  return snapshot
}

// ---------------------------------------------------------------------------
// On-demand model-cache refresh (issue-2 fix) — refreshCliProxyModelCache was
// previously invoked from exactly one place: refreshAuthFiles' 30s interval,
// itself only armed once start() completes. That leaves a window — proxy
// enabled+running but this run's first 30s tick hasn't fired yet, or the
// picker is opened before the interval catches up — where the routed-model
// cache is empty even though the proxy is healthy, so buildSelectableModels
// (models/selectable.ts) offers Claude-only despite Codex/etc. being
// reachable. models:listSelectable (ipc/models.ts) calls this BEFORE reading
// the cache whenever it's empty; ensureCliProxyModelCacheFresh only fires the
// network call if the cache is actually empty AND at least
// MODEL_CACHE_MIN_REFRESH_INTERVAL_MS has passed since the last attempt (so a
// picker opened repeatedly against a genuinely-down proxy doesn't hammer it).
// Always best-effort: refreshCliProxyModelCache never throws, and this
// function does not await network I/O on the caller's behalf in the sense
// that matters — models:listSelectable fires it and does NOT block its own
// response on the result, preserving the "offline guarantee" (Claude must
// render immediately even if this refresh is mid-flight or the proxy is
// unreachable).
// ---------------------------------------------------------------------------

const MODEL_CACHE_MIN_REFRESH_INTERVAL_MS = 5_000
let lastModelCacheRefreshAttempt = 0
let modelCacheRefreshInFlight: Promise<void> | null = null

/**
 * Best-effort, non-blocking: kicks off a cliproxy model-cache refresh if the
 * cache is empty, the proxy is actually running, and we haven't already
 * tried within the last MODEL_CACHE_MIN_REFRESH_INTERVAL_MS. Callers must NOT
 * await this for their own response — it's fire-and-forget by design so a
 * cold/slow/unreachable proxy can never add latency to the model picker.
 */
export function ensureCliProxyModelCacheFresh(): void {
  const secret = getManagementSecret()
  const now = Date.now()
  const shouldRefresh = shouldRefreshCliProxyModelCache({
    cacheSize: listCliProxyModelCacheEntries().length,
    isProxyRunning: isRunning(),
    hasManagementSecret: secret !== null,
    isRefreshInFlight: modelCacheRefreshInFlight !== null,
    lastAttemptAt: lastModelCacheRefreshAttempt,
    now,
    minIntervalMs: MODEL_CACHE_MIN_REFRESH_INTERVAL_MS
  })
  if (!shouldRefresh || !secret) return
  lastModelCacheRefreshAttempt = now
  modelCacheRefreshInFlight = refreshCliProxyModelCache(getRoutingProxyUrl(), secret)
    .then(() => {
      // The renderer's selectableModelsStore only refetches on a
      // routingProxy:onSnapshot push (see that module's doc comment) — it
      // does not poll. Re-broadcasting the (otherwise unchanged) snapshot
      // here is what turns a newly-populated cache into a picker update
      // without requiring the user to close/reopen the dropdown. Only worth
      // doing if the refresh actually found something — an empty result
      // means the proxy is still unreachable, so nothing changed for the
      // renderer to pick up.
      if (listCliProxyModelCacheEntries().length > 0) setSnapshot({})
    })
    .catch(() => {
      // refreshCliProxyModelCache itself never throws — this catch is a
      // defensive backstop only, mirroring the rest of this module's style.
    })
    .finally(() => {
      modelCacheRefreshInFlight = null
    })
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
  // getRoutingProxyUrl() (host/port never drift from a stale prior write)
  // AND the current stored provider configs (a provider added/edited while
  // the proxy was stopped must take effect on the next start).
  await writeRoutingProxyConfig(configPath(version), {
    host: proxyHost(),
    port: proxyPort(),
    authDir: authDir(),
    providers: listProviderConfigs()
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

  // Poll readiness until the port is listening (bounded), then flip to
  // running and start polling auth-files. Uses the cheap TCP-only probe with
  // a fast, backing-off cadence (immediate first probe, short probe timeout)
  // rather than the management-API round trip used elsewhere — readiness
  // only needs "something is listening on the port", and a local process
  // either accepts a loopback connection almost instantly or isn't up yet.
  // Still bounded overall so a broken binary can't spin forever.
  const healthy = await waitForRoutingProxyReady(getRoutingProxyUrl())

  if (!healthy) {
    setSnapshot({ status: 'error', error: 'Proxy process started but never became reachable.' })
    return
  }

  setSnapshot({ status: 'running', error: null, installedVersion: version })
  // Fire-and-forget: the 'running' status must be observable to the renderer
  // (via the snapshot push above) immediately, not gated on this network
  // round trip. refreshAuthFiles is best-effort and already re-broadcasts
  // its own result (setSnapshot) when it completes.
  void refreshAuthFiles()
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
// Provider config changes (unit 05) — regenerate + rewrite config.yaml
// immediately so an edit made from Settings takes effect without requiring
// the user to manually toggle the proxy off/on. Only writes when a version
// is actually installed (nothing to write otherwise — start()/install() will
// pick up listProviderConfigs() on their own next run regardless).
// ---------------------------------------------------------------------------

export async function regenerateConfigNow(): Promise<void> {
  const version = snapshot.installedVersion
  if (!version) return
  await writeRoutingProxyConfig(configPath(version), {
    host: proxyHost(),
    port: proxyPort(),
    authDir: authDir(),
    providers: listProviderConfigs()
  })
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

// ---------------------------------------------------------------------------
// OAuth "Connect <provider>" flow (model-routing unit 07) — thin passthrough
// to oauth.ts's pure primitives, supplying the live getRoutingProxyUrl()
// exactly like every other manager call above. Keeps oauth.ts itself free of
// any dependency on the manager's module-level snapshot, so its own harness
// (scripts/verify-oauth.ts) stays fully offline/Electron-free.
// ---------------------------------------------------------------------------

export { eligibleOAuthProviderIds }
export type { StartLoginResult }

/** Starts the login (fetches the auth-url) and opens it in the user's
 *  default browser. isSafeExternalUrl gates openExternal exactly like every
 *  other call site in this codebase (index.ts's will-navigate handler,
 *  ipc/shell.ts) — CLIProxyAPI's own auth-url response is trusted content
 *  from a localhost process we spawned, but the same guard costs nothing and
 *  keeps this call site consistent with the rest of the app. */
export async function startOAuthLogin(providerId: string): Promise<StartLoginResult> {
  const result = await startProviderLogin(providerId, getRoutingProxyUrl())
  if (isSafeExternalUrl(result.url)) {
    void shell.openExternal(result.url).catch(() => {})
  }
  return result
}

/**
 * Single get-auth-status check (NOT the whole bounded wait loop — that pure
 * timing/retry logic lives in oauth.ts's pollUntilSettled and is exercised
 * directly by scripts/verify-oauth.ts). The renderer drives its own 2s
 * client-side interval calling this handler repeatedly, so it can render its
 * own countdown/cancel UI rather than blocking one IPC call for minutes.
 *
 * On 'ok', refreshes auth-files + the cliproxy model cache immediately (not
 * waiting for the 30s interval) so the newly connected provider's models
 * become selectable without an app restart, and updates the snapshot so the
 * Settings UI's connection dot flips without a manual refresh.
 *
 * A 401 is never retried at this layer either — it propagates as a thrown
 * OAuthUnauthorizedError, which the IPC handler surfaces to the renderer as
 * an 'error' outcome the renderer must NOT poll again for.
 */
export async function pollOAuthLogin(state: string): Promise<PollResult> {
  try {
    const result = await pollAuthStatus(state, getRoutingProxyUrl())
    if (result.status === 'ok') {
      await refreshAuthFiles()
    }
    return result
  } catch (err) {
    if (err instanceof OAuthUnauthorizedError) {
      return { status: 'error', error: 'Unauthorized (401) — login attempt refused, not retried' }
    }
    throw err
  }
}

export async function cancelOAuthLogin(state: string): Promise<void> {
  await cancelProviderLoginImpl(state, getRoutingProxyUrl())
}

// Re-export for convenience so scripts / other main modules importing the
// manager don't also need install.ts's InstallDeps type at a second import
// site.
export { versionDir }
export type { InstallDeps }
