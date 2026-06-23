import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { CanvasAddon } from '@xterm/addon-canvas'
import { DIAG_EVENTS } from '@shared/diagEvents'
import { logDiag } from '@/lib/diag'
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
// Returns the resolved font size so callers can derive pixel-accurate padding.
async function applyGhosttyAppearance(term: Terminal): Promise<number> {
  let resolvedFontSize = GHOSTTY_DEFAULT_FONT_SIZE
  try {
    const config = await window.api.ghosttySettings.get()
    const { settings } = config

    const fontFamily =
      typeof settings['font-family'] === 'string' && settings['font-family']
        ? settings['font-family']
        : GHOSTTY_DEFAULT_FONT
    const fontSize =
      typeof settings['font-size'] === 'number' ? settings['font-size'] : GHOSTTY_DEFAULT_FONT_SIZE
    resolvedFontSize = fontSize

    term.options.fontFamily = fontFamily
    term.options.fontSize = fontSize
    // Line height multiplier: 1.2 gives vertical breathing room matching ghostty's
    // default cell metrics (ghostty renders slightly taller cells than xterm's 'normal').
    term.options.lineHeight = 1.2

    // Cursor style — ghostty 'block'|'underline'|'bar' map 1:1 to xterm.
    const cursorStyleRaw = settings['cursor-style']
    if (cursorStyleRaw === 'block' || cursorStyleRaw === 'underline' || cursorStyleRaw === 'bar') {
      term.options.cursorStyle = cursorStyleRaw
    }
    // Cursor blink — ghostty cursor-style-blink (boolean or string 'true'/'false').
    const blinkRaw = settings['cursor-style-blink']
    if (blinkRaw !== undefined && blinkRaw !== null) {
      term.options.cursorBlink = blinkRaw === true || blinkRaw === 'true'
    }

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
  return resolvedFontSize
}

export function XtermSurface({ workspaceId, cwd, active }: XtermSurfaceProps): React.JSX.Element {
  // containerRef: outer div that owns layout + horizontal padding.
  // xtermRef: inner div that xterm mounts into — FitAddon measures this element,
  // so it sees only the content box (inside the padding) and computes cols/rows correctly.
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<HTMLDivElement>(null)
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
    const el = xtermRef.current
    if (!el) return

    const term = new Terminal({
      macOptionIsMeta: true,
      convertEol: false,
      // ~20k lines ≈ 29MB/surface @120 cols (xterm cells are light); 4x headroom over
      // the original 5k for long agentic sessions with heavy tool output. Still a
      // documented gap vs ghostty's 2,000,000 (native memory) — see ghosttyTheme.ts.
      scrollback: 20000,
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

    // Accumulate committed byte counts and ack in strides of ACK_STRIDE.
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
      // Guard on the outer container (has layout dimensions); fit against the inner
      // xterm element so FitAddon measures the content box inside the padding.
      const outer = containerRef.current
      if (!outer || !active || outer.clientWidth === 0 || outer.clientHeight === 0) return
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
      // Check the outer container for layout dimensions (the inner xtermRef inherits them).
      const outer = containerRef.current
      if (!outer || !active || outer.clientWidth === 0 || outer.clientHeight === 0) {
        // Defer to a resize event; ResizeObserver will re-trigger when visible.
        return
      }

      // Apply ghostty font + theme before open() so font metrics are correct.
      const fontSize = await applyGhosttyAppearance(term)
      if (disposed) return

      // Horizontal padding: approximate ghostty's default window-padding-x (2 cells).
      // Cell width ≈ 0.6em for monospace fonts; 2 cells ≈ fontSize * 0.6 * 2.
      // Applied to the OUTER container so FitAddon (which measures the inner xterm div
      // passed to term.open) sees only the content-box width and computes cols/rows
      // from the padded area. Mouse hit-testing is unaffected — xterm's canvas fills
      // the inner div completely; only the surrounding gutter is padded.
      const hPad = Math.round(fontSize * 0.6 * 2)
      outer.style.paddingLeft = `${hPad}px`
      outer.style.paddingRight = `${hPad}px`

      term.open(el)

      // WebGL addon must be loaded after open() so the canvas is attached.
      webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        webgl?.dispose()
        webgl = null
        // Fallback to Canvas renderer on WebGL context loss.
        logDiag({
          category: 'anomaly',
          level: 'warn',
          event: DIAG_EVENTS.XTERM_WEBGL_CONTEXT_LOSS,
          workspaceId,
          message: 'WebGL context lost — falling back to Canvas renderer'
        })
        try {
          term.loadAddon(new CanvasAddon())
        } catch {
          // Canvas fallback failed — terminal degrades to DOM renderer.
        }
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

      // Keyboard editing fidelity: intercept specific combos BEFORE xterm's default
      // handler. Return false after writing bytes ourselves to prevent double-input.
      // Mirrors performKeyEquivalent: / keyDown: mods-translation in addon.mm.
      term.attachCustomKeyEventHandler((e: KeyboardEvent): boolean => {
        // Only intercept keydown — let keyup pass through untouched.
        if (e.type !== 'keydown') return true

        // Option(Alt)+Backspace → ESC DEL (backward-kill-word).
        // macOptionIsMeta is set but we assert this explicitly for reliability.
        if (e.altKey && !e.metaKey && !e.ctrlKey && e.key === 'Backspace') {
          void window.api.xterm.write(workspaceId, '\x1b\x7f')
          return false
        }

        // Cmd(Meta)+Backspace → Ctrl-U (\x15, kill line to start).
        // Matches what claude/readline expects for line-clear.
        if (e.metaKey && !e.altKey && !e.ctrlKey && e.key === 'Backspace') {
          void window.api.xterm.write(workspaceId, '\x15')
          return false
        }

        // Ctrl+/ → emit Ctrl+_ (\x1f) to avoid the macOS system beep.
        // Mirrors performKeyEquivalent: remap in addon.mm ~365-388.
        if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === '/') {
          void window.api.xterm.write(workspaceId, '\x1f')
          return false
        }

        // Ctrl+Enter → pass through as \r so the browser doesn't swallow it.
        // Mirrors the Control+Return passthrough in addon.mm ~356-363.
        if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Enter') {
          void window.api.xterm.write(workspaceId, '\r')
          return false
        }

        // All other keys (plain typing, arrows, Ctrl+C, Cmd+C/V, Tab, Escape,
        // etc.) pass through to xterm's default handler unchanged.
        return true
      })

      // Data loop: main → renderer.
      unsubData = window.api.xterm.onData(({ workspaceId: wid, data }) => {
        if (wid !== workspaceId || disposed) return
        // Bytes end-to-end: PTY emits Buffer, IPC sends Uint8Array, xterm.write accepts it.
        // ACK unit is BYTES (byteLength) on both sides — must match the engine's byte counters.
        term.write(data, () => onWriteCommitted(data.byteLength))
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

    // Mouse-hide-while-typing: hide cursor on keydown, restore on mousemove.
    // Mirrors ghostty's mouse-hide-while-typing = true. No per-frame work.
    const onKeyDown = (): void => {
      if (el) el.style.cursor = 'none'
    }
    const onMouseMove = (): void => {
      if (el) el.style.cursor = ''
    }
    el.addEventListener('keydown', onKeyDown)
    el.addEventListener('mousemove', onMouseMove)

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

      el.removeEventListener('keydown', onKeyDown)
      el.removeEventListener('mousemove', onMouseMove)

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
      {/* Inner div: xterm mounts here. Its width = outer width minus horizontal padding,
          so FitAddon computes cols from the content box, not the gutters. */}
      <div ref={xtermRef} className="w-full h-full" />
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
