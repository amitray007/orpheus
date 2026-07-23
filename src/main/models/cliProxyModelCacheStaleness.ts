// ---------------------------------------------------------------------------
// src/main/models/cliProxyModelCacheStaleness.ts
//
// Pure staleness/version-validity decisions for the persisted cliproxy model
// cache, factored out of cliProxyModelCachePersistence.ts so they're
// importable by the offline verify-*.ts harnesses. This file (deliberately)
// imports NOTHING that touches electron/better-sqlite3 — unlike
// cliProxyModelCachePersistence.ts, which imports db/dashboardCache.ts and
// therefore transitively imports `electron` (see that module's own doc
// comment on why persistence itself isn't offline-testable).
// ---------------------------------------------------------------------------

/** How stale (ms) a persisted payload can be and still be considered
 *  immediately usable-without-blocking. Chosen generously — the whole point
 *  is "serve immediately, refresh in background", not to second-guess a
 *  refresh that happened minutes ago. 24h comfortably covers "closed the app
 *  overnight" while still forcing a background refresh well before any
 *  routed-provider's model lineup could realistically drift. */
export const CLI_PROXY_MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Given a persisted payload's recorded pinnedVersion and the CURRENT pinned
 * version, is the payload usable at all? A version mismatch means
 * CLIProxyAPI's own model-definitions contract may have changed
 * shape/contents — never trust stale-version data, even as a
 * stale-but-usable fallback.
 */
export function isPersistedCacheVersionValid(
  persistedPinnedVersion: string,
  currentPinnedVersion: string
): boolean {
  return persistedPinnedVersion === currentPinnedVersion
}

/** Is `fetchedAt` within the TTL of `now`? */
export function isPersistedCacheFresh(
  fetchedAt: number,
  now: number,
  ttlMs: number = CLI_PROXY_MODEL_CACHE_TTL_MS
): boolean {
  return now - fetchedAt <= ttlMs
}

/**
 * Generic "wait for `pending` but never longer than `timeoutMs`" race,
 * factored out of routingProxy/manager.ts's waitForCliProxyModelCacheFresh
 * so the timeout-races-cleanly behavior is independently assertable offline
 * with a fake/controllable `pending` promise and a fake `scheduleTimeout`
 * (no real setTimeout/sleep needed in a harness). Always resolves — never
 * rejects, even if `pending` itself rejects, since the caller only cares
 * "did we finish in time", never the pending work's own success/failure.
 */
export function raceWithTimeout(
  pending: Promise<unknown>,
  timeoutMs: number,
  scheduleTimeout: (resolve: () => void, ms: number) => void = (resolve, ms) =>
    setTimeout(resolve, ms)
): Promise<void> {
  const settled = pending.then(
    () => undefined,
    () => undefined
  )
  return Promise.race([
    settled,
    new Promise<void>((resolve) => scheduleTimeout(resolve, timeoutMs))
  ])
}
