import { useEffect, useRef } from 'react'
import { reduceHoverGate, isGenuineHover } from './newWorkspaceMenuLogic'

// ---------------------------------------------------------------------------
// useGenuineHoverGate — the React-hook half of the phantom-hover-from-resize
// fix (see newWorkspaceMenuLogic.ts's own header comment on reduceHoverGate/
// isGenuineHover for the full root-cause story: an overlay window whose card
// size changes as a DIRECT consequence of a hover handler — opening a
// provider's flyout submenu grows the card, which grows the host
// BrowserWindow via overlayLayer.ts's setBounds — moves the window under a
// STATIONARY OS cursor across several resize frames, and Chromium delivers a
// perfectly genuine but spurious native mouseenter/mouseleave for that
// transition). reduceHoverGate/isGenuineHover are the pure, assertable half
// (scripts/verify-new-workspace-menu.ts); this hook is just their
// side-effecting continuation (real DOM listeners driving a ref).
//
// Meant to be shared by every overlay kind whose card can resize as a side
// effect of its own hover handling, so the fix lives in exactly one place
// rather than being re-derived per kind. NewWorkspaceMenu.tsx no longer uses
// it (support-multi-harness replaced its flyout submenu with a flat harness
// list) and the footer Model chip's own flyout (ChipGroupedDropdown.tsx) was
// removed outright — check for a current caller before assuming this hook
// is still wired into a live overlay kind.
//
// `onResize` is invoked from the SAME native 'resize' listener that closes
// the gate — callers use this as the clear point for their own JS-tracked
// hovered-row state (see reduceRowHover in newWorkspaceMenuLogic.ts): a
// resize that can leave stale `:hover` state in Chromium must, at minimum,
// never leave a stale JS-highlighted row either, so the same event that
// revokes hover trust also wipes whatever row was hovered.
// ---------------------------------------------------------------------------
export function useGenuineHoverGate(onResize: () => void): () => boolean {
  const hasMovedRef = useRef(true)
  const onResizeRef = useRef(onResize)
  // Sync the ref to the latest callback in an effect (never during render —
  // this repo's react-hooks/refs rule forbids that), same "commit-phase ref
  // sync" pattern used elsewhere for effect-callback freshness.
  useEffect(() => {
    onResizeRef.current = onResize
  })
  useEffect(() => {
    const onResize = (): void => {
      hasMovedRef.current = reduceHoverGate('resize')
      onResizeRef.current()
    }
    const onMouseMove = (): void => {
      hasMovedRef.current = reduceHoverGate('mousemove')
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('mousemove', onMouseMove, { capture: true })
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('mousemove', onMouseMove, { capture: true })
    }
  }, [])
  return () => isGenuineHover(hasMovedRef.current)
}
