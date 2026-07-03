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
// Terminal list/active-id state is ephemeral component state (persistence
// across navigation is a deliberately deferred future task — see the plan).
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
//   - Unmounting TerminalTab (owning WorkspaceView torn down) destroys ALL
//     terminals' keys — generalizing U6b's own single-key unmount effect.
//     The unmountedRef race guard from U6b is preserved for the currently-
//     active terminal's in-flight mount.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { TerminalStrip, type TerminalStripTerminal } from './TerminalStrip'

export interface TerminalTabProps {
  /** The owning claude workspace's id. Each terminal's native surface is
   *  keyed `workbench:<workspaceId>:<terminalId>` by the main-process
   *  handler. */
  workspaceId: string
  /** True when this tab body should be live: the Terminal tab is the active
   *  Workbench tab AND the Workbench is open or expanded. */
  active: boolean
}

interface TerminalModel {
  id: number
  label: string
}

const FIRST_TERMINAL: TerminalModel = { id: 1, label: 'Terminal 1' }

/** Picks which terminal becomes active after closing `closedId` out of
 *  `terminals` (the list BEFORE removal) — the right neighbor, else the
 *  left, matching §5.2's "closing active activates neighbor". Pure helper
 *  so closeTerminal's body stays under the complexity ceiling. */
function neighborAfterClose(terminals: readonly TerminalModel[], closedId: number): number | null {
  const idx = terminals.findIndex((t) => t.id === closedId)
  if (idx === -1) return null
  if (idx + 1 < terminals.length) return terminals[idx + 1].id
  if (idx - 1 >= 0) return terminals[idx - 1].id
  return null
}

export function TerminalTab({ workspaceId, active }: TerminalTabProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [terminals, setTerminals] = useState<TerminalModel[]>([FIRST_TERMINAL])
  const [activeTerminalId, setActiveTerminalId] = useState(FIRST_TERMINAL.id)
  // Monotonic terminal-id counter — never reused after a close, per §5.2.
  const nextIdRef = useRef(FIRST_TERMINAL.id + 1)

  // createdKeysRef — the set of terminal ids whose surface has actually been
  // mounted at least once (generalizes U6b's single createdRef boolean).
  // Consulted so destroy() is only called for keys the addon actually knows
  // about, and so a switch-in mounts a fresh surface vs. re-attaching one.
  const createdKeysRef = useRef<Set<number>>(new Set())
  // unmountedRef — see U6b's TerminalTab for the race this guards: an
  // in-flight mount() resolving after this component (or the Workbench tab)
  // has torn down must destroy the surface itself instead of leaking it.
  const unmountedRef = useRef(false)
  // activeTerminalIdRef mirrors activeTerminalId for use inside
  // closeTerminal (a useCallback with stable deps, so it would otherwise
  // close over a stale `activeTerminalId`). Updated in an effect — never
  // during render — per the rules-of-hooks (refs are write-outside-render).
  const activeTerminalIdRef = useRef(activeTerminalId)
  useEffect(() => {
    activeTerminalIdRef.current = activeTerminalId
  }, [activeTerminalId])

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
    const terminalId = activeTerminalId

    const flushResize = (): void => {
      resizeRafId = null
      if (!pendingRect) return
      window.api.workbench
        .resize(workspaceId, pendingRect, pendingSf, terminalId)
        .catch((e) => console.error('[TerminalTab] resize failed:', e))
      pendingRect = null
    }

    const scheduleResize = (rect: DOMRect): void => {
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

    if (active) {
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
            if (unmountedRef.current) {
              // Torn down while this mount was in flight — destroy the
              // surface this mount just created/re-attached instead of
              // leaking it (mirrors U6b's post-unmount destroy path).
              window.api.workbench
                .destroy(workspaceId, terminalId)
                .catch((e) => console.error('[TerminalTab] post-unmount destroy failed:', e))
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
      if (active && createdKeysRef.current.has(terminalId)) {
        window.api.workbench
          .hide(workspaceId, terminalId)
          .catch((e) => console.error('[TerminalTab] hide failed:', e))
      }
    }
    // Re-runs on every `active` OR `activeTerminalId` transition — this is
    // intentionally the ONLY effect that mounts/hides/resizes.
  }, [active, workspaceId, activeTerminalId])

  // True teardown — a SEPARATE `[]`-keyed effect so its cleanup fires only
  // on this component's own unmount (owning WorkspaceView torn down), never
  // on an active/inactive or active-terminal toggle above. Destroys EVERY
  // terminal's surface, not just the active one.
  useEffect(() => {
    return () => {
      unmountedRef.current = true
      // Intentionally reads the LIVE set at true-unmount time (not a value
      // captured when this effect was set up, which would just be the
      // initial empty set) — every terminal ever mounted over this
      // component's whole lifetime must be destroyed here, however many
      // were opened/closed in between. createdKeysRef is a plain data ref,
      // not a DOM ref, so the lint's node-ref caveat doesn't apply.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      for (const terminalId of createdKeysRef.current) {
        window.api.workbench
          .destroy(workspaceId, terminalId)
          .catch((e) => console.error('[TerminalTab] destroy failed:', e))
      }
    }
    // workspaceId is stable for this component's lifetime (a fresh
    // WorkbenchPanel/TerminalTab mounts per workspace).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
      // clean it up.
      if (createdKeysRef.current.has(id)) {
        createdKeysRef.current.delete(id)
        window.api.workbench
          .destroy(workspaceId, id)
          .catch((e) => console.error('[TerminalTab] close destroy failed:', e))
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
      <div className="h-6 flex-shrink-0 border-b border-border-default">
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
