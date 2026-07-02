import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import type { ActionResult, PromptDescriptor } from '@shared/types'
import { playSound } from '../../../lib/sound'
import { expandPlaceholders } from '../../../lib/footerPlaceholders'
import { DotmFooterLoader } from '../../ui/dotm-footer-loader'
import { IconByName } from './iconMap'
import {
  showChipTooltip,
  hideOverlayCard,
  chipTooltipId,
  showChipPrompt,
  hideChipPrompt,
  chipPromptId
} from '@/lib/overlayClient'

// ─── ChipButton ───────────────────────────────────────────────────────────────

interface ChipButtonProps {
  inFlight: boolean
  isDisabled: boolean
  showPrompt: boolean
  icon: string | null
  label: string
  title: string
  onClick: () => void
}

/** The chip visual: icon slot + label, styled by interaction state. */
const ChipButton = memo(function ChipButton({
  inFlight,
  isDisabled,
  showPrompt,
  icon,
  label,
  title,
  onClick
}: ChipButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={inFlight}
      title={title}
      aria-label={label}
      className={[
        'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs',
        'transition-colors duration-150',
        'border border-transparent',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
        isDisabled
          ? 'cursor-not-allowed text-text-muted bg-surface-overlay/40'
          : showPrompt
            ? 'text-text-primary bg-surface-overlay border border-border-default/60'
            : [
                'text-text-primary bg-surface-overlay/60',
                'hover:bg-surface-overlay hover:border-border-default/60',
                'active:scale-95 active:transition-transform active:duration-100'
              ].join(' ')
      ]
        .flat()
        .join(' ')}
    >
      <span className="flex-shrink-0 flex items-center" style={{ width: 12, height: 12 }}>
        {inFlight ? (
          <DotmFooterLoader animated={true} />
        ) : icon ? (
          <IconByName name={icon} size={12} />
        ) : null}
      </span>
      <span className="truncate max-w-[80px]">{label}</span>
    </button>
  )
})

// ─── ActionChip ───────────────────────────────────────────────────────────────

interface ActionChipProps {
  actionId: string
  label: string
  icon: string | null
  params: Record<string, unknown>
  /** Prompts to collect from the user before invoking the action. */
  prompts?: PromptDescriptor[]
  workspaceId: string
  /** Session ID for placeholder expansion in terminal.sendInput params. */
  sessionId?: string | null
  /** Working directory for placeholder expansion in terminal.sendInput params. */
  cwd?: string
  /** Current workspace name — for {workspaceName} placeholder expansion. */
  workspaceName?: string
  /** Called after a successful workspace.fork with the new workspace ID. */
  onForkSuccess?: (newWorkspaceId: string) => void
  /** Whether this chip's visibleWhen condition is satisfied for the current activity state. When false the chip renders disabled. */
  enabled?: boolean
}

/**
 * Renders a mutator action chip. Click invokes the action, shows an in-flight
 * loader, plays sounds on success/error, and navigates on fork success.
 *
 * When `prompts` is non-empty a small overlay popover appears above the chip
 * so the user can fill the required values before the action fires. Esc or
 * clicking outside cancels; Enter submits.
 */
export function ActionChip({
  actionId,
  label,
  icon,
  params,
  prompts,
  workspaceId,
  sessionId = null,
  cwd = '',
  workspaceName = '',
  onForkSuccess,
  enabled = true
}: ActionChipProps): React.JSX.Element {
  const [inFlight, setInFlight] = useState(false)
  const [canInject, setCanInject] = useState(true)
  const tooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Anchor element for the overlay-layer tooltip/prompt — the chip's own
  // wrapper div.
  const chipRef = useRef<HTMLDivElement>(null)
  const tooltipOverlayId = useMemo(() => chipTooltipId(actionId), [actionId])
  const promptOverlayId = useMemo(() => chipPromptId(actionId), [actionId])

  // Clear pending tooltip timer + hide any live overlay tooltip on unmount to
  // avoid a stranded overlay window.
  useEffect(() => {
    return () => {
      if (tooltipTimer.current) {
        clearTimeout(tooltipTimer.current)
        tooltipTimer.current = null
      }
      hideOverlayCard(tooltipOverlayId)
    }
  }, [tooltipOverlayId])

  // Prompt popover state
  const [showPrompt, setShowPrompt] = useState(false)

  // Subscribe to canInject push updates for terminal.* actions.
  // NOTE: depends on arch-main onCanInjectChanged — channel `terminal:canInjectChanged`,
  // payload { workspaceId: string; canInject: boolean }.
  // Preload method: window.api.terminal.onCanInjectChanged returning an unsubscribe fn.
  const isTerminalAction = actionId.startsWith('terminal.')

  // Renderer-local ambient type until the preload types are reconciled.
  type TerminalApiWithPush = typeof window.api.terminal & {
    onCanInjectChanged?: (
      cb: (e: { workspaceId: string; canInject: boolean }) => void
    ) => () => void
  }

  useEffect(() => {
    if (!isTerminalAction) return
    const terminalApi = window.api.terminal as TerminalApiWithPush

    let alive = true

    // Initial fetch so the chip reflects the current state before any push lands.
    window.api.terminal
      .canInject(workspaceId)
      .then((ok) => {
        if (alive) setCanInject(ok)
      })
      .catch(() => {
        if (alive) setCanInject(false)
      })

    if (typeof terminalApi.onCanInjectChanged !== 'function') {
      // Push channel not yet available — no subscription, initial value is enough.
      return () => {
        alive = false
      }
    }

    // Subscribe to push updates; filter to this chip's workspace.
    const unsub = terminalApi.onCanInjectChanged((e) => {
      if (e.workspaceId === workspaceId) setCanInject(e.canInject)
    })
    return () => {
      alive = false
      unsub()
    }
  }, [isTerminalAction, workspaceId])

  const disabled = isTerminalAction && !canInject
  const notApplicable = enabled === false
  const isDisabled = disabled || notApplicable

  const showTooltip = useCallback(
    (msg: string) => {
      if (tooltipTimer.current) clearTimeout(tooltipTimer.current)

      if (chipRef.current) {
        const r = chipRef.current.getBoundingClientRect()
        showChipTooltip(
          tooltipOverlayId,
          { x: r.left, y: r.top, w: r.width, h: r.height },
          { text: msg },
          workspaceId
        )
      }
      tooltipTimer.current = setTimeout(() => hideOverlayCard(tooltipOverlayId), 2500)
    },
    [tooltipOverlayId, workspaceId]
  )

  const placeholderCtx = useMemo(
    () => ({ sessionId, workspaceId, cwd, workspaceName }),
    [sessionId, workspaceId, cwd, workspaceName]
  )

  const invokeAction = useCallback(
    async (overrideParams?: Record<string, unknown>): Promise<void> => {
      playSound('click')
      setInFlight(true)
      if (tooltipTimer.current) {
        clearTimeout(tooltipTimer.current)
        tooltipTimer.current = null
      }
      hideOverlayCard(tooltipOverlayId)

      const effectiveParams = overrideParams ?? params

      // Expand placeholders in terminal.sendInput text and workspace.rename name
      let resolvedParams = effectiveParams
      if (
        (actionId === 'terminal.sendInput' || actionId === 'workspace.rename') &&
        (cwd || workspaceId || sessionId)
      ) {
        const ctx = placeholderCtx
        if (actionId === 'terminal.sendInput' && typeof resolvedParams.text === 'string') {
          resolvedParams = { ...resolvedParams, text: expandPlaceholders(resolvedParams.text, ctx) }
        } else if (actionId === 'workspace.rename' && typeof resolvedParams.name === 'string') {
          resolvedParams = { ...resolvedParams, name: expandPlaceholders(resolvedParams.name, ctx) }
        }
      }

      let result: ActionResult
      try {
        result = await window.api.actions.invoke(
          { id: actionId, params: resolvedParams, workspaceId },
          'footer'
        )
      } catch (err) {
        setInFlight(false)
        playSound('error')
        showTooltip('Action failed')
        console.error('[ActionChip] invoke error', err)
        return
      }

      setInFlight(false)

      if (result.ok) {
        playSound('success')
        // Post-fork/duplicate navigation
        if (
          (actionId === 'workspace.fork' || actionId === 'workspace.duplicate') &&
          result.value &&
          typeof result.value === 'object' &&
          'workspaceId' in (result.value as Record<string, unknown>)
        ) {
          const newId = (result.value as { workspaceId: string }).workspaceId
          onForkSuccess?.(newId)
        }
      } else {
        playSound('error')
        if (result.code === 'busy') {
          showTooltip('Claude is busy')
        } else {
          showTooltip(result.error ?? 'Action failed')
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      actionId,
      params,
      workspaceId,
      sessionId,
      cwd,
      workspaceName,
      onForkSuccess,
      showTooltip,
      tooltipOverlayId
    ]
  )

  /** Open the prompt popover, pre-filling defaults with expanded placeholders. */
  const openPromptPopover = useCallback((): void => {
    if (!prompts || prompts.length === 0) return
    const defaults: Record<string, string> = {}
    for (const p of prompts) {
      defaults[p.key] = p.default ? expandPlaceholders(p.default, placeholderCtx) : ''
    }

    if (!chipRef.current) return
    const r = chipRef.current.getBoundingClientRect()
    setShowPrompt(true)
    showChipPrompt(
      promptOverlayId,
      { x: r.left, y: r.top, w: r.width, h: r.height },
      { prompts, values: defaults },
      workspaceId
    )
      .then((res) => {
        setShowPrompt(false)
        if (!res) return // Cancel/Escape/outside-click/IPC failure
        const merged: Record<string, unknown> = { ...params }
        for (const p of prompts) {
          merged[p.key] = res.values[p.key] ?? ''
        }
        return invokeAction(merged)
      })
      .catch((e) => console.error('[ActionChip] prompt invoke failed', e))
  }, [prompts, placeholderCtx, promptOverlayId, workspaceId, params, invokeAction])

  // Outside-click dismissal while the overlay chipPrompt is open: the
  // popover lives in a separate child BrowserWindow, so the main renderer's
  // document-level listener never sees clicks landing INSIDE the popover —
  // only clicks in the main window (including the terminal) reach here,
  // which is exactly the "outside" set for this popover.
  useEffect(() => {
    if (!showPrompt) return
    const onPointerDown = (): void => {
      hideChipPrompt(promptOverlayId)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [showPrompt, promptOverlayId])

  const chipTitle = isDisabled ? (disabled ? 'Claude is busy' : 'Not available right now') : label

  const handleClick = useCallback(async (): Promise<void> => {
    if (inFlight) return

    if (isDisabled) {
      playSound('error')
      showTooltip(disabled ? 'Claude is busy' : 'Not available right now')
      return
    }

    // If this action requires user input first, open the popover instead of
    // invoking directly.
    if (prompts && prompts.length > 0) {
      if (showPrompt) {
        // Second click while popover is open → dismiss
        hideChipPrompt(promptOverlayId)
        return
      }
      openPromptPopover()
      return
    }

    await invokeAction()
  }, [
    inFlight,
    isDisabled,
    disabled,
    prompts,
    showPrompt,
    openPromptPopover,
    invokeAction,
    showTooltip,
    promptOverlayId
  ])

  // Wrap in a stable void callback so ChipButton.memo sees a stable reference.
  const handleChipClick = useCallback((): void => {
    handleClick().catch((e) => console.error('[ActionChip] click handler failed', e))
  }, [handleClick])

  return (
    <div ref={chipRef} className="relative flex-shrink-0">
      <ChipButton
        inFlight={inFlight}
        isDisabled={isDisabled}
        showPrompt={showPrompt}
        icon={icon}
        label={label}
        title={chipTitle}
        onClick={handleChipClick}
      />
    </div>
  )
}
