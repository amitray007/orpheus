import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import type { ActionKind, WorkspaceActivityDetail } from '@shared/types'
import { IconByName } from './iconMap'

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

  // session.getUsage — render "Context 78k / 200k"
  if (actionId === 'session.getUsage' && typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>
    if (typeof v.inputTokens === 'number' && typeof v.contextBudget === 'number') {
      const used =
        (v.inputTokens as number) +
        ((v.cacheReadTokens as number) ?? 0) +
        ((v.cacheCreationTokens as number) ?? 0)
      const budget = v.contextBudget as number
      const fmt = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
      return `${fmt(used)} / ${fmt(budget)}`
    }
    if (typeof v.usedPct === 'number') {
      return `${Math.round(v.usedPct as number)}%`
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

interface LiveChipProps {
  actionId: string
  label: string
  icon: string | null
  params: Record<string, unknown>
  workspaceId: string
  kind: ActionKind
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
  kind
}: LiveChipProps): React.JSX.Element {
  const [value, setValue] = useState<unknown>(null)
  const disposeRef = useRef<(() => void) | null>(null)

  const isStatus = actionId === 'workspace.getActivityStatus'

  useEffect(() => {
    if (!workspaceId) return

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
          if (result.ok) setValue(result.value ?? null)
        })
        .catch(() => {
          /* silently skip on error */
        })

      const handle = window.api.actions.subscribe(actionId, params, workspaceId, (v) => {
        setValue(v)
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
          if (!cancelled && result.ok) setValue(result.value ?? null)
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
  }, [actionId, workspaceId, kind, params])

  const displayText = formatValue(actionId, value)
  const dotColor = isStatus ? getStatusDotColor(value) : null

  return (
    <div
      className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-text-muted select-none"
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
