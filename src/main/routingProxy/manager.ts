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
import { reclaimOrphanRoutingProxyPort, defaultOrphanReclaimDeps } from './orphan'
import { defaultHealthCheckDeps } from './health'
import { checkRoutingProxyUpdate } from './updateCheck'
import { cleanStoppedStatus, disableTransitionPatch } from './state'
import {
  refreshCliProxyModelCache,
  listCliProxyModelCacheEntries,
  shouldRefreshCliProxyModelCache,
  snapshotCliProxyModelCache,
  hydrateCliProxyModelCacheFromPersisted
} from '../models/sources/cliproxy'
import {
  loadPersistedCliProxyModelCache,
  persistCliProxyModelCache
} from '../models/cliProxyModelCachePersistence'
import { raceWithTimeout } from '../models/cliProxyModelCacheStaleness'
import { listProviderConfigs } from './providers/storage'
import { listModelAliases } from './aliases'
import {
  aliasesToProviderModels,
  aliasSplitEqual,
  expandAliasesWithStampedVariants,
  type SplitAliasProviderModels
} from './aliasResolve'
import { bareClaudeIdFor } from '../models/registry'
import { listModelsDevCachedIds } from '../models/sources/modelsDev'
import { listObservedClaudeModelIds } from '../sessions'
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

/**
 * Build the bare-claudeName -> [stamped variant, ...] map that
 * expandAliasesWithStampedVariants (aliasResolve.ts) needs — see that
 * function's doc comment for the full mechanism. Combines two id pools
 * (deduped via the Set-per-bareId grouping below), neither sufficient alone:
 *
 *   - models.dev's "anthropic" bucket ONLY (listModelsDevCachedIds) — the
 *     general catalog, currently stamps claude-haiku-4-5/claude-opus-4-1/
 *     claude-opus-4-5/claude-sonnet-4-5, but NOT claude-opus-4-8/
 *     claude-sonnet-5/claude-fable-5 (the models this app's own transcripts
 *     show get the most real traffic) — models.dev alone would leave those
 *     uncovered. Deliberately scoped to ONLY the anthropic bucket, never
 *     models.dev's full multi-provider catalog — models.dev carries ~300
 *     OTHER provider buckets (google-vertex, nano-gpt, aihubmix, venice, ...)
 *     that resell Claude models under their OWN vendor-suffixed SKU names
 *     sharing a Claude-shaped prefix (e.g. "claude-opus-4-7@default",
 *     "claude-haiku-4-5-20251001-thinking" — real models.dev entries, NOT
 *     date stamps Anthropic mints). An earlier version of this fix sourced
 *     from the unscoped flattened cache and, verified live against this
 *     repo's own dev-app install, incorrectly emitted alias entries for
 *     exactly those vendor SKUs — see modelsDev.ts's listModelsDevCachedIds
 *     doc comment for the full incident writeup.
 *   - listObservedClaudeModelIds (sessions.ts) — stamped ids Claude Code has
 *     ACTUALLY requested on this machine, already recorded in the sessions
 *     table by the existing transcript-metadata extractor. Catches a stamp
 *     for a family models.dev doesn't carry, the first time any local
 *     session hits it. Trustworthy by construction (never third-party SKU
 *     data) — this column is only ever written from a real assistant
 *     message's own `message.model` field in a `.jsonl` transcript Claude
 *     Code itself wrote.
 *
 * Both pools are additionally cross-checked against bareClaudeIdFor
 * (models/registry.ts) — the registry's own STRICT date-stamp-suffix
 * definition of "is this id a date-stamped variant of Claude bare id X"
 * (exactly 8 trailing digits, nothing else — see builtin.ts's
 * DATE_STAMP_SUFFIX) — never a second string-matching definition invented
 * here. This is defense in depth on top of the anthropic-bucket scoping
 * above, not a substitute for it.
 *
 * RESIDUAL GAP: a stamp that is in neither pool yet (never seen by
 * models.dev's anthropic bucket nor by any local session) is invisible until
 * one of the two catches up — see aliases.ts's candidateClaudeNames doc
 * comment (the sibling of this function, used for the Settings UI's "Use
 * defaults" row set) for the full write-up; the two functions intentionally
 * document the same gap once each since they're the two independent call
 * sites that need to know about it.
 */
function buildStampedVariantsByBareId(): Record<string, string[]> {
  const pool = [...listModelsDevCachedIds(), ...listObservedClaudeModelIds()]
  const byBareId = new Map<string, Set<string>>()
  for (const candidate of pool) {
    const owner = bareClaudeIdFor(candidate)
    if (!owner || owner === candidate) continue
    const set = byBareId.get(owner) ?? new Set<string>()
    set.add(candidate)
    byBareId.set(owner, set)
  }
  return Object.fromEntries(Array.from(byBareId, ([bareId, set]) => [bareId, Array.from(set)]))
}

/**
 * Resolve stored model aliases (unit 08) against the master switch
 * (AppUiState.modelAliasesEnabled), the live cliproxy model cache, and each
 * target provider's CURRENTLY CONFIGURED authMethod, ready to hand straight
 * to writeRoutingProxyConfig's aliasModelsByProvider/oauthAliasModelsByProvider
 * pair. Every writeRoutingProxyConfig call site in this module goes through
 * this helper so aliases stay in sync with providers on every config
 * regeneration (install/start/regenerateConfigNow) without duplicating the
 * gating logic three times. See aliasResolve.ts's aliasesToProviderModels /
 * SplitAliasProviderModels doc comments for the full skip-if-stale contract
 * and why the oauth/apiKey split exists (an alias for an oauth-configured
 * provider emitted the apiKey way is silently ignored by CLIProxyAPI).
 *
 * (model-routing unit 09-polish) Every stored row is expanded to also emit
 * its known date-stamped variants (expandAliasesWithStampedVariants) BEFORE
 * being handed to aliasesToProviderModels — this is what fixes "502 unknown
 * provider for model claude-haiku-4-5-20251001": the user's stored alias row
 * is keyed by the bare id, but CLIProxyAPI needs an EXACT match against the
 * stamped id the CLI actually requests. See buildStampedVariantsByBareId's
 * doc comment for where variant ids come from.
 */
function resolveAliasModelsByProvider(): SplitAliasProviderModels {
  const providerAuthMethods = Object.fromEntries(
    listProviderConfigs().map((p) => [p.providerId, p.authMethod])
  )
  const expandedAliases = expandAliasesWithStampedVariants(
    listModelAliases(),
    buildStampedVariantsByBareId()
  )
  return aliasesToProviderModels(
    expandedAliases,
    getAppUiState().modelAliasesEnabled,
    listCliProxyModelCacheEntries(),
    providerAuthMethods
  )
}

// ---------------------------------------------------------------------------
// Alias/cache ordering fix — the reported "aliasing doesn't work in
// subagents" bug. resolveAliasModelsByProvider() (above) skips any alias
// whose target isn't present in the live cliproxy model cache
// (aliasResolve.ts's knownOnProvider guard — intentionally kept, see that
// module's doc comment). The cache, though, is only ever populated OUT OF
// BAND by refreshCliProxyModelCache — which itself only runs from
// refreshAuthFiles' 30s interval / startModelCacheRefresh's on-demand kick,
// both of which require the proxy to already be running+authenticated.
// Every writeRoutingProxyConfig call site in this module (install/start/
// regenerateConfigNow) fires BEFORE that first cache population can
// possibly have happened, so on a fresh cache (first-ever run with no
// persisted snapshot, or any run where the persisted snapshot didn't cover
// every configured alias target) every alias is silently skipped and NEVER
// retried — config.yaml is written once at start() and then never touched
// again for the rest of the session.
//
// lastWrittenAliasModelsByProvider tracks exactly what was resolved+written
// on the most recent writeRoutingProxyConfig call from ANY call site in this
// module (install/start/regenerateConfigNow all update it — see
// recordAliasWrite below). regenerateConfigIfAliasesChanged is the ordering
// fix: called after every cache refresh, it re-resolves aliases against the
// NOW-populated cache and, only if the result actually differs from what's
// on disk (aliasProviderModelsEqual — structural, not reference, equality),
// triggers a real regenerateConfigNow() rewrite. CLIProxyAPI watches
// config.yaml via fsnotify and hot-reloads on change (verified in unit 08 —
// see this module's own header/regenerateConfigNow doc), so the rewrite
// alone is sufficient; no restart is needed.
//
// The equality check is the churn-loop guard: refreshAuthFiles' 30s timer
// calls this on every tick once the proxy is running, and once the cache is
// warm the resolved map stops changing — comparing against
// lastWrittenAliasModelsByProvider means those steady-state ticks are a
// resolve + a cheap structural compare, not a rewrite.
// ---------------------------------------------------------------------------

let lastWrittenAliasModelsByProvider: SplitAliasProviderModels = {
  apiKeyModels: {},
  oauthModels: {}
}

/** Every writeRoutingProxyConfig call site in this module must call this
 *  immediately after a successful write with the SAME resolved split value
 *  it just wrote, so regenerateConfigIfAliasesChanged has an accurate
 *  baseline to diff against. */
function recordAliasWrite(resolved: SplitAliasProviderModels): void {
  lastWrittenAliasModelsByProvider = resolved
}

/**
 * Called after a cliproxy model-cache refresh completes (both refreshAuthFiles'
 * 30s interval and startModelCacheRefresh's on-demand path — see their call
 * sites below). Re-resolves aliases against the now-current cache; if the
 * result differs from what's currently on disk, rewrites config.yaml via
 * regenerateConfigNow() (which itself calls recordAliasWrite with the fresh
 * resolution). No-ops when nothing is installed yet (regenerateConfigNow's
 * own guard) or when the resolved set is unchanged — see this section's
 * header doc for why that equality check matters.
 */
async function regenerateConfigIfAliasesChanged(): Promise<void> {
  const resolved = resolveAliasModelsByProvider()
  if (aliasSplitEqual(resolved, lastWrittenAliasModelsByProvider)) return
  await regenerateConfigNow()
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
    const resolvedAliases = resolveAliasModelsByProvider()
    await writeRoutingProxyConfig(configPath(result.version), {
      host: proxyHost(),
      port: proxyPort(),
      authDir: authDir(),
      providers: listProviderConfigs(),
      aliasModelsByProvider: resolvedAliases.apiKeyModels,
      oauthAliasModelsByProvider: resolvedAliases.oauthModels
    })
    recordAliasWrite(resolvedAliases)
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
  // rather than a separate timer. Persist afterward so the on-disk copy
  // (models/cliProxyModelCachePersistence.ts) never falls far behind the
  // in-memory one — this is what lets the NEXT app launch's first
  // models:listSelectable call see routed models immediately (see
  // hydrateSnapshotAtBoot below).
  await refreshCliProxyModelCache(getRoutingProxyUrl(), secret)
  persistCliProxyModelCache(snapshotCliProxyModelCache())
  // The reported-bug fix: once the cache is (re)populated, aliases that
  // previously resolved to nothing may now resolve — re-check and rewrite
  // config.yaml if the resolved set actually changed. See
  // regenerateConfigIfAliasesChanged's doc comment for the full ordering
  // problem and the churn-loop guard.
  await regenerateConfigIfAliasesChanged()
}

/** IPC-facing manual refresh — returns the updated snapshot. */
export async function refreshAuthFilesNow(): Promise<RoutingProxySnapshot> {
  await refreshAuthFiles()
  return snapshot
}

// ---------------------------------------------------------------------------
// On-demand model-cache refresh (issue-2 fix, extended by the persisted-cache
// fix below) — refreshCliProxyModelCache was previously invoked from exactly
// one place: refreshAuthFiles' 30s interval, itself only armed once start()
// completes. That leaves a window — proxy enabled+running but this run's
// first 30s tick hasn't fired yet, or the picker is opened before the
// interval catches up — where the routed-model cache is empty even though
// the proxy is healthy, so buildSelectableModels (models/selectable.ts)
// offers Claude-only despite Codex/etc. being reachable.
// ensureCliProxyModelCacheFresh only fires the network call if the cache is
// actually empty AND at least MODEL_CACHE_MIN_REFRESH_INTERVAL_MS has passed
// since the last attempt (so a picker opened repeatedly against a
// genuinely-down proxy doesn't hammer it). Always best-effort:
// refreshCliProxyModelCache never throws.
//
// ipc/models.ts now uses this in TWO ways:
//   - Fire-and-forget (unchanged): most calls just invoke
//     ensureCliProxyModelCacheFresh() and ignore its return, exactly as
//     before this fix.
//   - Bounded-await (new, cold-boot only): waitForCliProxyModelCacheFresh()
//     lets the FIRST models:listSelectable call after boot await the SAME
//     in-flight refresh for a short, hard-capped window when the persisted
//     cache didn't already cover it, so that very first call can include
//     routed models instead of always seeing Claude-only. It still never
//     blocks when the proxy isn't running/enabled (shouldRefresh is false
//     immediately) and always resolves — timeout or success — never rejects.
// ---------------------------------------------------------------------------

const MODEL_CACHE_MIN_REFRESH_INTERVAL_MS = 5_000
let lastModelCacheRefreshAttempt = 0
let modelCacheRefreshInFlight: Promise<void> | null = null

function startModelCacheRefresh(secret: string): Promise<void> {
  const inFlight = refreshCliProxyModelCache(getRoutingProxyUrl(), secret)
    .then(async () => {
      // The renderer's selectableModelsStore only refetches on a
      // routingProxy:onSnapshot push (see that module's doc comment) — it
      // does not poll. Re-broadcasting the (otherwise unchanged) snapshot
      // here is what turns a newly-populated cache into a picker update
      // without requiring the user to close/reopen the dropdown. Only worth
      // doing if the refresh actually found something — an empty result
      // means the proxy is still unreachable, so nothing changed for the
      // renderer to pick up.
      const entries = listCliProxyModelCacheEntries()
      if (entries.length > 0) {
        persistCliProxyModelCache(snapshotCliProxyModelCache())
        setSnapshot({})
        // This is the cold-start leg of the reported-bug fix: this on-demand
        // path only ever runs when the cache was previously EMPTY (see
        // shouldRefreshCliProxyModelCache's cacheSize gate) — i.e. exactly
        // the first-ever-run scenario where install()/start() wrote
        // config.yaml before any cache existed. Now that it's populated,
        // re-resolve + rewrite if aliases actually changed.
        await regenerateConfigIfAliasesChanged()
      }
    })
    .catch(() => {
      // refreshCliProxyModelCache itself never throws — this catch is a
      // defensive backstop only, mirroring the rest of this module's style.
    })
    .finally(() => {
      modelCacheRefreshInFlight = null
    })
  modelCacheRefreshInFlight = inFlight
  return inFlight
}

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
  void startModelCacheRefresh(secret)
}

/**
 * Bounded-await variant for the cold-first-call case: if a refresh is
 * warranted (same gate as ensureCliProxyModelCacheFresh — empty cache,
 * proxy running, secret present, not already in flight, throttle elapsed)
 * AND the cache is currently empty, wait up to `timeoutMs` for it to
 * complete before returning. Resolves (never rejects) either way — on
 * timeout the in-flight refresh keeps running in the background exactly as
 * ensureCliProxyModelCacheFresh's fire-and-forget path already does, it's
 * just that this caller stopped waiting on it. When no refresh is warranted
 * (proxy disabled/unreachable, cache already populated, etc.) this resolves
 * immediately — the Claude offline guarantee never waits on this call.
 */
export async function waitForCliProxyModelCacheFresh(timeoutMs: number): Promise<void> {
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
  // Nothing to wait for: either a refresh isn't warranted right now (proxy
  // down/disabled, throttled, cache already has data) or one is already
  // in-flight from a previous caller — in the latter case, still bound the
  // wait on that existing promise rather than starting a second refresh.
  const pending =
    shouldRefresh && secret ? startModelCacheRefresh(secret) : modelCacheRefreshInFlight
  if (!pending) return
  if (shouldRefresh && secret) lastModelCacheRefreshAttempt = now

  await raceWithTimeout(pending, timeoutMs)
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
  const startResolvedAliases = resolveAliasModelsByProvider()
  await writeRoutingProxyConfig(configPath(version), {
    host: proxyHost(),
    port: proxyPort(),
    authDir: authDir(),
    providers: listProviderConfigs(),
    aliasModelsByProvider: startResolvedAliases.apiKeyModels,
    oauthAliasModelsByProvider: startResolvedAliases.oauthModels
  })
  recordAliasWrite(startResolvedAliases)

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
 * Detects a routing-proxy process left listening on our fixed loopback port
 * by a PREVIOUS app run (this run's isRunning() is false — lifecycle.ts's
 * child handle is a fresh module-level `let`, reset on every boot — but the
 * OS process can still be alive if the prior run crashed/force-quit before
 * reaching shutdownRoutingProxySync). See orphan.ts's module doc for why the
 * policy is kill-and-respawn rather than adopt: an orphan's
 * MANAGEMENT_PASSWORD was generated in a process that no longer exists in
 * memory anywhere, so this run has no credential to authenticate to it —
 * adoption is not just undesirable but impossible. Bounded to a fast TCP
 * probe (500ms) plus a short settle delay only when something is actually
 * found — a clean boot (nothing listening) returns near-instantly.
 */
async function reclaimOrphanIfPresent(): Promise<void> {
  const url = new URL(getRoutingProxyUrl())
  const port = Number(url.port || 80)
  const result = await reclaimOrphanRoutingProxyPort(
    url.hostname,
    port,
    defaultOrphanReclaimDeps(defaultHealthCheckDeps().tcpProbe)
  )
  if (result.reclaimed) {
    setSnapshot({ authFiles: [], authFilesCheckedAt: null })
  }
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
    if (!isRunning()) {
      // Reclaim a stale/orphan process holding our port BEFORE spawning —
      // otherwise start()'s own bind attempt either fails outright or (worse)
      // silently talks to nobody while a foreign, credential-unknown process
      // keeps holding the port for the rest of this session (the reported
      // bug: authFiles never populates because refreshAuthFiles()/the 30s
      // timer are only armed inside start(), which never got called).
      await reclaimOrphanIfPresent()
      await start()
    }
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
  // Seed the in-memory cliproxy model cache from the last successful
  // refresh (previous app run), synchronously with the rest of boot
  // hydration — no network I/O, just a SQLite read. This is what lets the
  // FIRST models:listSelectable call of this run include routed models
  // instead of guaranteed Claude-only: previously the in-memory cache
  // (models/sources/cliproxy.ts) started empty every launch and only filled
  // in later via the 30s auth-files tick or an on-demand refresh. Version-
  // gated (see cliProxyModelCachePersistence.ts's isPersistedCacheVersionValid)
  // so a CLIProxyAPI version bump can never hydrate from a payload shaped for
  // a different release. Availability is still fully re-decided live by
  // buildSelectableModels against the current routing-proxy snapshot/authFiles
  // once they populate — hydrating here only seeds model FACTS (context,
  // effort levels), never bypasses health gating.
  const persisted = loadPersistedCliProxyModelCache()
  if (persisted) hydrateCliProxyModelCacheFromPersisted(persisted.entries)
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
  const resolvedAliases = resolveAliasModelsByProvider()
  await writeRoutingProxyConfig(configPath(version), {
    host: proxyHost(),
    port: proxyPort(),
    authDir: authDir(),
    providers: listProviderConfigs(),
    aliasModelsByProvider: resolvedAliases.apiKeyModels,
    oauthAliasModelsByProvider: resolvedAliases.oauthModels
  })
  recordAliasWrite(resolvedAliases)
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
