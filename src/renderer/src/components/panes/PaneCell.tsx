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
//     (paneSurfacesByWorkspace). DESTROY on explicit ✕ close, a setup-rule
//     edit relaunch (a command change is a new process), OR the pane being
//     STOPPED (issue #17/#18 — see `running` below).
//
// ISSUE #17/#18 — REAL STOP/START (read before touching the running logic):
// `running` (sourced from paneRunStateStore.ts, shared with PanesView's
// layout-wide Stop/Restart) used to be a purely LOCAL flag that only ever
// fed into `active` (`active && running`), so stopping a pane just HID its
// surface — the process kept running, and worse, restarting it could paint
// blank because a hidden-then-reshown surface can race a stale/0-size rect.
// Now `running` is threaded into usePaneSurface as its own signal: stopping
// (running: true -> false) forces a real DESTROY (not hide) on cleanup, and
// starting (false -> true) is therefore always a genuinely FRESH `pane:mount`
// into a freshly-measured container — never a hide/show of a stale surface.
// That fresh-mount guarantee, combined with the unconditional ResizeObserver
// retry already in tryMount/attachResizeListener below (Bug #2's fix), is
// what makes the restarted pane paint correctly instead of staying blank.
//
// The destroy-vs-hide decision needs to know, AT CLEANUP TIME, whether the
// upcoming run's `command`/`running` differ from the run being torn down —
// naively comparing "did command/running change since last render" INSIDE
// the effect body computes the wrong transition (it answers "was outdated
// by the time THIS run started", not "is about to be replaced when THIS run
// ends"), because a cleanup closure captures whatever was computed when ITS
// OWN effect instance was set up, and that cleanup fires BEFORE the next
// run's body executes. The fix (mirrors how `activeRef`/`animatingRef`
// already solve the identical problem for the resize path): commandRef and
// runningRef are mutated on EVERY RENDER (not just effect runs), so by the
// time a stale run's cleanup actually fires — which happens during the
// commit that ALSO re-renders with the new prop values — the refs already
// hold the upcoming values. Cleanup then compares its own closure snapshot
// (taken at setup time) against the live ref to correctly detect "the thing
// that's about to replace me differs from me", not the reverse.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from 'react'
import { DotsSixVertical, Columns, Rows, Pencil, Stop, Play, X } from '@phosphor-icons/react'
import { useInlineRename } from '@/lib/useInlineRename'
import { usePaneRunning, setPaneRunning } from '@/lib/paneRunStateStore'

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
  /** The pane's display name (issue #21) — '' means unnamed. PaneCell falls
   *  back to `Pane ${position + 1}` when this is empty; the caller (via
   *  SplitTree) is responsible for resolving `''` names, since only it
   *  knows every leaf's stable 1-based position across the whole layout. */
  displayName: string
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
  /** Persists an edited display name for this pane (PaneTerminal.name) —
   *  issue #21. Never relaunches the surface (unlike onCommandChange). */
  onNameChange: (paneId: string, name: string) => void
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

/** Owns the mount/resize/hide/destroy effect for one pane cell's native
 *  surface — extracted from PaneCell so the component body (header/body
 *  JSX) stays under the cognitive-complexity cap. Called exactly once per
 *  PaneCell instance; all the guard refs below live for this cell's whole
 *  lifetime and are private to that instance (returned, not shared module
 *  state).
 *
 *  `running` (issue #17/#18): when false, this hook neither mounts nor
 *  keeps a surface alive — stopping DESTROYS it (a real process kill), and
 *  starting again always goes through a full fresh `pane:mount`. See the
 *  file header comment for why the destroy-vs-hide decision needs live refs
 *  rather than a closure-captured "did this change" flag. */
function usePaneSurface(
  containerRef: React.RefObject<HTMLDivElement | null>,
  layoutId: string,
  paneId: string,
  command: string,
  running: boolean,
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

  // commandRef/runningRef — ALSO mirrored on every render (not just inside
  // the effect), so a stale run's cleanup can read what command/running are
  // ABOUT TO BECOME (see the file-header comment: this is what fixes the
  // off-by-one a naive closure-captured "changed" flag would have). The
  // mount effect below still also needs the value AT THIS RUN's setup time
  // to decide whether to mount at all — that comes from the plain
  // `command`/`running` params (correct: an effect's own body always sees
  // its own render's fresh props), only the CLEANUP decision needs the
  // live-ref trick.
  const commandRef = useRef(command)
  // eslint-disable-next-line react-hooks/refs -- intentional render-time ref mutation so a torn-down run's cleanup can see the command it's being replaced by
  commandRef.current = command
  const runningRef = useRef(running)
  // eslint-disable-next-line react-hooks/refs -- intentional render-time ref mutation so a torn-down run's cleanup can see the running state it's being replaced by
  runningRef.current = running

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

  useEffect(() => {
    let resizeRafId: number | null = null
    let pendingRect: { x: number; y: number; w: number; h: number } | null = null
    let pendingSf = 1
    let ro: ResizeObserver | null = null
    let mountRafId: number | null = null
    // Whether this run issued a mount — only a run that mounted should
    // hide/destroy on cleanup. A run deferred because animating was true or
    // running was false must not fire a spurious hide/destroy against a
    // surface it never touched.
    let didMount = false
    // Snapshot of THIS run's own command/running, closed over for the
    // mount call below (correct to use the plain params here — an effect
    // body always wants its own render's values).
    const thisRunCommand = command
    const thisRunRunning = running

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

    // tryMount — the sub-floor check + `pane:mount` call + the createdRef/
    // pendingClose/unmounted guards, factored out of the rAF callback below
    // so BOTH the initial mount attempt AND a later ResizeObserver-driven
    // "the container finally has a real size" retry can call the exact same
    // path (Bug #2's fix — see the ResizeObserver wiring below for why a
    // retry path is needed at all). Also the path a STOPPED->STARTED
    // transition takes (issue #18): since running:false always destroys on
    // cleanup (below) and resets createdRef to false, the next active run
    // always arrives here with createdRef.current === false, so starting a
    // stopped pane is guaranteed to be a genuine fresh mount, never a
    // no-op against a surface that's merely hidden.
    const tryMount = (rect: DOMRect): void => {
      if (createdRef.current) return
      if (rect.width < MIN_SURFACE_PX || rect.height < MIN_SURFACE_PX) return
      const scaleFactor = window.devicePixelRatio ?? 1
      window.api.panes
        .mount(layoutId, paneId, toTerminalRect(rect), scaleFactor, thisRunCommand)
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
          }
        })
        .catch((e) => console.error('[PaneCell] mount failed:', e))
    }

    // ResizeObserver — attached UNCONDITIONALLY whenever this run is live
    // (active && running && !animating), NOT gated on a successful mount.
    // This is Bug #2's fix, and it's also what makes issue #18's restart
    // path reliable: a freshly-started pane's container may not have
    // finished laying out on the very first rAF measurement (0-size rect),
    // and this observer is what retries the mount the moment a real size
    // is reported, instead of leaving the pane permanently blank.
    const attachResizeListener = (): void => {
      const el = containerRef.current
      if (!el || ro) return
      ro = new ResizeObserver(() => {
        const rect = el.getBoundingClientRect()
        if (!createdRef.current) {
          tryMount(rect)
          return
        }
        scheduleResize(rect)
      })
      ro.observe(el)
    }

    if (active && running && !animating) {
      didMount = true
      attachResizeListener()
      // rAF so the container has laid out before we measure it (matches
      // TerminalTab.tsx / WorkspaceView.tsx's mount-effect pattern). If this
      // first measurement is still sub-floor, tryMount no-ops and the
      // ResizeObserver attached above is what eventually retries — no
      // separate retry loop needed here.
      mountRafId = requestAnimationFrame(() => {
        mountRafId = null
        const el = containerRef.current
        if (!el) return
        tryMount(el.getBoundingClientRect())
      })
    }

    return () => {
      if (mountRafId !== null) cancelAnimationFrame(mountRafId)
      if (resizeRafId !== null) cancelAnimationFrame(resizeRafId)
      ro?.disconnect()
      pendingRect = null
      if (!didMount || !createdRef.current) return
      // The DESTROY-vs-HIDE decision: compare what THIS run mounted with
      // (thisRunCommand/thisRunRunning) against the LIVE refs, which by the
      // time this cleanup actually executes already hold the values from
      // the render that's replacing this one (see the file-header comment
      // for why this must be live refs, not a closure-captured "changed"
      // flag computed at setup time — that reads one transition late).
      const commandAboutToChange = commandRef.current !== thisRunCommand
      const stoppingNow = thisRunRunning && !runningRef.current
      if (commandAboutToChange || stoppingNow) {
        // Setup-rule edit relaunch, OR the user/layout-menu stopped this
        // pane: the old process/surface must be genuinely killed, not just
        // hidden — a hidden surface would (a) leak a live process for a
        // stopped pane, and (b) block the next mount via the createdRef
        // guard above, which is exactly the stale-hide/show path that used
        // to cause the blank-on-restart bug (issue #18).
        createdRef.current = false
        window.api.panes
          .destroy(layoutId, paneId)
          .catch((e) => console.error('[PaneCell] destroy failed:', e))
      } else {
        window.api.panes
          .hide(layoutId, paneId)
          .catch((e) => console.error('[PaneCell] hide failed:', e))
      }
    }
    // Re-runs on every `active`, `animating`, `running`, OR `command`
    // transition — this is intentionally the only effect that mounts/hides/
    // resizes/destroys this pane's surface.
  }, [active, animating, running, layoutId, paneId, command, containerRef])

  // True teardown — a SEPARATE `[]`-keyed effect so its cleanup fires only
  // on this cell's own unmount (nav away / layout switch / pane removed
  // from the tree), never on an active/animating/running/command toggle
  // above. HIDE, never destroy — mirrors TerminalTab.tsx's own teardown
  // effect: surfaces are destroyed ONLY by explicit ✕-close (handled in
  // PaneCell's handleClose, which reaches into the createdRef/
  // pendingCloseRef this hook returns), a setup-rule relaunch, an explicit
  // stop (both handled by the effect above), or workspace/project archival
  // (main-side).
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
  displayName,
  active,
  animating,
  focused,
  onFocus,
  onSplit,
  onClose,
  onCommandChange,
  onNameChange,
  draggingPaneId,
  onDragStart,
  onDragEnd,
  onSwap
}: PaneCellProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  // running — sourced from the shared paneRunStateStore (issue #17), not
  // local state: PanesView's Stop/Restart-layout menu items write to the
  // SAME store this hook reads, so a layout-wide command and this cell's
  // own ◼/▶ buttons drive the exact same mount/destroy path below.
  const running = usePaneRunning(paneId)
  const [dropTarget, setDropTarget] = useState(false)
  const [editingCommand, setEditingCommand] = useState(false)
  const [editingName, setEditingName] = useState(false)

  const { createdRef, pendingCloseRef } = usePaneSurface(
    containerRef,
    layoutId,
    paneId,
    command,
    running,
    active,
    animating
  )

  // Setup-rule edit input — reuses the shared inline-rename value/commit
  // protocol (Sidebar's own rename rows). '' is a valid committed value
  // here (plain shell), unlike a name field, so commit is driven manually
  // below rather than via the hook's own commit() (which no-ops on empty).
  const commandEditValue = useInlineRename(command, (trimmed) => onCommandChange(paneId, trimmed))

  const commitCommandEdit = (): void => {
    const next = commandEditValue.value.trim()
    setEditingCommand(false)
    if (next !== command) onCommandChange(paneId, next)
  }
  const cancelCommandEdit = (): void => {
    commandEditValue.cancel()
    setEditingCommand(false)
  }

  // Name edit input (issue #21) — same protocol, but '' IS a meaningful
  // commit here too (clears back to the "Pane N" fallback), so this also
  // drives commit manually rather than via the hook's own commit() (which
  // no-ops on empty, same reasoning as the command editor above).
  const nameEditValue = useInlineRename(displayName, (trimmed) => onNameChange(paneId, trimmed))

  const commitNameEdit = (): void => {
    const next = nameEditValue.value.trim()
    setEditingName(false)
    if (next !== displayName) onNameChange(paneId, next)
  }
  const cancelNameEdit = (): void => {
    nameEditValue.cancel()
    setEditingName(false)
  }

  // Header label (issue #1b) — the header shows the pane's setup-rule
  // COMMAND when one is set (e.g. "npm run dev"), so a running pane reads
  // as "what's actually running" rather than a generic "Pane N" name. A
  // plain-shell pane (command === '') has nothing more informative to show
  // than its name, so it keeps the existing displayName fallback. This is
  // purely a DISPLAY substitution — double-click-to-rename below still
  // seeds/edits `displayName`, never `headerLabel`, so renaming always
  // targets the name field regardless of which text is currently visible.
  const headerLabel = command.trim().length > 0 ? command : displayName

  const isDragging = draggingPaneId === paneId

  const handleClose = (): void => {
    // Destroy this pane's surface immediately regardless of active state —
    // this IS one of the allowed destroy triggers (explicit ✕). If the
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
      {/* Header — grip, live dot, editable name, hover-reveal controls. */}
      <div
        draggable
        onDragStart={() => onDragStart(paneId)}
        onDragEnd={onDragEnd}
        className="flex h-7 flex-shrink-0 cursor-grab items-center gap-1.5 border-b border-border-default bg-surface-overlay pl-1.5 pr-1 active:cursor-grabbing select-none"
      >
        <DotsSixVertical size={13} className="flex-shrink-0 text-text-muted opacity-60" />
        <span
          className={[
            'h-1.5 w-1.5 flex-shrink-0 rounded-full',
            running ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]' : 'bg-text-muted'
          ].join(' ')}
        />
        {editingName ? (
          <input
            autoFocus
            value={nameEditValue.value}
            onChange={(e) => nameEditValue.setValue(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onBlur={commitNameEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitNameEdit()
              if (e.key === 'Escape') cancelNameEdit()
            }}
            placeholder={displayName}
            className="min-w-0 flex-1 rounded border border-accent bg-surface-base px-1 font-mono text-[10.5px] text-text-primary outline-none"
          />
        ) : editingCommand ? (
          // Setup-rule (command) edit — shares the name span's slot rather
          // than adding a second header row (the header is a fixed 28px
          // flush strip, matching the mockup exactly; there's no room for a
          // second row). A distinct placeholder ("shell" vs. the pane's own
          // name) and accent-bordered styling make it visually obvious this
          // input edits the COMMAND, not the name, even though it briefly
          // occupies the same slot the name normally lives in.
          <input
            autoFocus
            value={commandEditValue.value}
            onChange={(e) => commandEditValue.setValue(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onBlur={commitCommandEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitCommandEdit()
              if (e.key === 'Escape') cancelCommandEdit()
            }}
            placeholder="shell"
            title="Setup rule (command)"
            className="min-w-0 flex-1 rounded border border-accent bg-surface-base px-1 font-mono text-[10.5px] text-text-primary outline-none"
          />
        ) : (
          // Double-click to rename (issue #21) — mirrors the Sidebar's own
          // double-click-to-rename affordance for workspace/project rows,
          // so Panes stays consistent with the rest of the app's rename UX
          // rather than inventing a new gesture. Displays `headerLabel`
          // (issue #1b — command-when-set, else displayName), but the
          // rename gesture always seeds/edits `displayName`: renaming a
          // pane never touches its setup-rule command, only its name, even
          // while the command is what's currently on screen.
          <span
            title="Double-click to rename"
            onDoubleClick={(e) => {
              e.stopPropagation()
              nameEditValue.seed(displayName)
              setEditingName(true)
            }}
            className={[
              'min-w-0 flex-1 truncate font-mono text-[10.5px]',
              focused ? 'text-text-primary' : 'text-text-muted'
            ].join(' ')}
          >
            {headerLabel}
          </span>
        )}

        {/* Edit — sits immediately beside the name/label (or whichever edit
            input above is currently showing), not in the far-right controls
            cluster. Hover/focus-reveal like the other controls, with a small
            gap from the name so it never overlaps the truncated label.
            Toggles the inline SETUP-RULE (command) input above, which
            commits on blur/Enter and cancels on Escape; committing a
            changed command relaunches the surface (usePaneSurface's
            command-change branch destroys the old process and mounts a
            fresh one). This edits the command, not the name — renaming is
            the name span's own double-click affordance, above. */}
        <button
          type="button"
          title="Edit setup rule"
          className="ml-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-text-muted opacity-0 transition-opacity duration-150 hover:bg-surface-raised hover:text-accent cursor-pointer group-hover:opacity-100 group-focus-within:opacity-100"
          onClick={(e) => {
            e.stopPropagation()
            commandEditValue.seed(command)
            setEditingCommand(true)
          }}
        >
          <Pencil size={12} weight="regular" />
        </button>

        {/* Split buttons — hover/focus-reveal, matching mockup .splitbtns. */}
        <div className="flex gap-px opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
          <button
            type="button"
            title="Split right"
            className="flex h-5 w-5 items-center justify-center rounded text-text-muted hover:bg-surface-raised hover:text-accent cursor-pointer"
            onClick={(e) => {
              e.stopPropagation()
              onSplit(paneId, 'v')
            }}
          >
            <Columns size={13} weight="regular" />
          </button>
          <button
            type="button"
            title="Split down"
            className="flex h-5 w-5 items-center justify-center rounded text-text-muted hover:bg-surface-raised hover:text-accent cursor-pointer"
            onClick={(e) => {
              e.stopPropagation()
              onSplit(paneId, 'h')
            }}
          >
            <Rows size={13} weight="regular" />
          </button>
        </div>

        {/* Stop/start + close — hover/focus-reveal, matching mockup .tctrls.
            (Edit now lives beside the pane name, above.) Real stop/start
            (issue #17): writes to the shared paneRunStateStore, which
            usePaneSurface above turns into a genuine destroy/fresh-mount —
            not a local-only hide/show toggle. */}
        <div className="flex opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
          {running ? (
            <button
              type="button"
              title="Stop"
              className="flex h-5 w-5 items-center justify-center rounded text-text-muted hover:bg-surface-raised hover:text-[#e07a7a] cursor-pointer"
              onClick={(e) => {
                e.stopPropagation()
                setPaneRunning(paneId, false)
              }}
            >
              <Stop size={12} weight="regular" />
            </button>
          ) : (
            <button
              type="button"
              title="Start"
              className="flex h-5 w-5 items-center justify-center rounded text-text-muted hover:bg-surface-raised hover:text-text-primary cursor-pointer"
              onClick={(e) => {
                e.stopPropagation()
                setPaneRunning(paneId, true)
              }}
            >
              <Play size={12} weight="regular" />
            </button>
          )}
          <button
            type="button"
            title="Close"
            className="flex h-5 w-5 items-center justify-center rounded text-text-muted hover:bg-surface-raised hover:text-text-primary cursor-pointer"
            onClick={(e) => {
              e.stopPropagation()
              handleClose()
            }}
          >
            <X size={12} weight="regular" />
          </button>
        </div>
      </div>

      {/* Body — the REAL native terminal surface host when running, or a
          plain stopped placeholder (issue #18's glyph cleanup: no more bare
          "◼ " text prefix on the label — a stopped pane now gets an actual
          body treatment consistent with the phosphor iconography used
          everywhere else in this header). Transparent + flush when live:
          the opaque libghostty NSView paints through this div, same
          convention as workbench/TerminalTab.tsx's own host. */}
      <div ref={containerRef} className="relative flex-1 min-h-0 min-w-0 overflow-hidden">
        {running ? null : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-text-muted">
            <Stop size={16} weight="fill" className="opacity-40" />
            <span className="font-mono text-[10px] opacity-70">stopped</span>
          </div>
        )}
      </div>
    </div>
  )
}
