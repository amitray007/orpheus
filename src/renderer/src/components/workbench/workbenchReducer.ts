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
// State is EPHEMERAL for U4 — in-memory only, no persistence to the DB. The
// storage itself lives in `@/lib/workbenchStore` (a per-workspace-id keyed
// store, same idiom as sleepStore/activityStore) rather than local
// `useState`, specifically so it SURVIVES `WorkspaceView` unmount/remount —
// see that module's header comment for the full rationale. This hook still
// owns all the transition logic (dispatch through the pure reducer below,
// keyboard shortcuts, divider drag); only the state/width VALUES are sourced
// from the keyed store. A later unit can persist width/last-state to the DB
// if desired.
// ---------------------------------------------------------------------------

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import {
  DEFAULT_WORKBENCH_WIDTH,
  useWorkbenchEntry,
  setWorkbenchEntry,
  nextLastMode,
  type WorkbenchState
} from '../../lib/workbenchStore'
import type { WorkbenchTabId } from './workbenchTabs'

export type { WorkbenchState }

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

// Re-exported so existing importers (e.g. WorkbenchPanel.tsx) keep working
// unchanged — the value itself now lives in workbenchStore.ts alongside the
// per-workspace entry shape it defaults to.
export { DEFAULT_WORKBENCH_WIDTH }
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
  /** The active Workbench section tab (Git/Terminal/Files/Panes). Shared so
   *  the top-bar tab strip (WorkspaceTitleBar) and the panel body
   *  (WorkbenchPanel) agree on selection — see workbenchStore.ts's
   *  WorkbenchEntry.activeTab for the storage rationale. */
  activeTab: WorkbenchTabId
  /** Selects a tab. If the Workbench is currently dormant, this ALSO opens it
   *  (restoring lastMode) — clicking a top-bar tab while dormant is the
   *  chosen "open the Workbench" affordance (see WorkspaceTitleBar). */
  selectTab: (tab: WorkbenchTabId) => void
}

export const WorkbenchContext = createContext<WorkbenchApi | null>(null)

export function useWorkbenchApi(): WorkbenchApi | null {
  return useContext(WorkbenchContext)
}

/**
 * The state machine hook. Mounted ONCE per workspace (in WorkspaceView,
 * unconditionally) and provided via WorkbenchProvider so both WorkbenchPanel
 * (the frame/body) and WorkspaceTitleBar (the top-bar section tabs + ⤢/✕ +
 * the expanded-state [◂] restore control) can read/drive the same state.
 *
 * `workspaceId` selects which workspace's entry (state + width) this
 * instance reads/writes in the shared keyed store (`@/lib/workbenchStore`) —
 * that store, not local `useState`, is what survives `WorkspaceView`
 * unmount/remount (e.g. navigating to a project and back). Two different
 * workspaceIds are fully independent: each keeps its own entry.
 *
 * Always binds the keyboard listener (Cmd/Ctrl+\ toggle, Esc step-down) —
 * the Workbench is always on, so there's no gate to consult.
 */
export function useWorkbenchState(workspaceId: string): WorkbenchApi {
  const { state, width, lastMode, activeTab } = useWorkbenchEntry(workspaceId)
  const [isDraggingDivider, setIsDraggingDivider] = useState(false)

  // Reads/writes always go through the store keyed by the CURRENT
  // workspaceId — kept in a ref so callbacks below don't need to be
  // recreated (and re-bind the keyboard listener) on every workspace switch,
  // while still never writing into a stale workspace's slot.
  const workspaceIdRef = useRef(workspaceId)
  useEffect(() => {
    workspaceIdRef.current = workspaceId
  }, [workspaceId])

  // Mirrors the entry so callbacks that need the LATEST state/width/lastMode/
  // activeTab (divider drag math, keyboard Esc gating, dormant->reopen
  // restore, tab selection) can read it without becoming stale or needing to
  // be re-created every render.
  const entryRef = useRef({ state, width, lastMode, activeTab })
  useEffect(() => {
    entryRef.current = { state, width, lastMode, activeTab }
  }, [state, width, lastMode, activeTab])

  const dispatch = useCallback((action: WorkbenchAction) => {
    const id = workspaceIdRef.current
    const prevEntry = entryRef.current
    let nextState = workbenchReducer(prevEntry.state, action)
    // Reopening from dormant (via 'toggle' or 'open') should restore whichever
    // non-dormant mode the workbench was last in, not hardcode 'open' — the
    // pure reducer always returns 'open' here since it has no concept of
    // lastMode; override its result at this layer only for the dormant->open
    // edge, keeping workbenchReducer itself (and its exhaustive transition
    // test) unchanged. Every other transition passes through untouched.
    if (prevEntry.state === 'dormant' && (action.type === 'toggle' || action.type === 'open')) {
      nextState = prevEntry.lastMode
    }
    if (nextState === prevEntry.state) return
    setWorkbenchEntry(id, {
      state: nextState,
      width: prevEntry.width,
      lastMode: nextLastMode(nextState, prevEntry.lastMode),
      activeTab: prevEntry.activeTab
    })
  }, [])

  const open = useCallback(() => dispatch({ type: 'open' }), [dispatch])
  const toggleExpand = useCallback(() => dispatch({ type: 'toggleExpand' }), [dispatch])
  const restoreToOpen = useCallback(() => dispatch({ type: 'restoreToOpen' }), [dispatch])
  const close = useCallback(() => dispatch({ type: 'close' }), [dispatch])
  const stepDown = useCallback(() => dispatch({ type: 'stepDown' }), [dispatch])
  const toggle = useCallback(() => dispatch({ type: 'toggle' }), [dispatch])

  // selectTab: switches the active section tab. If dormant, this is also the
  // chosen "open the Workbench from the top bar" affordance (see
  // WorkspaceTitleBar) — clicking any top-bar tab opens the Workbench
  // (restoring lastMode, same as 'toggle'/'open') with that tab active, in
  // one click rather than requiring an extra "open" click first.
  const selectTab = useCallback((tab: WorkbenchTabId) => {
    const id = workspaceIdRef.current
    const prevEntry = entryRef.current
    const nextState = prevEntry.state === 'dormant' ? prevEntry.lastMode : prevEntry.state
    setWorkbenchEntry(id, {
      state: nextState,
      width: prevEntry.width,
      lastMode: nextLastMode(nextState, prevEntry.lastMode),
      activeTab: tab
    })
  }, [])

  // Keyboard: Cmd/Ctrl+\ toggles open/closed; Esc steps down one level.
  // Esc only acts when the workbench isn't dormant, so it never steals Esc
  // from other UI (modals, etc.) while the workbench has nothing to step
  // down from. Reads entryRef.current (kept fresh above) rather than a
  // separate ref so there's a single source of "latest state" to maintain.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      const isToggleChord = (e.metaKey || e.ctrlKey) && e.key === '\\'
      if (isToggleChord) {
        e.preventDefault()
        dispatch({ type: 'toggle' })
        return
      }
      if (e.key === 'Escape' && entryRef.current.state !== 'dormant') {
        e.preventDefault()
        dispatch({ type: 'stepDown' })
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [dispatch])

  // Divider drag — tracks pointer position relative to the drag-start point,
  // converts to a new docked width, and snaps to 'expanded' past the
  // threshold. Un-snap back to 'open' happens by dragging back below the
  // threshold, or via the top bar's ⤢/[◂] restore controls (handled
  // elsewhere, in WorkspaceTitleBar).
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

  const beginDividerDrag = useCallback((startEvent: React.MouseEvent, availableWidth: number) => {
    startEvent.preventDefault()
    dragOriginRef.current = {
      startX: startEvent.clientX,
      startWidth: entryRef.current.width,
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

      const id = workspaceIdRef.current
      const prevState = entryRef.current.state
      const prevLastMode = entryRef.current.lastMode

      if (avail > 0 && clamped / avail >= EXPAND_SNAP_FRACTION) {
        const snappedState = prevState === 'open' ? 'expanded' : prevState
        setWorkbenchEntry(id, {
          state: snappedState,
          width: entryRef.current.width,
          lastMode: nextLastMode(snappedState, prevLastMode),
          activeTab: entryRef.current.activeTab
        })
        return
      }
      // Dragging back below the threshold un-snaps expanded -> open, and
      // keeps tracking the width for the open state.
      const unsnappedState = prevState === 'expanded' ? 'open' : prevState
      setWorkbenchEntry(id, {
        state: unsnappedState,
        width: clamped,
        lastMode: nextLastMode(unsnappedState, prevLastMode),
        activeTab: entryRef.current.activeTab
      })
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
  }, [])

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
      isDraggingDivider,
      activeTab,
      selectTab
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
      isDraggingDivider,
      activeTab,
      selectTab
    ]
  )
}
