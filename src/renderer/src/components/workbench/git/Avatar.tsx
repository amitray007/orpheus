// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/git/Avatar.tsx
//
// Shared avatar renderer for the Git tab's Details/ReviewCommentThread
// surfaces: a real GitHub avatar <img> when the call site's data source
// captured an avatarUrl (currently only GhReviewComment — see its doc
// comment in shared/types.ts for which `gh` field carries it and why the
// other Gh* comment/review/reviewer types don't), falling back to the
// existing initials-circle (avatarColor.ts's initialsOf/avatarColorFor) when
// avatarUrl is null/empty OR the image fails to load (broken URL, offline,
// blocked, revoked GitHub avatar).
//
// The CSP (src/renderer/index.html) already allowlists
// `https://avatars.githubusercontent.com` and `https://github.com` in
// img-src, so a real avatar <img> loads fine — the "CSP forbids remote
// avatar fetches" claim that used to live on avatarColor.ts's doc comment was
// stale (there was never a captured avatar_url to try loading, so the CSP
// allowance went untested/unused until now). No CSP change needed here.
//
// Fast + cached: main process (src/main/avatarCache.ts) fetches the avatar
// ONCE (sized down to ~40px via a `s=` query param — GitHub serves full-res
// otherwise) and persists it to disk as a data URI, served instantly (and
// offline) on every subsequent load via the `avatar:get` IPC. This component
// degrades through three tiers, never blocking render: cached data-URI (once
// the IPC resolves) → direct sized CDN url (immediate, while the IPC is
// in flight, or if it resolves null) → initials circle (avatarUrl absent, or
// the <img> itself fails to load).
//
// Kept as its own component file (not folded into avatarColor.ts) because a
// `.tsx` file that exports both a component and plain functions trips the
// react-refresh/only-export-components lint rule — avatarColor.ts stays a
// plain, JSX-free `.ts` module of pure helpers, this file is the one
// component that consumes them.
// ---------------------------------------------------------------------------

import type React from 'react'
import { useEffect, useState } from 'react'
import { initialsOf, avatarColorFor } from './avatarColor'

// Mirrors src/main/avatarCache.ts's AVATAR_CACHE_PX — kept as a literal
// rather than a shared import since preload/renderer don't reach into main
// process modules; this is the client-side sizing used for the direct-CDN
// fallback tier (the cached tier's sizing is decided in main).
const AVATAR_RENDER_PX = 40

/** Append/overwrite the `s=` size param so even the uncached fallback tier
 *  requests a small image instead of GitHub's full-res default. Non-CDN or
 *  malformed urls are returned unchanged — best-effort sizing only. */
function sizedAvatarUrl(url: string, px: number = AVATAR_RENDER_PX): string {
  try {
    const u = new URL(url)
    u.searchParams.set('s', String(px))
    return u.toString()
  } catch {
    return url
  }
}

export interface AvatarProps {
  /** GitHub login, used for the initials/color fallback and the <img>'s alt
   *  text. Empty string renders '?' (see initialsOf). */
  login: string
  /** Real avatar image URL, when the call site's data source captured one.
   *  Null/undefined/empty renders the initials fallback directly, no image
   *  attempted. */
  avatarUrl?: string | null
  /** Square size in px — matches the existing initials-circle call sites
   *  (DetailsTab's old `Avatar` default 24, ReviewCommentThread's `rc-avatar`
   *  CSS-driven 20px) so swapping in a real image never changes layout. */
  size?: number
  /** Extra className applied to whichever element actually renders (img or
   *  the initials span), so call sites keep their existing sizing/positioning
   *  CSS (e.g. ReviewCommentThread's `.rc-avatar`, DetailsTab's
   *  `.details-avatar`) working unchanged for both the image and fallback
   *  paths. */
  className?: string
}

/** Shared avatar renderer: a real GitHub avatar image when `avatarUrl` is
 *  present, falling back to the existing initials-circle (initialsOf +
 *  avatarColorFor) when it's null/empty OR the image fails to load (broken
 *  URL, offline, blocked). The onError→fallback flip uses local state rather
 *  than trying to pre-validate the URL — simplest correct handling for an
 *  <img> that may 404/timeout after mount.
 *
 *  Three-tier degrade for the `src`, never blocking render: the direct sized
 *  CDN url (tier 2) is derived straight from `avatarUrl` so it's available
 *  from the very first render, then a `useEffect` asks main's fetch-once
 *  disk cache (`window.api.avatar.get`) for a data URI and swaps it in once
 *  resolved (tier 1 — fast + works offline on repeat visits) via `cachedSrc`
 *  state, which is ONLY ever written from that async callback (never
 *  synchronously in the effect body, to avoid a cascading-render setState).
 *  If the cache call resolves null (fetch/network failure) or is still in
 *  flight, the derived CDN url stays. If the <img> itself then fails to load
 *  (`onError`), tier 3 (initials) takes over. */
export function Avatar({ login, avatarUrl, size = 24, className }: AvatarProps): React.JSX.Element {
  const hasAvatarUrl = typeof avatarUrl === 'string' && avatarUrl.length > 0
  const fallbackSrc = hasAvatarUrl ? sizedAvatarUrl(avatarUrl) : null

  // Cached data-URI, once main's disk cache resolves one for the CURRENT
  // avatarUrl. Paired with the url it was resolved for (rather than reset via
  // an effect) so a stale cached image from a previous login is ignored the
  // instant avatarUrl changes, with no synchronous setState-in-effect needed.
  const [cachedSrc, setCachedSrc] = useState<{ forUrl: string; dataUri: string } | null>(null)

  useEffect(() => {
    if (!hasAvatarUrl) return

    let cancelled = false
    window.api.avatar
      .get(avatarUrl)
      .then((dataUri) => {
        if (!cancelled && dataUri) setCachedSrc({ forUrl: avatarUrl, dataUri })
      })
      .catch(() => {
        // Cache lookup failed — the derived sized CDN url stays as `src`.
      })
    return () => {
      cancelled = true
    }
  }, [avatarUrl, hasAvatarUrl])

  const src = cachedSrc && cachedSrc.forUrl === avatarUrl ? cachedSrc.dataUri : fallbackSrc

  // "Broken" (img onError) is paired with the src it failed for, same trick
  // as cachedSrc above — so swapping from a broken CDN url to a freshly
  // resolved cached data-URI (or a new avatarUrl entirely) automatically
  // gets a fresh chance to load, with no effect-based reset required.
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null)
  const hasImage = src !== null && src !== brokenSrc

  if (hasImage) {
    return (
      <img
        src={src}
        alt={login || 'unknown'}
        width={size}
        height={size}
        className={className}
        style={{ borderRadius: '50%', width: size, height: size, objectFit: 'cover' }}
        onError={() => setBrokenSrc(src)}
      />
    )
  }

  return (
    <span
      className={className}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.4)),
        background: avatarColorFor(login)
      }}
    >
      {initialsOf(login)}
    </span>
  )
}
