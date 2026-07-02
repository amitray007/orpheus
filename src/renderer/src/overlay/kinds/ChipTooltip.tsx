import type React from 'react'
import type { ChipTooltipProps } from '@shared/types'
import type { OverlayKindProps } from '../registry'

// ---------------------------------------------------------------------------
// ChipTooltip — U9 React migration of the footer ActionChip's transient
// hover-label (chassis-free `ChipTooltip` component in ActionChip.tsx),
// which opened bottom-full (upward into the terminal rect) and was occluded
// by the live terminal. Same styling, now anchored via the overlay layer.
// Non-interactive: acceptsClicks: false, takesFocus: false — never emits
// events; the call site hides it directly (showChipTooltip re-show / a timer
// / mouseleave), same as the chassis-free version's setTimeout-driven hide.
// ---------------------------------------------------------------------------

export function ChipTooltip({ props }: OverlayKindProps): React.JSX.Element {
  const data = props as unknown as ChipTooltipProps
  return (
    <div className="px-2 py-1 rounded text-xs text-text-primary bg-surface-overlay border border-border-default shadow-md whitespace-nowrap font-[family-name:var(--font-sans)]">
      {data.text}
    </div>
  )
}
