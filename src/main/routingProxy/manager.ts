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
  RoutingProxyUpdateCheckResult,
  RoutingProxyMaintenanceResult
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
  hydrateCliProxyModelCacheFromPersisted,
  didCliProxyModelCacheChange,
  cliProxyModelCacheSignature
} from '../models/sources/cliproxy'
import {
  loadPersistedCliProxyModelCache,
  persistCliProxyModelCache
} from '../models/cliProxyModelCachePersistence'
import { raceWithTimeout } from '../models/cliProxyModelCacheStaleness'
import {
  loadPersistedHealthyProviderIds,
  persistHealthyProviderIds
} from './providerConnectionPersistence'
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

// The cold-boot picker-staleness fix's churn-loop guard — the signature
// (cliproxy.ts's cliProxyModelCacheSignature) of the model cache content as
// of the LAST time refreshAuthFiles actually re-broadcast the snapshot for a
// catalog change. Compared on every tick via didCliProxyModelCacheChange so
// the steady-state 30s interval only re-broadcasts (and triggers every
// mounted picker's refetch) when the catalog genuinely changed, not on every
// tick. Reset is never needed — a fresh empty-string signature naturally
// differs from any populated one, so a proxy stop/restart's fresh empty
// cache still compares correctly against whatever was last broadcast.
let lastBroadcastCliProxyModelSignature: string | null = null

async function refreshAuthFiles(): Promise<void> {
  const secret = getManagementSecret()
  if (!secret || !isRunning()) return
  const files = await fetchRoutingProxyAuthFiles(getRoutingProxyUrl(), secret)
  setSnapshot({ authFiles: files, authFilesCheckedAt: Date.now() })
  // (model-routing unit 09-polish) Persist the live-healthy provider id set
  // after every successful fetch — this is the write side of the startup-
  // window fix (see providerConnectionPersistence.ts's own doc comment and
  // models/selectable.ts's persistedAvailabilityFor for the read/consuming
  // side). Fire-and-forget, same as persistCliProxyModelCache below — never
  // blocks, never throws.
  persistHealthyProviderIds(files.filter((f) => f.health === 'ok').map((f) => f.provider))
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
  // The cold-boot picker-staleness fix: the setSnapshot above already fired
  // BEFORE this fetch, so a picker mounted in that window saw whatever the
  // cache held at that instant (empty, on a cold boot). Broadcast a SECOND
  // time now that the catalog is (re)populated — but only when the content
  // actually changed since the last such broadcast (didCliProxyModelCacheChange),
  // so the steady-state 30s tick doesn't refetch every mounted picker for no
  // reason once the cache is warm. Mirrors startModelCacheRefresh's own
  // post-populate re-broadcast (the on-demand picker-open path) — this is
  // the automatic-tick counterpart of the same fix.
  const cliProxyEntries = listCliProxyModelCacheEntries()
  const cliProxySignature = cliProxyModelCacheSignature(cliProxyEntries)
  if (didCliProxyModelCacheChange(lastBroadcastCliProxyModelSignature, cliProxyEntries)) {
    lastBroadcastCliProxyModelSignature = cliProxySignature
    setSnapshot({})
  }
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
        // Record the signature we're broadcasting here too — keeps it in
        // sync with refreshAuthFiles' own guard (same module-level variable)
        // so the NEXT 30s tick doesn't immediately re-broadcast a signature
        // this on-demand path already sent.
        lastBroadcastCliProxyModelSignature = cliProxyModelCacheSignature(entries)
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

// ---------------------------------------------------------------------------
// Manual maintenance actions (model-routing unit 09-polish) — explicit
// "fix it now" escape hatches surfaced in Settings for a user who can't (or
// shouldn't have to) wait on a background refresh they can't see or
// trigger. IMPORTANT: these are escape hatches, NOT the primary mechanism —
// the automatic paths (boot hydration, the 30s refreshAuthFiles tick,
// post-OAuth-connect refresh, regenerateConfigIfAliasesChanged's cache-
// population trigger) already keep everything current on their own. A user
// needing to click one of these routinely is a sign something upstream is
// broken, not evidence the buttons are working as intended — don't let a
// later change quietly start relying on the user clicking these.
// ---------------------------------------------------------------------------

/**
 * "Refresh models" — force a cliproxy model-cache refresh, bypassing
 * shouldRefreshCliProxyModelCache's cacheSize/throttle checks (those exist
 * to protect the AUTOMATIC paths from hammering a down proxy; a
 * user-initiated click is a deliberate, bounded, one-shot request that
 * should always actually try, even with a warm cache or mid-throttle-
 * window). The ONE piece of that gate still respected is isRefreshInFlight —
 * a concurrent refresh (automatic or a previous manual click) is piggy-
 * backed on rather than starting a second overlapping fetch, so this
 * function is non-re-entrant without needing its own separate flag.
 * Reuses startModelCacheRefresh/refreshCliProxyModelCache directly — no
 * parallel fetch logic. That helper already persists + re-broadcasts the
 * snapshot on success, exactly like the automatic on-demand path does.
 * Refused cleanly (never attempted) when the proxy isn't running or no
 * management secret exists yet — those are the same preconditions the IPC
 * handler / renderer use to decide whether to even offer this action
 * enabled.
 */
export async function forceRefreshCliProxyModelCache(): Promise<RoutingProxyMaintenanceResult> {
  const secret = getManagementSecret()
  if (!secret || !isRunning()) {
    return { ok: false, message: "Couldn't reach the proxy — is it running?" }
  }
  // Non-re-entrant: if a refresh is already in flight (from the automatic
  // path OR a previous manual click), piggyback on that SAME promise rather
  // than starting a second overlapping fetch — this is the one piece of
  // shouldRefreshCliProxyModelCache's gate this function still respects
  // (isRefreshInFlight), everything else (cacheSize/throttle) is
  // deliberately bypassed, see this function's own doc comment.
  lastModelCacheRefreshAttempt = Date.now()
  await (modelCacheRefreshInFlight ?? startModelCacheRefresh(secret))
  const entries = listCliProxyModelCacheEntries()
  if (entries.length === 0) {
    return { ok: false, message: 'No models reported — check provider connections.' }
  }
  const providerCount = new Set(entries.map((e) => e.providerId).filter(Boolean)).size
  return {
    ok: true,
    message: `Refreshed — ${entries.length} model${entries.length === 1 ? '' : 's'} from ${providerCount} provider${providerCount === 1 ? '' : 's'}`,
    modelCount: entries.length,
    providerCount
  }
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

// ---------------------------------------------------------------------------
// Explicit restart (model-routing unit 09-polish) — a manual recovery tool
// for a wedged process/stale in-proxy state/a config key that doesn't
// hot-reload (most keys DO hot-reload via CLIProxyAPI's own config.yaml
// fsnotify watch — see resolveAliasModelsByProvider's doc comment — so this
// is deliberately NOT required for ordinary alias/provider edits, which
// already take effect live). Reuses stop()/start() exactly — no parallel
// lifecycle path — so restart inherits every invariant those two already
// have: stop()'s SIGTERM-then-SIGKILL-after-grace, start()'s auto-install-
// if-needed + config regeneration + readiness polling + authFiles/model-cache
// refresh kickoff.
// ---------------------------------------------------------------------------

let restartInFlight = false

/** True while a restart() call is in progress — the IPC handler (and the
 *  renderer's disabled-button state) uses this to refuse a re-entrant second
 *  restart rather than queuing/racing two overlapping stop-then-start
 *  sequences against the same port. */
export function isRestarting(): boolean {
  return restartInFlight
}

/**
 * Stop the proxy (if running), reclaim the port defensively in case the OS
 * hasn't fully released it yet even though stop()'s child-exit promise has
 * already resolved (mirrors reconcileRoutingProxy's own pre-start reclaim —
 * see reclaimOrphanIfPresent's doc comment for why adoption is impossible
 * and kill-and-respawn is the only safe policy for a foreign listener), then
 * start() again on the SAME configured port (proxyPort()/proxyHost() are
 * re-read from getRoutingProxyUrl(), never cached from the pre-restart run).
 * start() itself regenerates config.yaml, rotates MANAGEMENT_PASSWORD +
 * the client auth token (lifecycle.ts's startRoutingProxy generates both
 * fresh on every call), waits for readiness, and kicks off the authFiles +
 * cliproxy-model-cache refresh — so the picker is never left stale after a
 * restart, exactly as it wouldn't be after a fresh enable.
 *
 * Non-re-entrant: a restart already in flight makes a second call a no-op
 * that just returns the current (in-progress) snapshot rather than starting
 * a second overlapping stop/start sequence against the same port.
 */
export async function restart(): Promise<RoutingProxySnapshot> {
  if (restartInFlight) return snapshot
  restartInFlight = true
  try {
    if (isRunning()) {
      await stop()
    }
    await reclaimOrphanIfPresent()
    await start()
    return snapshot
  } finally {
    restartInFlight = false
  }
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
// Persisted-healthy-provider-ids in-memory holder (model-routing
// unit 09-polish) — hydrated once at boot (below), read by
// getPersistedHealthyProviderIds() (ipc/models.ts's collectSelectableInput).
// Deliberately never mutated after boot hydration by anything other than a
// fresh hydrateSnapshotAtBoot() call — the LIVE authFiles data in `snapshot`
// is what actually drives availability after boot (see
// models/selectable.ts's persistedAvailabilityFor); this module-level value
// only ever answers "what did we know as of process start".
// ---------------------------------------------------------------------------

let persistedHealthyProviderIdsAtBoot: Set<string> = new Set()

/** Read-only accessor for ipc/models.ts — the startup-window fallback set
 *  hydrated once at boot. Never empty-checked specially by callers; an
 *  empty set behaves identically to "no persisted fallback available",
 *  which is also this variable's default before hydrateSnapshotAtBoot runs
 *  (or when nothing was ever persisted). */
export function getPersistedHealthyProviderIds(): Set<string> {
  return persistedHealthyProviderIdsAtBoot
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
  // (model-routing unit 09-polish) Seed the persisted-healthy-provider-ids
  // fallback the SAME way, synchronously, no network I/O — this is the
  // startup-window fix: the FIRST models:listSelectable call of this run can
  // now offer a provider's routed models even while the proxy is still
  // 'starting' and live authFiles is still empty, provided that provider was
  // healthy last session (see models/selectable.ts's persistedAvailabilityFor
  // for the full precedence rule — live data always wins the instant it
  // arrives). loadPersistedHealthyProviderIds returns null (not just an
  // empty set) on version-mismatch/TTL-expiry/never-written, all of which
  // correctly collapse to "no fallback" here.
  persistedHealthyProviderIdsAtBoot = loadPersistedHealthyProviderIds() ?? new Set()
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
// Manual maintenance-result wrappers around two already-existing functions
// (refreshAuthFilesNow / regenerateConfigNow) — see this file's
// forceRefreshCliProxyModelCache doc comment for why these buttons exist and
// the "escape hatch, not the primary mechanism" framing. Both reuse the
// existing function UNCHANGED; this is purely an honest-outcome wrapper for
// the Settings UI.
// ---------------------------------------------------------------------------

let refreshConnectionsInFlight: Promise<RoutingProxyMaintenanceResult> | null = null

/** "Refresh connections" — force refreshAuthFilesNow() and report how many
 *  providers came back healthy. Refused cleanly (no attempt) when the proxy
 *  isn't running, mirroring forceRefreshCliProxyModelCache's own guard.
 *  Non-re-entrant: a concurrent call piggybacks on the same in-flight
 *  promise rather than firing a second overlapping management-API request. */
export async function forceRefreshConnections(): Promise<RoutingProxyMaintenanceResult> {
  if (refreshConnectionsInFlight) return refreshConnectionsInFlight
  if (!isRunning()) {
    return { ok: false, message: "Couldn't reach the proxy — is it running?" }
  }
  const work = (async (): Promise<RoutingProxyMaintenanceResult> => {
    const before = snapshot.authFilesCheckedAt
    await refreshAuthFilesNow()
    if (snapshot.authFilesCheckedAt === before) {
      // refreshAuthFiles() itself no-ops without a management secret (see its
      // own doc comment) — authFilesCheckedAt not moving is the honest signal
      // that nothing actually happened, distinct from "it ran and found zero
      // connections" (which WOULD move the timestamp).
      return { ok: false, message: 'No management secret yet — try again shortly.' }
    }
    const healthy = snapshot.authFiles.filter((f) => f.health === 'ok').length
    return {
      ok: true,
      message: `Refreshed — ${healthy} of ${snapshot.authFiles.length} connection${snapshot.authFiles.length === 1 ? '' : 's'} healthy`
    }
  })()
  refreshConnectionsInFlight = work
  try {
    return await work
  } finally {
    refreshConnectionsInFlight = null
  }
}

let regenerateConfigManualInFlight: Promise<RoutingProxyMaintenanceResult> | null = null

/** "Regenerate config" — force regenerateConfigNow(). Useful after an alias/
 *  provider edit if the config.yaml fsnotify hot-reload ever misbehaves;
 *  ordinary edits already call this automatically and do NOT need this
 *  button (see this file's header comment on the alias-edit hot-reload
 *  path). Refused cleanly when nothing is installed (regenerateConfigNow's
 *  own no-op condition) rather than reporting a false success. Non-re-
 *  entrant: a concurrent call piggybacks on the same in-flight promise. */
export async function forceRegenerateConfig(): Promise<RoutingProxyMaintenanceResult> {
  if (regenerateConfigManualInFlight) return regenerateConfigManualInFlight
  if (!snapshot.installedVersion) {
    return { ok: false, message: 'Nothing installed yet — install the proxy first.' }
  }
  const work = (async (): Promise<RoutingProxyMaintenanceResult> => {
    await regenerateConfigNow()
    return { ok: true, message: 'Config regenerated.' }
  })()
  regenerateConfigManualInFlight = work
  try {
    return await work
  } finally {
    regenerateConfigManualInFlight = null
  }
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
