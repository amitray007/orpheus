import { useEffect, useRef } from 'react'
import type React from 'react'
import { Terminal as TerminalIcon, Folder } from '@phosphor-icons/react'
import type { WorkspaceRecord } from '@shared/types'

interface WorkspaceViewProps {
  workspace: WorkspaceRecord
}

export function WorkspaceView({ workspace }: WorkspaceViewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const surfaceIdRef = useRef<string | null>(null)
  const mountedRef = useRef(false)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (mountedRef.current) return
    mountedRef.current = true

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

      console.log('[WorkspaceView] mounting terminal', termRect, 'dpr=', scaleFactor)
      try {
        const { surfaceId } = await window.api.terminal.mount(termRect, scaleFactor, workspace.cwd)
        surfaceIdRef.current = surfaceId
        console.log('[WorkspaceView] mounted surface', surfaceId)
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
    const ro = new ResizeObserver(() => {
      const sid = surfaceIdRef.current
      if (!sid || !el) return
      const newRect = el.getBoundingClientRect()
      const sf = window.devicePixelRatio ?? 1
      window.api.terminal
        .resize(sid, {
          x: Math.round(newRect.left),
          y: Math.round(newRect.top),
          w: Math.round(newRect.width),
          h: Math.round(newRect.height)
        }, sf)
        .catch((e) => console.error('[WorkspaceView] resize failed:', e))
    })
    ro.observe(el)

    // window resize — bounding rect position shifts even if our div size doesn't.
    const onWindowResize = (): void => {
      const sid = surfaceIdRef.current
      if (!sid || !el) return
      const newRect = el.getBoundingClientRect()
      const sf = window.devicePixelRatio ?? 1
      window.api.terminal
        .resize(sid, {
          x: Math.round(newRect.left),
          y: Math.round(newRect.top),
          w: Math.round(newRect.width),
          h: Math.round(newRect.height)
        }, sf)
        .catch((e) => console.error('[WorkspaceView] window-resize failed:', e))
    }
    window.addEventListener('resize', onWindowResize)

    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onWindowResize)

      const sid = surfaceIdRef.current
      if (sid) {
        console.log('[WorkspaceView] unmounting surface', sid)
        window.api.terminal.unmount(sid).catch((e) =>
          console.error('[WorkspaceView] unmount failed:', e)
        )
        surfaceIdRef.current = null
      }
      mountedRef.current = false
    }
  }, [])

  return (
    <div className="flex flex-col h-full">
      {/* Tab title bar — thin strip */}
      <div className="h-8 flex items-center gap-2 px-3 border-b border-border-default bg-surface-raised flex-shrink-0">
        <TerminalIcon size={13} className="text-text-muted flex-shrink-0" />
        <span className="text-xs font-medium text-text-primary truncate">{workspace.name}</span>
        <span className="text-text-muted text-xs">·</span>
        <span
          className="text-xs text-text-muted truncate flex items-center gap-1 min-w-0"
          title={workspace.cwd}
        >
          <Folder size={10} className="flex-shrink-0" />
          {workspace.cwd}
        </span>
      </div>

      {/* Terminal area — transparent div; the native NSView renders directly behind/over this. */}
      <div ref={containerRef} className="flex-1 min-h-0 relative" />
    </div>
  )
}
