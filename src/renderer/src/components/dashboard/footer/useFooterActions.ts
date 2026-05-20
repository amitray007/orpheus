import { useCallback, useEffect, useState } from 'react'
import type { ActionKind, FooterActionDescriptor } from '@shared/types'

export type FooterActionItem = FooterActionDescriptor & {
  kind: ActionKind
}

interface UseFooterActionsResult {
  items: FooterActionItem[]
  loading: boolean
  error: string | null
  refetch: () => void
}

/**
 * Fetches merged footer actions for a workspace and enriches each descriptor
 * with the registry `kind` (mutator | query | subscription).
 */
export function useFooterActions(workspaceId: string): UseFooterActionsResult {
  const [items, setItems] = useState<FooterActionItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  const refetch = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: clear UI state to "loading" before async fetch.
    setLoading(true)
    setError(null)

    Promise.all([window.api.footerActions.listMerged(workspaceId), window.api.actions.list()])
      .then(([descriptors, registry]) => {
        if (cancelled) return
        const kindMap = new Map(registry.map((r) => [r.id, r.kind]))
        const enriched: FooterActionItem[] = descriptors.map((d) => ({
          ...d,
          kind: kindMap.get(d.actionId) ?? 'mutator'
        }))
        setItems(enriched)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(String(err))
        setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [workspaceId, tick])

  return { items, loading, error, refetch }
}
