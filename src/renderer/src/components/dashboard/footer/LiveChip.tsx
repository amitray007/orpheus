import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import type { ActionKind, WorkspaceActivityDetail } from '@shared/types'
import { IconByName } from './iconMap'

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const v = n / 1_000_000
    // 3 sig figs, trim trailing zeros
    return parseFloat(v.toPrecision(3)) + 'M'
  }
  if (n >= 1_000) {
    const v = n / 1_000
    return parseFloat(v.toPrecision(3)) + 'k'
  }
  return parseFloat((n / 1_000).toPrecision(3)) + 'k'
}

function formatUsd(n: number): string {
  if (n === 0) return '$0'
  if (n > 0 && n < 0.01) return '< $0.01'
  if (n >= 1) return '$' + n.toFixed(2)
  return '$' + parseFloat(n.toPrecision(3)).toString()
}

// Dot color by workspace activity status
function getStatusDotColor(value: unknown): string {
  if (typeof value !== 'string') return 'bg-text-muted/40'
  switch (value as WorkspaceActivityDetail) {
    case 'thinking':
    case 'tool':
    case 'compacting':
      return 'bg-accent/70 animate-pulse'
    case 'asking':
    case 'ready':
      return 'bg-[#22c55e]' // green
    case 'attention':
      return 'bg-[#ef4444]' // red
    case 'idle':
      return 'bg-[#22c55e]/60'
    case 'archived':
      return 'bg-text-muted/30'
    default:
      return 'bg-text-muted/40'
  }
}

// Format values for display
function formatValue(actionId: string, value: unknown): string | null {
  if (value === null || value === undefined) return null

  // session.getUsage — render occupancy from the most-recent turn only (e.g. "78.2k")
  if (actionId === 'session.getUsage' && typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>
    if (typeof v.lastTurnContextTokens === 'number') {
      return formatTokens(v.lastTurnContextTokens as number)
    }
    // Fallback for stale cached values without the new field
    if (typeof v.usedPct === 'number') {
      return `${Math.round(v.usedPct as number)}%`
    }
  }

  // session.getCost — render cost with 3 sig figs (e.g. "$0.0042" or "< $0.01")
  if (actionId === 'session.getCost' && typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>
    if (typeof v.usd === 'number') {
      return formatUsd(v.usd as number)
    }
  }

  // workspace.getActivityStatus — show the detail string
  if (actionId === 'workspace.getActivityStatus' && typeof value === 'string') {
    return value
  }

  // Generic fallback
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return null
}

// ---------------------------------------------------------------------------
// Module-level value cache — keyed by `${actionId}:${workspaceId}`.
// On workspace switch-back the chip immediately renders the stale value
// (no null → value flash) while the subscription / poll catches up.
// ---------------------------------------------------------------------------
const chipValueCache = new Map<string, unknown>()

interface LiveChipProps {
  actionId: string
  label: string
  icon: string | null
  params: Record<string, unknown>
  workspaceId: string
  kind: ActionKind
  /** Whether this chip's visibleWhen condition is satisfied for the current activity state. When false the chip renders dimmed. */
  enabled?: boolean
}

/**
 * Renders a display-only chip for query (polled) and subscription actions.
 * Shows the live value next to the icon.
 */
export function LiveChip({
  actionId,
  label,
  icon,
  params,
  workspaceId,
  kind,
  enabled = true
}: LiveChipProps): React.JSX.Element {
  const cacheKey = `${actionId}:${workspaceId}`
  const [value, setValue] = useState<unknown>(() => chipValueCache.get(cacheKey) ?? null)
  const disposeRef = useRef<(() => void) | null>(null)

  const isStatus = actionId === 'workspace.getActivityStatus'

  useEffect(() => {
    if (!workspaceId) return
    if (!enabled) return

    const key = `${actionId}:${workspaceId}`

    // Helper that writes through to both component state and the module cache.
    const updateValue = (v: unknown): void => {
      chipValueCache.set(key, v)
      setValue(v)
    }

    // Subscribe for explicit subscription kind OR any session.* action.
    // session.* actions are backed by fs.watch on the JSONL (200ms debounce)
    // so subscription gives ~200ms latency vs the 2s poll — much snappier.
    const useSubscription = kind === 'subscription' || actionId.startsWith('session.')

    if (useSubscription) {
      // Initial fetch so the chip shows a value immediately; then let
      // subscription updates take over as claude writes new turns.
      window.api.actions
        .invoke({ id: actionId, params, workspaceId }, 'footer-live')
        .then((result) => {
          if (result.ok) updateValue(result.value ?? null)
        })
        .catch(() => {
          /* silently skip on error */
        })

      const handle = window.api.actions.subscribe(actionId, params, workspaceId, (v) => {
        updateValue(v)
      })
      disposeRef.current = handle.dispose
      return () => {
        handle.dispose()
        disposeRef.current = null
      }
    }

    // kind === 'query' (non-session) — poll every 2s
    let cancelled = false
    const fetchOnce = (): void => {
      window.api.actions
        .invoke({ id: actionId, params, workspaceId }, 'footer-live')
        .then((result) => {
          if (!cancelled && result.ok) updateValue(result.value ?? null)
        })
        .catch(() => {
          /* silently skip on error */
        })
    }
    fetchOnce()
    const id = setInterval(fetchOnce, 2000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [actionId, workspaceId, kind, params, enabled])

  const displayText = formatValue(actionId, value)
  const dotColor = isStatus ? getStatusDotColor(value) : null

  return (
    <div
      className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-text-muted select-none${enabled ? '' : ' opacity-40'}`}
      title={`${label}${displayText ? `: ${displayText}` : ''}`}
    >
      {/* Colored status dot OR icon */}
      {isStatus && dotColor ? (
        <span className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${dotColor}`} />
      ) : icon ? (
        <span className="flex-shrink-0 opacity-50">
          <IconByName name={icon} size={11} />
        </span>
      ) : null}

      <span className="truncate max-w-[120px]">
        {displayText ? `${label} ${displayText}` : label}
      </span>
    </div>
  )
}
