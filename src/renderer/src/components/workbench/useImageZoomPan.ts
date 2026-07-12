// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/useImageZoomPan.ts
//
// Zoom + pan state for the Files-tab raster IMAGE viewer (FilesTab.tsx's
// ImageBody). Extracted out of FilesTab.tsx to keep that file's cognitive
// complexity down (CLAUDE.md's 20-ceiling ratchet) — this hook owns all the
// scale/offset math and event wiring; ImageBody just applies the returned
// CSS transform + spreads the returned drag handlers onto the <img>.
//
// Model: `scale` is a multiplier over "fit" (object-contain sizing) — 1 means
// fit, matching the floating bar's "click % to reset to fit" contract in the
// requirements. `offset` is a pan translation in CSS pixels, meaningful only
// once `scale > 1` (panning while at fit is a no-op visually, since there's no
// overflow to reveal). Ctrl/Cmd+wheel zooms (plain wheel is left alone so the
// viewer's own scroll/overflow behavior for a genuinely huge image, or just
// scrolling the page, isn't hijacked — the safer of the two options called
// out in the ask). Drag-to-pan is only wired while zoomed past fit.
// ---------------------------------------------------------------------------

import { useCallback, useMemo, useRef, useState } from 'react'
import type React from 'react'

/** Multiplier bounds over "fit" — matches the ask's 0.1x-8x clamp. */
const MIN_SCALE = 0.1
const MAX_SCALE = 8
/** Per-wheel-notch zoom step (multiplicative, so it feels consistent at any
 *  current scale rather than a fixed additive step). */
const WHEEL_ZOOM_FACTOR = 1.1
/** Step used by the floating bar's +/- buttons. */
const BUTTON_ZOOM_FACTOR = 1.25
/** Tolerance for "close enough to fit (scale=1)" — repeated multiplicative
 *  zoomBy() steps (e.g. zoom in N times then out N times) accumulate float
 *  drift and will rarely land on an EXACT 1.0, so both `isFit` and the
 *  snap-back-to-fit check below compare against this epsilon rather than
 *  `=== 1`. */
const FIT_EPSILON = 1e-3

export interface ImageZoomPanState {
  /** Current scale multiplier over "fit" (1 = fit). */
  scale: number
  /** Whether we're at (or numerically indistinguishable from) fit — drives
   *  the bar's "%"/fit label and whether panning is enabled. */
  isFit: boolean
  /** The transform to apply to the image element. */
  style: React.CSSProperties
  /** Cursor class for the image container — grab/grabbing while zoomed,
   *  default at fit (nothing to pan). */
  cursorClassName: string
  zoomIn: () => void
  zoomOut: () => void
  /** Reset to fit (scale=1, offset=0) — the bar's "%" label click target. */
  resetToFit: () => void
  onWheel: (e: React.WheelEvent<HTMLElement>) => void
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void
  onPointerMove: (e: React.PointerEvent<HTMLElement>) => void
  onPointerUp: (e: React.PointerEvent<HTMLElement>) => void
}

function clampScale(next: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, next))
}

interface DragState {
  pointerId: number
  startX: number
  startY: number
  origin: { x: number; y: number }
}

/** Zoom + pan state machine for one image viewport. `resetKey` should change
 *  whenever the viewed image changes (e.g. the selected path) — the hook
 *  resets scale/offset to fit whenever it sees a new key, mirroring the
 *  "reset zoom/pan when the image changes" requirement without the caller
 *  needing to manage a `key`-remount (which would also drop the pointer
 *  handlers mid-drag on fast selection changes). */
export function useImageZoomPan(resetKey: string | null): ImageZoomPanState {
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const dragRef = useRef<DragState | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  // Tracks the resetKey we've already reset for, in STATE (not a ref) so the
  // "key changed -> reset derived state" adjustment can happen synchronously
  // during render (the documented React pattern — see "Adjusting state when
  // a prop changes" in the React docs) without tripping either
  // react-hooks/refs (no ref read/write during render) or
  // react-hooks/set-state-in-effect (no setState inside a useEffect body).
  // `dragRef` itself doesn't need clearing here: a stale entry is harmless
  // (onPointerMove/onPointerUp already gate on a matching pointerId, and a
  // fresh onPointerDown unconditionally overwrites it), and `isDragging`
  // false already reflects "not currently panning".
  const [lastResetKey, setLastResetKey] = useState(resetKey)
  if (lastResetKey !== resetKey) {
    setLastResetKey(resetKey)
    setScale(1)
    setOffset({ x: 0, y: 0 })
    setIsDragging(false)
  }

  const isFit = Math.abs(scale - 1) < FIT_EPSILON

  const resetToFit = useCallback(() => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }, [])

  const zoomBy = useCallback((factor: number) => {
    setScale((s) => {
      const next = clampScale(s * factor)
      // Snapping back through (near) 1 clears any residual pan so "zoom out
      // to fit" behaves like an explicit reset, not a stray near-zero offset
      // left over from float drift across repeated multiplicative steps.
      if (Math.abs(next - 1) < FIT_EPSILON) setOffset({ x: 0, y: 0 })
      return next
    })
  }, [])

  const zoomIn = useCallback(() => zoomBy(BUTTON_ZOOM_FACTOR), [zoomBy])
  const zoomOut = useCallback(() => zoomBy(1 / BUTTON_ZOOM_FACTOR), [zoomBy])

  // Ctrl/Cmd+wheel zooms; plain wheel is left alone (the safer default per the
  // ask — a trackpad pinch or an accidental scroll over the image shouldn't
  // hijack zoom, and overflow scrolling still works when not zoomed).
  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLElement>) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      zoomBy(e.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR)
    },
    [zoomBy]
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (isFit) return
      e.currentTarget.setPointerCapture(e.pointerId)
      dragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        origin: offset
      }
      setIsDragging(true)
    },
    [isFit, offset]
  )

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    setOffset({
      x: drag.origin.x + (e.clientX - drag.startX),
      y: drag.origin.y + (e.clientY - drag.startY)
    })
  }, [])

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    dragRef.current = null
    setIsDragging(false)
  }, [])

  const style = useMemo<React.CSSProperties>(
    () => ({
      transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
      transformOrigin: 'center center',
      transition: isDragging ? 'none' : 'transform 60ms ease-out'
    }),
    [offset, scale, isDragging]
  )

  const cursorClassName = isFit ? '' : isDragging ? 'cursor-grabbing' : 'cursor-grab'

  return {
    scale,
    isFit,
    style,
    cursorClassName,
    zoomIn,
    zoomOut,
    resetToFit,
    onWheel,
    onPointerDown,
    onPointerMove,
    onPointerUp
  }
}
