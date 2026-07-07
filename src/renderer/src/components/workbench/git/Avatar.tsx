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
// Kept as its own component file (not folded into avatarColor.ts) because a
// `.tsx` file that exports both a component and plain functions trips the
// react-refresh/only-export-components lint rule — avatarColor.ts stays a
// plain, JSX-free `.ts` module of pure helpers, this file is the one
// component that consumes them.
// ---------------------------------------------------------------------------

import type React from 'react'
import { useState } from 'react'
import { initialsOf, avatarColorFor } from './avatarColor'

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
 *  <img> that may 404/timeout after mount. */
export function Avatar({ login, avatarUrl, size = 24, className }: AvatarProps): React.JSX.Element {
  const [broken, setBroken] = useState(false)
  const hasImage = !broken && typeof avatarUrl === 'string' && avatarUrl.length > 0

  if (hasImage) {
    return (
      <img
        src={avatarUrl}
        alt={login || 'unknown'}
        width={size}
        height={size}
        className={className}
        style={{ borderRadius: '50%', width: size, height: size, objectFit: 'cover' }}
        onError={() => setBroken(true)}
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
