// ---------------------------------------------------------------------------
// src/main/avatarCache.ts
//
// Fast + cached GitHub avatars. GitHub's CDN (avatars.githubusercontent.com)
// serves full-res (~460px, tens of KB) unless a `s=<px>` size param is
// appended, and every render (Avatar.tsx, ~20px) re-fetches the full-res image
// over the network even though the same login's avatar rarely changes.
//
// This module does two things:
//   1. `sizedAvatarUrl` — appends/overwrites the `s=` query param so BOTH the
//      cache (below) and the renderer's own uncached fallback request a small
//      image instead of full-res.
//   2. `getCachedAvatar` — fetches the sized url ONCE, converts it to a
//      `data:image/...;base64,...` URI, and persists it to a small file cache
//      under userData so subsequent loads (including offline) are instant
//      disk reads instead of network round-trips.
//
// Mirrors the data-URI approach already used for local file images (see
// src/main/ipc/files.ts's readImageContents) and the plain-`fetch` GitHub call
// already used in src/main/githubAvatar.ts (no `net.request` precedent exists
// elsewhere in main — global `fetch` is available and is what that sibling
// module uses).
//
// Total/never-throws: any fetch/network/fs failure resolves to `null`, and
// the renderer (Avatar.tsx) degrades to the direct sized CDN url, then the
// initials-circle fallback.
// ---------------------------------------------------------------------------

import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { app } from 'electron'

// Avatars render at ~20px (see Avatar.tsx's `size` default/call sites) — 2x
// for retina. Exported so the renderer can build the same small CDN url for
// its own uncached fallback path (cached data-URI → sized CDN url → initials).
export const AVATAR_CACHE_PX = 40

// Cap the on-disk cache at ~500 entries. Each cached image is a few KB
// (40px, jpeg/png), so 500 entries is roughly 1-2 MB total — avatars rarely
// churn per project, so this comfortably covers real usage without needing
// an LRU structure; a simple mtime-oldest prune on write is enough.
const MAX_CACHE_ENTRIES = 500

let cacheDirReady: Promise<string> | null = null

/** Resolve (and lazily mkdir -p) the on-disk avatar cache directory under
 *  userData. Memoized — the mkdir only needs to happen once per process. */
function getCacheDir(): Promise<string> {
  if (!cacheDirReady) {
    cacheDirReady = (async () => {
      const dir = path.join(app.getPath('userData'), 'avatar-cache')
      await fs.mkdir(dir, { recursive: true })
      return dir
    })()
  }
  return cacheDirReady
}

/**
 * Append/overwrite the `s=` size query param on a GitHub avatar CDN url so
 * both the cache fetch and any uncached direct-CDN fallback request a small
 * image instead of GitHub's full-res default. Non-CDN or malformed urls are
 * returned unchanged (best-effort — the caller's <img> tag still works, just
 * un-sized).
 */
export function sizedAvatarUrl(url: string, px: number = AVATAR_CACHE_PX): string {
  try {
    const u = new URL(url)
    u.searchParams.set('s', String(px))
    return u.toString()
  } catch {
    return url
  }
}

/** Stable filename for a (sized) url — sha256 keeps it filesystem-safe and
 *  collision-free without leaking the url itself into the filename. */
function cacheKeyFor(sizedUrl: string): string {
  return crypto.createHash('sha256').update(sizedUrl).digest('hex')
}

/** Evict the oldest entries once the cache exceeds MAX_CACHE_ENTRIES. Runs
 *  after a successful write; failures are swallowed (a slightly-oversized
 *  cache is harmless, unlike a crash on write). */
async function pruneCache(dir: string): Promise<void> {
  try {
    const names = await fs.readdir(dir)
    if (names.length <= MAX_CACHE_ENTRIES) return

    const withStats = await Promise.all(
      names.map(async (name) => {
        const full = path.join(dir, name)
        const stat = await fs.stat(full)
        return { full, mtimeMs: stat.mtimeMs }
      })
    )
    withStats.sort((a, b) => a.mtimeMs - b.mtimeMs)

    const toRemove = withStats.slice(0, withStats.length - MAX_CACHE_ENTRIES)
    await Promise.all(toRemove.map((entry) => fs.rm(entry.full, { force: true })))
  } catch {
    // Best-effort — an oversized cache is harmless, never fatal.
  }
}

/**
 * Fetch+cache a GitHub avatar as a data URI. Sizes the url down first
 * (AVATAR_CACHE_PX) so both the cached bytes and the one-time network fetch
 * stay small. Disk cache is keyed by a hash of the sized url, so re-sizing
 * policy changes naturally invalidate old entries instead of serving stale
 * full-res data.
 *
 * Total — never throws. Returns `null` on any fetch/network/fs failure so
 * the renderer can fall back to the direct CDN url or the initials circle.
 */
export async function getCachedAvatar(url: string): Promise<string | null> {
  if (!url) return null

  try {
    const sized = sizedAvatarUrl(url)
    const key = cacheKeyFor(sized)
    const dir = await getCacheDir()
    const cachePath = path.join(dir, key)

    try {
      const cached = await fs.readFile(cachePath, 'utf8')
      if (cached.startsWith('data:')) return cached
    } catch {
      // Not cached yet (or unreadable) — fall through to fetch.
    }

    const res = await fetch(sized, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) return null

    const contentType = res.headers.get('content-type') || 'image/png'
    const buf = Buffer.from(await res.arrayBuffer())
    const dataUri = `data:${contentType};base64,${buf.toString('base64')}`

    await fs.writeFile(cachePath, dataUri, 'utf8')
    await pruneCache(dir)

    return dataUri
  } catch {
    return null
  }
}
