import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import type { ActionResult, PromptDescriptor } from '@shared/types'
import { playSound } from '../../../lib/sound'
import { expandPlaceholders } from '../../../lib/footerPlaceholders'
import { DotmFooterLoader } from '../../ui/dotm-footer-loader'
import { IconByName } from './iconMap'

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
}

/**
 * Renders a mutator action chip. Click invokes the action, shows an in-flight
 * loader, plays sounds on success/error, and navigates on fork success.
 *
 * When `prompts` is non-empty a small inline popover appears above the chip
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
  onForkSuccess
}: ActionChipProps): React.JSX.Element {
  const [inFlight, setInFlight] = useState(false)
  const [tooltip, setTooltip] = useState<string | null>(null)
  const [canInject, setCanInject] = useState(true)
  const tooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Clear pending tooltip timer on unmount to avoid setState on unmounted component.
  useEffect(() => {
    return () => {
      if (tooltipTimer.current) {
        clearTimeout(tooltipTimer.current)
        tooltipTimer.current = null
      }
    }
  }, [])

  // Prompt popover state
  const [showPrompt, setShowPrompt] = useState(false)
  const [promptValues, setPromptValues] = useState<Record<string, string>>({})
  const promptInputRef = useRef<HTMLInputElement>(null)

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

  const showTooltip = useCallback((msg: string) => {
    setTooltip(msg)
    if (tooltipTimer.current) clearTimeout(tooltipTimer.current)
    tooltipTimer.current = setTimeout(() => setTooltip(null), 2500)
  }, [])

  const placeholderCtx = useMemo(
    () => ({ sessionId, workspaceId, cwd, workspaceName }),
    [sessionId, workspaceId, cwd, workspaceName]
  )

  /** Open the prompt popover, pre-filling defaults with expanded placeholders. */
  const openPromptPopover = useCallback((): void => {
    if (!prompts || prompts.length === 0) return
    const defaults: Record<string, string> = {}
    for (const p of prompts) {
      defaults[p.key] = p.default ? expandPlaceholders(p.default, placeholderCtx) : ''
    }
    setPromptValues(defaults)
    setShowPrompt(true)
    // Focus the first input after the popover renders
    setTimeout(() => promptInputRef.current?.focus(), 0)
  }, [prompts, placeholderCtx])

  const invokeAction = useCallback(
    async (overrideParams?: Record<string, unknown>): Promise<void> => {
      playSound('click')
      setInFlight(true)
      setTooltip(null)

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
    [actionId, params, workspaceId, sessionId, cwd, workspaceName, onForkSuccess, showTooltip]
  )

  const handlePromptSubmit = useCallback((): void => {
    if (!prompts || prompts.length === 0) return
    setShowPrompt(false)
    // Merge prompt values into params
    const merged: Record<string, unknown> = { ...params }
    for (const p of prompts) {
      merged[p.key] = promptValues[p.key] ?? ''
    }
    invokeAction(merged).catch((e) => console.error('[ActionChip] prompt invoke failed', e))
  }, [prompts, params, promptValues, invokeAction])

  const handleClick = useCallback(async (): Promise<void> => {
    if (inFlight) return

    if (disabled) {
      playSound('error')
      showTooltip('Claude is busy')
      return
    }

    // If this action requires user input first, open the popover instead of
    // invoking directly.
    if (prompts && prompts.length > 0) {
      if (showPrompt) {
        // Second click while popover is open → dismiss
        setShowPrompt(false)
        return
      }
      openPromptPopover()
      return
    }

    await invokeAction()
  }, [inFlight, disabled, prompts, showPrompt, openPromptPopover, invokeAction, showTooltip])

  return (
    <div className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => {
          handleClick().catch((e) => console.error('[ActionChip] click handler failed', e))
        }}
        disabled={inFlight}
        title={disabled ? 'Claude is busy' : label}
        aria-label={label}
        className={[
          'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs',
          'transition-colors duration-150',
          'border border-transparent',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
          disabled
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

      {/* Prompt popover — appears above the chip when the action needs user input */}
      {showPrompt && prompts && prompts.length > 0 && (
        <>
          {/* Click-outside overlay */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setShowPrompt(false)}
            aria-hidden="true"
          />
          <div
            className="absolute bottom-full left-0 mb-1.5 z-50 w-52 bg-surface-overlay border border-border-default rounded-lg shadow-lg p-2 flex flex-col gap-2"
            role="dialog"
            aria-label={`${label} — enter value`}
          >
            {prompts.map((p, idx) => (
              <div key={p.key} className="flex flex-col gap-0.5">
                <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
                  {p.label}
                </span>
                <input
                  ref={idx === 0 ? promptInputRef : null}
                  type="text"
                  value={promptValues[p.key] ?? ''}
                  placeholder={p.placeholder ?? ''}
                  onChange={(e) =>
                    setPromptValues((prev) => ({ ...prev, [p.key]: e.target.value }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      handlePromptSubmit()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      setShowPrompt(false)
                    }
                  }}
                  className="w-full px-2 py-1 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
                />
              </div>
            ))}
            <div className="flex justify-end gap-1.5 pt-0.5">
              <button
                type="button"
                onClick={() => setShowPrompt(false)}
                className="text-xs text-text-muted hover:text-text-primary px-2 py-0.5 rounded hover:bg-surface-raised transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handlePromptSubmit}
                className="text-xs font-medium text-white bg-accent hover:bg-accent/90 px-2 py-0.5 rounded transition-colors cursor-pointer"
              >
                Apply
              </button>
            </div>
          </div>
        </>
      )}

      {/* Tooltip */}
      {tooltip && !showPrompt && (
        <div
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-1 rounded text-xs text-text-primary bg-surface-overlay border border-border-default shadow-md whitespace-nowrap z-50 pointer-events-none"
          role="tooltip"
        >
          {tooltip}
        </div>
      )}
    </div>
  )
}
