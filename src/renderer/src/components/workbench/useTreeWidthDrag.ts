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
//
// PERF FIX (LAG-LAYER #4): `width` used to be written to React state on
// EVERY mousemove tick. That state lived above the diff pane (GitTab's
// DiffContentPane / FilesTab's ContentPane), so every drag frame forced a
// full React re-render of the whole tree+diff subtree — and because
// @pierre/diffs isn't virtualized, each of THOSE re-renders re-applied the
// full diff DOM, pinning the main thread proportional to diff size for the
// whole drag gesture. Now the live value during an active drag is written
// straight to a CSS variable (`--tree-width`) on an imperative ref via
// `requestAnimationFrame` — no React state changes at all while dragging —
// and `liveWidth` (the React-visible `width`) is only committed once, on
// mouseup. Callers apply `style={{ width: 'var(--tree-width)' }}` plus the
// `treeWidthVarRef` below on the SAME element that used to read `width`
// directly, and keep reading `width` for the non-drag (initial/persisted)
// render.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { WORKBENCH_TREE_WIDTH_MIN, WORKBENCH_TREE_WIDTH_MAX } from '@shared/uiStateDefaults'

/** CSS custom property the drag writes to imperatively — see the module
 *  header's PERF FIX note. Consumers set `width: var(--tree-width)` (or
 *  reference this constant) on the SAME element `treeWidthVarRef` attaches
 *  to. */
export const TREE_WIDTH_CSS_VAR = '--tree-width'

export interface TreeWidthDrag {
  /** Width (px) to render the tree pane at — the COMMITTED value (updates on
   *  mouseup and on an external persisted-width change), NOT live per-frame
   *  during a drag. Use for the element's `style.width` initial/fallback
   *  value; `treeWidthVarRef` overrides it live via CSS var while dragging. */
  width: number
  /** True while a drag is in progress (for divider hover/active styling). */
  isDragging: boolean
  /** Attach to the divider's `onMouseDown`. */
  beginDrag: (e: React.MouseEvent) => void
  /** Attach to the tree-pane wrapper element (the one whose `style.width`
   *  should track the drag). The hook writes `--tree-width` on this node via
   *  rAF on every mousemove — wire the wrapper's inline style to
   *  `width: 'var(--tree-width)'` (falling back to `width`'s px value before
   *  the ref attaches) so the live drag never flows through React state. */
  treeWidthVarRef: React.RefCallback<HTMLElement>
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
  // `liveWidth` is now the COMMITTED width only — set on mount/persisted-value
  // sync and once more on mouseup. It deliberately does NOT update per drag
  // frame anymore (see the module header's PERF FIX note); the live value
  // during an active drag lives entirely in `liveWidthRef` + the CSS var
  // written directly to the DOM node below.
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

  // The tree-pane wrapper DOM node — the CSS var is written directly onto
  // this element via rAF while dragging, bypassing React state entirely.
  const nodeRef = useRef<HTMLElement | null>(null)
  const treeWidthVarRef = useCallback((node: HTMLElement | null) => {
    nodeRef.current = node
    if (node !== null) node.style.setProperty(TREE_WIDTH_CSS_VAR, `${liveWidthRef.current}px`)
  }, [])
  // Keep the CSS var in sync whenever the COMMITTED width changes outside a
  // drag (mount, external/shared-value sync, post-drag commit) — otherwise a
  // non-drag width change (e.g. the other tab dragging the shared value)
  // would only reach `width`'s fallback, not the var an already-attached
  // wrapper is actively rendering from.
  useEffect(() => {
    nodeRef.current?.style.setProperty(TREE_WIDTH_CSS_VAR, `${liveWidth}px`)
  }, [liveWidth])

  const cleanupRef = useRef<() => void>(() => {})

  const beginDrag = useCallback((startEvent: React.MouseEvent) => {
    startEvent.preventDefault()
    const startX = startEvent.clientX
    const startWidth = liveWidthRef.current
    draggingRef.current = true
    setIsDragging(true)

    // rAF-batched: mousemove can fire far faster than the display refresh
    // rate; only the LATEST pending value per frame is written to the DOM,
    // and it's a direct style mutation (no React state, no re-render) — the
    // fix for the tree-drag re-render storm (LAG-LAYER #4).
    let rafId: number | null = null
    let pendingWidth = startWidth

    function flush(): void {
      rafId = null
      nodeRef.current?.style.setProperty(TREE_WIDTH_CSS_VAR, `${pendingWidth}px`)
    }

    function handleMouseMove(moveEvent: MouseEvent): void {
      // Divider sits between tree (left) and content (right) — dragging
      // right (positive dx) widens the tree.
      const dx = moveEvent.clientX - startX
      const next = Math.min(
        WORKBENCH_TREE_WIDTH_MAX,
        Math.max(WORKBENCH_TREE_WIDTH_MIN, startWidth + dx)
      )
      liveWidthRef.current = next
      pendingWidth = next
      if (rafId === null) rafId = requestAnimationFrame(flush)
    }

    function handleMouseUp(): void {
      draggingRef.current = false
      setIsDragging(false)
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      cleanupRef.current = () => {}
      // Commit to React state exactly ONCE, on drag-end — this is the only
      // point after mousedown where the width flows through React again.
      setLiveWidth(liveWidthRef.current)
      onCommitRef.current(liveWidthRef.current)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    cleanupRef.current = () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
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

  return { width: liveWidth, isDragging, beginDrag, treeWidthVarRef }
}
