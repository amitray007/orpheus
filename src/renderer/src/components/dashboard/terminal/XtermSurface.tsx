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
import { isEditableTarget } from '@/lib/focusTarget'
import { DotmSquare12 } from '@/components/ui/dotm-square-12'

interface XtermSurfaceProps {
  workspaceId: string
  cwd: string
  active: boolean
  /** Called when the internal focus function becomes available (on mount) or is released (on unmount). */
  registerFocus?: (fn: (() => void) | null) => void
}

const ACK_STRIDE = 5000

// Ghostty default font: "JetBrains Mono" (vendor/ghostty/src/config/Config.zig).
// Fall back to common monospace stacks if not installed.
const GHOSTTY_DEFAULT_FONT = 'JetBrains Mono, SF Mono, Menlo, Courier New, monospace'
const GHOSTTY_DEFAULT_FONT_SIZE = 13

// Apply ghostty font + theme settings to the terminal. Called before term.open()
// so font metrics (fontFamily, fontSize, lineHeight, letterSpacing, fontWeight) are
// correct before the canvas is sized. Accepts pre-fetched settings so the caller can
// batch the single ghosttySettings.get() fetch for other consumers (mouse-hide,
// copy-on-select, window-padding-x, etc.) without a double round-trip.
// Metric-affecting options (fontFamily, fontSize, lineHeight, letterSpacing, padding)
// must be set before open(); live-changing them glitches cell metrics. Safe-subset
// options are re-applied live via the onChanged subscription in the mount effect.
// Returns the resolved font size (for padding) and the resolved terminal
// background color (so the host container can paint the sub-cell remainder strip
// the same color → no visible gap at the bottom where FitAddon floors rows).
async function applyGhosttyAppearance(
  term: Terminal,
  settings: Record<string, unknown>
): Promise<{ fontSize: number; background: string | null }> {
  let resolvedFontSize = GHOSTTY_DEFAULT_FONT_SIZE
  try {
    const fontFamily =
      typeof settings['font-family'] === 'string' && settings['font-family']
        ? settings['font-family']
        : GHOSTTY_DEFAULT_FONT
    const fontSize =
      typeof settings['font-size'] === 'number' ? settings['font-size'] : GHOSTTY_DEFAULT_FONT_SIZE
    resolvedFontSize = fontSize

    term.options.fontFamily = fontFamily
    term.options.fontSize = fontSize

    // Line height: map ghostty's adjust-cell-height percentage to xterm's lineHeight multiplier.
    // "35%" → lineHeight = 1 + 35/100 = 1.35. Default 1.2 if not set or not a percentage string.
    const adjustCellHeight = settings['adjust-cell-height']
    let lineHeight = 1.2
    if (typeof adjustCellHeight === 'string' && adjustCellHeight.endsWith('%')) {
      const pct = parseFloat(adjustCellHeight)
      if (!isNaN(pct)) {
        lineHeight = 1 + pct / 100
      }
    }
    term.options.lineHeight = lineHeight

    // P1 — adjust-cell-width: map percentage to letterSpacing px.
    // cellWidth ≈ fontSize * 0.6; letterSpacing = cellWidth * (pct/100).
    // Must be set before open() so canvas metrics are calculated correctly.
    const adjustCellWidth = settings['adjust-cell-width']
    if (typeof adjustCellWidth === 'string' && adjustCellWidth.endsWith('%')) {
      const pct = parseFloat(adjustCellWidth)
      if (!isNaN(pct)) {
        const cellWidth = fontSize * 0.6
        term.options.letterSpacing = cellWidth * (pct / 100)
      }
    }

    // P1 — font-thicken: bump fontWeight to 500 / bold to 700 for sub-pixel emphasis.
    const fontThicken = settings['font-thicken']
    if (fontThicken === true || fontThicken === 'true') {
      term.options.fontWeight = '500'
      term.options.fontWeightBold = '700'
    }

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

    // P1 — bold-is-bright: render bold text in bright ANSI colors.
    const boldIsBright = settings['bold-is-bright']
    if (boldIsBright !== undefined && boldIsBright !== null) {
      if (boldIsBright === true || boldIsBright === 'true') {
        term.options.drawBoldTextInBrightColors = true
      }
    }

    // P1 — minimum-contrast: enforce a minimum contrast ratio (>= 1).
    const minimumContrast = settings['minimum-contrast']
    if (minimumContrast !== undefined && minimumContrast !== null) {
      const contrastNum = Number(minimumContrast)
      if (!isNaN(contrastNum) && contrastNum >= 1) {
        term.options.minimumContrastRatio = contrastNum
      }
    }

    // P2 — scrollback-limit: cap at 50k lines to avoid runaway memory.
    const scrollbackLimit = settings['scrollback-limit']
    if (scrollbackLimit !== undefined && scrollbackLimit !== null) {
      const scrollbackNum = Number(scrollbackLimit)
      if (!isNaN(scrollbackNum) && scrollbackNum > 0) {
        term.options.scrollback = Math.min(scrollbackNum, 50000)
      }
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

    // P0 — cursor-color / selection-background / selection-foreground:
    // merge color overrides on top of whatever theme is already resolved.
    // Applied regardless of whether a named theme was loaded.
    let currentTheme: ITheme = term.options.theme ?? {}
    const cursorColor = settings['cursor-color']
    if (typeof cursorColor === 'string' && cursorColor) {
      currentTheme = { ...currentTheme, cursor: cursorColor }
    }
    const selBg = settings['selection-background']
    if (typeof selBg === 'string' && selBg) {
      currentTheme = { ...currentTheme, selectionBackground: selBg }
    }
    const selFg = settings['selection-foreground']
    if (typeof selFg === 'string' && selFg) {
      currentTheme = { ...currentTheme, selectionForeground: selFg }
    }
    if (Object.keys(currentTheme).length > 0) {
      term.options.theme = currentTheme
    }
  } catch {
    // Non-fatal: if ghostty config is unavailable, xterm uses its defaults.
  }
  const background =
    typeof term.options.theme?.background === 'string' ? term.options.theme.background : null
  return { fontSize: resolvedFontSize, background }
}

// Map a ghostty trigger string to a KeyboardEvent match.
// Returns false immediately if the trigger has no modifier tokens (safety guard:
// never consume bare key presses that would break normal typing).
function matchTrigger(e: KeyboardEvent, trigger: string): boolean {
  const parts = trigger.toLowerCase().split('+')
  const MODIFIER_TOKENS = new Set([
    'ctrl',
    'control',
    'cmd',
    'super',
    'command',
    'alt',
    'opt',
    'option',
    'shift'
  ])
  const modifiers = parts.filter((p) => MODIFIER_TOKENS.has(p))
  const keyTokens = parts.filter((p) => !MODIFIER_TOKENS.has(p))
  if (modifiers.length === 0) return false // safety: never match bare keys
  if (keyTokens.length !== 1) return false
  const key = keyTokens[0]

  const needsCtrl = modifiers.some((m) => m === 'ctrl' || m === 'control')
  const needsMeta = modifiers.some((m) => m === 'cmd' || m === 'super' || m === 'command')
  const needsAlt = modifiers.some((m) => m === 'alt' || m === 'opt' || m === 'option')
  const needsShift = modifiers.includes('shift')

  if (e.ctrlKey !== needsCtrl) return false
  if (e.metaKey !== needsMeta) return false
  if (e.altKey !== needsAlt) return false
  if (e.shiftKey !== needsShift) return false
  return e.key.toLowerCase() === key
}

// Dispatch a ghostty action string to the corresponding xterm terminal operation.
// Returns true if the action was consumed (caller should return false from the
// key handler so xterm does not process the key further). Returns false for
// actions with no xterm equivalent (splits, unknown) so the caller can pass through.
function dispatchGhosttyAction(action: string, term: Terminal, doFit: () => void): boolean {
  // Parse optional ':N' numeric suffix (e.g. increase_font_size:2).
  const colonIdx = action.indexOf(':')
  const baseAction = colonIdx === -1 ? action : action.slice(0, colonIdx)
  const suffixStr = colonIdx === -1 ? '' : action.slice(colonIdx + 1)
  const suffixN = suffixStr ? parseInt(suffixStr, 10) : NaN

  switch (baseAction) {
    case 'copy_to_clipboard':
      void navigator.clipboard.writeText(term.getSelection())
      return true
    case 'paste_from_clipboard':
      navigator.clipboard
        .readText()
        .then((t) => term.paste(t))
        .catch(() => {})
      return true
    case 'select_all':
      term.selectAll()
      return true
    case 'clear_screen':
      term.clear()
      return true
    case 'scroll_to_top':
      term.scrollToTop()
      return true
    case 'scroll_to_bottom':
      term.scrollToBottom()
      return true
    case 'scroll_page_up':
      term.scrollLines(-term.rows)
      return true
    case 'scroll_page_down':
      term.scrollLines(term.rows)
      return true
    case 'increase_font_size': {
      const delta = !isNaN(suffixN) && suffixN > 0 ? suffixN : 1
      term.options.fontSize = (term.options.fontSize ?? GHOSTTY_DEFAULT_FONT_SIZE) + delta
      doFit()
      return true
    }
    case 'decrease_font_size': {
      const delta = !isNaN(suffixN) && suffixN > 0 ? suffixN : 1
      term.options.fontSize = Math.max(
        6,
        (term.options.fontSize ?? GHOSTTY_DEFAULT_FONT_SIZE) - delta
      )
      doFit()
      return true
    }
    case 'reset_font_size':
      term.options.fontSize = GHOSTTY_DEFAULT_FONT_SIZE
      doFit()
      return true
    case 'ignore':
      return true
    // split actions and anything else: do not consume
    default:
      return false
  }
}

export function XtermSurface({
  workspaceId,
  cwd,
  active,
  registerFocus
}: XtermSurfaceProps): React.JSX.Element {
  // containerRef: outer div that owns layout dimensions (full width/height).
  // xtermRef: inner div that xterm mounts into. Padding is applied directly to
  // term.element (.xterm) after open() so FitAddon accounts for it correctly.
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<HTMLDivElement>(null)
  const [spawnError, setSpawnError] = useState<string | null>(null)
  const [exited, setExited] = useState<{ code: number; signal?: number } | null>(null)
  const [loading, setLoading] = useState(false)
  // Resolved terminal background — painted on the host container so the floored-row
  // remainder at the bottom matches the terminal color (no visible gap).
  const [bgColor, setBgColor] = useState<string | null>(null)
  // Bumping attemptKey tears down and rebuilds the terminal effect — used by Restart.
  const [attemptKey, setAttemptKey] = useState(0)
  // Stable ref to doFit so the active-toggle and recover effects can call it
  // without being in the mount effect's closure.
  const doFitRef = useRef<(() => void) | null>(null)
  // Stable ref to focus function; set in mount effect and shared via registerFocus prop.
  const focusTermRef = useRef<(() => void) | null>(null)

  const handleRestart = (): void => {
    setLoading(true)
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
      // 5k lines (~7MB/surface @120 cols); reasonable default matching the xterm 5×
      // original (1k) while staying well under the per-workspace memory budget.
      // Users can raise this up to 50k via the scrollback-limit ghostty setting,
      // which applyGhosttyAppearance reads and applies on top of this constructor value.
      scrollback: 5000,
      allowProposedApi: false,
      // Disable xterm's built-in smooth scroll so scroll events are immediate.
      // This is the xterm 6 default but we set it explicitly to guard against future default changes.
      smoothScrollDuration: 0
    })

    const fit = new FitAddon()
    term.loadAddon(fit)

    let webgl: WebglAddon | null = null
    let webglRetried = false
    let resizeObserver: ResizeObserver | null = null
    let resizeDebounceId: ReturnType<typeof setTimeout> | null = null
    let unsubData: (() => void) | null = null
    let unsubExit: (() => void) | null = null
    let unsubSettingsChanged: (() => void) | null = null
    let pendingAck = 0
    let disposed = false

    // P0 — mouse-hide-while-typing: default TRUE (matches ghostty default).
    // Set asynchronously from settings in openAndSpawn before DOM listeners fire;
    // onKeyDown / onMouseMove read this let so they pick up the resolved value.
    let mouseHideWhileTyping = true

    // C2 — mouse-scroll-multiplier: resolved from settings in openAndSpawn.
    // Reassignable so C1's onChanged can update it live.
    let scrollMultiplier = 1

    // User-defined ghostty keybinds: loaded in openAndSpawn, refreshed in onChanged.
    let userKeybinds: Array<{ trigger: string; action: string }> = []

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

    const focusFn = (): void => {
      if (!disposed) term.focus()
    }
    focusTermRef.current = focusFn
    registerFocus?.(focusFn)

    const scheduleResize = (): void => {
      if (resizeDebounceId !== null) clearTimeout(resizeDebounceId)
      resizeDebounceId = setTimeout(doFit, 60)
    }

    let unsubSessionReady: (() => void) | null = null
    let fallbackTimeoutId: ReturnType<typeof setTimeout> | null = null

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

      // Fetch ghostty settings once for all consumers in this mount:
      // appearance (applyGhosttyAppearance), mouse-hide-while-typing, copy-on-select,
      // and window-padding-x. A single fetch avoids redundant IPC round-trips.
      let settings: Record<string, unknown> = {}
      let config: Awaited<ReturnType<typeof window.api.ghosttySettings.get>> | null = null
      try {
        config = await window.api.ghosttySettings.get()
        settings = config.settings as Record<string, unknown>
      } catch {
        // Non-fatal: use empty settings, all features fall back to defaults.
      }
      if (disposed) return

      // P0 — mouse-hide-while-typing: update the closure let before DOM listeners fire.
      mouseHideWhileTyping =
        settings['mouse-hide-while-typing'] !== false &&
        settings['mouse-hide-while-typing'] !== 'false'

      // C2 — mouse-scroll-multiplier: scale wheel scroll by this factor.
      const rawMultiplier = Number(settings['mouse-scroll-multiplier'])
      scrollMultiplier = !isNaN(rawMultiplier) && rawMultiplier > 0 ? rawMultiplier : 1
      // Delegate scroll multiplication to xterm's native wheel pipeline so trackpad
      // momentum, deltaMode normalization, and sub-line accumulation are preserved.
      term.options.scrollSensitivity = scrollMultiplier

      // Load user keybinds from the fetched config (config is the full GhosttyUserConfig).
      userKeybinds = config?.keybinds ?? []

      // P0 — copy-on-select.
      const copyOnSelect =
        settings['copy-on-select'] === true || settings['copy-on-select'] === 'true'

      // Apply ghostty font + theme before open() so font metrics are correct.
      const { fontSize, background } = await applyGhosttyAppearance(term, settings)
      if (disposed) return
      // Paint the host container with the terminal's own background so the sub-cell
      // remainder strip (FitAddon floors rows, leaving < 1 cell at the bottom) is
      // the same color as the terminal — no visible gap at the bottom edge.
      if (background) setBgColor(background)

      term.open(el)

      // P0 — copy-on-select: wire after open() so term.hasSelection() is available.
      if (copyOnSelect) {
        term.onSelectionChange(() => {
          if (copyOnSelect && term.hasSelection()) {
            void navigator.clipboard.writeText(term.getSelection())
          }
        })
      }

      // Padding on term.element so FitAddon accounts for it correctly (it reads
      // terminal.element padding via getComputedStyle and subtracts it from the
      // measured parentElement → canvas fills the remaining content box).
      // Default is ZERO so the terminal sits flush to the app pane edges (touches
      // all corners). window-padding-x is still honored: if the user explicitly
      // sets it (cell count), apply that many cells of horizontal padding.
      const windowPaddingX = settings['window-padding-x']
      let hPad = 0
      if (windowPaddingX !== undefined && windowPaddingX !== null) {
        const paddingXNum = Number(windowPaddingX)
        if (!isNaN(paddingXNum) && paddingXNum > 0) {
          hPad = Math.round(fontSize * 0.6 * paddingXNum)
        }
      }
      // window-padding-y: read the same way as window-padding-x (ghostty cell count).
      // Vertical cell height ≈ fontSize * lineHeight; use fontSize * 1.2 as a stable
      // estimate (matches the default lineHeight in applyGhosttyAppearance). Defaults
      // to 0 (flush) when the setting is absent — preserving the flush-bottom default.
      const windowPaddingY = settings['window-padding-y']
      let vPad = 0
      if (windowPaddingY !== undefined && windowPaddingY !== null) {
        const paddingYNum = Number(windowPaddingY)
        if (!isNaN(paddingYNum) && paddingYNum > 0) {
          vPad = Math.round(fontSize * 1.2 * paddingYNum)
        }
      }
      if (term.element) {
        term.element.style.paddingLeft = `${hPad}px`
        term.element.style.paddingRight = `${hPad}px`
        term.element.style.paddingTop = `${vPad}px`
        term.element.style.paddingBottom = `${vPad}px`
        term.element.style.boxSizing = 'border-box'
      }

      // WebGL addon must be loaded after open() so the canvas is attached.
      // On context loss: attempt ONE WebGL re-init before permanently falling to Canvas.
      const loadWebgl = (): void => {
        const addon = new WebglAddon()
        addon.onContextLoss(() => {
          addon.dispose()
          if (webgl === addon) webgl = null
          logDiag({
            category: 'anomaly',
            level: 'warn',
            event: DIAG_EVENTS.XTERM_WEBGL_CONTEXT_LOSS,
            workspaceId,
            message: webglRetried
              ? 'WebGL context lost again — falling back to Canvas renderer'
              : 'WebGL context lost — attempting re-init'
          })
          if (!webglRetried && !disposed) {
            webglRetried = true
            setTimeout(() => {
              if (disposed) return
              try {
                loadWebgl()
              } catch {
                // Retry failed — fall back to Canvas.
                try {
                  term.loadAddon(new CanvasAddon())
                } catch {
                  // Canvas fallback failed — terminal degrades to DOM renderer.
                }
              }
            }, 200)
          } else {
            // Second loss or already retried — permanent Canvas fallback.
            try {
              term.loadAddon(new CanvasAddon())
            } catch {
              // Canvas fallback failed — terminal degrades to DOM renderer.
            }
          }
        })
        term.loadAddon(addon)
        webgl = addon
      }
      try {
        loadWebgl()
        logDiag({
          category: 'lifecycle',
          level: 'info',
          event: DIAG_EVENTS.XTERM_RENDERER_ACTIVE,
          workspaceId,
          message: 'WebGL renderer active'
        })
        // DIAGNOSTIC: log actual active renderer class name to verify WebGL is active
        console.log(
          '[xterm] active renderer:',
          (
            term as unknown as {
              _core?: {
                _renderService?: { _renderer?: { value?: { constructor?: { name?: string } } } }
              }
            }
          )._core?._renderService?._renderer?.value?.constructor?.name ?? 'unknown'
        )
      } catch (err) {
        webgl?.dispose()
        webgl = null
        logDiag({
          category: 'anomaly',
          level: 'warn',
          event: DIAG_EVENTS.XTERM_WEBGL_INIT_FAILED,
          workspaceId,
          message: `WebGL init failed — falling back to Canvas: ${err}`
        })
        try {
          term.loadAddon(new CanvasAddon())
        } catch (canvasErr) {
          logDiag({
            category: 'anomaly',
            level: 'warn',
            event: DIAG_EVENTS.XTERM_WEBGL_INIT_FAILED,
            workspaceId,
            message: `Canvas fallback also failed — DOM renderer: ${canvasErr}`
          })
        }
      }

      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => {
          doFit()
          resolve()
        })
      )

      // Clamp dims — PTY must never receive 0×0.
      const cols = Math.max(1, term.cols)
      const rows = Math.max(1, term.rows)

      const result = await window.api.xterm.spawn(workspaceId, cwd, cols, rows)
      if (disposed) return

      // Wire all subscriptions and input handlers for a live (fresh or reattached) session.
      // Called exactly once per mount — fresh Terminal + el means no double-registration risk.
      const wireLiveSession = (): void => {
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

          // Cmd+C: copy selection if text is selected; otherwise fall through (do NOT map to SIGINT — Ctrl+C handles that).
          // Mirrors the ghostty clipboard triad (performKeyEquivalent: ~390-406).
          if (e.metaKey && !e.altKey && !e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
            if (term.hasSelection()) {
              void navigator.clipboard.writeText(term.getSelection())
              return false
            }
            return true
          }

          // Cmd+V: return true so the browser fires its native paste DOM event.
          // The paste listener below (U4) handles both text and image — unifying paste in one place
          // eliminates the double-paste race that would occur if we also called readText() here.
          if (e.metaKey && !e.altKey && !e.ctrlKey && (e.key === 'v' || e.key === 'V')) {
            return true
          }

          // Cmd+X: treat as copy (terminals don't cut); mirrors ghostty triad behavior.
          if (e.metaKey && !e.altKey && !e.ctrlKey && (e.key === 'x' || e.key === 'X')) {
            if (term.hasSelection()) {
              void navigator.clipboard.writeText(term.getSelection())
              return false
            }
            return true
          }

          // User-defined ghostty keybinds: checked AFTER hardcoded combos so the
          // hardcoded ones above always win (they already returned false or true).
          for (const kb of userKeybinds) {
            if (matchTrigger(e, kb.trigger)) {
              const consumed = dispatchGhosttyAction(kb.action, term, () => doFitRef.current?.())
              if (consumed) return false
            }
          }

          // All other keys (plain typing, arrows, Ctrl+C, Tab, Escape, IME
          // composition, etc.) pass through to xterm's default handler unchanged.
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
          setLoading(false)
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

      if (result.created) {
        setLoading(true)
        // Fresh spawn: wire the live session immediately.
        wireLiveSession()
        if (active && !disposed) term.focus()
        // Hide loader when SessionStart hook fires — canonical "claude is ready" signal.
        unsubSessionReady = window.api.xterm.onSessionReady(({ workspaceId: wid }) => {
          if (wid !== workspaceId || disposed) return
          if (fallbackTimeoutId !== null) {
            clearTimeout(fallbackTimeoutId)
            fallbackTimeoutId = null
          }
          setLoading(false)
        })
        // 10s fallback: if SessionStart never fires (hook system broken), clear the loader.
        fallbackTimeoutId = setTimeout(() => {
          fallbackTimeoutId = null
          if (!disposed) setLoading(false)
        }, 10000)
      } else if (result.reattached) {
        // Reattach: PTY was already live (navigated away and back).
        // Replay the rolling output tail so the screen isn't blank, then wire.
        const reattachResult = await window.api.xterm.reattach(workspaceId)
        if (disposed) return
        if (reattachResult.data !== null) {
          term.write(reattachResult.data)
        }
        setLoading(false)
        wireLiveSession()
        if (active && !disposed) term.focus()
        // Nudge PTY to redraw by syncing current cols/rows.
        doFit()
        void window.api.xterm.resize(workspaceId, Math.max(1, term.cols), Math.max(1, term.rows))
      } else {
        // Real failure (PTY spawn error, not a reattach).
        setLoading(false)
        setSpawnError(result.error ?? 'Failed to spawn terminal process')
      }
    }

    openAndSpawn().catch((err) => {
      setLoading(false)
      setSpawnError(String(err))
    })

    // Mouse-hide-while-typing: hide cursor on keydown, restore on mousemove.
    // Mirrors ghostty's mouse-hide-while-typing = true. No per-frame work.
    // mouseHideWhileTyping is resolved asynchronously in openAndSpawn and written
    // to the let above; these handlers close over the let so they read the resolved value.
    const onKeyDown = (): void => {
      if (mouseHideWhileTyping && el) el.style.cursor = 'none'
    }
    const onMouseMove = (): void => {
      if (mouseHideWhileTyping && el) el.style.cursor = ''
    }
    // U4 — Unified paste handler: handles both image and text paste via the DOM paste event.
    // Cmd+V in the key handler above returns true (passes through to native paste), so this
    // listener is the single owner of paste — no double-paste race.
    // Mirror addon.mm tryPasteClipboardImage (~947-995): image flavor wins over text when both present.
    const onPaste = (e: ClipboardEvent): void => {
      if (disposed) return
      const items = e.clipboardData?.items
      if (!items) return

      // Prefer image flavor — screenshots carry both image and text representations.
      let imageItem: DataTransferItem | null = null
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          imageItem = item
          break
        }
      }

      if (imageItem !== null) {
        // Capture mime and file synchronously before any await.
        const mime = imageItem.type
        const file = imageItem.getAsFile()
        // Prevent default synchronously — must be called before any async gap.
        e.preventDefault()
        if (!file) return
        void (async () => {
          try {
            const buf = await file.arrayBuffer()
            const bytes = new Uint8Array(buf)
            const result = await window.api.xterm.writeImageAttachment(bytes, mime)
            if (disposed) return
            if ('error' in result) {
              console.warn('[xterm] writeImageAttachment failed:', result.error)
              return
            }
            // result.path is already POSIX-quoted (U2 guarantees this).
            term.paste(result.path)
          } catch (err) {
            console.warn('[xterm] image paste error:', err)
          }
        })()
        return
      }

      // No image — paste text if available.
      const text = e.clipboardData?.getData('text/plain') ?? ''
      if (text) {
        e.preventDefault()
        term.paste(text)
      }
      // If neither image nor text, do nothing — let default handling proceed.
    }
    // U5 — File / image drag-drop.
    // Mirrors addon.mm performDragOperation (~997-1027): resolve real paths via
    // webUtils.getPathForFile, quote via xterm:quotePaths, paste into terminal.
    const onDragOver = (e: DragEvent): void => {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onDrop = (e: DragEvent): void => {
      // preventDefault synchronously before any awaits — required for drop to work.
      e.preventDefault()
      if (disposed) return
      const files = e.dataTransfer?.files
      if (!files || files.length === 0) return
      void (async () => {
        try {
          const realPaths: string[] = []
          const imageFiles: File[] = []
          for (let i = 0; i < files.length; i++) {
            const file = files[i]
            const p = window.api.xterm.getPathForFile(file)
            if (p) {
              realPaths.push(p)
            } else if (file.type.startsWith('image/')) {
              imageFiles.push(file)
            }
          }
          // Paste quoted real paths.
          if (realPaths.length > 0) {
            const { text } = await window.api.xterm.quotePaths(realPaths)
            if (!disposed && text) term.paste(text)
          }
          // Fallback: path-less images → write to tmp and paste the resulting path.
          for (const file of imageFiles) {
            const buf = await file.arrayBuffer()
            const bytes = new Uint8Array(buf)
            const result = await window.api.xterm.writeImageAttachment(bytes, file.type)
            if (disposed) return
            if ('error' in result) {
              console.warn('[xterm] drop image writeImageAttachment failed:', result.error)
              continue
            }
            // result.path is already POSIX-quoted (U2 guarantees this).
            term.paste(result.path)
          }
        } catch (err) {
          console.warn('[xterm] drop handler error:', err)
        }
      })()
    }
    // C1 — live settings hot-swap for safe subset (no metric-affecting keys).
    unsubSettingsChanged = window.api.ghosttySettings.onChanged(async () => {
      if (disposed) return
      let s: Record<string, unknown> = {}
      let fetched: Awaited<ReturnType<typeof window.api.ghosttySettings.get>> | null = null
      try {
        fetched = await window.api.ghosttySettings.get()
        s = fetched.settings as Record<string, unknown>
      } catch {
        return
      }
      if (disposed) return

      // Theme/colors: resolve named theme then merge per-key overrides.
      const themeName = typeof s['theme'] === 'string' ? s['theme'] : null
      let theme: ITheme | null = null
      try {
        if (themeName) {
          theme = (await window.api.ghosttySettings.getTheme(themeName)) as ITheme | null
        }
      } catch {
        // Non-fatal: proceed without named theme.
      }
      if (disposed) return
      let currentTheme: ITheme = theme ?? term.options.theme ?? {}
      if (theme) {
        if (typeof s['background'] === 'string' && s['background'])
          currentTheme = { ...currentTheme, background: s['background'] }
        if (typeof s['foreground'] === 'string' && s['foreground'])
          currentTheme = { ...currentTheme, foreground: s['foreground'] }
      }
      if (typeof s['cursor-color'] === 'string' && s['cursor-color'])
        currentTheme = { ...currentTheme, cursor: s['cursor-color'] }
      if (typeof s['selection-background'] === 'string' && s['selection-background'])
        currentTheme = { ...currentTheme, selectionBackground: s['selection-background'] }
      if (typeof s['selection-foreground'] === 'string' && s['selection-foreground'])
        currentTheme = { ...currentTheme, selectionForeground: s['selection-foreground'] }
      if (Object.keys(currentTheme).length > 0) term.options.theme = currentTheme

      // Cursor.
      const cursorStyleRaw = s['cursor-style']
      if (cursorStyleRaw === 'block' || cursorStyleRaw === 'underline' || cursorStyleRaw === 'bar')
        term.options.cursorStyle = cursorStyleRaw
      const blinkRaw = s['cursor-style-blink']
      if (blinkRaw !== undefined && blinkRaw !== null)
        term.options.cursorBlink = blinkRaw === true || blinkRaw === 'true'

      // Text rendering.
      const boldIsBright = s['bold-is-bright']
      if (boldIsBright === true || boldIsBright === 'true')
        term.options.drawBoldTextInBrightColors = true
      else if (boldIsBright === false || boldIsBright === 'false')
        term.options.drawBoldTextInBrightColors = false
      const minContrast = Number(s['minimum-contrast'])
      if (!isNaN(minContrast) && minContrast >= 1) term.options.minimumContrastRatio = minContrast

      // Scrollback.
      const scrollbackNum = Number(s['scrollback-limit'])
      if (!isNaN(scrollbackNum) && scrollbackNum > 0)
        term.options.scrollback = Math.min(scrollbackNum, 50000)

      // Reassignable lets — picked up by existing event handlers.
      mouseHideWhileTyping =
        s['mouse-hide-while-typing'] !== false && s['mouse-hide-while-typing'] !== 'false'
      const rawMult = Number(s['mouse-scroll-multiplier'])
      scrollMultiplier = !isNaN(rawMult) && rawMult > 0 ? rawMult : 1
      term.options.scrollSensitivity = scrollMultiplier
      userKeybinds = fetched?.keybinds ?? []

      // NOT live-applied (metric-affecting, require restart):
      // font-family, font-size, lineHeight (adjust-cell-height),
      // letterSpacing (adjust-cell-width), window-padding-x/y.
    })

    el.addEventListener('dragover', onDragOver)
    el.addEventListener('drop', onDrop)
    el.addEventListener('keydown', onKeyDown)
    el.addEventListener('mousemove', onMouseMove)
    el.addEventListener('paste', onPaste)

    return () => {
      disposed = true
      doFitRef.current = null
      focusTermRef.current = null
      registerFocus?.(null)

      if (resizeDebounceId !== null) {
        clearTimeout(resizeDebounceId)
        resizeDebounceId = null
      }
      if (fallbackTimeoutId !== null) {
        clearTimeout(fallbackTimeoutId)
        fallbackTimeoutId = null
      }
      resizeObserver?.disconnect()
      resizeObserver = null

      unsubData?.()
      unsubExit?.()
      unsubSessionReady?.()
      unsubSettingsChanged?.()

      // Flush any remaining ack before teardown.
      if (pendingAck > 0) {
        void window.api.xterm.ack(workspaceId, pendingAck)
        pendingAck = 0
      }

      el.removeEventListener('dragover', onDragOver)
      el.removeEventListener('drop', onDrop)
      el.removeEventListener('keydown', onKeyDown)
      el.removeEventListener('mousemove', onMouseMove)
      el.removeEventListener('paste', onPaste)

      // Dispose WebGL addon before Terminal to avoid GPU resource leaks.
      webgl?.dispose()
      webgl = null
      term.dispose()

      // Do NOT call window.api.xterm.destroy here — hide ≠ destroy.
      // The PTY stays alive so navigating back can reattach. U8 refines teardown.
    }
    // active deliberately excluded — active changes drive fit below, not teardown.
    // attemptKey is included so bumping it (Restart) rebuilds the terminal effect.
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

  // Sticky focus: refocus terminal when active flips to true.
  useEffect(() => {
    if (active) requestAnimationFrame(() => focusTermRef.current?.())
  }, [active])

  // Sticky focus: refocus terminal when the app/window regains OS focus.
  useEffect(() => {
    const onWindowFocus = (): void => {
      if (active && !isEditableTarget()) focusTermRef.current?.()
    }
    window.addEventListener('focus', onWindowFocus)
    return () => window.removeEventListener('focus', onWindowFocus)
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
    <div
      ref={containerRef}
      className="w-full h-full relative"
      style={bgColor ? { backgroundColor: bgColor } : undefined}
    >
      {/* Inner div: xterm mounts here. term.element padding is set after open() so FitAddon subtracts it. */}
      <div ref={xtermRef} className="w-full h-full" />
      {loading && !spawnError && !exited && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface-base">
          <div
            className="flex flex-col items-center gap-3 rounded-[14px] border border-border-base bg-surface-base px-8 py-6 shadow-lg"
            style={{ width: 340 }}
          >
            <DotmSquare12 size={36} dotSize={5} animated />
            <p className="text-sm text-text-primary">Starting workspace</p>
          </div>
        </div>
      )}
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
