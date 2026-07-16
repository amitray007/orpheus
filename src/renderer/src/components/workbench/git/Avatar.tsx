// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/git/Avatar.tsx
//
// Shared avatar renderer for the Git tab's Details/ReviewCommentThread
// surfaces: a real GitHub avatar <img>, falling back to the existing
// initials-circle (avatarColor.ts's initialsOf/avatarColorFor) when no
// avatar can be resolved OR the image fails to load (broken URL, offline,
// blocked, revoked GitHub avatar).
//
// Two avatar URL sources, in priority order:
//   1. `avatarUrl` — captured directly by the call site's data source
//      (currently only GhReviewComment; see its doc comment in
//      shared/types.ts for which `gh` field carries it and why the other
//      Gh* comment/review/reviewer types don't).
//   2. `login` — for every OTHER call site (general comments, reviews,
//      reviewers, assignees) that has a login but no avatarUrl, we build
//      `https://github.com/<login>.png?size=<px>`, which 302-redirects to
//      the real avatars CDN for any real GitHub user. A bot login's
//      trailing `[bot]` suffix is stripped for this constructed URL (GitHub
//      doesn't serve `github.com/foo[bot].png`) while the ORIGINAL login is
//      kept for the initials fallback. A login that isn't a real GitHub
//      user 404s → onError → initials (correct degrade).
//
// The CSP (src/renderer/index.html) already allowlists
// `https://avatars.githubusercontent.com` and `https://github.com` in
// img-src, so both avatar URL sources load fine.
//
// Fast + cached: main process (src/main/avatarCache.ts) fetches the avatar
// URL ONCE (sized down to ~40px via a size param) and persists it to disk as
// a data URI, served instantly (and offline) on every subsequent load via
// the `avatar:get` IPC — this applies identically whether the URL came from
// `avatarUrl` or was constructed from `login`, since both are just URLs to
// the same cache. This component degrades through three tiers, never
// blocking render: cached data-URI (once the IPC resolves) → direct sized
// url (immediate, while the IPC is in flight, or if it resolves null) →
// initials circle (no url resolvable, or the <img> itself fails to load).
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

/** Build a `github.com/<login>.png?size=<px>` url — GitHub redirects this to
 *  the real avatars CDN for any real user login, giving every call site with
 *  just a login (no captured avatarUrl) a real avatar. Strips a trailing
 *  `[bot]` suffix (e.g. `coderabbitai[bot]` → `coderabbitai`) since
 *  `github.com/<login>[bot].png` isn't a valid path — the ORIGINAL login is
 *  still used for the initials fallback/alt text, only the constructed url
 *  is affected. Returns null for an empty login (nothing to build from). */
function loginAvatarUrl(login: string, px: number = AVATAR_RENDER_PX * 2): string | null {
  const trimmed = login.trim()
  if (!trimmed) return null
  const bareLogin = trimmed.replace(/\[bot\]$/, '')
  return `https://github.com/${encodeURIComponent(bareLogin)}.png?size=${px}`
}

export interface AvatarProps {
  /** GitHub login, used for the initials/color fallback, the <img>'s alt
   *  text, and (when avatarUrl is absent) to construct a
   *  `github.com/<login>.png` avatar url. Empty string renders '?' (see
   *  initialsOf) since there's nothing to build a url from either. */
  login: string
  /** Real avatar image URL, when the call site's data source captured one.
   *  Null/undefined/empty falls back to a url constructed from `login`
   *  (see `loginAvatarUrl`); only an empty `login` too renders the initials
   *  fallback directly with no image attempted. */
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

/** Shared avatar renderer: a real GitHub avatar image whenever one can be
 *  resolved — either `avatarUrl` (captured directly) or a url constructed
 *  from `login` (`github.com/<login>.png`, redirects to the real CDN) —
 *  falling back to the existing initials-circle (initialsOf + avatarColorFor)
 *  when neither is available OR the image fails to load (broken URL,
 *  offline, blocked, unknown login). The onError→fallback flip uses local
 *  state rather than trying to pre-validate the URL — simplest correct
 *  handling for an <img> that may 404/timeout after mount.
 *
 *  Three-tier degrade for the `src`, never blocking render: the direct sized
 *  url (tier 2) is derived synchronously from `avatarUrl` (preferred) or
 *  `login` so it's available from the very first render, then a `useEffect`
 *  asks main's fetch-once disk cache (`window.api.avatar.get`) for a data URI
 *  and swaps it in once resolved (tier 1 — fast + works offline on repeat
 *  visits) via `cachedSrc` state, which is ONLY ever written from that async
 *  callback (never synchronously in the effect body, to avoid a
 *  cascading-render setState). If the cache call resolves null (fetch/network
 *  failure) or is still in flight, the derived url stays. If the <img> itself
 *  then fails to load (`onError`), tier 3 (initials) takes over. */
export function Avatar({ login, avatarUrl, size = 24, className }: AvatarProps): React.JSX.Element {
  const hasAvatarUrl = typeof avatarUrl === 'string' && avatarUrl.length > 0
  // Resolve the url to attempt: the captured avatarUrl wins when present;
  // otherwise construct one from login so every call site with just a login
  // (general comments, reviews, reviewers, assignees) still gets a real
  // avatar instead of always falling straight to initials.
  const resolvedUrl = hasAvatarUrl ? avatarUrl : loginAvatarUrl(login)
  const hasResolvedUrl = resolvedUrl !== null
  const fallbackSrc = hasAvatarUrl ? sizedAvatarUrl(avatarUrl) : resolvedUrl

  // Cached data-URI, once main's disk cache resolves one for the CURRENT
  // resolvedUrl. Paired with the url it was resolved for (rather than reset
  // via an effect) so a stale cached image from a previous login is ignored
  // the instant resolvedUrl changes, with no synchronous setState-in-effect
  // needed.
  const [cachedSrc, setCachedSrc] = useState<{ forUrl: string; dataUri: string } | null>(null)

  useEffect(() => {
    if (!hasResolvedUrl) return

    let cancelled = false
    window.api.avatar
      .get(resolvedUrl)
      .then((dataUri) => {
        if (!cancelled && dataUri) setCachedSrc({ forUrl: resolvedUrl, dataUri })
      })
      .catch(() => {
        // Cache lookup failed — the derived sized/constructed url stays as `src`.
      })
    return () => {
      cancelled = true
    }
  }, [resolvedUrl, hasResolvedUrl])

  const src = cachedSrc && cachedSrc.forUrl === resolvedUrl ? cachedSrc.dataUri : fallbackSrc

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
