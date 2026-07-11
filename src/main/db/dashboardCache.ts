// ---------------------------------------------------------------------------
// src/main/db/dashboardCache.ts
//
// Dashboard D1 — persisted cache read/write helpers over the generic
// `dashboard_cache` table (schema.ts). This is deliberately separate from
// each source's own in-memory TTL cache (src/main/github.ts,
// src/main/claudeUsage.ts): those exist to dedup/rate-limit repeated calls
// WITHIN a running process; this table exists so the Dashboard can paint
// from the LAST successful fetch immediately after a cold app launch,
// before any live fetch has even started.
//
// Total contract: neither helper ever throws. A cache miss, a corrupt row,
// or a write failure all degrade silently (readDashboardCache -> null;
// writeDashboardCache -> no-op) so a persistence hiccup can never crash or
// block the caller — worst case the Dashboard just falls back to its
// existing live-fetch path, same as before this table existed.
// ---------------------------------------------------------------------------

import { getDb } from './index'

/** Canonical set of `dashboard_cache.key` values — one per expensive
 *  Dashboard data source. Centralized here (rather than each call site
 *  hand-typing the string) so a typo can't silently create a second,
 *  never-read cache row. */
export const DASHBOARD_CACHE_KEYS = {
  githubPrs: 'github_prs',
  githubIssues: 'github_issues',
  claudeUsage: 'claude_usage'
} as const

export type DashboardCacheKey = (typeof DASHBOARD_CACHE_KEYS)[keyof typeof DASHBOARD_CACHE_KEYS]

interface DashboardCacheRow {
  payload_json: string
  fetched_at: number
}

/** Reads + JSON-parses a cached payload for `key`. Returns null if the key
 *  has never been written, OR if the stored JSON fails to parse (tolerates
 *  on-disk corruption rather than propagating a throw into a UI paint
 *  path) — callers should treat null exactly like "no cache yet". Never
 *  throws. */
export function readDashboardCache<T>(key: string): { value: T; fetchedAt: number } | null {
  try {
    const db = getDb()
    const row = db
      .prepare('SELECT payload_json, fetched_at FROM dashboard_cache WHERE key = ?')
      .get(key) as DashboardCacheRow | undefined
    if (!row) return null
    const value = JSON.parse(row.payload_json) as T
    return { value, fetchedAt: row.fetched_at }
  } catch (err) {
    // Corrupt payload_json, or a DB-access error — degrade to "no cache",
    // never throw into the caller's read path. No secret material can
    // appear in `err` here (this table only ever stores non-secret
    // usage/PR/issue payloads), so logging it is safe.
    console.error('[dashboardCache] readDashboardCache failed', key, err)
    return null
  }
}

/** Upserts `value` (JSON-serialized) under `key`, stamping the current
 *  epoch-ms write time. Fire-and-forget from the caller's perspective —
 *  never throws, so a write failure (e.g. DB locked, JSON.stringify on a
 *  circular value) can never break the fetch it's piggybacking on. */
export function writeDashboardCache(key: string, value: unknown): void {
  try {
    const db = getDb()
    const payloadJson = JSON.stringify(value)
    db.prepare(
      `INSERT INTO dashboard_cache (key, payload_json, fetched_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET payload_json = excluded.payload_json, fetched_at = excluded.fetched_at`
    ).run(key, payloadJson, Date.now())
  } catch (err) {
    console.error('[dashboardCache] writeDashboardCache failed', key, err)
  }
}
