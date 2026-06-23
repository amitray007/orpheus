import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'

interface XtermSurfaceProps {
  workspaceId: string
  cwd: string
  active: boolean
}

const ACK_STRIDE = 5000

export function XtermSurface({ workspaceId, cwd, active }: XtermSurfaceProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [spawnError, setSpawnError] = useState<string | null>(null)
  const [exited, setExited] = useState<{ code: number; signal?: number } | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const term = new Terminal({
      macOptionIsMeta: true,
      convertEol: false,
      scrollback: 5000,
      allowProposedApi: false
    })

    const fit = new FitAddon()
    term.loadAddon(fit)

    let webgl: WebglAddon | null = null
    let resizeObserver: ResizeObserver | null = null
    let resizeDebounceId: ReturnType<typeof setTimeout> | null = null
    let unsubData: (() => void) | null = null
    let unsubExit: (() => void) | null = null
    let pendingAck = 0
    let disposed = false

    // Accumulate committed char counts and ack in strides of ACK_STRIDE.
    const onWriteCommitted = (count: number): void => {
      if (disposed) return
      pendingAck += count
      if (pendingAck >= ACK_STRIDE) {
        const toAck = pendingAck
        pendingAck = 0
        void window.api.xterm.ack(workspaceId, toAck)
      }
    }

    const doFit = (): void => {
      if (disposed) return
      const container = containerRef.current
      if (!container || !active || container.clientWidth === 0 || container.clientHeight === 0)
        return
      fit.fit()
    }

    const scheduleResize = (): void => {
      if (resizeDebounceId !== null) clearTimeout(resizeDebounceId)
      resizeDebounceId = setTimeout(doFit, 60)
    }

    const openAndSpawn = async (): Promise<void> => {
      await document.fonts.ready

      if (disposed) return

      // Guard: don't open at zero size — misaligns cell metrics and sends 0×0 to PTY.
      const container = containerRef.current
      if (!container || !active || container.clientWidth === 0 || container.clientHeight === 0) {
        // Defer to a resize event; ResizeObserver will re-trigger when visible.
        return
      }

      term.open(el)

      // WebGL addon must be loaded after open() so the canvas is attached.
      webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        webgl?.dispose()
        webgl = null
      })
      try {
        term.loadAddon(webgl)
      } catch {
        webgl?.dispose()
        webgl = null
      }

      doFit()

      // Clamp dims — PTY must never receive 0×0.
      const cols = Math.max(1, term.cols)
      const rows = Math.max(1, term.rows)

      const result = await window.api.xterm.spawn(workspaceId, cwd, cols, rows)
      if (disposed) return

      if (!result.created) {
        setSpawnError(result.error ?? 'Failed to spawn terminal process')
        return
      }

      // Reset flow control so a stale paused state from a prior session is cleared.
      void window.api.xterm.resetFlow(workspaceId)

      // Data loop: main → renderer.
      unsubData = window.api.xterm.onData(({ workspaceId: wid, data }) => {
        if (wid !== workspaceId || disposed) return
        // data arrives as a string from IPC (U3 sends Uint8Array but preload d.ts declares string).
        term.write(data, () => onWriteCommitted(data.length))
      })

      // Exit subscription.
      unsubExit = window.api.xterm.onExit(({ workspaceId: wid, exitCode, signal }) => {
        if (wid !== workspaceId) return
        setExited({ code: exitCode, signal })
      })

      // Input loop: renderer → main.
      term.onData((d) => {
        void window.api.xterm.write(workspaceId, d)
      })

      // Resize loop: wire FitAddon → PTY via onResize.
      term.onResize(({ cols: c, rows: r }) => {
        const safeCols = Math.max(1, c)
        const safeRows = Math.max(1, r)
        void window.api.xterm.resize(workspaceId, safeCols, safeRows)
      })

      // Title loop: forward raw OSC 0/2 titles to main for spinner-glyph
      // heartbeat detection and sidebar title updates — mirrors ghostty path.
      term.onTitleChange((title) => {
        window.api.xterm.title(workspaceId, title)
      })

      // ResizeObserver for container size changes.
      resizeObserver = new ResizeObserver(scheduleResize)
      resizeObserver.observe(el)
    }

    openAndSpawn().catch((err) => {
      setSpawnError(String(err))
    })

    return () => {
      disposed = true

      if (resizeDebounceId !== null) {
        clearTimeout(resizeDebounceId)
        resizeDebounceId = null
      }
      resizeObserver?.disconnect()
      resizeObserver = null

      unsubData?.()
      unsubExit?.()

      // Flush any remaining ack before teardown.
      if (pendingAck > 0) {
        void window.api.xterm.ack(workspaceId, pendingAck)
        pendingAck = 0
      }

      // Dispose WebGL addon before Terminal to avoid GPU resource leaks.
      webgl?.dispose()
      webgl = null
      term.dispose()

      // Do NOT call window.api.xterm.destroy here — hide ≠ destroy.
      // The PTY stays alive so navigating back can reattach. U8 refines teardown.
    }
    // active deliberately excluded — active changes drive fit below, not teardown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, cwd])

  // Re-fit when active transitions to true (workspace navigated back to).
  useEffect(() => {
    if (!active) return
    const el = containerRef.current
    if (!el || el.clientWidth === 0 || el.clientHeight === 0) return
    // Trigger a fit via a ResizeObserver notification — defer to next frame so
    // layout has settled after the CSS display change.
    requestAnimationFrame(() => {
      const container = containerRef.current
      if (!container || container.clientWidth === 0 || container.clientHeight === 0) return
      // FitAddon is wired inside the mount effect; schedule a resize event
      // by dispatching a synthetic resize on the window so the debouncer fires.
      window.dispatchEvent(new Event('resize'))
    })
  }, [active])

  return (
    <div ref={containerRef} className="w-full h-full relative">
      {spawnError !== null && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface-base">
          <p className="text-sm text-text-secondary px-4 text-center">
            Terminal failed to start: {spawnError}
          </p>
        </div>
      )}
      {exited !== null && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface-base/80">
          <p className="text-sm text-text-secondary">
            Process exited (code {exited.code})
            {exited.signal != null ? `, signal ${exited.signal}` : ''}
          </p>
        </div>
      )}
    </div>
  )
}
