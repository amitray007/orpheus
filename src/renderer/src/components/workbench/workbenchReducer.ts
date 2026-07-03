// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/workbenchReducer.ts
//
// U4 (P1) — the Workbench dormant/open/expanded state machine's PURE parts:
// the transition reducer, its types, the shared context, and the
// `useWorkbenchState` hook that drives it
// (docs/plans/2026-07-02-001-feat-workbench-panes-plan.md;
// docs/brainstorms/2026-07-02-workbench-panes-requirements.md §4).
//
// Deliberately split out of a plain `.tsx` component file: this module has no
// JSX of its own (react-refresh/only-export-components forbids mixing
// non-component exports like `workbenchReducer`/hooks into a file that also
// exports a component — see WorkbenchProvider.tsx, the one component that
// wraps this context).
//
// The transition table is pure and small enough to verify exhaustively by
// inspection (the `never` fallthrough below makes an unhandled action a
// compile error) AND is exercised directly by
// `scripts/verify-workbench-reducer.ts` (there is no renderer test runner in
// this repo, see CLAUDE.md, so that script is a plain assert-based check
// rather than a framework-based test — run via `bun run test:workbench`).
//
// State is EPHEMERAL (plain React state) for U4 — no persistence to the DB.
// A later unit can persist width/last-state if desired.
// ---------------------------------------------------------------------------

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'

export type WorkbenchState = 'dormant' | 'open' | 'expanded'

export type WorkbenchAction =
  | { type: 'open' }
  | { type: 'toggleExpand' }
  | { type: 'restoreToOpen' }
  | { type: 'close' }
  | { type: 'stepDown' }
  | { type: 'toggle' }

/**
 * Pure transition function: (state, action) -> next state. Exhaustive switch
 * over both state and action so an unhandled combination is a compile error
 * (the `never` fallthrough below), not a silent no-op bug.
 *
 * Transition table (docs/brainstorms/2026-07-02-workbench-panes-requirements.md §4):
 *   - open:          dormant -> open;                     open/expanded -> unchanged (already open)
 *   - toggleExpand:  open -> expanded, expanded -> open;   dormant -> unchanged (no-op, nothing to expand)
 *   - restoreToOpen: expanded -> open;                     dormant/open -> unchanged
 *   - close:         any -> dormant
 *   - stepDown:      expanded -> open, open -> dormant, dormant -> unchanged (no-op)
 *   - toggle (Cmd/Ctrl+\): dormant -> open; open|expanded -> dormant
 */
export function workbenchReducer(state: WorkbenchState, action: WorkbenchAction): WorkbenchState {
  switch (action.type) {
    case 'open':
      return state === 'dormant' ? 'open' : state
    case 'toggleExpand':
      if (state === 'open') return 'expanded'
      if (state === 'expanded') return 'open'
      return state
    case 'restoreToOpen':
      return state === 'expanded' ? 'open' : state
    case 'close':
      return 'dormant'
    case 'stepDown':
      if (state === 'expanded') return 'open'
      if (state === 'open') return 'dormant'
      return state
    case 'toggle':
      return state === 'dormant' ? 'open' : 'dormant'
    default: {
      const _exhaustive: never = action
      return _exhaustive
    }
  }
}

export const DEFAULT_WORKBENCH_WIDTH = 460
// Floor chosen so the full Git · Terminal · Files · Panes tab row plus the
// expand/collapse + close controls stay visible without the last tab ("Panes")
// being clipped or scrolled behind the controls. Do not lower below this
// without shrinking the tab row.
export const MIN_WORKBENCH_WIDTH = 400
// Snap threshold: dragging the divider so the workbench frame would occupy
// more than this fraction of the available (claude + workbench) width snaps
// straight into 'expanded' instead of continuing to track the drag as a huge
// 'open' width.
const EXPAND_SNAP_FRACTION = 0.8

export interface WorkbenchApi {
  state: WorkbenchState
  /** Docked ("open") width in px. Not meaningful/used while dormant or expanded. */
  width: number
  open: () => void
  toggleExpand: () => void
  restoreToOpen: () => void
  close: () => void
  stepDown: () => void
  toggle: () => void
  /** Begin a divider drag. `availableWidth` is the total width (claude column
   *  + workbench frame) the divider is distributing, used to compute the
   *  expand-snap threshold. Attaches its own document-level move/up listeners
   *  and cleans them up on mouseup — call from the divider's onMouseDown. */
  beginDividerDrag: (startEvent: React.MouseEvent, availableWidth: number) => void
  isDraggingDivider: boolean
}

export const WorkbenchContext = createContext<WorkbenchApi | null>(null)

export function useWorkbenchApi(): WorkbenchApi | null {
  return useContext(WorkbenchContext)
}

/**
 * The state machine hook. Mounted ONCE (in WorkspaceView, unconditionally —
 * hooks can't be called conditionally) and provided via WorkbenchProvider so
 * both WorkbenchPanel (the frame) and WorkspaceTitleBar (the "Workbench"
 * button + section-2 restore control) can read/drive the same state.
 *
 * `enabled` gates the keyboard listener (Cmd/Ctrl+\ toggle, Esc step-down):
 * when false (workbenchEnabled off), the keydown effect is a no-op and binds
 * NO window listener at all, per the flag-off byte-identical requirement —
 * WorkspaceView only ever wraps children in WorkbenchProvider when the flag
 * is on, so a disabled hook instance is never actually consulted, but the
 * `enabled` gate keeps the hook itself inert regardless.
 */
export function useWorkbenchState(enabled: boolean): WorkbenchApi {
  const [state, setState] = useState<WorkbenchState>('dormant')
  const [width, setWidth] = useState(DEFAULT_WORKBENCH_WIDTH)
  const [isDraggingDivider, setIsDraggingDivider] = useState(false)

  const dispatch = useCallback((action: WorkbenchAction) => {
    setState((prev) => workbenchReducer(prev, action))
  }, [])

  const open = useCallback(() => dispatch({ type: 'open' }), [dispatch])
  const toggleExpand = useCallback(() => dispatch({ type: 'toggleExpand' }), [dispatch])
  const restoreToOpen = useCallback(() => dispatch({ type: 'restoreToOpen' }), [dispatch])
  const close = useCallback(() => dispatch({ type: 'close' }), [dispatch])
  const stepDown = useCallback(() => dispatch({ type: 'stepDown' }), [dispatch])
  const toggle = useCallback(() => dispatch({ type: 'toggle' }), [dispatch])

  // Keyboard: Cmd/Ctrl+\ toggles open/closed; Esc steps down one level.
  // Esc only acts when the workbench isn't dormant, so it never steals Esc
  // from other UI (modals, etc.) while the workbench has nothing to step
  // down from. stateRef is updated in an effect (not during render) to avoid
  // the react-hooks/refs "don't mutate refs during render" rule.
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    if (!enabled) return
    function handleKeyDown(e: KeyboardEvent): void {
      const isToggleChord = (e.metaKey || e.ctrlKey) && e.key === '\\'
      if (isToggleChord) {
        e.preventDefault()
        dispatch({ type: 'toggle' })
        return
      }
      if (e.key === 'Escape' && stateRef.current !== 'dormant') {
        e.preventDefault()
        dispatch({ type: 'stepDown' })
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [dispatch, enabled])

  // Divider drag — tracks pointer position relative to the drag-start point,
  // converts to a new docked width, and snaps to 'expanded' past the
  // threshold. Un-snap back to 'open' happens by dragging back below the
  // threshold, or via the ⤡/section-2 restore controls (handled elsewhere).
  const dragOriginRef = useRef<{ startX: number; startWidth: number; availableWidth: number }>({
    startX: 0,
    startWidth: DEFAULT_WORKBENCH_WIDTH,
    availableWidth: DEFAULT_WORKBENCH_WIDTH
  })
  // Holds the teardown for the currently-active drag's window listeners (or a
  // no-op when no drag is in progress) — consulted by the unmount effect
  // below so a mid-drag unmount (e.g. navigating away from the workspace
  // while the mouse is still down) can't leak listeners closing over a
  // now-unmounted component's setState.
  const cleanupDragRef = useRef<() => void>(() => {})

  const beginDividerDrag = useCallback(
    (startEvent: React.MouseEvent, availableWidth: number) => {
      startEvent.preventDefault()
      dragOriginRef.current = {
        startX: startEvent.clientX,
        startWidth: width,
        availableWidth
      }
      setIsDraggingDivider(true)

      function handleMouseMove(moveEvent: MouseEvent): void {
        const { startX, startWidth, availableWidth: avail } = dragOriginRef.current
        // Divider is dragged left (negative dx) to grow the workbench frame
        // (frame is docked on the right), so width grows as clientX decreases.
        const dx = moveEvent.clientX - startX
        const nextWidth = startWidth - dx
        const clamped = Math.min(Math.max(nextWidth, MIN_WORKBENCH_WIDTH), avail)

        if (avail > 0 && clamped / avail >= EXPAND_SNAP_FRACTION) {
          setState((prev) => (prev === 'open' ? 'expanded' : prev))
          return
        }
        // Dragging back below the threshold un-snaps expanded -> open, and
        // keeps tracking the width for the open state.
        setState((prev) => (prev === 'expanded' ? 'open' : prev))
        setWidth(clamped)
      }

      function handleMouseUp(): void {
        setIsDraggingDivider(false)
        window.removeEventListener('mousemove', handleMouseMove)
        window.removeEventListener('mouseup', handleMouseUp)
        cleanupDragRef.current = () => {}
      }

      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
      cleanupDragRef.current = () => {
        window.removeEventListener('mousemove', handleMouseMove)
        window.removeEventListener('mouseup', handleMouseUp)
      }
    },
    [width]
  )

  // Unmount safety net: if the hook owner unmounts mid-drag, remove any still-
  // active drag listeners rather than leaking them.
  useEffect(() => {
    return () => cleanupDragRef.current()
  }, [])

  return useMemo(
    () => ({
      state,
      width,
      open,
      toggleExpand,
      restoreToOpen,
      close,
      stepDown,
      toggle,
      beginDividerDrag,
      isDraggingDivider
    }),
    [
      state,
      width,
      open,
      toggleExpand,
      restoreToOpen,
      close,
      stepDown,
      toggle,
      beginDividerDrag,
      isDraggingDivider
    ]
  )
}
