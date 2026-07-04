// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/TerminalTab.tsx
//
// U8 (P3) — generalizes U6b's single $SHELL surface into a STRIP of ad-hoc
// terminals (docs/plans/2026-07-02-001-feat-workbench-panes-plan.md U8;
// docs/brainstorms/2026-07-02-workbench-panes-requirements.md §5.2). Each
// terminal is its own libghostty surface, keyed
// `workbench:<workspaceId>:<terminalId>` by the main-process handler (U8's
// generalization of U6b's `workbench:<workspaceId>`); the native addon
// treats any `workbench:`-prefixed id as belonging to the single Workbench
// slot, so mounting terminal B auto-evicts (hides, does not destroy)
// whichever terminal was visible — exactly "one visible at a time" for
// free, with NO addon changes (docs/learnings/native-multisurface-
// investigation.md §1).
//
// U9 — terminal list/active-id/next-id state is persisted per-workspace in
// `workbenchTerminalsStore.ts` (a sibling of `workbenchStore.ts`, same
// `createPerKeyStore` idiom) so a remounted TerminalTab (nav away and back,
// LRU eviction) rebuilds the EXACT same tab strip instead of resetting to a
// fresh "Terminal 1", and re-attaches (mounts) each previously-created
// surface instead of orphaning it. This component's own unmount cleanup only
// ever HIDES surfaces (see the `[]`-keyed effect below) — surfaces are
// destroyed ONLY by (f) a terminal's own ✕-close, or (g) the owning
// workspace being closed/archived/removed (handled authoritatively in
// main/index.ts via a per-workspace surface-key registry, independent of
// whatever's currently mounted in the renderer).
//
// Empty-state policy: there is always >=1 terminal — closing the last one
// immediately respawns a fresh "Terminal 1" (see closeTerminal below).
//
// Lifecycle (generalizes U6b's active-toggle / unmount-destroy split):
//   - A single host div is reused for whichever terminal is active — on an
//     active-terminal switch we hide the outgoing key and mount/show the
//     incoming key into the same rect (the addon's slot-eviction means the
//     explicit hide is belt-and-suspenders, not load-bearing).
//   - The active-effect below owns workbench:mount/resize/hide for both (a)
//     the Terminal tab's own active/inactive transitions (mirrors U6b
//     exactly) and (b) switching which terminal is active while the tab
//     itself stays active.
//   - Closing a terminal (✕) destroys ONLY that terminal's key immediately
//     (whether or not it's the active one) — no hide/destroy race, since a
//     background terminal's surface isn't part of the active mount cycle.
//   - Unmounting TerminalTab (owning WorkspaceView torn down, nav away from
//     kind:'workspace', or LRU eviction) HIDES every terminal's surface —
//     generalizing U6b's own single-key unmount effect, but hide instead of
//     destroy (U9). The unmountedRef race guard from U6b is preserved for
//     the currently-active terminal's in-flight mount.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { TerminalStrip, type TerminalStripTerminal } from './TerminalStrip'
import {
  getWorkbenchTerminalsEntry,
  setWorkbenchTerminalsEntry,
  type WorkbenchTerminalModel
} from '@/lib/workbenchTerminalsStore'

// Minimum width/height (CSS px) a measured rect must have before we forward
// it to the addon as a workbench:resize. THE SCROLLBACK GUARD: when the
// Workbench collapses open/expanded → dormant, its container animates from
// its open width toward 0 (the frame uses `width 200ms ease`, dormant is
// width:0). The ResizeObserver below keeps firing during that animation with
// progressively smaller — eventually near-ZERO — rects, and libghostty
// reflows its buffer to whatever size it's handed, PERMANENTLY dropping
// scrollback that no longer "fits" the degenerate size. Dropping any
// sub-floor resize means the surface keeps its LAST GOOD size until it's
// re-shown at a real size — no reflow, no scrollback loss. This mirrors the
// U6b HARD CONSTRAINT that WorkspaceView.tsx enforces for claude's surface on
// expand (its workbenchExpandedRef guard); the workbench terminal needs the
// equivalent guard on collapse-to-dormant. 40px is comfortably below any real
// terminal size yet above the collapsing-animation tail.
const MIN_SURFACE_PX = 40

export interface TerminalTabProps {
  /** The owning claude workspace's id. Each terminal's native surface is
   *  keyed `workbench:<workspaceId>:<terminalId>` by the main-process
   *  handler. */
  workspaceId: string
  /** True when this tab body should be live: the Terminal tab is the active
   *  Workbench tab AND the Workbench is open or expanded. */
  active: boolean
  /** True while the Workbench frame's width is mid-transition (the 200ms
   *  open<->dormant<->expanded CSS animation). While true, this component must
   *  NOT measure + forward a resize, and must DEFER its (re)mount, because the
   *  container is passing through intermediate widths. Forwarding one would
   *  make libghostty reflow the buffer (snapping the viewport to the bottom
   *  and discarding scrollback); mounting at one would land the surface at a
   *  size != the size it had when hidden, defeating the addon's
   *  "size-unchanged -> skip set_size" scrollback guard on reopen. Divider
   *  drags are NOT animations (the CSS transition is suppressed during a drag),
   *  so those still flow through with `animating` false — see WorkbenchPanel. */
  animating: boolean
}

/** Picks which terminal becomes active after closing `closedId` out of
 *  `terminals` (the list BEFORE removal) — the right neighbor, else the
 *  left, matching §5.2's "closing active activates neighbor". Pure helper
 *  so closeTerminal's body stays under the complexity ceiling. */
function neighborAfterClose(
  terminals: readonly WorkbenchTerminalModel[],
  closedId: number
): number | null {
  const idx = terminals.findIndex((t) => t.id === closedId)
  if (idx === -1) return null
  if (idx + 1 < terminals.length) return terminals[idx + 1].id
  if (idx - 1 >= 0) return terminals[idx - 1].id
  return null
}

export function TerminalTab({
  workspaceId,
  active,
  animating
}: TerminalTabProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)

  // activeRef — mirrors the `active` prop as a ref so the stable
  // ResizeObserver-driven resize path (scheduleResize/flushResize) can read
  // the LATEST value without re-subscribing. Mirrors WorkspaceView.tsx's own
  // activeRef guard: when the Workbench collapses to dormant, `active` flips
  // false immediately (before/around the collapse animation), but the
  // ResizeObserver keeps firing with shrinking rects during the animation.
  // Bailing on !activeRef.current means no resize sneaks through while the
  // tab is transitioning to hidden — belt-and-suspenders alongside the
  // MIN_SURFACE_PX floor below.
  const activeRef = useRef(active)
  // eslint-disable-next-line react-hooks/refs -- intentional render-time ref mutation to track latest active prop for the stable resize listeners
  activeRef.current = active

  // animatingRef — mirrors the `animating` prop as a ref so the stable
  // ResizeObserver-driven scheduleResize/flushResize can bail while the
  // Workbench frame's width transition is running (the intermediate-width
  // resizes that would otherwise reflow libghostty and drop scrollback). Same
  // pattern as activeRef above: a render-time ref mutation keeps the stable
  // listeners reading the LATEST value without re-subscribing.
  const animatingRef = useRef(animating)
  // eslint-disable-next-line react-hooks/refs -- intentional render-time ref mutation to track latest animating prop for the stable resize listeners
  animatingRef.current = animating

  // Seed all persisted state from the store exactly once per mount (a fresh
  // TerminalTab instance per workspace-view mount) — read directly (a pure
  // module-level Map lookup, not a ref) so the very first render already
  // reflects whatever this workspace's terminal strip looked like before its
  // last unmount. useState's lazy-initializer form ensures this read only
  // happens on the initial render, never on subsequent re-renders.
  const [terminals, setTerminals] = useState<WorkbenchTerminalModel[]>(
    () => getWorkbenchTerminalsEntry(workspaceId).terminals
  )
  const [activeTerminalId, setActiveTerminalId] = useState(
    () => getWorkbenchTerminalsEntry(workspaceId).activeTerminalId
  )
  // Monotonic terminal-id counter — never reused after a close, per §5.2.
  // Seeded from the store so ids never collide across remounts.
  const nextIdRef = useRef(getWorkbenchTerminalsEntry(workspaceId).nextId)

  // createdKeysRef — the set of terminal ids whose surface has actually been
  // mounted at least once (generalizes U6b's single createdRef boolean).
  // Consulted so hide()/destroy() is only called for keys the addon actually
  // knows about, and so a switch-in mounts a fresh surface vs. re-attaching
  // one. Seeded with every PERSISTED terminal id on mount too — if this
  // workspace had prior terminals, their surfaces are still alive (hidden)
  // addon-side from the previous TerminalTab instance's unmount cleanup, so
  // treating them as "already created" here means this instance's own
  // unmount-hide / close-destroy logic correctly covers them as well.
  const createdKeysRef = useRef<Set<number>>(
    new Set(getWorkbenchTerminalsEntry(workspaceId).terminals.map((t) => t.id))
  )
  // unmountedRef — see U6b's TerminalTab for the race this guards: an
  // in-flight mount() resolving after this component (or the Workbench tab)
  // has torn down must destroy the surface itself instead of leaking it.
  const unmountedRef = useRef(false)
  // pendingCloseRef — ids the user closed (✕) WHILE their workbench:mount
  // call was still in flight. closeTerminal's destroy is gated on
  // createdKeysRef already containing the id (the addon doesn't know about
  // a not-yet-resolved mount yet), so a close landing between "mount
  // requested" and "mount resolved" would otherwise be silently dropped —
  // the mount's `.then` goes on to attach a surface for an id the user
  // already asked to close, leaking it (never destroyed, since closeTerminal
  // already ran and won't run again for this id). Recording the id here lets
  // the mount's `.then` destroy it immediately on resolution instead of
  // attaching, closing that gap.
  const pendingCloseRef = useRef<Set<number>>(new Set())
  // activeTerminalIdRef mirrors activeTerminalId for use inside
  // closeTerminal (a useCallback with stable deps, so it would otherwise
  // close over a stale `activeTerminalId`). Updated in an effect — never
  // during render — per the rules-of-hooks (refs are write-outside-render).
  const activeTerminalIdRef = useRef(activeTerminalId)
  useEffect(() => {
    activeTerminalIdRef.current = activeTerminalId
  }, [activeTerminalId])

  // Persist terminals/activeTerminalId/nextId back to the store on every
  // change — covers spawn, close, auto-title label updates, and tab
  // switches, so a later unmount/remount rebuilds this exact state.
  useEffect(() => {
    setWorkbenchTerminalsEntry(workspaceId, {
      terminals,
      activeTerminalId,
      nextId: nextIdRef.current
    })
  }, [workspaceId, terminals, activeTerminalId])

  // Activate/deactivate + switch-terminal effect — owns workbench:mount /
  // workbench:resize / workbench:hide for every `active` transition AND
  // every `activeTerminalId` change while active, mirroring U6b's single
  // effect but keyed per-terminal.
  useEffect(() => {
    let resizeRafId: number | null = null
    let pendingRect: { x: number; y: number; w: number; h: number } | null = null
    let pendingSf = 1
    let ro: ResizeObserver | null = null
    let mountRafId: number | null = null
    // Whether THIS effect run actually issued a mount (i.e. it was active AND
    // not mid-animation). Only a run that mounted+showed a surface should hide
    // it on cleanup — a run that deferred its mount because a width transition
    // was in flight (active && animating) must NOT hide on cleanup, or it would
    // fire a spurious hide against the surface the very next (settled) run is
    // about to show. Guards the reopen sequence: run-with-animating-true skips
    // mount AND skips the cleanup hide; run-with-animating-false does both.
    let didMount = false
    const terminalId = activeTerminalId

    // Flush the latest pending resize via one IPC call. Re-checks the guards
    // at flush time (not just at schedule time): the tab can deactivate the
    // instant after a resize was scheduled, and this rAF callback fires on the
    // next frame after that flip — dropping it here too closes that window.
    // Mirrors WorkspaceView.tsx's flushResize re-check of workbenchExpandedRef.
    const flushResize = (): void => {
      resizeRafId = null
      if (!pendingRect) return
      if (!activeRef.current || animatingRef.current) {
        // Drop if the tab deactivated OR a width transition started between
        // schedule and flush — a mid-animation resize would reflow scrollback.
        pendingRect = null
        return
      }
      window.api.workbench
        .resize(workspaceId, pendingRect, pendingSf, terminalId)
        .catch((e) => console.error('[TerminalTab] resize failed:', e))
      pendingRect = null
    }

    // Schedule one rAF-coalesced resize IPC. Three guards, mirroring
    // WorkspaceView.tsx's scheduleResize plus the animation guard:
    //   1. State guard: skip if the tab is no longer active — a collapse to
    //      dormant flips `active` false, and any resize measured after that
    //      is part of the collapse, not a real user-driven size change.
    //   2. Animation guard: skip while the Workbench frame's width transition
    //      is running (`animating`). During the 200ms open<->dormant<->
    //      expanded animation the container passes through INTERMEDIATE widths
    //      (> the floor, yet != the settled width); forwarding one would make
    //      libghostty reflow the buffer and snap to the bottom, dropping
    //      scrollback. Resizes only flow once the width has SETTLED (animating
    //      false). Divider drags set no `animating` flag (the CSS transition is
    //      suppressed during a drag), so drag-to-resize is NOT affected here.
    //   3. Floor guard: skip DEGENERATE rects (w/h below MIN_SURFACE_PX) — a
    //      collapsing container produces shrinking, eventually near-zero
    //      rects; forwarding them would make libghostty reflow scrollback to a
    //      degenerate size and lose it. Sub-floor measurements are dropped so
    //      the surface keeps its last good size until it's re-shown for real.
    // A genuine divider-drag to a new real width still produces w/h >= floor
    // while active and NOT animating, so normal resize is unaffected.
    const scheduleResize = (rect: DOMRect): void => {
      if (!activeRef.current || animatingRef.current) return
      if (rect.width < MIN_SURFACE_PX || rect.height < MIN_SURFACE_PX) return
      pendingSf = window.devicePixelRatio ?? 1
      pendingRect = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      }
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
      // Mount only once the frame's width has SETTLED (animating false). If a
      // width transition is running, this effect re-runs when `animating`
      // flips false (it's in the dep array) and mounts THEN — at the final,
      // settled width. On reopen that settled width equals the size the
      // surface had when hidden, so the addon's re-attach path sees
      // sizeChanged == false and skips the reflow, preserving scrollback.
      // rAF so the container has laid out before we measure it (matches
      // WorkspaceView.tsx's mount-effect pattern, preserved from U6b).
      mountRafId = requestAnimationFrame(() => {
        mountRafId = null
        const el = containerRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        const scaleFactor = window.devicePixelRatio ?? 1
        const termRect = {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          w: Math.round(rect.width),
          h: Math.round(rect.height)
        }
        window.api.workbench
          .mount(workspaceId, termRect, scaleFactor, terminalId)
          .then(() => {
            createdKeysRef.current.add(terminalId)
            if (pendingCloseRef.current.has(terminalId)) {
              // The user closed (✕) this terminal WHILE this mount call was
              // still in flight — closeTerminal's own destroy was a no-op
              // back then (createdKeysRef didn't have this id yet), so this
              // resolution must destroy it now instead of attaching a
              // surface for a terminal the strip no longer shows.
              pendingCloseRef.current.delete(terminalId)
              createdKeysRef.current.delete(terminalId)
              window.api.workbench
                .destroy(workspaceId, terminalId)
                .catch((e) => console.error('[TerminalTab] deferred close destroy failed:', e))
              return
            }
            if (unmountedRef.current) {
              // Torn down while this mount was in flight — hide the surface
              // this mount just created/re-attached instead of leaving it
              // visible (mirrors U6b's post-unmount cleanup path, but hide
              // per U9 — only ✕-close/archive/close ever destroy).
              window.api.workbench
                .hide(workspaceId, terminalId)
                .catch((e) => console.error('[TerminalTab] post-unmount hide failed:', e))
              return
            }
            attachResizeListener()
          })
          .catch((e) => console.error('[TerminalTab] mount failed:', e))
      })
    }
    // No `else` branch here for the deactivate case — see the cleanup
    // below, which uniformly hides `terminalId` whenever THIS run was the
    // one that made it visible, covering both "tab deactivated" and
    // "switched to a different terminal" with a single code path (rather
    // than one hide in the body and a second, redundant one in cleanup).

    return () => {
      if (mountRafId !== null) cancelAnimationFrame(mountRafId)
      if (resizeRafId !== null) cancelAnimationFrame(resizeRafId)
      ro?.disconnect()
      pendingRect = null
      // Hide `terminalId` if THIS run made it visible (active was true)
      // and it actually got mounted. Fires on: switching to a different
      // terminal while the tab stays active, OR the tab itself
      // deactivating (tab switched away, Workbench closed to dormant) —
      // both are just "this run's active terminal is no longer the shown
      // one," which is exactly what a cleanup-of-the-outgoing-run means.
      // hide, never destroy (R10) — the shell stays alive in the background.
      // createdKeysRef is a plain mutable data ref (not a DOM ref) — reading
      // its LIVE value at cleanup time is exactly the intended design (it
      // reflects whatever workbench:mount calls have resolved so far), so
      // the lint's "may have changed by cleanup time" warning is expected
      // and safe to disable here.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      if (didMount && createdKeysRef.current.has(terminalId)) {
        window.api.workbench
          .hide(workspaceId, terminalId)
          .catch((e) => console.error('[TerminalTab] hide failed:', e))
      }
    }
    // Re-runs on every `active`, `activeTerminalId`, OR `animating` transition
    // — this is intentionally the ONLY effect that mounts/hides/resizes.
    // `animating` is a dep so the deferred (re)mount fires the moment the
    // frame's width transition settles (animating true -> false): that run
    // measures the FINAL width and mounts there, which on reopen equals the
    // hidden size -> the addon skips set_size -> scrollback survives.
  }, [active, workspaceId, activeTerminalId, animating])

  // True teardown — a SEPARATE `[]`-keyed effect so its cleanup fires only
  // on this component's own unmount (owning WorkspaceView torn down, nav
  // away from kind:'workspace', or LRU eviction), never on an active/inactive
  // or active-terminal toggle above.
  //
  // HIDE, never destroy — mirrors WorkspaceView.tsx's own Effect-1 unmount
  // cleanup exactly (see WorkspaceView.tsx ~L609-621: "hide() keeps the
  // surface alive in the addon's map so that navigating back re-attaches the
  // same shell session. Destroy is fired only from Dashboard on
  // archive/project-remove, or from handleRestart above."). Per the U9
  // persistence rule, a workbench terminal surface may be destroyed ONLY by
  // (f) its own ✕-close (see closeTerminal below) or (g) the owning
  // workspace being closed/archived/removed — both handled authoritatively
  // by main's per-workspace surface registry (see workbenchTerminalRegistry
  // in main/index.ts), NEVER by this component's own unmount. Navigation,
  // LRU eviction, and remounts must all keep every still-open terminal's
  // surface (+ scrollback + live shell) alive — hide is cheap + reversible,
  // exactly like claude's own terminal already does.
  useEffect(() => {
    return () => {
      unmountedRef.current = true
      // Intentionally reads the LIVE set at true-unmount time (not a value
      // captured when this effect was set up, which would just be the
      // initial empty set) — every terminal ever mounted over this
      // component's whole lifetime must be hidden here, however many were
      // opened/closed in between. createdKeysRef is a plain data ref, not a
      // DOM ref, so the lint's node-ref caveat doesn't apply.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      for (const terminalId of createdKeysRef.current) {
        window.api.workbench
          .hide(workspaceId, terminalId)
          .catch((e) => console.error('[TerminalTab] post-unmount hide failed:', e))
      }
    }
    // workspaceId is stable for this component's lifetime (a fresh
    // WorkbenchPanel/TerminalTab mounts per workspace).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-title: reflect whatever program is running in each ad-hoc terminal
  // (e.g. `claude` sets its own title, just like it does in the main
  // per-workspace terminal) via the main process's setTitleCallback bridge,
  // routed here through a dedicated workbench-scoped push channel (see
  // src/main/index.ts's parseWorkbenchSlotId + workbenchTerminalTitleChanged
  // — deliberately NOT workspace:titleChanged, which is claude-workspace-
  // scoped and would collide across terminals). Matched on BOTH workspaceId
  // and terminalId so an event for another workspace's (or another
  // terminal's) surface never touches this list. An empty/blank title falls
  // back to the default "Terminal <id>" label rather than clearing it. Label
  // updates flow through setTerminals, so the persist-effect above picks
  // them up automatically — titles survive nav.
  useEffect(() => {
    const unsub = window.api.workbench.onTerminalTitleChanged((e) => {
      if (e.workspaceId !== workspaceId) return
      setTerminals((prev) =>
        prev.map((t) =>
          t.id === e.terminalId ? { ...t, label: e.title?.trim() || `Terminal ${t.id}` } : t
        )
      )
    })
    return unsub
  }, [workspaceId])

  const spawnTerminal = useCallback((): void => {
    const id = nextIdRef.current
    nextIdRef.current += 1
    setTerminals((prev) => [...prev, { id, label: `Terminal ${id}` }])
    setActiveTerminalId(id)
  }, [])

  const closeTerminal = useCallback(
    (id: number): void => {
      // Destroy this terminal's surface immediately, regardless of whether
      // it's the active one — a background terminal isn't part of the
      // active-effect's mount/hide cycle above, so nothing else will ever
      // clean it up. This IS one of the two allowed destroy triggers (f).
      if (createdKeysRef.current.has(id)) {
        createdKeysRef.current.delete(id)
        window.api.workbench
          .destroy(workspaceId, id)
          .catch((e) => console.error('[TerminalTab] close destroy failed:', e))
      } else {
        // Its workbench:mount call hasn't resolved yet — mark it so the
        // mount's own .then destroys it on resolution instead of attaching
        // a surface for a terminal the strip no longer shows (closes the
        // race where an in-flight mount would otherwise leak).
        pendingCloseRef.current.add(id)
      }

      setTerminals((prev) => {
        const closingActive = id === activeTerminalIdRef.current
        const next = prev.filter((t) => t.id !== id)

        if (next.length === 0) {
          // Empty-state policy: never show an empty strip — respawn a fresh
          // Terminal 1 immediately (monotonic id, so it's a NEW surface key
          // even if the counter happens to land back on 1's old slot; the
          // old key was already destroyed above).
          const freshId = nextIdRef.current
          nextIdRef.current += 1
          setActiveTerminalId(freshId)
          return [{ id: freshId, label: `Terminal ${freshId}` }]
        }

        if (closingActive) {
          setActiveTerminalId(neighborAfterClose(prev, id) ?? next[0].id)
        }
        return next
      })
    },
    [workspaceId]
  )

  const stripTerminals: TerminalStripTerminal[] = terminals.map((t) => ({
    id: t.id,
    label: t.label
  }))

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col">
      <div className="h-8 flex-shrink-0 border-b border-border-default">
        <TerminalStrip
          terminals={stripTerminals}
          activeTerminalId={activeTerminalId}
          onSelect={setActiveTerminalId}
          onClose={closeTerminal}
          onSpawn={spawnTerminal}
        />
      </div>
      <div
        ref={containerRef}
        className="flex-1 min-w-0 min-h-0 relative"
        // Transparent host — the opaque libghostty NSView paints through,
        // same convention as WorkspaceView.tsx's terminal container. Only
        // ONE terminal's surface is ever visible at a time (the addon's
        // slot model), so a single shared host div suffices for all of them.
      />
    </div>
  )
}
