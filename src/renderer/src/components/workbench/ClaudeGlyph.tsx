// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/ClaudeGlyph.tsx
//
// Hand-authored "sunburst" glyph used in place of the terminal icon in the
// Workbench-enabled workspace title bar (U3,
// docs/plans/2026-07-02-001-feat-workbench-panes-plan.md). This is an
// original inline SVG — NOT a reproduction of the Anthropic/Claude wordmark
// or logo (trademarked brand IP) — a simple set of tapered spokes radiating
// from a center, drawn with fill="currentColor" so it themes with the top
// bar the same way the Phosphor icons it sits next to do.
// ---------------------------------------------------------------------------

import type React from 'react'

export interface ClaudeGlyphProps {
  /** Pixel size of the (square) icon. Mirrors the Phosphor icon `size` prop. */
  size?: number
  className?: string
}

const SPOKE_COUNT = 12

export function ClaudeGlyph({ size = 13, className }: ClaudeGlyphProps): React.JSX.Element {
  const view = 24
  const center = view / 2
  const outerRadius = 11
  const innerRadius = 3.2
  const spokeHalfWidth = 1.15

  const spokes: string[] = []
  for (let i = 0; i < SPOKE_COUNT; i++) {
    const angle = (i / SPOKE_COUNT) * Math.PI * 2 - Math.PI / 2
    const perp = angle + Math.PI / 2

    const tipX = center + Math.cos(angle) * outerRadius
    const tipY = center + Math.sin(angle) * outerRadius

    const baseLX = center + Math.cos(angle) * innerRadius + Math.cos(perp) * spokeHalfWidth
    const baseLY = center + Math.sin(angle) * innerRadius + Math.sin(perp) * spokeHalfWidth
    const baseRX = center + Math.cos(angle) * innerRadius - Math.cos(perp) * spokeHalfWidth
    const baseRY = center + Math.sin(angle) * innerRadius - Math.sin(perp) * spokeHalfWidth

    spokes.push(`M ${baseLX} ${baseLY} L ${tipX} ${tipY} L ${baseRX} ${baseRY} Z`)
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${view} ${view}`}
      fill="currentColor"
      className={className}
      role="img"
      aria-label="Claude"
    >
      <path d={spokes.join(' ')} />
    </svg>
  )
}
