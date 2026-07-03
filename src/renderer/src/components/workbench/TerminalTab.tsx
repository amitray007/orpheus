// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/TerminalTab.tsx
//
// U6b (P2) — the Workbench Terminal tab's real body: ONE plain $SHELL
// libghostty surface, mounted beside claude's via the native addon's slot
// model proven in U6a (docs/learnings/native-multisurface-investigation.md
// §1 — any workspaceId prefixed `workbench:` routes to the Workbench slot and
// coexists with claude's surface without evicting it).
//
// Scope (U6b, per docs/plans/2026-07-02-001-feat-workbench-panes-plan.md U8):
// exactly one shell, not a tab strip of many (that's U8) and not the
// Commands library (U11/U12). The mount/resize/hide lifecycle here
// deliberately mirrors WorkspaceView.tsx's containerRef + getBoundingClientRect
// -> IPC -> addon pattern (the DOM->IPC->native rect path is CSS pixels
// relative to the contentView, NOT screen coordinates — see the
// investigation doc §6 — so this must NOT reuse overlayLayer.ts's coordinate
// math).
//
// Lifecycle:
//   - Mounts (workbench:mount) whenever `active` transitions to true —
//     including the FIRST such transition, whether that happens on initial
//     render (Terminal tab already selected + Workbench already open) or
//     later (component rendered inactive first — e.g. Workbench dormant —
//     then activated by opening/selecting the tab). ONE effect below owns
//     every active-becomes-true / active-becomes-false transition uniformly;
//     there is no separate "first mount" special case that can fall out of
//     sync with the steady-state toggle path.
//   - Resizes (workbench:resize, rAF-coalesced) via a ResizeObserver on the
//     host div, attached only while active.
//   - Hides (workbench:hide) when `active` becomes false (tab switched away,
//     or the Workbench closes to dormant) — NEVER destroyed on a mere tab
//     switch, so the shell session survives navigating away and back
//     (hide != destroy, R10).
//   - Destroyed only in a SEPARATE, `[]`-keyed effect's cleanup — i.e. only
//     on this component's own unmount (owning WorkspaceView torn down). If
//     unmount races an in-flight mount(), the mount's completion handler
//     checks `unmountedRef` and issues the destroy itself once the promise
//     resolves, so a surface can never be left dangling in the addon.
//     Keeping destroy in its own effect (rather than in the active-toggle
//     effect's cleanup) means there is exactly ONE call site that can ever
//     destroy the surface — no ambiguity from React's cleanup ordering
//     across two effects.
// ---------------------------------------------------------------------------

import { useEffect, useRef } from 'react'
import type React from 'react'

export interface TerminalTabProps {
  /** The owning claude workspace's id. The native surface is keyed
   *  `workbench:<workspaceId>` by the main-process handler. */
  workspaceId: string
  /** True when this tab body should be live: the Terminal tab is the active
   *  Workbench tab AND the Workbench is open or expanded. */
  active: boolean
}

export function TerminalTab({ workspaceId, active }: TerminalTabProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  // createdRef — true once workbench:mount has resolved at least once for
  // this workspaceId. Read by the unmount-destroy effect to decide whether a
  // destroy call is actually needed.
  const createdRef = useRef(false)
  // unmountedRef — flips true in the destroy effect's cleanup. Consulted by
  // an in-flight mount()'s .then() so a mount that resolves AFTER unmount
  // destroys the surface itself instead of leaking it (the destroy effect's
  // cleanup runs synchronously and cannot destroy a surface that doesn't
  // exist yet at that point).
  const unmountedRef = useRef(false)

  // Activate/deactivate effect — owns workbench:mount / workbench:resize /
  // workbench:hide for every `active` transition, first-or-not.
  useEffect(() => {
    let resizeRafId: number | null = null
    let pendingRect: { x: number; y: number; w: number; h: number } | null = null
    let pendingSf = 1
    let ro: ResizeObserver | null = null
    let mountRafId: number | null = null

    const flushResize = (): void => {
      resizeRafId = null
      if (!pendingRect) return
      window.api.workbench
        .resize(workspaceId, pendingRect, pendingSf)
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
      // WorkspaceView.tsx's mount-effect pattern).
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
          .mount(workspaceId, termRect, scaleFactor)
          .then(() => {
            createdRef.current = true
            if (unmountedRef.current) {
              // Component was torn down while this mount was in flight — the
              // destroy effect's cleanup already ran and saw createdRef as
              // false, so it couldn't destroy anything. Do it now so the
              // surface never outlives this component.
              window.api.workbench
                .destroy(workspaceId)
                .catch((e) => console.error('[TerminalTab] post-unmount destroy failed:', e))
              return
            }
            attachResizeListener()
          })
          .catch((e) => console.error('[TerminalTab] mount failed:', e))
      })
    } else if (createdRef.current) {
      // Deactivating an already-created surface (tab switched away, or the
      // Workbench closed to dormant) — hide, don't destroy (R10).
      window.api.workbench
        .hide(workspaceId)
        .catch((e) => console.error('[TerminalTab] hide failed:', e))
    }

    return () => {
      if (mountRafId !== null) cancelAnimationFrame(mountRafId)
      if (resizeRafId !== null) cancelAnimationFrame(resizeRafId)
      ro?.disconnect()
      pendingRect = null
    }
    // Re-runs on every `active` transition — this is intentionally the ONLY
    // effect that mounts/hides/resizes; it does not destroy (see the
    // separate unmount-only effect below), so there is exactly one call
    // site for each native action, regardless of how many times `active`
    // toggles or in what order React runs cleanups.
  }, [active, workspaceId])

  // True teardown — a SEPARATE `[]`-keyed effect so its cleanup fires only
  // on this component's own unmount (owning WorkspaceView torn down), never
  // on a mere active/inactive toggle above.
  useEffect(() => {
    return () => {
      unmountedRef.current = true
      if (createdRef.current) {
        window.api.workbench
          .destroy(workspaceId)
          .catch((e) => console.error('[TerminalTab] destroy failed:', e))
      }
    }
    // workspaceId is stable for this component's lifetime (a fresh
    // WorkbenchPanel/TerminalTab mounts per workspace).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      ref={containerRef}
      className="flex-1 min-w-0 relative"
      // Transparent host — the opaque libghostty NSView paints through, same
      // convention as WorkspaceView.tsx's terminal container.
    />
  )
}
