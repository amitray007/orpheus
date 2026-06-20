import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type React from 'react'
import type { GhPullRequest, WorkspaceRecord, WorkspaceActivityDetail } from '@shared/types'
import { WorkspaceDrawer } from './WorkspaceDrawer'
import { WorkspaceTitleBar } from './WorkspaceTitleBar'
import { WorkspaceFooter } from './footer/WorkspaceFooter'
import { useSetActiveOverlayWorkspace } from '@/lib/overlayMode'
import { useWorkspaceActivity } from '@/lib/activityStore'

interface WorkspaceViewProps {
  workspace: WorkspaceRecord
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
  initialDetail,
  pr,
  onSelectWorkspace,
  allWorkspaces
}: WorkspaceViewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  // mountedRef guards against double-mount in React StrictMode.
  const mountedRef = useRef(false)
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

  // Tell the overlay-mode provider which workspace's NSView to flip when a
  // popover / modal / drawer mounts useTerminalOverlay(). Cleared on unmount
  // so navigating away (back to Sessions / Project / Settings) disables
  // overlay flipping until we re-enter a workspace.
  useSetActiveOverlayWorkspace(workspace.id)

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

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (mountedRef.current) return
    mountedRef.current = true

    const workspaceId = workspace.id

    // Pending mount debounce timer — allows cancellation on rapid navigation.
    let mountTimerId: ReturnType<typeof setTimeout> | null = null
    // rAF spawned inside the 75ms mount timer — stored so cleanup can cancel it.
    let mountRafId: number | null = null
    // rAF guard for resize coalescing
    let resizeRafId: number | null = null
    // Pending resize rect — latest measurement, flushed in the rAF
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
        const result = await window.api.terminal.mount(
          workspaceId,
          termRect,
          scaleFactor,
          workspace.cwd
        )
        console.log(
          '[WorkspaceView] mounted workspaceId=',
          result.workspaceId,
          'created=',
          result.created
        )
      } catch (err) {
        console.error('[WorkspaceView] mount failed:', err)
      }
    }

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
        doMount()
      })
    }, 75)

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
    const scheduleResize = (rect: DOMRect): void => {
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
    const ro = new ResizeObserver(() => {
      if (!el) return
      scheduleResize(el.getBoundingClientRect())
    })
    ro.observe(el)

    // window resize — bounding rect position shifts even if our div size doesn't.
    const onWindowResize = (): void => {
      if (!el) return
      scheduleResize(el.getBoundingClientRect())
    }
    window.addEventListener('resize', onWindowResize)

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
      // Cancel any pending rAF resize flush.
      if (resizeRafId !== null) {
        cancelAnimationFrame(resizeRafId)
        resizeRafId = null
      }

      ro.disconnect()
      window.removeEventListener('resize', onWindowResize)

      // hide() keeps the surface alive in the addon's map so that navigating
      // back re-attaches the same shell session. Destroy is fired only from
      // Dashboard on archive/project-remove, or from handleRestart above.
      console.log('[WorkspaceView] hiding surface workspaceId=', workspaceId)
      window.api.terminal
        .hide(workspaceId)
        .catch((e) => console.error('[WorkspaceView] hide failed:', e))
      mountedRef.current = false
    }
    // remountKey is intentionally included: bumping it re-runs this effect
    // to remount the surface with fresh launch params after a restart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remountKey])

  return (
    <>
      {titleBarHost &&
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
          {/* Terminal area — transparent div; the native NSView renders directly behind/over this.
              ResizeObserver on this div fires when the footer height changes the container. */}
          <div ref={containerRef} className="flex-1 min-w-0 relative" />

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
