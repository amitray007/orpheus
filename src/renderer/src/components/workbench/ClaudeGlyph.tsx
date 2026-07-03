// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/ClaudeGlyph.tsx
//
// Claude brand icon, provided by the user, rendered from
// src/renderer/src/assets/claude-icon.svg. Used in place of the terminal
// icon in the Workbench-enabled workspace title bar (U3,
// docs/plans/2026-07-02-001-feat-workbench-panes-plan.md).
// ---------------------------------------------------------------------------

import type React from 'react'
import claudeIconUrl from '@/assets/claude-icon.svg'

export interface ClaudeGlyphProps {
  /** Pixel size of the (square) icon. Mirrors the Phosphor icon `size` prop. */
  size?: number
  className?: string
}

export function ClaudeGlyph({ size = 13, className }: ClaudeGlyphProps): React.JSX.Element {
  return (
    <img
      src={claudeIconUrl}
      width={size}
      height={size}
      className={className}
      style={{ objectFit: 'contain' }}
      draggable={false}
      alt="Claude"
    />
  )
}
