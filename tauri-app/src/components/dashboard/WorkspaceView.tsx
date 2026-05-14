import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import type { WorkspaceRecord, WorkspaceStatus, WorkspaceActivityDetail } from '@shared/types'
import { WorkspaceDrawer } from './WorkspaceDrawer'

interface WorkspaceViewProps {
  workspace: WorkspaceRecord
  drawerTab: null | 'status' | 'overrides'
  onSetDrawerTab: (tab: null | 'status' | 'overrides') => void
  remountKey: number
}

export function WorkspaceView({
  workspace,
  drawerTab,
  onSetDrawerTab,
  remountKey
}: WorkspaceViewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  // mountedRef guards against double-mount in React StrictMode.
  const mountedRef = useRef(false)
  // Activity status driven by claude hook events
  const [activity, setActivity] = useState<WorkspaceStatus>(workspace.status)
  // Detail sub-state (thinking / tool / compacting / ready / etc.)
  const [detail, setDetail] = useState<WorkspaceActivityDetail | undefined>(undefined)

  // Subscribe to live activity changes for this workspace.
  useEffect(() => {
    const workspaceId = workspace.id
    setActivity(workspace.status)
    const unsub = window.api.workspaces.onActivityChanged((e) => {
      if (e.workspaceId === workspaceId) {
        setActivity(e.status)
        setDetail(e.detail)
      }
    })
    return unsub
  }, [workspace.id, workspace.status])

  const handleTabChange = useCallback((tab: 'status' | 'overrides') => {
    onSetDrawerTab(tab)
  }, [onSetDrawerTab])

  const handleCloseDrawer = useCallback(() => onSetDrawerTab(null), [onSetDrawerTab])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (mountedRef.current) return
    mountedRef.current = true

    const workspaceId = workspace.id

    const doMount = async (): Promise<void> => {
      const rect = el.getBoundingClientRect()
      const scaleFactor = window.devicePixelRatio ?? 1

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
    // we measure its rect. This avoids a zero-size rect on first mount.
    requestAnimationFrame(() => {
      doMount()
    })

    // ResizeObserver — fires when the div's intrinsic size changes (e.g. drawer toggles).
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

      // hide() keeps the surface alive so navigating back re-attaches the same shell.
      console.log('[WorkspaceView] hiding surface workspaceId=', workspaceId)
      window.api.terminal
        .hide(workspaceId)
        .catch((e) => console.error('[WorkspaceView] hide failed:', e))
      mountedRef.current = false
    }
    // remountKey re-fires this effect so terminal.mount gets called with fresh launch params.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remountKey])

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-1 min-h-0">
        {/* Terminal area — transparent div; the native NSView renders directly behind/over this. */}
        <div ref={containerRef} className="flex-1 min-w-0 relative" />

        {drawerTab !== null && (
          <div className="w-80 flex-shrink-0 border-l border-border-default bg-surface-raised flex flex-col">
            <WorkspaceDrawer
              workspace={workspace}
              activity={activity}
              detail={detail}
              activeTab={drawerTab}
              onTabChange={handleTabChange}
              onClose={handleCloseDrawer}
            />
          </div>
        )}
      </div>
    </div>
  )
}
