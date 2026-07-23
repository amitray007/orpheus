// ---------------------------------------------------------------------------
// src/main/models/cliProxyModelCachePersistence.ts
//
// Persists the in-memory cliproxy model cache (models/sources/cliproxy.ts)
// across app launches, via the existing generic `dashboard_cache` table
// (src/main/db/schema.ts + src/main/db/dashboardCache.ts) — reused rather
// than adding a new table: this is exactly the same shape (one JSON payload
// + a fetched-at timestamp, read once at boot / written after each
// successful refresh) as every existing dashboard_cache consumer
// (claudeActivity.ts, github.ts, claudeUsage.ts).
//
// WHY this fixes the reported bug: cliproxy.ts's cache is in-memory only
// (`let cache = new Map(...)`), so it is empty on every process start. The
// model picker's first open after every app launch previously had nothing to
// read until the first background refresh completed (30s auth-files tick, or
// the on-demand ensureCliProxyModelCacheFresh() kick) — this module lets
// routingProxy/manager.ts hydrate cliproxy.ts's in-memory cache from the last
// successful fetch BEFORE any network round trip happens, so the very first
// models:listSelectable call after boot can already include routed models.
//
// Correctness rule this module exists to enforce: a persisted cache must
// never LIE. It only ever supplies "these model ids have these facts
// (context/effort levels)" — it does not decide availability. Availability
// (proxy running + provider enabled + provider healthy) is entirely owned by
// models/selectable.ts's existing gating against the LIVE routing-proxy
// snapshot's authFiles, which this module never touches or overrides. A
// persisted entry for a provider that's since been disabled/disconnected is
// therefore automatically withheld by buildSelectableModels — no separate
// "delete on provider change" step is needed here.
//
// Deliberately NOT covered by the offline verify-*.ts harnesses directly
// (this module imports ../db/dashboardCache, which imports ./index, which
// pulls in better-sqlite3/electron, same as providers/storage.ts) — the pure
// "is this persisted payload usable right now" decisions live in
// cliProxyModelCacheStaleness.ts (no electron import at all) so THOSE can be
// asserted offline against plain objects; this module just wires them to the
// real DB.
// ---------------------------------------------------------------------------

import { readDashboardCache, writeDashboardCache } from '../db/dashboardCache'
import { PINNED_VERSION } from '../routingProxy/constants'
import { isPersistedCacheFresh, isPersistedCacheVersionValid } from './cliProxyModelCacheStaleness'

export const CLI_PROXY_MODEL_CACHE_KEY = 'cliproxy_model_cache'

/** Same shape as cliproxy.ts's private CachedEntry — duplicated here
 *  (rather than imported) so this module's on-disk contract is an explicit,
 *  independently-versioned wire shape, not accidentally coupled to whatever
 *  shape the in-memory type happens to have this week. */
export interface PersistedCliProxyEntry {
  context: number | null
  supportsReasoning: boolean
  providerId?: string
  effortLevels?: string[] | null
}

export interface PersistedCliProxyModelCache {
  /** The pinned CLIProxyAPI version this payload was fetched against — a
   *  version bump invalidates the payload (model-definitions shape/contents
   *  can change release to release). */
  pinnedVersion: string
  entries: Record<string, PersistedCliProxyEntry>
}

/** Read the persisted cache from disk, or null if never written / corrupt /
 *  version-mismatched. Never throws (readDashboardCache's own contract).
 *  Version validity is checked here so callers never have to remember to. */
export function loadPersistedCliProxyModelCache(): {
  entries: Record<string, PersistedCliProxyEntry>
  fetchedAt: number
  stale: boolean
} | null {
  const cached = readDashboardCache<PersistedCliProxyModelCache>(CLI_PROXY_MODEL_CACHE_KEY)
  if (!cached) return null
  if (!isPersistedCacheVersionValid(cached.value.pinnedVersion, PINNED_VERSION)) return null
  return {
    entries: cached.value.entries,
    fetchedAt: cached.fetchedAt,
    stale: !isPersistedCacheFresh(cached.fetchedAt, Date.now())
  }
}

/** Persist the current cache. Fire-and-forget from the caller's perspective —
 *  writeDashboardCache never throws. Called after every successful
 *  refreshCliProxyModelCache() so the on-disk copy never falls far behind
 *  the in-memory one. */
export function persistCliProxyModelCache(entries: Record<string, PersistedCliProxyEntry>): void {
  const payload: PersistedCliProxyModelCache = { pinnedVersion: PINNED_VERSION, entries }
  writeDashboardCache(CLI_PROXY_MODEL_CACHE_KEY, payload)
}
