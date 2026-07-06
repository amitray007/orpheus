// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/useTreeWidthDrag.ts
//
// Draggable tree/code split — the changed-files tree pane (FilesTab.tsx) and
// the Git tab's DiffTreePane both used a FIXED `w-60` (240px) tree width,
// which truncates long filenames badly (live QA finding). This hook adds a
// local mousemove/mouseup drag handler for a divider between the tree and
// the content pane, clamped 160–560px, that commits to the shared DB-backed
// `AppUiState.workbenchTreeWidth` (ONE value for both Files + Git — see
// uiState.ts/schema.ts's `workbench_tree_width` column) on drag-end.
//
// Deliberately NOT reusing `beginDividerDrag` from workbenchReducer.ts: that
// drag is coupled to the Workbench frame's own dormant/open/expanded state
// machine (snap-to-expanded threshold, `availableWidth` relative to the
// claude column, `WorkbenchEntry` storage) — none of which applies here.
// This hook matches its VISUAL feel (thin `cursor-col-resize` handle, accent
// hover, drag tracked via clientX delta, clamped) without borrowing its
// unrelated state machine.
//
// Persistence model: only the DB write is throttled to drag-END (not
// continuous), per the task's "drag-end is fine + simplest" — the local
// `liveWidth` state tracks the drag in real time for a responsive feel, and
// `onCommit` (wired to `updateUiState({ workbenchTreeWidth })`) fires once on
// mouseup. `liveWidth` re-syncs to the persisted `width` prop whenever it
// changes AND no drag is in progress, so a change from the OTHER tab (shared
// value) or a fresh `uiState.get()` resolving is reflected immediately.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { WORKBENCH_TREE_WIDTH_MIN, WORKBENCH_TREE_WIDTH_MAX } from '@shared/uiStateDefaults'

export { WORKBENCH_TREE_WIDTH_MIN, WORKBENCH_TREE_WIDTH_MAX }

export interface TreeWidthDrag {
  /** Width (px) to render the tree pane at right now — tracks the drag live. */
  width: number
  /** True while a drag is in progress (for divider hover/active styling). */
  isDragging: boolean
  /** Attach to the divider's `onMouseDown`. */
  beginDrag: (e: React.MouseEvent) => void
}

/**
 * `persistedWidth` is the current DB-backed value (already clamped by the
 * main process on read — see uiState.ts's rowToRecord). `onCommit` is called
 * with the final clamped width once per completed drag.
 */
export function useTreeWidthDrag(
  persistedWidth: number,
  onCommit: (width: number) => void
): TreeWidthDrag {
  const [liveWidth, setLiveWidth] = useState(persistedWidth)
  const [isDragging, setIsDragging] = useState(false)

  // Re-sync to the persisted value when it changes from elsewhere (the other
  // tab dragging the SAME shared width, or the initial uiState.get()
  // resolving) — but never while this instance is mid-drag, which would
  // fight the live tracking below.
  const draggingRef = useRef(false)
  useEffect(() => {
    if (!draggingRef.current) setLiveWidth(persistedWidth)
  }, [persistedWidth])

  const onCommitRef = useRef(onCommit)
  useEffect(() => {
    onCommitRef.current = onCommit
  }, [onCommit])

  // Mirrors liveWidth into a ref so `beginDrag` (stable identity) always
  // starts a new drag from the LATEST width, without needing to be recreated
  // whenever liveWidth changes.
  const liveWidthRef = useRef(liveWidth)
  useEffect(() => {
    liveWidthRef.current = liveWidth
  }, [liveWidth])

  const cleanupRef = useRef<() => void>(() => {})

  const beginDrag = useCallback((startEvent: React.MouseEvent) => {
    startEvent.preventDefault()
    const startX = startEvent.clientX
    const startWidth = liveWidthRef.current
    draggingRef.current = true
    setIsDragging(true)

    function handleMouseMove(moveEvent: MouseEvent): void {
      // Divider sits between tree (left) and content (right) — dragging
      // right (positive dx) widens the tree.
      const dx = moveEvent.clientX - startX
      const next = Math.min(
        WORKBENCH_TREE_WIDTH_MAX,
        Math.max(WORKBENCH_TREE_WIDTH_MIN, startWidth + dx)
      )
      liveWidthRef.current = next
      setLiveWidth(next)
    }

    function handleMouseUp(): void {
      draggingRef.current = false
      setIsDragging(false)
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      cleanupRef.current = () => {}
      onCommitRef.current(liveWidthRef.current)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    cleanupRef.current = () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
    // Intentionally stable (empty deps): reads startWidth off liveWidthRef
    // (kept in sync above), not the `liveWidth` state value, so this callback
    // doesn't need to be recreated every drag tick.
  }, [])

  // Unmount safety net — same pattern as workbenchReducer.ts's beginDividerDrag.
  useEffect(() => {
    return () => cleanupRef.current()
  }, [])

  return { width: liveWidth, isDragging, beginDrag }
}
