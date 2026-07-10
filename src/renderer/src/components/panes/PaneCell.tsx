// ---------------------------------------------------------------------------
// src/renderer/src/components/panes/PaneCell.tsx
//
// Panes v2 — top-level Panels · Layouts · split Panes
// (docs/plans/2026-07-10-001-feat-panes-v2-toplevel-layouts-plan.md, U7, R6,
// R7, KTD6). One leaf of the split-tree: mounts a REAL libghostty terminal
// surface — `window.api.panes.mount(layoutId, paneId, rect, sf, command)`,
// keyed `pane:<layoutId>:<paneId>` by the main-process handler — and runs
// the pane's setup rule (`command`; '' = plain shell) via
// resources/orpheus-pane.sh. Mirrors the mockup's `.cell` structure
// (scratchpad/panes-final2.html: `renderCell`) exactly for header layout,
// hover-reveal controls, and flush/square framing.
//
// LIFECYCLE — replicated from workbench/TerminalTab.tsx (the hardened
// per-surface lifecycle built for U6b/U8/U9's ad-hoc terminal strip — a
// DIFFERENT feature, the Workbench panel's own shell tabs, unrelated to
// Panes v2 but sharing the exact same native-surface mount/hide/destroy
// concerns). Same guards, adapted from "one host div shared by N terminals,
// only the active one visible" to "one host div per PANE CELL, all panes in
// the active layout visible at once":
//   - MIN_SURFACE_PX floor — a collapsing/animating container hands
//     near-zero rects; forwarding one to resize would make libghostty
//     reflow its buffer and drop scrollback, so sub-floor rects are dropped
//     and the surface keeps its last good size.
//   - rAF-deferred mount — the container must have laid out before
//     getBoundingClientRect() is measured.
//   - ResizeObserver -> rAF-coalesced resize, guards re-checked at flush
//     time (the tab/pane can go inactive between schedule and flush).
//   - unmountedRef + pendingCloseRef — an in-flight mount resolving after
//     this cell has unmounted (nav away) or after the user closed (✕) this
//     pane must hide/destroy the surface it just created instead of leaking
//     a visible one.
//   - HIDE (not destroy) on ordinary unmount (nav away / layout switch) —
//     keeps the process + surface alive in main's registry
//     (paneSurfacesByWorkspace). DESTROY only on explicit ✕ close, or a
//     setup-rule edit relaunch (a command change is a new process).
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from 'react'
import { useInlineRename } from '@/lib/useInlineRename'

// See TerminalTab.tsx's own MIN_SURFACE_PX doc comment for the full
// scrollback-loss rationale — identical guard, same floor value.
const MIN_SURFACE_PX = 40

export interface PaneCellProps {
  /** The owning layout's id — half of the native surface key
   *  (`pane:<layoutId>:<paneId>`) and the arg the main handler resolves a
   *  `cwd` from (falls back to $HOME; layouts aren't workspaces, so
   *  getWorkspace(layoutId) is expected to miss). */
  layoutId: string
  paneId: string
  /** The pane's setup rule (src/shared/types.ts PaneTerminal.command); ''
   *  renders as "shell". */
  command: string
  /** True when this cell's surface should be live: the Panes view is the
   *  active top-level view AND this pane's layout is the active layout.
   *  Toggling false hides the surface (mirrors TerminalTab's `active`). */
  active: boolean
  /** True while this cell's container is mid-transition (width/height
   *  animating). Panes is a full view with no collapse animation today, so
   *  callers currently always pass false — threaded through for parity with
   *  TerminalTab/WorkspaceView's shared animation guard, and so a future
   *  animated container (e.g. a docked mini-Panes strip) can wire it up
   *  without touching this component. */
  animating: boolean
  focused: boolean
  onFocus: (paneId: string) => void
  onSplit: (paneId: string, dir: 'v' | 'h') => void
  onClose: (paneId: string) => void
  /** Persists an edited setup rule for this pane (PaneTerminal.command). */
  onCommandChange: (paneId: string, command: string) => void
  /** Drag-to-swap: the paneId currently being dragged (lifted up to
   *  SplitTree/PanesView so any two cells in the tree can participate),
   *  and the setter this cell's header calls on dragstart/dragend. */
  draggingPaneId: string | null
  onDragStart: (paneId: string) => void
  onDragEnd: () => void
  onSwap: (draggedPaneId: string, targetPaneId: string) => void
}

/** Rounds a DOMRect down to the plain {x,y,w,h} shape window.api.panes.mount/
 *  resize expect. Shared by the mount and resize paths so their rounding is
 *  always identical (a resize whose rounding drifts from the mount's would
 *  make the addon see a spurious size change on the very first frame). */
function toTerminalRect(rect: DOMRect): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    w: Math.round(rect.width),
    h: Math.round(rect.height)
  }
}

/** The two guard refs PaneCell's own onClose handler needs to read/set
 *  directly (see usePaneSurface's return below) — closing a pane is a
 *  DIFFERENT trigger than the effect's own active/animating/command
 *  transitions, so it reaches into the same createdRef/pendingCloseRef
 *  rather than duplicating their bookkeeping. */
interface PaneSurfaceHandle {
  createdRef: React.RefObject<boolean>
  pendingCloseRef: React.RefObject<boolean>
}

/** Owns the mount/resize/hide effect for one pane cell's native surface —
 *  extracted from PaneCell so the component body (header/body JSX) stays
 *  under the cognitive-complexity cap. Called exactly once per PaneCell
 *  instance; all the guard refs below live for this cell's whole lifetime
 *  and are private to that instance (returned, not shared module state). */
function usePaneSurface(
  containerRef: React.RefObject<HTMLDivElement | null>,
  layoutId: string,
  paneId: string,
  command: string,
  active: boolean,
  animating: boolean
): PaneSurfaceHandle {
  // activeRef/animatingRef — mirror the props as refs so the stable
  // ResizeObserver-driven resize path can read the LATEST value without
  // re-subscribing. Same pattern as TerminalTab.tsx's own guards.
  const activeRef = useRef(active)
  // eslint-disable-next-line react-hooks/refs -- intentional render-time ref mutation to track latest active prop for the stable resize listener
  activeRef.current = active
  const animatingRef = useRef(animating)
  // eslint-disable-next-line react-hooks/refs -- intentional render-time ref mutation to track latest animating prop for the stable resize listener
  animatingRef.current = animating

  // createdRef — has THIS pane's surface actually been mounted at least
  // once. Consulted so hide()/destroy() is only called for a slot the addon
  // actually knows about.
  const createdRef = useRef(false)
  // unmountedRef — an in-flight mount() resolving after this cell has torn
  // down must hide the surface itself instead of leaking it visible.
  const unmountedRef = useRef(false)
  // pendingCloseRef — set when the user closes (✕) this pane WHILE its
  // mount() call is still in flight. Without this, the mount's `.then`
  // would attach a surface for a pane the tree no longer shows (createdRef
  // isn't true yet when onClose runs, so its own destroy is a no-op) —
  // leaking it. See TerminalTab.tsx's identical guard.
  const pendingCloseRef = useRef(false)

  // Re-runs on every active/animating transition, AND whenever `command`
  // changes — a setup-rule edit is a new process, so it destroys the old
  // surface and mounts a fresh one with the new command (handled by this
  // effect re-running: cleanup destroys via the `command`-change branch
  // below, the new run mounts with the new command).
  const prevCommandRef = useRef(command)

  useEffect(() => {
    let resizeRafId: number | null = null
    let pendingRect: { x: number; y: number; w: number; h: number } | null = null
    let pendingSf = 1
    let ro: ResizeObserver | null = null
    let mountRafId: number | null = null
    // Whether this run issued a mount — only a run that mounted should hide
    // (or destroy, on a command change) on cleanup. A run deferred because
    // animating was true must not fire a spurious hide/destroy against a
    // surface it never touched.
    let didMount = false
    // Snapshot at effect-setup time: did the command change since the LAST
    // run (vs. this being the pane's very first mount, or a plain
    // active/animating toggle)? Read once here rather than inside cleanup
    // so cleanup's decision reflects what triggered THIS run, not whatever
    // `command` happens to be by the time cleanup fires.
    const commandChanged = prevCommandRef.current !== command
    prevCommandRef.current = command

    const flushResize = (): void => {
      resizeRafId = null
      if (!pendingRect) return
      if (!activeRef.current || animatingRef.current) {
        pendingRect = null
        return
      }
      window.api.panes
        .resize(layoutId, paneId, pendingRect, pendingSf)
        .catch((e) => console.error('[PaneCell] resize failed:', e))
      pendingRect = null
    }

    const scheduleResize = (rect: DOMRect): void => {
      if (!activeRef.current || animatingRef.current) return
      if (rect.width < MIN_SURFACE_PX || rect.height < MIN_SURFACE_PX) return
      pendingSf = window.devicePixelRatio ?? 1
      pendingRect = toTerminalRect(rect)
      if (resizeRafId === null) {
        resizeRafId = requestAnimationFrame(flushResize)
      }
    }

    const attachResizeListener = (): void => {
      const el = containerRef.current
      if (!el || ro) return
      ro = new ResizeObserver(() => {
        scheduleResize(el.getBoundingClientRect())
      })
      ro.observe(el)
    }

    if (active && !animating) {
      didMount = true
      // rAF so the container has laid out before we measure it (matches
      // TerminalTab.tsx / WorkspaceView.tsx's mount-effect pattern).
      mountRafId = requestAnimationFrame(() => {
        mountRafId = null
        const el = containerRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        if (rect.width < MIN_SURFACE_PX || rect.height < MIN_SURFACE_PX) return
        const scaleFactor = window.devicePixelRatio ?? 1
        window.api.panes
          .mount(layoutId, paneId, toTerminalRect(rect), scaleFactor, command)
          .then(() => {
            createdRef.current = true
            if (pendingCloseRef.current) {
              pendingCloseRef.current = false
              createdRef.current = false
              window.api.panes
                .destroy(layoutId, paneId)
                .catch((e) => console.error('[PaneCell] deferred close destroy failed:', e))
              return
            }
            if (unmountedRef.current) {
              window.api.panes
                .hide(layoutId, paneId)
                .catch((e) => console.error('[PaneCell] post-unmount hide failed:', e))
              return
            }
            attachResizeListener()
          })
          .catch((e) => console.error('[PaneCell] mount failed:', e))
      })
    }

    return () => {
      if (mountRafId !== null) cancelAnimationFrame(mountRafId)
      if (resizeRafId !== null) cancelAnimationFrame(resizeRafId)
      ro?.disconnect()
      pendingRect = null
      if (!didMount || !createdRef.current) return
      if (commandChanged) {
        // Setup-rule edit relaunch: the old process/surface is gone the
        // instant the command changes, so destroy (not hide) it — the next
        // run mounts a fresh surface with the new command.
        createdRef.current = false
        window.api.panes
          .destroy(layoutId, paneId)
          .catch((e) => console.error('[PaneCell] relaunch destroy failed:', e))
      } else {
        window.api.panes
          .hide(layoutId, paneId)
          .catch((e) => console.error('[PaneCell] hide failed:', e))
      }
    }
    // Re-runs on every `active`, `animating`, OR `command` transition —
    // this is intentionally the only effect that mounts/hides/resizes/
    // destroys this pane's surface.
  }, [active, animating, layoutId, paneId, command, containerRef])

  // True teardown — a SEPARATE `[]`-keyed effect so its cleanup fires only
  // on this cell's own unmount (nav away / layout switch / pane removed
  // from the tree), never on an active/animating/command toggle above.
  // HIDE, never destroy — mirrors TerminalTab.tsx's own teardown effect:
  // surfaces are destroyed ONLY by explicit ✕-close (handled in PaneCell's
  // handleClose, which reaches into the createdRef/pendingCloseRef this
  // hook returns) or workspace/project archival (main-side).
  useEffect(() => {
    return () => {
      unmountedRef.current = true
      if (!createdRef.current) return
      window.api.panes
        .hide(layoutId, paneId)
        .catch((e) => console.error('[PaneCell] post-unmount hide failed:', e))
    }
    // layoutId/paneId are stable for this cell's lifetime (SplitTree keys
    // each PaneCell by paneId; a pane never changes which layout owns it
    // without a fresh cell being created).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { createdRef, pendingCloseRef }
}

export function PaneCell({
  layoutId,
  paneId,
  command,
  active,
  animating,
  focused,
  onFocus,
  onSplit,
  onClose,
  onCommandChange,
  draggingPaneId,
  onDragStart,
  onDragEnd,
  onSwap
}: PaneCellProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [running, setRunning] = useState(true)
  const [dropTarget, setDropTarget] = useState(false)
  const [editing, setEditing] = useState(false)

  const { createdRef, pendingCloseRef } = usePaneSurface(
    containerRef,
    layoutId,
    paneId,
    command,
    active && running,
    animating
  )

  // Setup-rule edit input — reuses the shared inline-rename value/commit
  // protocol (Sidebar's own rename rows). '' is a valid committed value
  // here (plain shell), unlike a name field, so commit is driven manually
  // below rather than via the hook's own commit() (which no-ops on empty).
  const editValue = useInlineRename(command, (trimmed) => onCommandChange(paneId, trimmed))

  const commitEdit = (): void => {
    const next = editValue.value.trim()
    setEditing(false)
    if (next !== command) onCommandChange(paneId, next)
  }
  const cancelEdit = (): void => {
    editValue.cancel()
    setEditing(false)
  }

  const isDragging = draggingPaneId === paneId
  const label = command || 'shell'

  const handleClose = (): void => {
    // Destroy this pane's surface immediately regardless of active state —
    // this IS one of the two allowed destroy triggers (explicit ✕). If the
    // mount is still in flight, mark it so the mount's own .then destroys
    // on resolution instead of attaching a surface for a pane the tree no
    // longer shows (closes the same race TerminalTab.tsx guards).
    if (createdRef.current) {
      createdRef.current = false
      window.api.panes
        .destroy(layoutId, paneId)
        .catch((e) => console.error('[PaneCell] close destroy failed:', e))
    } else {
      pendingCloseRef.current = true
    }
    onClose(paneId)
  }

  return (
    <div
      className={[
        'group relative flex flex-1 min-w-0 min-h-0 flex-col',
        'border border-border-default overflow-hidden bg-surface-raised transition-[box-shadow,border-color,opacity] duration-150',
        focused ? 'border-accent shadow-[inset_0_0_0_1px_rgba(212,168,71,0.35)] z-[3]' : '',
        running ? '' : 'opacity-55',
        isDragging ? 'opacity-35' : '',
        dropTarget ? 'outline outline-2 outline-dashed outline-accent -outline-offset-2' : ''
      ]
        .filter(Boolean)
        .join(' ')}
      onMouseDown={() => onFocus(paneId)}
      onDragOver={(e) => {
        e.preventDefault()
        setDropTarget(true)
      }}
      onDragLeave={() => setDropTarget(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDropTarget(false)
        if (draggingPaneId) onSwap(draggingPaneId, paneId)
      }}
    >
      {/* Header — grip, live dot, command label, hover-reveal controls. */}
      <div
        draggable
        onDragStart={() => onDragStart(paneId)}
        onDragEnd={onDragEnd}
        className="flex h-7 flex-shrink-0 cursor-grab items-center gap-1.5 border-b border-border-default bg-surface-overlay pl-1.5 pr-1 active:cursor-grabbing select-none"
      >
        <span className="text-text-muted text-xs opacity-60 tracking-[-2px]">⠿</span>
        <span
          className={[
            'h-1.5 w-1.5 flex-shrink-0 rounded-full',
            running ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]' : 'bg-text-muted'
          ].join(' ')}
        />
        {editing ? (
          <input
            autoFocus
            value={editValue.value}
            onChange={(e) => editValue.setValue(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitEdit()
              if (e.key === 'Escape') cancelEdit()
            }}
            placeholder="shell"
            className="min-w-0 flex-1 rounded border border-accent bg-surface-base px-1 font-mono text-[10.5px] text-text-primary outline-none"
          />
        ) : (
          <span
            className={[
              'min-w-0 flex-1 truncate font-mono text-[10.5px]',
              focused ? 'text-text-primary' : 'text-text-muted'
            ].join(' ')}
          >
            {running ? '' : '◼ '}
            {label}
          </span>
        )}

        {/* Split buttons — hover/focus-reveal, matching mockup .splitbtns. */}
        <div className="flex gap-px opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
          <button
            type="button"
            title="split right"
            className="flex h-5 w-5 items-center justify-center rounded text-text-muted text-[11px] hover:bg-surface-raised hover:text-accent cursor-pointer"
            onClick={(e) => {
              e.stopPropagation()
              onSplit(paneId, 'v')
            }}
          >
            ▏
          </button>
          <button
            type="button"
            title="split below"
            className="flex h-5 w-5 items-center justify-center rounded text-text-muted text-[11px] hover:bg-surface-raised hover:text-accent cursor-pointer"
            onClick={(e) => {
              e.stopPropagation()
              onSplit(paneId, 'h')
            }}
          >
            ▁
          </button>
        </div>

        {/* Edit / stop-start / close — hover/focus-reveal, matching mockup
            .tctrls. Edit toggles an inline input (above) that commits on
            blur/Enter and cancels on Escape; committing a changed command
            relaunches the surface (usePaneSurface's command-change branch
            destroys the old process and mounts a fresh one). */}
        <div className="flex opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
          <button
            type="button"
            title="edit setup rule"
            className="flex h-5 w-5 items-center justify-center rounded text-text-muted text-[11px] hover:bg-surface-raised hover:text-text-primary cursor-pointer"
            onClick={(e) => {
              e.stopPropagation()
              editValue.seed(command)
              setEditing(true)
            }}
          >
            ✎
          </button>
          {running ? (
            <button
              type="button"
              title="stop"
              className="flex h-5 w-5 items-center justify-center rounded text-text-muted text-[11px] hover:bg-surface-raised hover:text-[#e07a7a] cursor-pointer"
              onClick={(e) => {
                e.stopPropagation()
                setRunning(false)
              }}
            >
              ◼
            </button>
          ) : (
            <button
              type="button"
              title="start"
              className="flex h-5 w-5 items-center justify-center rounded text-text-muted text-[11px] hover:bg-surface-raised hover:text-text-primary cursor-pointer"
              onClick={(e) => {
                e.stopPropagation()
                setRunning(true)
              }}
            >
              ▶
            </button>
          )}
          <button
            type="button"
            title="close"
            className="flex h-5 w-5 items-center justify-center rounded text-text-muted text-[11px] hover:bg-surface-raised hover:text-text-primary cursor-pointer"
            onClick={(e) => {
              e.stopPropagation()
              handleClose()
            }}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Body — the REAL native terminal surface host. Transparent + flush:
          the opaque libghostty NSView paints through this div, same
          convention as workbench/TerminalTab.tsx's own host. */}
      <div ref={containerRef} className="relative flex-1 min-h-0 min-w-0 overflow-hidden" />

      {/* Setup-rule strip — only shown when a rule is actually set, mirrors
          mockup .setuprow. Omitted entirely for a plain shell pane; adding
          it unconditionally would just be dead chrome for the common case. */}
      {command ? (
        <div className="flex h-[23px] flex-shrink-0 items-center gap-1.5 border-t border-dashed border-border-default bg-surface-raised px-2 font-mono text-[9.5px] text-text-muted">
          setup: <span className="text-accent">{command}</span> · then shell
        </div>
      ) : null}
    </div>
  )
}
