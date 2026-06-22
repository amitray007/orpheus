import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type React from 'react'
import type { GhPullRequest, WorkspaceRecord, WorkspaceActivityDetail } from '@shared/types'
import { WorkspaceDrawer } from './WorkspaceDrawer'
import { WorkspaceTitleBar } from './WorkspaceTitleBar'
import { WorkspaceFooter } from './footer/WorkspaceFooter'
import { useWorkspaceActivity } from '@/lib/activityStore'
import { useTerminalSleeping } from '@/lib/sleepStore'
import { Moon } from '@phosphor-icons/react'

interface WorkspaceViewProps {
  workspace: WorkspaceRecord
  /** Whether this workspace is currently the active (visible) one.
   *  When false the view is CSS-hidden; the native surface is also hidden
   *  via terminal:hide so it stops drawing. When flipped to true the surface
   *  is re-attached via terminal:mount (fast rAF, no 75ms debounce). */
  active?: boolean
  /** Last-seen activity detail from Dashboard's live cache; seeds the drawer
   *  glyph on re-mount so a tool / compacting / asking sub-state survives a
   *  navigation round-trip until the next hook event refreshes it. */
  initialDetail?: WorkspaceActivityDetail
  /** Open PR for this workspace's current branch, fetched at Dashboard level. */
  pr?: GhPullRequest | null
  /** Callback to navigate to a workspace — used by footer post-fork. */
  onSelectWorkspace?: (workspaceId: string, projectId: string) => void
  /** All workspaces across projects — used by title bar "forked from" chip. */
  allWorkspaces?: WorkspaceRecord[]
}

export function WorkspaceView({
  workspace,
  active = true,
  initialDetail,
  pr,
  onSelectWorkspace,
  allWorkspaces
}: WorkspaceViewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  // mountedRef guards against double-mount in React StrictMode (first-create path).
  const mountedRef = useRef(false)
  // surfaceCreatedRef — true once terminal:mount has been called at least once
  // for this workspace ID (i.e. the native surface exists in the addon's map).
  // When active flips true on an already-created surface we skip the 75ms
  // debounce and use a single rAF (fast re-activate path).
  const surfaceCreatedRef = useRef(false)
  // activeRef — mirrors the `active` prop as a ref so stable callbacks
  // (resize listeners) can read the latest value without re-subscribing.
  const activeRef = useRef(active)
  // eslint-disable-next-line react-hooks/refs -- intentional render-time ref mutation to track latest active prop for resize listeners
  activeRef.current = active

  // remountKey — incrementing this triggers the mount effect to re-run,
  // which tears down the old surface and boots a fresh one with new settings.
  const [remountKey, setRemountKey] = useState(0)
  // Drawer: null = closed; 'status' | 'overrides' = open on that tab
  const [drawer, setDrawer] = useState<null | 'status' | 'overrides'>(null)
  // Where to portal the workspace title bar — slot lives in TopBar.
  const [titleBarHost, setTitleBarHost] = useState<HTMLElement | null>(null)

  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time DOM query at mount; DOM not available until after render
    setTitleBarHost(document.getElementById('topbar-workspace-slot'))
  }, [])

  // Sleep state — true when the macOS window is occluded/backgrounded and the
  // native terminal render loop is paused.
  const sleeping = useTerminalSleeping(workspace.id)

  // Activity status and detail from the per-key store — re-renders only when
  // THIS workspace's activity changes (not when any other workspace fires).
  // Replaces the old onActivityChanged subscription that was registering
  // a duplicate listener on top of Dashboard's.
  const storeDetail = useWorkspaceActivity(workspace.id)

  // detail: prefer live store value; fall back to initialDetail (seed from Dashboard
  // snapshot passed at mount time) so the drawer glyph is correct before the
  // first hook event fires.
  const detail: WorkspaceActivityDetail | undefined = storeDetail ?? initialDetail

  // Activity status (coarse) — derived from the detail for the drawer.
  // Mirrors the mapping in orpheusNotify.ts / WorkspaceActivityDetail definitions.
  const activity = workspace.status

  async function handleRestart(): Promise<void> {
    await window.api.terminal.destroy(workspace.id)
    // Bumping remountKey re-fires the mount effect below, which calls terminal.mount
    // with the freshly composed launch params. The main process snapshots the new
    // launch at that point and clears dirty — the chip disappears via dirtyChanged event.
    setRemountKey((k) => k + 1)
  }

  const handleCloseDrawer = useCallback(() => setDrawer(null), [])

  // ---------------------------------------------------------------------------
  // Mount / resize / active-toggle lifecycle
  //
  // A single effect owns:
  //   • First-create (75ms debounce + rAF) — runs when component mounts active
  //   • Resize observers — only active while the surface is visible
  //   • Unmount cleanup (terminal:hide)
  //
  // The active-toggle effect (below) reacts to active prop changes AFTER the
  // first render:
  //   • false → terminal:hide
  //   • true  → terminal:mount (fast rAF, no debounce)
  //
  // Shared mutable state between the two effects is held in refs so both
  // closures read the same live values without re-registering.
  // ---------------------------------------------------------------------------

  // Ref bundle shared between the two effects below.
  // Callbacks are written into it by Effect 1 so Effect 2 can call them.
  const effectStateRef = useRef<{
    attachResizeListeners: () => void
    detachResizeListeners: () => void
  } | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    // StrictMode double-mount guard
    if (mountedRef.current) return
    mountedRef.current = true

    const workspaceId = workspace.id
    const cwd = workspace.cwd

    // rAF guard for resize coalescing
    let resizeRafId: number | null = null
    let pendingResizeRect: { x: number; y: number; w: number; h: number } | null = null
    let pendingResizeSf = 1

    const doMount = async (): Promise<void> => {
      const rect = el.getBoundingClientRect()
      const scaleFactor = window.devicePixelRatio ?? 1

      // getBoundingClientRect() returns viewport-relative coords.
      // The Electron BrowserWindow's contentView IS the viewport, so these
      // coords map directly to the AppKit coordinate space (after Y-flip in the addon).
      const termRect = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      }

      console.log(
        '[WorkspaceView] mounting terminal workspaceId=',
        workspaceId,
        termRect,
        'dpr=',
        scaleFactor,
        'remountKey=',
        remountKey
      )
      try {
        const result = await window.api.terminal.mount(workspaceId, termRect, scaleFactor, cwd)
        surfaceCreatedRef.current = true
        // Guard: if the user navigated away while mount was resolving, hide
        // immediately so the surface doesn't draw while inactive.
        if (!activeRef.current) {
          window.api.terminal
            .hide(workspaceId)
            .catch((e) => console.error('[WorkspaceView] post-mount hide failed:', e))
          return
        }
        console.log(
          '[WorkspaceView] mounted workspaceId=',
          result.workspaceId,
          'created=',
          result.created
        )
        // Re-assert terminal focus AFTER the native mount path's dispatch_async
        // makeFirstResponder runs. A DOM overlay (e.g. an open sidebar hover card)
        // can win the focus race at mount time, leaving the terminal unable to
        // receive keystrokes until a click or workspace switch. Defer to a macrotask
        // so this runs after the native focus-grab, and guard on active so we never
        // focus a hidden/inactive surface.
        setTimeout(() => {
          if (!activeRef.current || !mountedRef.current) return
          void window.api.terminal.focus(workspaceId).catch(() => {})
        }, 0)
      } catch (err) {
        console.error('[WorkspaceView] mount failed:', err)
      }
    }

    // Flush the latest pending resize measurement via a single IPC call.
    const flushResize = (): void => {
      resizeRafId = null
      if (!pendingResizeRect) return
      window.api.terminal
        .resize(workspaceId, pendingResizeRect, pendingResizeSf)
        .catch((e) => console.error('[WorkspaceView] resize failed:', e))
      pendingResizeRect = null
    }

    // Schedule one rAF-coalesced resize IPC. Intermediate measurements during
    // a window drag are stored in the ref and only the last one is flushed.
    // Guard: skip if the surface is not active — inactive views are display:none
    // and would report a 0×0 rect which would corrupt the IOSurface geometry.
    const scheduleResize = (rect: DOMRect): void => {
      if (!activeRef.current) return
      pendingResizeSf = window.devicePixelRatio ?? 1
      pendingResizeRect = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      }
      if (resizeRafId === null) {
        resizeRafId = requestAnimationFrame(flushResize)
      }
    }

    // ResizeObserver — fires when the div's intrinsic size changes.
    // This fires automatically when the drawer opens/closes and changes the
    // terminal host div's width via flex layout.
    // Lifecycle: attached when the view becomes active, detached when inactive.
    let ro: ResizeObserver | null = null
    let boundWindowResize: (() => void) | null = null

    const attachResizeListeners = (): void => {
      if (ro) return // idempotent
      ro = new ResizeObserver(() => {
        if (!el) return
        scheduleResize(el.getBoundingClientRect())
      })
      ro.observe(el)

      boundWindowResize = (): void => {
        if (!el) return
        scheduleResize(el.getBoundingClientRect())
      }
      window.addEventListener('resize', boundWindowResize)
    }

    const detachResizeListeners = (): void => {
      ro?.disconnect()
      ro = null
      if (boundWindowResize) {
        window.removeEventListener('resize', boundWindowResize)
        boundWindowResize = null
      }
      if (resizeRafId !== null) {
        cancelAnimationFrame(resizeRafId)
        resizeRafId = null
      }
      pendingResizeRect = null
    }

    // Expose to the active-toggle effect so it can manage resize listeners
    // without duplicating all the closure variables.
    effectStateRef.current = { attachResizeListeners, detachResizeListeners }

    // First-create mount path: 75ms debounce + rAF.
    // If mounted inactive (pre-warmed by LRU keep-alive), skip — the
    // active-toggle effect handles mount when active flips to true.
    let mountTimerId: ReturnType<typeof setTimeout> | null = null
    let mountRafId: number | null = null

    if (active) {
      // 75ms debounce before mounting — rapid navigation (e.g. clicking through
      // the sidebar quickly) will cancel the pending mount and only the final
      // destination surface actually mounts. The cleanup function cancels the
      // timer before calling terminal.hide, so no mount fires after unmount.
      mountTimerId = setTimeout(() => {
        mountTimerId = null
        // Small rAF delay after the debounce to ensure the div has been laid
        // out and painted before we measure its rect.
        mountRafId = requestAnimationFrame(() => {
          mountRafId = null
          if (!mountedRef.current) return // guard: unmounted during rAF
          // Guard: if active was flipped to false after the debounce started
          // (rapid navigation with keep-alive), abort the mount. Effect 2 will
          // call terminal:hide for the active→false transition.
          if (!activeRef.current) return
          attachResizeListeners()
          doMount()
        })
      }, 75)
    }

    return () => {
      // Cancel any pending debounced mount — prevents mount from firing after unmount.
      if (mountTimerId !== null) {
        clearTimeout(mountTimerId)
        mountTimerId = null
      }
      // Cancel the rAF spawned inside the mount timer, if it hasn't fired yet.
      if (mountRafId !== null) {
        cancelAnimationFrame(mountRafId)
        mountRafId = null
      }

      detachResizeListeners()
      effectStateRef.current = null

      // hide() keeps the surface alive in the addon's map so that navigating
      // back re-attaches the same shell session. Destroy is fired only from
      // Dashboard on archive/project-remove, or from handleRestart above.
      if (surfaceCreatedRef.current) {
        console.log('[WorkspaceView] hiding surface on unmount workspaceId=', workspaceId)
        window.api.terminal
          .hide(workspaceId)
          .catch((e) => console.error('[WorkspaceView] hide failed:', e))
      }
      mountedRef.current = false
      surfaceCreatedRef.current = false
    }
    // remountKey is intentionally included: bumping it re-runs this effect
    // to remount the surface with fresh launch params after a restart.
    // active is intentionally excluded: active-toggle lifecycle is in the next effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remountKey])

  // ---------------------------------------------------------------------------
  // Active-toggle effect — drives terminal:hide / terminal:mount on switches.
  //
  // Skips the first render — Effect 1 owns first-create / initial mount.
  // After the first render, active transitions drive:
  //   true → false: terminal:hide, detach resize listeners
  //   false → true: terminal:mount (fast rAF, no 75ms debounce), attach listeners
  //
  // Guard: only fires the hide/re-mount paths when the surface has been created
  // (surfaceCreatedRef.current is true). This prevents a double-mount race with
  // Effect 1 in React StrictMode, where both effects re-run after the teardown.
  // ---------------------------------------------------------------------------
  const isFirstActiveRenderRef = useRef(true)
  useEffect(() => {
    // Skip the first render — Effect 1 owns the first-create path.
    if (isFirstActiveRenderRef.current) {
      isFirstActiveRenderRef.current = false
      return
    }

    const el = containerRef.current
    const workspaceId = workspace.id
    const cwd = workspace.cwd

    if (!active) {
      // Deactivating: hide the surface so ghostty's display link stops drawing.
      // Only act if the surface was actually created (guards StrictMode teardown).
      if (surfaceCreatedRef.current) {
        console.log('[WorkspaceView] hiding surface (deactivated) workspaceId=', workspaceId)
        window.api.terminal
          .hide(workspaceId)
          .catch((e) => console.error('[WorkspaceView] hide (deactivate) failed:', e))
      }
      // Detach resize listeners — inactive views are display:none so their rects
      // are meaningless; we don't want to fire bogus resize IPCs.
      effectStateRef.current?.detachResizeListeners()
      return
    }

    // Activating: re-mount the surface. Fast rAF (no 75ms debounce) since the
    // user explicitly navigated here.
    // Guard: if Effect 1 hasn't run yet (effectStateRef.current is null), the
    // shared closure state (resize listeners etc.) isn't ready. This happens
    // in StrictMode double-mount teardown where both effects re-run in sequence.
    // Effect 1 will handle the initial mount via its 75ms debounce.
    if (!effectStateRef.current) return

    let rafId: number | null = null
    rafId = requestAnimationFrame(() => {
      rafId = null
      if (!el) return

      const rect = el.getBoundingClientRect()
      const scaleFactor = window.devicePixelRatio ?? 1
      const termRect = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      }

      console.log(
        '[WorkspaceView] re-mounting surface (activated) workspaceId=',
        workspaceId,
        termRect
      )
      window.api.terminal
        .mount(workspaceId, termRect, scaleFactor, cwd)
        .then((result) => {
          surfaceCreatedRef.current = true
          // Guard: if the user navigated away while re-mount was resolving, hide
          // immediately so the surface doesn't draw while inactive.
          if (!activeRef.current || !mountedRef.current) {
            window.api.terminal
              .hide(workspaceId)
              .catch((e) => console.error('[WorkspaceView] post-mount hide failed:', e))
            return
          }
          console.log(
            '[WorkspaceView] re-mounted workspaceId=',
            result.workspaceId,
            'created=',
            result.created
          )
          // Re-attach resize listeners now that the surface is live.
          effectStateRef.current?.attachResizeListeners()
          // Re-assert terminal focus AFTER the native dispatch_async makeFirstResponder
          // (see first-create path) — wins the focus race against an open DOM overlay
          // so keyboard input lands in the terminal on re-activate.
          setTimeout(() => {
            if (!activeRef.current || !mountedRef.current) return
            void window.api.terminal.focus(workspaceId).catch(() => {})
          }, 0)
        })
        .catch((e) => console.error('[WorkspaceView] re-mount failed:', e))
    })

    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
    }
    // workspace.cwd is stable for a given workspace record.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  return (
    <>
      {/* Only render the title bar portal when this workspace is active.
          Inactive (keep-alive) views must not compete for the topbar slot. */}
      {active &&
        titleBarHost &&
        createPortal(
          <WorkspaceTitleBar
            workspace={workspace}
            drawer={drawer}
            onSetDrawer={setDrawer}
            pr={pr}
            allWorkspaces={allWorkspaces}
          />,
          titleBarHost
        )}

      {/* Content row: terminal host + optional drawer */}
      <div className="flex h-full min-h-0">
        {/* Terminal column: terminal host + footer strip */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Terminal area — the libghostty NSView is parented as the BOTTOM sibling of
              the BrowserWindow contentView (NSWindowBelow), so the web layer composites
              OVER it. This div MUST stay background-less (transparent) so the terminal
              shows through; an opaque bg here would hide the terminal entirely.
              ResizeObserver fires when the footer height changes the container. */}
          <div ref={containerRef} className="flex-1 min-w-0 relative">
            {active && sleeping && (
              <button
                type="button"
                onClick={() => void window.api.terminal.focus(workspace.id)}
                title="Click to wake the terminal"
                className="absolute top-2 right-2 z-20 flex items-center gap-1 bg-surface-overlay/90 border border-border-default rounded-md px-2 py-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
              >
                <Moon size={12} weight="fill" />
                Asleep
              </button>
            )}
          </div>

          <WorkspaceFooter
            workspaceId={workspace.id}
            sessionId={workspace.claudeSessionId}
            cwd={workspace.cwd}
            projectId={workspace.projectId}
            workspaceName={workspace.name}
            onSelectWorkspace={onSelectWorkspace}
            activityDetail={detail}
          />
        </div>

        {drawer !== null && (
          <div className="w-80 flex-shrink-0 border-l border-border-default bg-surface-raised flex flex-col">
            <WorkspaceDrawer
              workspace={workspace}
              activity={activity}
              detail={detail}
              onClose={handleCloseDrawer}
              onRestart={() => {
                handleRestart().catch((e) => console.error('[WorkspaceView] restart failed:', e))
              }}
            />
          </div>
        )}
      </div>
    </>
  )
}
