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

// ---------------------------------------------------------------------------
// Module-level caches — stale-while-revalidate per workspace.
// Survives workspace switches so returning to a recent workspace shows
// cached actions immediately (no loading flash) while a fresh fetch runs.
// ---------------------------------------------------------------------------

// Cache of enriched items per workspaceId.
const itemsCache = new Map<string, FooterActionItem[]>()

/**
 * Evicts the cached footer actions for a workspace that has been archived or
 * removed. Safe to call even if the workspace was never cached.
 */
export function clearFooterActionsCache(workspaceId: string): void {
  itemsCache.delete(workspaceId)
}

// Actions registry — runtime-immutable after first load; fetch once and reuse.
let registryPromise: Promise<Map<string, ActionKind>> | null = null

function setCachedItems(key: string, value: FooterActionItem[]): void {
  if (itemsCache.size >= 20) {
    const oldest = itemsCache.keys().next().value
    if (oldest !== undefined) itemsCache.delete(oldest)
  }
  itemsCache.set(key, value)
}

function getRegistry(): Promise<Map<string, ActionKind>> {
  if (!registryPromise) {
    registryPromise = window.api.actions
      .list()
      .then((registry) => new Map(registry.map((r) => [r.id, r.kind])))
      .catch(() => {
        // Allow retry on next call if the first attempt fails.
        registryPromise = null
        return new Map<string, ActionKind>()
      })
  }
  return registryPromise
}

/**
 * Fetches merged footer actions for a workspace and enriches each descriptor
 * with the registry `kind` (mutator | query | subscription).
 *
 * Stale-while-revalidate: if a cached value exists for the workspace, it is
 * returned immediately with loading=false, while a background fetch runs to
 * refresh the cache.  Invalidate via refetch() (e.g. after saving settings).
 */
export function useFooterActions(workspaceId: string): UseFooterActionsResult {
  const cached = workspaceId ? (itemsCache.get(workspaceId) ?? null) : null
  const [items, setItems] = useState<FooterActionItem[]>(cached ?? [])
  const [loading, setLoading] = useState(cached === null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  const refetch = useCallback(() => {
    // Evict cache for this workspace so the next fetch is authoritative.
    itemsCache.delete(workspaceId)
    setTick((t) => t + 1)
  }, [workspaceId])

  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false

    // Serve cached value immediately on workspaceId change so there's no
    // loading flash when switching back to a recent workspace (stale-while-revalidate).
    const stale = itemsCache.get(workspaceId)
    if (stale) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: seed items from cache on workspace switch; background fetch updates below
      setItems(stale)
      setLoading(false)
      setError(null)
      // Continue to fetch in background — updates arrive via setItems below.
    } else {
      setLoading(true)
      setError(null)
    }

    Promise.all([window.api.footerActions.listMerged(workspaceId), getRegistry()])
      .then(([descriptors, kindMap]) => {
        if (cancelled) return
        const enriched: FooterActionItem[] = descriptors.map((d) => ({
          ...d,
          kind: kindMap.get(d.actionId) ?? 'mutator'
        }))
        setCachedItems(workspaceId, enriched)
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
