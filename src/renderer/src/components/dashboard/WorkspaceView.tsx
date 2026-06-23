import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type React from 'react'
import type { GhPullRequest, WorkspaceRecord, WorkspaceActivityDetail } from '@shared/types'
import { WorkspaceDrawer } from './WorkspaceDrawer'
import { WorkspaceTitleBar } from './WorkspaceTitleBar'
import { WorkspaceFooter } from './footer/WorkspaceFooter'
import { useWorkspaceActivity } from '@/lib/activityStore'
import { useTerminalSleeping } from '@/lib/sleepStore'
import { setActiveWatchdogWorkspace } from '@/lib/freezeWatchdog'
import { Moon } from '@phosphor-icons/react'
import { useOverlayOpenState } from '@/lib/overlayFocus'
import { XtermSurface } from './terminal/XtermSurface'

function isEditableTarget(): boolean {
  const el = document.activeElement
  if (!el) return false
  if (el instanceof HTMLTextAreaElement && el.classList.contains('xterm-helper-textarea'))
    return false
  if (el instanceof HTMLInputElement) {
    const type = (el.type || 'text').toLowerCase()
    return ['text', 'search', 'email', 'url', 'password', 'number', 'tel', ''].includes(type)
  }
  if (el instanceof HTMLTextAreaElement) return true
  if ((el as HTMLElement).contentEditable === 'true') return true
  return false
}

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
  const overlayOpen = useOverlayOpenState()
  // Stores the xterm focus function registered by XtermSurface via registerFocus prop.
  const xtermFocusFnRef = useRef<(() => void) | null>(null)
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
  const [drawer, setDrawer] = useState<null | 'status' | 'overrides' | 'details'>(null)
  // Where to portal the workspace title bar — slot lives in TopBar.
  const [titleBarHost, setTitleBarHost] = useState<HTMLElement | null>(null)

  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time DOM query at mount; DOM not available until after render
    setTitleBarHost(document.getElementById('topbar-workspace-slot'))
  }, [])

  // Terminal engine — read from persisted app_ui_state. The terminal lifecycle must
  // NOT start until this resolves: starting on the 'ghostty' default and flipping later
  // races the mount effects (which can't un-mount the wrong engine cleanly), so a
  // workspace would mount ghostty before the persisted 'xterm' value loaded. engineLoaded
  // gates every terminal effect + the surface render so the engine is known up front.
  const [terminalEngine, setTerminalEngine] = useState<'ghostty' | 'xterm'>('xterm')
  const [engineLoaded, setEngineLoaded] = useState(false)
  useEffect(() => {
    window.api.uiState
      .get()
      .then((s) => {
        setTerminalEngine(s.terminalEngine ?? 'xterm')
        setEngineLoaded(true)
      })
      .catch(() => {
        // On failure, keep the default engine (xterm) so the terminal still mounts.
        setEngineLoaded(true)
      })
    return window.api.uiState.onChanged((s) => {
      setTerminalEngine(s.terminalEngine ?? 'xterm')
    })
  }, [])
  const USE_XTERM = terminalEngine === 'xterm'

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

  async function handleRestart(): Promise<void> {
    await window.api.terminal.destroy(workspace.id)
    // Bumping remountKey re-fires the mount effect below, which calls terminal.mount
    // with the freshly composed launch params. The main process snapshots the new
    // launch at that point and clears dirty — the chip disappears via dirtyChanged event.
    setRemountKey((k) => k + 1)
  }

  const handleCloseDrawer = useCallback(() => setDrawer(null), [])

  const workspaceId = workspace.id
  const refocusTerminal = useCallback((): void => {
    if (!active) return
    if (isEditableTarget()) return
    if (USE_XTERM) {
      xtermFocusFnRef.current?.()
    } else {
      void window.api.terminal.focus(workspaceId).catch(() => {})
    }
  }, [active, USE_XTERM, workspaceId])

  // Sticky focus: window regains OS focus (Cmd-Tab back to Orpheus).
  useEffect(() => {
    const onWindowFocus = (): void => {
      if (!USE_XTERM) refocusTerminal()
      // xterm path is handled inside XtermSurface's own window focus listener.
    }
    window.addEventListener('focus', onWindowFocus)
    return () => window.removeEventListener('focus', onWindowFocus)
  }, [USE_XTERM, refocusTerminal])

  // Sticky focus: any click on app chrome outside the terminal container refocuses.
  // rAF-deferred so the clicked element receives its own focus/click first.
  useEffect(() => {
    const onMouseUp = (e: MouseEvent): void => {
      // Skip if the click was inside the terminal container (don't interfere with selection).
      if (containerRef.current?.contains(e.target as Node)) return
      requestAnimationFrame(() => {
        if (!USE_XTERM) refocusTerminal()
        // xterm path: check editable first, then focus via stored fn.
        if (USE_XTERM && active && !isEditableTarget()) xtermFocusFnRef.current?.()
      })
    }
    document.addEventListener('mouseup', onMouseUp)
    return () => document.removeEventListener('mouseup', onMouseUp)
  }, [USE_XTERM, active, refocusTerminal])

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
    // Wait until the persisted engine setting has loaded — otherwise this can mount
    // ghostty on the default before the real value (possibly 'xterm') resolves.
    if (!engineLoaded) return
    // When the xterm gate is on, the ghostty terminal lifecycle is skipped entirely.
    // XtermSurface manages its own mount/data/resize lifecycle.
    if (USE_XTERM) return

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
    // engineLoaded is included so the ghostty lifecycle starts once the engine is known.
    // active is intentionally excluded: active-toggle lifecycle is in the next effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remountKey, engineLoaded])

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
    // Wait until the persisted engine setting has loaded (see Effect 1).
    if (!engineLoaded) return
    // When the xterm gate is on, ghostty active-toggle lifecycle is skipped.
    if (USE_XTERM) return

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

        console.log(
          '[WorkspaceView] re-mounting surface (activated) workspaceId=',
          workspaceId,
          termRect,
          'phase=',
          phase
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
    })

    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
    }
    // workspace.cwd is stable for a given workspace record.
    // engineLoaded is included so the active-toggle lifecycle starts once the engine is known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, isClosed, engineLoaded])

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
            terminalEngine={terminalEngine}
          />,
          titleBarHost
        )}

      {/* Content row: terminal host + optional drawer */}
      <div className="flex h-full min-h-0">
        {/* Terminal column: terminal host + footer strip */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Terminal area — the libghostty NSView is the TOPMOST sibling of
              contentView at rest (NSWindowAbove relativeTo:nil, isOpaque=YES).
              This div is transparent at rest so the opaque terminal paints
              itself through. When an overlay is open the terminal swaps below
              WebContents, so we fill bg-surface-base here to avoid a gap.
              ResizeObserver fires when the footer height changes the container.
              When USE_XTERM is on, XtermSurface is rendered inside the container
              and the ghostty IPC lifecycle (terminal.mount/hide/resize/destroy)
              does not run for this workspace. */}
          <div
            ref={containerRef}
            className={`flex-1 min-w-0 relative ${overlayOpen || USE_XTERM ? 'bg-surface-base' : ''}`}
          >
            {USE_XTERM && (
              <XtermSurface
                workspaceId={workspace.id}
                cwd={workspace.cwd}
                active={active}
                registerFocus={(fn) => {
                  xtermFocusFnRef.current = fn
                }}
              />
            )}
            {active && sleeping && !USE_XTERM && (
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
            {active && isClosed && (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-surface-overlay/90">
                <p className="text-sm text-text-secondary">
                  This workspace is closed to free resources. Select it again to reopen.
                </p>
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
              drawer={drawer}
              pr={pr ?? null}
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
