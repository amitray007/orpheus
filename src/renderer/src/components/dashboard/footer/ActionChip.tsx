import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import type { ActionResult } from '@shared/types'
import { playSound } from '../../../lib/sound'
import { expandPlaceholders } from '../../../lib/footerPlaceholders'
import { DotmFooterLoader } from '../../ui/dotm-footer-loader'
import { IconByName } from './iconMap'

interface ActionChipProps {
  actionId: string
  label: string
  icon: string | null
  params: Record<string, unknown>
  workspaceId: string
  /** Session ID for placeholder expansion in terminal.sendInput params. */
  sessionId?: string | null
  /** Working directory for placeholder expansion in terminal.sendInput params. */
  cwd?: string
  /** Called after a successful workspace.fork with the new workspace ID. */
  onForkSuccess?: (newWorkspaceId: string) => void
}

/**
 * Renders a mutator action chip. Click invokes the action, shows an in-flight
 * loader, plays sounds on success/error, and navigates on fork success.
 */
export function ActionChip({
  actionId,
  label,
  icon,
  params,
  workspaceId,
  sessionId = null,
  cwd = '',
  onForkSuccess
}: ActionChipProps): React.JSX.Element {
  const [inFlight, setInFlight] = useState(false)
  const [tooltip, setTooltip] = useState<string | null>(null)
  const [canInject, setCanInject] = useState(true)
  const tooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Poll canInject every 1s for terminal.* actions
  const isTerminalAction = actionId.startsWith('terminal.')
  useEffect(() => {
    if (!isTerminalAction) return
    let cancelled = false
    const poll = (): void => {
      window.api.terminal
        .canInject(workspaceId)
        .then((ok) => {
          if (!cancelled) setCanInject(ok)
        })
        .catch(() => {
          if (!cancelled) setCanInject(false)
        })
    }
    poll()
    const id = setInterval(poll, 1000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [isTerminalAction, workspaceId])

  const disabled = isTerminalAction && !canInject

  const showTooltip = useCallback((msg: string) => {
    setTooltip(msg)
    if (tooltipTimer.current) clearTimeout(tooltipTimer.current)
    tooltipTimer.current = setTimeout(() => setTooltip(null), 2500)
  }, [])

  const handleClick = useCallback(async (): Promise<void> => {
    if (inFlight) return

    if (disabled) {
      playSound('error')
      showTooltip('Claude is busy')
      return
    }

    playSound('click')
    setInFlight(true)
    setTooltip(null)

    // Expand placeholders in terminal.sendInput text and workspace.rename name
    let resolvedParams = params
    if (
      (actionId === 'terminal.sendInput' || actionId === 'workspace.rename') &&
      (cwd || workspaceId || sessionId)
    ) {
      const ctx = { sessionId, workspaceId, cwd }
      if (actionId === 'terminal.sendInput' && typeof params.text === 'string') {
        resolvedParams = { ...params, text: expandPlaceholders(params.text, ctx) }
      } else if (actionId === 'workspace.rename' && typeof params.name === 'string') {
        resolvedParams = { ...params, name: expandPlaceholders(params.name, ctx) }
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
  }, [
    inFlight,
    disabled,
    actionId,
    params,
    workspaceId,
    sessionId,
    cwd,
    onForkSuccess,
    showTooltip
  ])

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
            ? 'cursor-not-allowed text-text-muted/70 bg-surface-overlay/40'
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

      {/* Tooltip */}
      {tooltip && (
        <div
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-1 rounded text-[10px] text-text-primary bg-surface-overlay border border-border-default shadow-md whitespace-nowrap z-50 pointer-events-none"
          role="tooltip"
        >
          {tooltip}
        </div>
      )}
    </div>
  )
}
