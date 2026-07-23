// ---------------------------------------------------------------------------
// src/main/routingProxy/providerConnectionPersistence.ts
//
// Persists the LAST-KNOWN-HEALTHY set of provider ids across app launches,
// via the existing generic `dashboard_cache` table (src/main/db/schema.ts +
// src/main/db/dashboardCache.ts) — reused rather than adding a new table,
// mirroring models/cliProxyModelCachePersistence.ts's own precedent exactly
// (same shape: one JSON payload + a fetched-at timestamp, read once at boot,
// written after each successful authFiles refresh).
//
// WHY this fixes the reported bug: the routing-proxy snapshot's `authFiles`
// (connection/health state) is in-memory only — populated by
// routingProxy/manager.ts's refreshAuthFiles(), which only ever runs once
// the proxy process is actually up and reachable. On a cold app launch that
// opens directly on a workspace, there is a real window (proxy status
// 'starting', authFiles still []) where the picker has NO basis to offer a
// provider's routed models even though that provider was connected and
// healthy in the previous session — see models/selectable.ts's
// persistedAvailabilityFor for the consuming side of this fix.
//
// Correctness rule this module exists to enforce, same as the model-cache
// persistence module's own: a persisted value must never LIE once live data
// exists. This module only ever supplies "these provider ids were healthy
// AS OF THE LAST SUCCESSFUL LIVE FETCH" — selectable.ts's
// persistedAvailabilityFor is solely responsible for stepping aside the
// instant a live authFiles entry (healthy OR unhealthy) exists for that
// provider; this module has no opinion on precedence, it only stores/loads
// a plain id set.
//
// Deliberately NOT covered by the offline verify-*.ts harnesses directly —
// same carve-out as cliProxyModelCachePersistence.ts: this module imports
// ../db/dashboardCache, which transitively imports better-sqlite3/electron.
// The pure "is this persisted payload usable right now" staleness/version
// decision is delegated to cliProxyModelCacheStaleness.ts's existing
// isPersistedCacheFresh/isPersistedCacheVersionValid (reused as-is, not
// duplicated) so that logic stays asserted offline exactly once.
// ---------------------------------------------------------------------------

import { readDashboardCache, writeDashboardCache } from '../db/dashboardCache'
import { PINNED_VERSION } from './constants'
import {
  isPersistedCacheFresh,
  isPersistedCacheVersionValid
} from '../models/cliProxyModelCacheStaleness'

export const PROVIDER_CONNECTION_CACHE_KEY = 'routing_proxy_provider_connections'

interface PersistedProviderConnections {
  /** The pinned CLIProxyAPI version this payload was recorded against — a
   *  version bump invalidates it, same rationale as the model-cache payload
   *  (management-API health-field shape could change release to release). */
  pinnedVersion: string
  /** Every provider id that reported health 'ok' as of the last successful
   *  refreshAuthFiles() call. Deliberately NOT a richer per-provider record
   *  (label/timestamp/etc.) — the consuming gate (selectable.ts) only ever
   *  needs a yes/no "was this healthy last session", nothing else. */
  healthyProviderIds: string[]
}

/**
 * Read the persisted healthy-provider-id set from disk, or null if never
 * written / corrupt / version-mismatched / past TTL. Never throws
 * (readDashboardCache's own contract). Reuses the SAME TTL as the model
 * cache (CLI_PROXY_MODEL_CACHE_TTL_MS, 24h) — there is no reason connection
 * history should be trusted longer or shorter than model-fact history; both
 * describe "how stale can a snapshot of the same proxy's state be before we
 * stop treating it as a startup-window hint at all".
 */
export function loadPersistedHealthyProviderIds(): Set<string> | null {
  const cached = readDashboardCache<PersistedProviderConnections>(PROVIDER_CONNECTION_CACHE_KEY)
  if (!cached) return null
  if (!isPersistedCacheVersionValid(cached.value.pinnedVersion, PINNED_VERSION)) return null
  if (!isPersistedCacheFresh(cached.fetchedAt, Date.now())) return null
  return new Set(cached.value.healthyProviderIds)
}

/**
 * Persist the current set of healthy provider ids. Fire-and-forget from the
 * caller's perspective — writeDashboardCache never throws. Called after
 * every successful refreshAuthFiles() (manager.ts) so the on-disk copy never
 * falls far behind the in-memory authFiles snapshot.
 */
export function persistHealthyProviderIds(healthyProviderIds: string[]): void {
  const payload: PersistedProviderConnections = {
    pinnedVersion: PINNED_VERSION,
    healthyProviderIds
  }
  writeDashboardCache(PROVIDER_CONNECTION_CACHE_KEY, payload)
}
