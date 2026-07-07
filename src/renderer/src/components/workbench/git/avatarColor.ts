// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/git/avatarColor.ts
//
// Shared GitHub-login -> initials/avatar-color helpers, used by the shared
// <Avatar> component (./Avatar.tsx) as its no-image fallback rendering, and
// previously used directly by DetailsTab.tsx / ReviewCommentThread.tsx before
// both call sites switched to <Avatar>. These were originally byte-identical
// copies in each file — the whole point of `avatarColorFor` is that the SAME
// login always maps to the SAME color everywhere it renders (description
// card, timeline, sidebar, inline review thread), so duplicating it risked
// the two copies drifting (a hash-function tweak in one file silently NOT
// applying to the other). Hoisted here as a pure, stateless module (no React,
// no app state, kept a plain .ts rather than .tsx so it can freely export
// multiple non-component functions without tripping the
// react-refresh/only-export-components lint rule that a `.tsx` file with
// mixed component/non-component exports would hit).
// ---------------------------------------------------------------------------

/** GitHub-login → 1-2 letter avatar initial. Used as <Avatar>'s fallback
 *  rendering when no avatarUrl is available (or the image fails to load). */
export function initialsOf(login: string): string {
  const trimmed = login.trim()
  if (trimmed.length === 0) return '?'
  return trimmed.slice(0, 2).toUpperCase()
}

// A small fixed palette keyed off a stable hash of the login, so the same
// author always gets the same color across every surface that renders an
// avatar, without needing a lookup table of real GitHub users.
const AVATAR_COLORS = ['#d4a847', '#7c8cff', '#3fb950', '#f0883e', '#b18cf0', '#58a6ff', '#e0688f']

export function avatarColorFor(login: string): string {
  let hash = 0
  for (let i = 0; i < login.length; i++) hash = (hash * 31 + login.charCodeAt(i)) | 0
  const idx = Math.abs(hash) % AVATAR_COLORS.length
  return AVATAR_COLORS[idx]
}
