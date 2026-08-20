// ---------------------------------------------------------------------------
// src/main/models/modelsDevPersistence.ts
//
// Wires models.dev's catalog cache (./sources/modelsDev.ts) to the persisted
// `dashboard_cache` table. This is the ONLY file that knows both sides.
//
// WHY A SEPARATE FILE — dependency inversion, for a concrete reason:
// sources/modelsDev.ts is imported directly by several pure, no-electron
// verifiers (verify-routing.ts, verify-model-registry.ts, verify-providers.ts,
// verify-model-picker.ts). Importing db/dashboardCache from there drags
// `electron` into all of them through the DB layer — verify-routing.ts mocks
// nothing today and would have to start mocking electron just to keep testing
// routing logic. Empirically confirmed: adding that import failed the suite
// with "Export named 'app' not found in module .../electron/index.js".
//
// So modelsDev.ts declares a persistence PORT and this module supplies it.
// Only the main process imports this file, so the electron-reaching edge
// exists in exactly one place and the pure verifiers stay pure.
//
// WHAT IT BUYS: refreshModelsDevCache downloads 3.8 MB from models.dev and
// parses 3202 models. Measured on a real cold boot, that was ~2 s before any
// model fact resolved plus a ~400 ms main-thread stall when the JSON landed —
// on EVERY launch, for a catalog that changes rarely. Persisting the DERIVED
// catalog (~456 KB, an 8.8x reduction — the raw response is never stored) and
// rehydrating from SQLite makes the common path local and instant. The live
// refresh still runs fire-and-forget afterwards.
// ---------------------------------------------------------------------------

import { DASHBOARD_CACHE_KEYS, readDashboardCache, writeDashboardCache } from '../db/dashboardCache'
import { setModelsDevPersistence, type PersistedCatalog } from './sources/modelsDev'

/**
 * Installs the SQLite-backed persistence port. Call once, early in boot and
 * BEFORE hydrateModelsDevCacheFromDisk() — hydrate is a no-op without it.
 *
 * Both directions are already total: readDashboardCache returns null on a
 * miss/corrupt row/DB error, and writeDashboardCache swallows its own
 * failures. That contract is what lets modelsDev.ts treat persistence as
 * best-effort and degrade to network-only rather than failing a boot.
 */
export function installModelsDevPersistence(): void {
  setModelsDevPersistence({
    read: () => readDashboardCache<PersistedCatalog>(DASHBOARD_CACHE_KEYS.modelsDevCatalog),
    write: (value) => writeDashboardCache(DASHBOARD_CACHE_KEYS.modelsDevCatalog, value)
  })
}
