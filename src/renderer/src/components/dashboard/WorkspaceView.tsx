import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { Terminal as TerminalIcon, Folder } from '@phosphor-icons/react'
import type { WorkspaceRecord } from '@shared/types'

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
  // Dirty state — true when settings have changed since this workspace was last mounted.
  const [isDirty, setIsDirty] = useState(false)

  // Seed dirty state on mount and subscribe to live events.
  useEffect(() => {
    const workspaceId = workspace.id
    window.api.workspaces.isDirty(workspaceId).then(setIsDirty).catch(() => setIsDirty(false))

    const unsub = window.api.workspaces.onDirtyChanged((e) => {
      if (e.workspaceId === workspaceId) {
        setIsDirty(e.dirty)
      }
    })
    return unsub
  }, [workspace.id])

  async function handleRestart(): Promise<void> {
    await window.api.terminal.destroy(workspace.id)
    // Bumping remountKey re-fires the mount effect below, which calls terminal.mount
    // with the freshly composed launch params. The main process snapshots the new
    // launch at that point and clears dirty — the chip disappears via dirtyChanged event.
    setRemountKey((k) => k + 1)
  }

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
        {/* Settings-changed chip — appears when launch params have drifted since last mount */}
        {isDirty && (
          <span className="flex items-center gap-1.5 ml-auto flex-shrink-0 text-[10px] font-mono text-amber-400">
            Settings changed
            <button
              onClick={() => { handleRestart().catch((e) => console.error('[WorkspaceView] restart failed:', e)) }}
              className="text-[10px] font-sans font-medium text-amber-300 hover:text-amber-100 underline underline-offset-2 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400/40"
            >
              Restart to apply
            </button>
          </span>
        )}
      </div>

      {/* Terminal area — transparent div; the native NSView renders directly behind/over this. */}
      <div ref={containerRef} className="flex-1 min-h-0 relative" />
    </div>
  )
}
