import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type React from 'react'
import type { WorkspaceRecord, WorkspaceStatus, WorkspaceActivityDetail } from '@shared/types'
import { WorkspaceDrawer } from './WorkspaceDrawer'
import { WorkspaceTitleBar } from './WorkspaceTitleBar'

interface WorkspaceViewProps {
  workspace: WorkspaceRecord
}

export function WorkspaceView({ workspace }: WorkspaceViewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  // mountedRef guards against double-mount in React StrictMode.
  const mountedRef = useRef(false)
  // remountKey — incrementing this triggers the mount effect to re-run,
  // which tears down the old surface and boots a fresh one with new settings.
  const [remountKey, setRemountKey] = useState(0)
  // Drawer: null = closed; 'status' | 'overrides' = open on that tab
  const [drawer, setDrawer] = useState<null | 'status' | 'overrides'>(null)
  // Activity status driven by claude hook events
  const [activity, setActivity] = useState<WorkspaceStatus>(workspace.status)
  // Detail sub-state (thinking / tool / compacting / ready / etc.)
  const [detail, setDetail] = useState<WorkspaceActivityDetail | undefined>(undefined)
  // Where to portal the workspace title bar — slot lives in TopBar.
  const [titleBarHost, setTitleBarHost] = useState<HTMLElement | null>(null)

  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time DOM query at mount; DOM not available until after render
    setTitleBarHost(document.getElementById('topbar-workspace-slot'))
  }, [])

  // Subscribe to live activity changes for this workspace.
  useEffect(() => {
    const workspaceId = workspace.id
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync initial status when workspace changes, then subscribe
    setActivity(workspace.status)
    const unsub = window.api.workspaces.onActivityChanged((e) => {
      if (e.workspaceId === workspaceId) {
        setActivity(e.status)
        setDetail(e.detail)
      }
    })
    return unsub
  }, [workspace.id, workspace.status])

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

    // Small rAF delay to ensure the div has been laid out and painted before
    // we measure its rect.  This avoids a zero-size rect on first mount.
    requestAnimationFrame(() => {
      doMount()
    })

    // ResizeObserver — fires when the div's intrinsic size changes.
    // This fires automatically when the drawer opens/closes and changes the
    // terminal host div's width via flex layout.
    const ro = new ResizeObserver(() => {
      if (!el) return
      const newRect = el.getBoundingClientRect()
      const sf = window.devicePixelRatio ?? 1
      window.api.terminal
        .resize(
          workspaceId,
          {
            x: Math.round(newRect.left),
            y: Math.round(newRect.top),
            w: Math.round(newRect.width),
            h: Math.round(newRect.height)
          },
          sf
        )
        .catch((e) => console.error('[WorkspaceView] resize failed:', e))
    })
    ro.observe(el)

    // window resize — bounding rect position shifts even if our div size doesn't.
    const onWindowResize = (): void => {
      if (!el) return
      const newRect = el.getBoundingClientRect()
      const sf = window.devicePixelRatio ?? 1
      window.api.terminal
        .resize(
          workspaceId,
          {
            x: Math.round(newRect.left),
            y: Math.round(newRect.top),
            w: Math.round(newRect.width),
            h: Math.round(newRect.height)
          },
          sf
        )
        .catch((e) => console.error('[WorkspaceView] window-resize failed:', e))
    }
    window.addEventListener('resize', onWindowResize)

    return () => {
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
          <WorkspaceTitleBar workspace={workspace} drawer={drawer} onSetDrawer={setDrawer} />,
          titleBarHost
        )}

      {/* Content row: terminal host + optional drawer */}
      <div className="flex h-full min-h-0">
        {/* Terminal area — transparent div; the native NSView renders directly behind/over this.
            ResizeObserver on this div fires when the drawer opens/closes (flex layout narrows it),
            which triggers terminal:resize and repositions the native NSView. */}
        <div ref={containerRef} className="flex-1 min-w-0 relative" />

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
