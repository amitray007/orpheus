// ---------------------------------------------------------------------------
// src/renderer/src/components/ProviderIcon.tsx
//
// Provider brand mark, used in two places: the workspace-creation popover's
// provider rows (NewWorkspaceMenu.tsx) and the sidebar workspace row's
// provider-icon prefix slot (Sidebar.tsx). One shared component so both
// call sites resolve the icon identically.
//
// THEME REACTIVITY — no React state, no `prefers-color-scheme`, no second
// theme mechanism: Orpheus's existing [data-theme] CSS-variable cascade
// (main.css) already re-resolves `--color-text-primary`/`--color-text-
// secondary` live whenever Dashboard.tsx flips `document.documentElement.
// dataset.theme` (driven by the user's Appearance setting, see
// OrpheusAppearanceSection.tsx) — with zero JS re-render required, because
// it's a CSS custom-property cascade, not a value read once at mount. Two
// icon techniques share that SAME cascade:
//
//   - OpenAI / Grok: the source marks are a single monochrome path with NO
//     baked-in brand color (verified against the raw SVGs — light variant
//     ships with no `fill` at all / dark ships `fill="#fff"`, i.e. both are
//     literally the same geometry with only the fill swapped). Rather than
//     ship two fixed-color assets and pick one, the committed asset has its
//     path recolored to `fill="currentColor"` and is inlined via
//     dangerouslySetInnerHTML (same pattern Identicon.tsx already uses for a
//     build-time-trusted, non-user SVG string) so it inherits the
//     `text-text-secondary` Tailwind utility on its wrapper — which is
//     ALREADY theme-reactive via the cascade above. One asset, one
//     mechanism, live-swaps with the rest of the chrome.
//
//   - Claude / Antigravity: no dark variant exists (verified: both 404 for
//     any `-dark`/`light` filename). Both are fixed-color brand marks (Claude
//     is a solid terracotta path; Antigravity is a multicolor gradient
//     logo) — recoloring them via currentColor would break the brand mark
//     entirely, and both are legible against both a light and a dark
//     surface as shipped (this is the same treatment already given to the
//     Claude glyph elsewhere in the app — see ClaudeGlyph.tsx, which also
//     renders claude-icon.svg verbatim via <img> with no theme handling).
//     Rendered via plain <img src>, unaffected by theme.
// ---------------------------------------------------------------------------

import type React from 'react'
import claudeIconUrl from '@/assets/providers/claude.svg'
import antigravityIconUrl from '@/assets/providers/antigravity.svg'
import openaiIconRaw from '@/assets/providers/openai.svg?raw'
import grokIconRaw from '@/assets/providers/grok.svg?raw'

/** Provider ids this component knows how to render an icon for. Mirrors the
 *  SelectableModel.providerId value space: 'claude' (the always-present,
 *  non-routed group) plus the routed provider ids from
 *  routingProxy/providers/registry.ts. An id outside this set (e.g. a
 *  removed/unknown provider) renders nothing rather than a broken image. */
export type KnownProviderIconId = 'claude' | 'codex' | 'xai' | 'antigravity'

function isKnownProviderIconId(id: string): id is KnownProviderIconId {
  return id === 'claude' || id === 'codex' || id === 'xai' || id === 'antigravity'
}

interface ProviderIconProps {
  /** A SelectableModel.providerId value ('claude' | 'codex' | 'xai' |
   *  'antigravity'). Any other id (e.g. a removed provider like 'ollama',
   *  or 'unknown') renders nothing. */
  providerId: string
  /** Pixel size of the (square) icon box. */
  size?: number
  className?: string
}

export function ProviderIcon({
  providerId,
  size = 12,
  className
}: ProviderIconProps): React.JSX.Element | null {
  if (!isKnownProviderIconId(providerId)) return null

  const boxStyle = { width: size, height: size, minWidth: size, minHeight: size }

  if (providerId === 'claude') {
    return (
      <img
        src={claudeIconUrl}
        width={size}
        height={size}
        style={{ ...boxStyle, objectFit: 'contain' }}
        className={['inline-block flex-shrink-0', className].filter(Boolean).join(' ')}
        draggable={false}
        alt="Claude"
      />
    )
  }

  if (providerId === 'antigravity') {
    return (
      <img
        src={antigravityIconUrl}
        width={size}
        height={size}
        style={{ ...boxStyle, objectFit: 'contain' }}
        className={['inline-block flex-shrink-0', className].filter(Boolean).join(' ')}
        draggable={false}
        alt="Antigravity"
      />
    )
  }

  // codex (OpenAI) / xai (Grok) — currentColor marks, inherit
  // text-text-secondary so they follow the live [data-theme] cascade with no
  // JS theme read and no re-render on theme change.
  const raw = providerId === 'codex' ? openaiIconRaw : grokIconRaw
  const label = providerId === 'codex' ? 'OpenAI' : 'Grok'
  return (
    <span
      role="img"
      aria-label={label}
      style={boxStyle}
      className={[
        'inline-flex items-center justify-center flex-shrink-0 text-text-secondary [&>svg]:w-full [&>svg]:h-full',
        className
      ]
        .filter(Boolean)
        .join(' ')}
      dangerouslySetInnerHTML={{ __html: raw }}
    />
  )
}
