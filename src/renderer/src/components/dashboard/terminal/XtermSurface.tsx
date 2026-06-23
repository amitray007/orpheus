import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { setSleeping } from '@/lib/sleepStore'

interface XtermSurfaceProps {
  workspaceId: string
  cwd: string
  active: boolean
}

const ACK_STRIDE = 5000

// Ghostty default font: "JetBrains Mono" (vendor/ghostty/src/config/Config.zig).
// Fall back to common monospace stacks if not installed.
const GHOSTTY_DEFAULT_FONT = 'JetBrains Mono, SF Mono, Menlo, Courier New, monospace'
const GHOSTTY_DEFAULT_FONT_SIZE = 13

// Fetch the ghostty user config, resolve the selected theme, and apply font +
// theme to the terminal. Called before term.open() so font metrics are correct.
// ghosttySettings.onChanged does not exist in the current preload — live switch
// is not wired; changes take effect on next mount (workspace restart).
async function applyGhosttyAppearance(term: Terminal): Promise<void> {
  try {
    const config = await window.api.ghosttySettings.get()
    const { settings } = config

    const fontFamily =
      typeof settings['font-family'] === 'string' && settings['font-family']
        ? settings['font-family']
        : GHOSTTY_DEFAULT_FONT
    const fontSize =
      typeof settings['font-size'] === 'number' ? settings['font-size'] : GHOSTTY_DEFAULT_FONT_SIZE

    term.options.fontFamily = fontFamily
    term.options.fontSize = fontSize

    const themeName = typeof settings['theme'] === 'string' ? settings['theme'] : null
    let theme: ITheme | null = null

    if (themeName) {
      theme = (await window.api.ghosttySettings.getTheme(themeName)) as ITheme | null
    }

    if (theme) {
      // Individual background/foreground overrides in settings win over the theme file.
      if (typeof settings['background'] === 'string' && settings['background']) {
        theme = { ...theme, background: settings['background'] }
      }
      if (typeof settings['foreground'] === 'string' && settings['foreground']) {
        theme = { ...theme, foreground: settings['foreground'] }
      }
      // Whole-object assignment preserves all theme fields atomically.
      term.options.theme = theme
    }
  } catch {
    // Non-fatal: if ghostty config is unavailable, xterm uses its defaults.
  }
}

export function XtermSurface({ workspaceId, cwd, active }: XtermSurfaceProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [spawnError, setSpawnError] = useState<string | null>(null)
  const [exited, setExited] = useState<{ code: number; signal?: number } | null>(null)
  // Bumping attemptKey tears down and rebuilds the terminal effect — used by Restart.
  const [attemptKey, setAttemptKey] = useState(0)
  // Stable ref to doFit so the active-toggle and recover effects can call it
  // without being in the mount effect's closure.
  const doFitRef = useRef<(() => void) | null>(null)

  const handleRestart = (): void => {
    setExited(null)
    setSpawnError(null)
    // destroy is idempotent — clears dead PTY before we respawn on next mount.
    void window.api.xterm.destroy(workspaceId)
    setAttemptKey((k) => k + 1)
  }

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
    doFitRef.current = doFit

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

      // Apply ghostty font + theme before open() so font metrics are correct.
      await applyGhosttyAppearance(term)
      if (disposed) return

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
      doFitRef.current = null

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
    // attemptKey is included so bumping it (Restart) rebuilds the terminal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, cwd, attemptKey])

  // Sleep wiring: active=false → sleeping=true, active=true → sleeping=false.
  // Visibility is known in JS so we write sleepStore directly (no IPC round-trip).
  useEffect(() => {
    setSleeping(workspaceId, !active)
    return () => {
      // On unmount treat as sleeping so consumers don't show a stale awake state.
      setSleeping(workspaceId, true)
    }
  }, [workspaceId, active])

  // Re-fit when active transitions to true (workspace navigated back to).
  // Bug fix: call doFit directly via ref instead of dispatching window 'resize' —
  // the ResizeObserver only observes the container, not the window, so the synthetic
  // window resize event was never picked up.
  useEffect(() => {
    if (!active) return
    const el = containerRef.current
    if (!el || el.clientWidth === 0 || el.clientHeight === 0) return
    requestAnimationFrame(() => {
      doFitRef.current?.()
    })
  }, [active])

  // xterm-specific recovery: on flow stall, reset the ACK window and re-fit.
  useEffect(() => {
    return window.api.xterm.onRecover(({ workspaceId: wid }) => {
      if (wid !== workspaceId) return
      void window.api.xterm.resetFlow(workspaceId)
      requestAnimationFrame(() => {
        doFitRef.current?.()
      })
    })
  }, [workspaceId])

  return (
    <div ref={containerRef} className="w-full h-full relative">
      {spawnError !== null && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-surface-base">
          <p className="text-sm text-text-secondary px-4 text-center">
            Terminal failed to start: {spawnError}
          </p>
          <button
            onClick={handleRestart}
            className="px-3 py-1.5 text-xs rounded border border-border-base text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors"
          >
            Restart
          </button>
        </div>
      )}
      {exited !== null && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-surface-base/80">
          <p className="text-sm text-text-secondary">
            Process exited (code {exited.code})
            {exited.signal != null ? `, signal ${exited.signal}` : ''}
          </p>
          <button
            onClick={handleRestart}
            className="px-3 py-1.5 text-xs rounded border border-border-base text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors"
          >
            Restart
          </button>
        </div>
      )}
    </div>
  )
}
