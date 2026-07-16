// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/ImageZoomBar.tsx
//
// Floating [- | %/fit | +] toolbar for the Files-tab raster image viewer
// (FilesTab.tsx's ImageBody), absolutely-positioned bottom-center INSIDE the
// image viewport it controls — anchored within the workbench pane, never
// window-spanning (no fixed inset-0). Styled like TreeOptionsPopover's
// surface-overlay/border/rounded chrome so it reads as the same app-native
// floating-panel family.
// ---------------------------------------------------------------------------

import type React from 'react'
import { Minus, Plus } from '@phosphor-icons/react'
import type { ImageZoomPanState } from './useImageZoomPan'

interface ImageZoomBarProps {
  zoom: Pick<ImageZoomPanState, 'scale' | 'isFit' | 'zoomIn' | 'zoomOut' | 'resetToFit'>
}

const BAR_BUTTON_CLASS =
  'p-1 rounded text-text-muted hover:bg-surface-raised hover:text-text-primary disabled:opacity-40 disabled:pointer-events-none'

/** The bottom-center floating zoom bar. `isFit` shows a "Fit" label; otherwise
 *  the current scale as a percentage — either way, clicking the label resets
 *  to fit (per the ask: "a %/fit label (click = reset to fit)"). */
export function ImageZoomBar({ zoom }: ImageZoomBarProps): React.JSX.Element {
  const { scale, isFit, zoomIn, zoomOut, resetToFit } = zoom
  const label = isFit ? 'Fit' : `${Math.round(scale * 100)}%`
  return (
    <div
      className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-0.5 px-1 py-1 rounded-md border border-border-default bg-surface-overlay shadow-lg select-none"
      role="toolbar"
      aria-label="Image zoom"
    >
      <button
        type="button"
        onClick={zoomOut}
        title="Zoom out"
        aria-label="Zoom out"
        className={BAR_BUTTON_CLASS}
      >
        <Minus size={14} />
      </button>
      <button
        type="button"
        onClick={resetToFit}
        title="Reset to fit"
        aria-label="Reset zoom to fit"
        disabled={isFit}
        className="min-w-[3.5rem] px-1.5 py-0.5 rounded text-[11px] font-medium text-text-secondary hover:bg-surface-raised hover:text-text-primary disabled:opacity-70 disabled:pointer-events-none tabular-nums"
      >
        {label}
      </button>
      <button
        type="button"
        onClick={zoomIn}
        title="Zoom in"
        aria-label="Zoom in"
        className={BAR_BUTTON_CLASS}
      >
        <Plus size={14} />
      </button>
    </div>
  )
}
