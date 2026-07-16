import type React from 'react'
import type { NoticeBannerProps } from '@shared/types'
import type { OverlayKindProps } from '../registry'

// ---------------------------------------------------------------------------
// NoticeBanner — WorkspaceView's one-time notice (e.g. "started fresh on
// branch X") migrated to the overlay layer (U9). Non-interactive
// (acceptsClicks: false, takesFocus: false) — purely informational, so it
// never emits events. Auto-hide is driven by the call site's own timer
// (hideOverlayCard after the existing 6s display duration), matching the
// chassis-free JSX it replaces exactly (same copy, spacing, and pill chrome —
// just anchored via the overlay layer instead of an absolutely-positioned
// <div> inside the terminal container, which was the one placement that
// risked being occluded by a live libghostty surface, see
// docs/learnings/overlay-child-window-macos.md).
//
// FIXED width (w-96 = 384px, matching the chassis-free markup's max-w-sm
// upper bound), not max-content: the overlay layer's anchored-placement
// algorithm (main/overlayLayer.ts computeAnchoredPlacement) only supports
// edge-flush placement (x = anchor.x), not "centered under/above anchor" — so
// overlayClient.showNoticeBanner centers the anchor strip against THIS exact
// width to reproduce the original `left-1/2 -translate-x-1/2` centering. A
// variable max-content width would only self-correct after the first
// reportSize round-trip (a visible one-frame horizontal jump); fixing the
// width keeps the very first paint centered.
// ---------------------------------------------------------------------------

export function NoticeBanner({ props }: OverlayKindProps): React.JSX.Element {
  const data = props as unknown as NoticeBannerProps
  const { message } = data

  return (
    <div className="w-96 px-4 py-2.5 rounded-lg bg-surface-overlay/95 border border-border-default shadow-lg flex items-center gap-2.5 font-[family-name:var(--font-sans)]">
      <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
      <span className="text-xs text-text-secondary leading-snug">{message}</span>
    </div>
  )
}
