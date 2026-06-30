import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type React from 'react'
import type { GhPullRequest, WorkspaceRecord, WorkspaceActivityDetail } from '@shared/types'
import { logDiag } from '@/lib/diag'
import { DIAG_EVENTS } from '@shared/diagEvents'
import { WorkspaceDrawer } from './WorkspaceDrawer'
import { WorkspaceTitleBar } from './WorkspaceTitleBar'
import { WorkspaceFooter } from './footer/WorkspaceFooter'
import { WorkspaceTerminalOverlays } from './WorkspaceTerminalOverlays'
import { WorktreeErrorCard } from './WorktreeErrorCard'
import type { WorktreeError } from './WorktreeErrorCard'
import { useWorkspaceActivity } from '@/lib/activityStore'
import { useTerminalSleeping } from '@/lib/sleepStore'
import { setActiveWatchdogWorkspace } from '@/lib/freezeWatchdog'

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
  // surfaceCreatedRef — sync hint: true once terminal:mount has been called at
  // least once for this workspace ID. Used for fast synchronous guards (e.g. the
  // unmount-cleanup hide path). NOT authoritative for mount decisions — can be
  // stale if the native surface was freed without going through React cleanup.
  // The active-toggle mount path consults getSurfacePhase (native truth) instead.
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
  // Worktree reconcile error — set when terminal:mount returns worktreeError.
  // While non-null the terminal surface is not mounted; WorktreeErrorCard is shown instead.
  const [worktreeError, setWorktreeError] = useState<WorktreeError | null>(null)
  // converting — true while a convertToLocal IPC is in-flight; prevents double-conversion.
  const [converting, setConverting] = useState(false)
  // pendingCwdOverrideRef — holds the fresh cwd returned by convertToLocal so the
  // re-mount triggered by bumping remountKey uses the updated repo-root path rather
  // than the stale workspace.cwd prop (which propagates via workspaces:changed only
  // after the IPC resolves, potentially after the effect closure has already closed
  // over the old value). Cleared (set to null) once consumed by doMount.
  const pendingCwdOverrideRef = useRef<string | null>(null)
  // One-time notice from a successful mount (e.g. "started fresh on branch X").
  const [notice, setNotice] = useState<string | null>(null)
  // Where to portal the workspace title bar — slot lives in TopBar.
  const [titleBarHost, setTitleBarHost] = useState<HTMLElement | null>(null)

  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time DOM query at mount; DOM not available until after render
    setTitleBarHost(document.getElementById('topbar-workspace-slot'))
  }, [])

  // Sleep state — true when the macOS window is occluded/backgrounded and the
  // native terminal render loop is paused.
  const sleeping = useTerminalSleeping(workspace.id)
  const isClosed = workspace.closedAt !== null
  const isClosedRef = useRef(isClosed)
  // eslint-disable-next-line react-hooks/refs -- intentional render-time ref mutation
  isClosedRef.current = isClosed

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

  const handleRestart = useCallback(() => {
    window.api.terminal
      .destroy(workspace.id)
      // Bumping remountKey re-fires the mount effect below, which calls terminal.mount
      // with the freshly composed launch params. The main process snapshots the new
      // launch at that point and clears dirty — the chip disappears via dirtyChanged event.
      .then(() => setRemountKey((k) => k + 1))
      .catch((e) => console.error('[WorkspaceView] restart failed:', e))
  }, [workspace.id])

  const handleFocusTerminal = useCallback(() => {
    void window.api.terminal.focus(workspace.id)
  }, [workspace.id])

  const handleCloseDrawer = useCallback(() => setDrawer(null), [])

  // --- Worktree error card callbacks ---

  /** Retry mount after a worktree reconcile error by bumping the remount key. */
  const handleWorktreeRetry = useCallback(() => {
    setWorktreeError(null)
    setRemountKey((k) => k + 1)
  }, [])

  /** Reveal the conflict path (or worktree parent) in Finder. */
  const handleWorktreeOpenLocation = useCallback((p: string) => {
    void window.api.shell.revealInFinder(p).catch((e) => {
      console.error('[WorkspaceView] revealInFinder failed:', e)
    })
  }, [])

  /**
   * Convert a worktree workspace to a local workspace (non-destructive), then
   * re-mount at the repo root. The IPC returns the updated WorkspaceRecord; we
   * stash its cwd in pendingCwdOverrideRef so the re-mount (triggered by bumping
   * remountKey) uses the fresh repo-root path instead of the stale workspace.cwd
   * prop (which only updates when the workspaces:changed broadcast propagates
   * through Dashboard state — potentially after the mount effect closure has
   * already been created with the old value).
   *
   * The `converting` flag prevents double-conversion if the button is clicked
   * twice before the IPC resolves.
   */
  const handleWorktreeConvertToLocal = useCallback(() => {
    setConverting(true)
    void window.api.workspaces
      .convertToLocal(workspace.id)
      .then((updated) => {
        // Stash the fresh cwd BEFORE bumping remountKey so the mount effect
        // closure created on the next render can read it via the ref.
        pendingCwdOverrideRef.current = updated.cwd
        setWorktreeError(null)
        setRemountKey((k) => k + 1)
      })
      .catch((e) => {
        console.error('[WorkspaceView] convertToLocal failed:', e)
      })
      .finally(() => {
        setConverting(false)
      })
  }, [workspace.id])

  // Auto-dismiss the one-time notice after 6 seconds.
  useEffect(() => {
    if (!notice) return
    const id = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(id)
  }, [notice])

  const requestRemount = useCallback(() => {
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
    // Re-attach recovery (the automated "switch view and back"): hide then mount.
    // Keeps the claude process alive (unlike handleRestart which destroys).
    void window.api.terminal
      .hide(workspace.id)
      .then(() => window.api.terminal.mount(workspace.id, termRect, scaleFactor, workspace.cwd))
      .catch(() => {})
  }, [workspace.id, workspace.cwd])

  useEffect(() => {
    if (!active) {
      setActiveWatchdogWorkspace(null, null)
      return
    }
    setActiveWatchdogWorkspace(workspace.id, requestRemount)
    return () => setActiveWatchdogWorkspace(null, null)
  }, [active, workspace.id, requestRemount])

  useEffect(() => {
    if (isClosed) {
      // Backend destroyed the surface (workspace:close frees native resources).
      // Mark it gone so the mount-effect cleanup won't fire a stale terminal.hide
      // on a destroyed surface, which would race the reopen mount and stick the terminal.
      surfaceCreatedRef.current = false
    }
  }, [isClosed])

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
    // Prefer pendingCwdOverrideRef when set (populated by convertToLocal so the
    // re-mount uses the returned repo-root cwd rather than the stale prop value).
    // Consume and clear immediately so it doesn't leak into later mounts.
    const cwd = pendingCwdOverrideRef.current ?? workspace.cwd
    pendingCwdOverrideRef.current = null

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
        if ('worktreeError' in result) {
          // Worktree reconcile failed — surface not mounted; show the error card.
          console.warn('[WorkspaceView] worktree reconcile error:', result.worktreeError)
          setWorktreeError(result.worktreeError)
          return
        }
        // Success path — clear any prior reconcile error.
        setWorktreeError(null)
        // Surface a one-time notice if the backend emitted one (e.g. "started fresh on branch X").
        if (result.notice) {
          setNotice(result.notice)
        }
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

    if (active && !isClosedRef.current) {
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
      // surfaceCreatedRef is a sync hint here — addon.hide() is idempotent and
      // no-ops on missing/already-hidden entries, so the check just avoids a
      // redundant IPC round-trip. getSurfacePhase is NOT used here because this
      // cleanup runs synchronously (no await in effect teardown).
      if (surfaceCreatedRef.current && !isClosedRef.current) {
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
    if (isClosed) return

    // Clear any stale worktree error before attempting re-mount so the user sees
    // a clean loading state instead of a stale error card flashing during a now-
    // succeeding reconcile.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional pre-mount reset, not a cascading update; cleared once before the rAF that initiates the IPC
    setWorktreeError(null)

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

      // Consult native truth before mounting. surfaceCreatedRef can be stale
      // (true when the surface was already freed by the reconciler), which would
      // cause a double-mount. getSurfacePhase is the authoritative source.
      //
      // Only 'visible' is safe to skip — the surface is attached AND it is the
      // native g_visibleWorkspaceId (already shown + focused). Every other phase
      // falls through to terminal.mount:
      //   • 'attached' = attached but a DIFFERENT workspace owns visibility.
      //     mount hits the isAttached==YES branch → setVisibleWorkspace promotes
      //     THIS surface to visible, runs makeFirstResponder, and hides the prior
      //     one. Skipping here would leave the wrong surface showing + unfocused.
      //   • 'none' / 'hidden' / 'freeing' = needs a real (re-)create or re-attach.
      void window.api.terminal.getSurfacePhase(workspaceId).then((phase) => {
        if (!activeRef.current || !mountedRef.current) return

        if (phase === 'visible') {
          // Surface is already live + focused — reconcile surfaceCreatedRef and
          // attach resize listeners without triggering a redundant mount IPC.
          console.log(
            '[WorkspaceView] surface already visible — skipping re-mount workspaceId=',
            workspaceId
          )
          surfaceCreatedRef.current = true
          effectStateRef.current?.attachResizeListeners()
          return
        }

        if (phase === 'attached') {
          logDiag({
            category: 'lifecycle',
            level: 'info',
            event: DIAG_EVENTS.TERMINAL_REATTACH,
            workspaceId
          })
        }

        console.log(
          '[WorkspaceView] re-mounting surface (activated) workspaceId=',
          workspaceId,
          termRect,
          'phase=',
          phase
        )
        const t0 = performance.now()
        window.api.terminal
          .mount(workspaceId, termRect, scaleFactor, cwd)
          .then((result) => {
            logDiag({
              category: 'perf',
              level: 'info',
              event: DIAG_EVENTS.PERF_WORKSPACE_SWITCH,
              workspaceId,
              durationMs: Math.round(performance.now() - t0)
            })
            if ('worktreeError' in result) {
              // Worktree reconcile failed — surface not mounted; show the error card.
              console.warn(
                '[WorkspaceView] worktree reconcile error (re-mount):',
                result.worktreeError
              )
              setWorktreeError(result.worktreeError)
              return
            }
            // Success path — clear any prior reconcile error.
            setWorktreeError(null)
            // Surface a one-time notice if the backend emitted one.
            if (result.notice) {
              setNotice(result.notice)
            }
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
    })

    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
    }
    // workspace.cwd is stable for a given workspace record.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, isClosed])

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
          {/* Terminal area — the libghostty NSView is the TOPMOST sibling of
              contentView (NSWindowAbove relativeTo:nil, isOpaque=YES). This div
              is transparent so the opaque terminal NSView paints through.
              ResizeObserver fires when the footer height changes the container. */}
          <div ref={containerRef} className="flex-1 min-w-0 relative">
            {active && (
              <WorkspaceTerminalOverlays
                sleeping={sleeping}
                isClosed={isClosed}
                onFocusTerminal={handleFocusTerminal}
              />
            )}
            {/* Worktree reconcile error card — shown instead of the terminal surface
                when terminal:mount returns a worktreeError. Only rendered for the
                active view so inactive (keep-alive) views don't render it unnecessarily. */}
            {active && worktreeError && (
              <WorktreeErrorCard
                error={worktreeError}
                worktreeParentCwd={workspace.worktreeParentCwd}
                onRetry={handleWorktreeRetry}
                onOpenLocation={handleWorktreeOpenLocation}
                onConvertToLocal={handleWorktreeConvertToLocal}
                converting={converting}
              />
            )}
            {/* One-time notice banner (e.g. "started fresh on branch X") — shown
                briefly after a successful mount and auto-dismissed after 6 s. */}
            {active && notice && (
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 max-w-sm w-auto px-4 py-2.5 rounded-lg bg-surface-overlay/95 border border-border-default shadow-lg flex items-center gap-2.5 pointer-events-none">
                <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
                <span className="text-xs text-text-secondary leading-snug">{notice}</span>
              </div>
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
              onRestart={handleRestart}
            />
          </div>
        )}
      </div>
    </>
  )
}
