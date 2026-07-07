// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/useAnchoredPopover.ts
//
// Fix #16 (Workbench audit) — GitDiffOptionsPopover.tsx and
// TreeOptionsPopover.tsx each duplicated an identical anchored-popover
// open/anchorPos/buttonRef/handleTriggerClick recipe: capture the trigger
// button's rect on click so a portaled `Overlay` can position itself via
// `fixed` without reading a ref during render (the same recipe
// NewWorkspaceMenu also uses). This hook hoists that shared state/handler so
// both popovers consume ONE implementation instead of two independently-
// editable copies — it owns ONLY the anchor/positioning mechanics; each
// popover's own body (toggle rows, width, labels) is untouched and still
// lives in its own file.
// ---------------------------------------------------------------------------

import { useRef, useState } from 'react'
import type React from 'react'

/** Fixed-position coordinates for the portaled popover, captured from the
 *  trigger button's `getBoundingClientRect()` at open-time. */
export type AnchorPos = { top: number; left: number }

export interface UseAnchoredPopoverResult {
  open: boolean
  setOpen: (open: boolean) => void
  anchorPos: AnchorPos | null
  buttonRef: React.RefObject<HTMLButtonElement | null>
  /** Wire directly to the trigger button's `onClick`. Stops propagation
   *  (mirrors both popovers' original inline handler), toggles closed if
   *  already open, otherwise captures the button's rect and opens. */
  handleTriggerClick: (e: React.MouseEvent) => void
}

/** Shared anchored-popover state + trigger handler — see module header.
 *  Positions the popover 4px below the trigger button's bottom edge, left-
 *  aligned to the button, matching both GitDiffOptionsPopover's and
 *  TreeOptionsPopover's original inline logic exactly. */
export function useAnchoredPopover(): UseAnchoredPopoverResult {
  const [open, setOpen] = useState(false)
  const [anchorPos, setAnchorPos] = useState<AnchorPos | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  function handleTriggerClick(e: React.MouseEvent): void {
    e.stopPropagation()
    if (open) {
      setOpen(false)
      return
    }
    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect) setAnchorPos({ top: rect.bottom + 4, left: rect.left })
    setOpen(true)
  }

  return { open, setOpen, anchorPos, buttonRef, handleTriggerClick }
}
