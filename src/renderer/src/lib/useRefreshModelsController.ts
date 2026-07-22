import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefreshButtonState } from '@shared/types'
import { refetchSelectableModels } from './useSelectableModels'
import { reduceRefreshButtonState } from './refreshModelsButtonLogic'

const UPDATED_HOLD_MS = 2000

// ---------------------------------------------------------------------------
// useRefreshModelsController — the MAIN-WINDOW half of the pinned "Refresh
// models" button (model-routing unit 12). Owns everything
// RefreshModelsButton.tsx (the overlay-rendered, PURE render component — see
// that file's own header comment for the crash this hook's existence fixes)
// used to own directly before it turned out to be running in the wrong
// process: the reduceRefreshButtonState state machine's imperative half, the
// two real calls a refresh performs, and the live step-progress
// subscription.
//
// Used by BOTH main-window call sites — DropdownChip.tsx's footer flyout and
// components/dashboard/NewWorkspaceMenu.tsx's creation menu — rather than
// duplicating this sequence twice; each just reads `refreshState`/`onRefresh`
// out of this hook and threads them into the overlay props/patch it already
// pushes down (groups, routingProxyEnabled, ...), and wires its `onRefresh`
// event handler (from onChipGroupedDropdownEvent-style plumbing) to call
// this hook's `onRefresh`.
//
// WHAT A REFRESH DOES (in this exact order, same as before this file
// existed):
//   1. await window.api.routingProxy.refreshAuthFiles() — force re-pulls the
//      model catalog AND re-checks provider health server-side (internally
//      calls refreshCliProxyModelCache), then broadcasts the routing-proxy
//      snapshot. Never lets a throw here break the state machine —
//      refreshAuthFilesNow() itself no-ops cleanly if the proxy isn't
//      running; any OTHER failure is caught and logged, and this still
//      proceeds to refetch + 'updated' regardless.
//   2. refetchSelectableModels(currentModelId) — the shared store's own
//      imperative refetch (selectableModelsStore.ts), immediate so THIS
//      (main) window's picker updates without waiting on the push from
//      step 1. This is the window whose store the flyout actually renders
//      from (see RefreshModelsButton.tsx's own doc comment on why this
//      MUST run here, not in the overlay window).
//
// STEP PROGRESS: subscribed to routingProxy:refreshProgress ONLY while
// `refreshState.kind === 'refreshing'` — manager.ts's refreshAuthFilesNow is
// the ONLY broadcaster on that channel; the automatic 30s background tick
// calls the same underlying refresh with no progress callback and never
// broadcasts, so it can't leak a count in here while nothing THIS hook
// started is in flight.
//
// DOUBLE-CLICK / UNMOUNT: onRefresh applies reduceRefreshButtonState's
// 'click' transition itself and bails if the result is reference-identical
// to the current state (already refreshing/updated) — the authoritative
// guard; RefreshModelsButton.tsx's own display-layer check is
// belt-and-suspenders only. `mountedRef` guards every setState after the
// async work settles (the popover can close mid-refresh) so no "set state on
// an unmounted component" warning/leak is possible; the "Updated" hold timer
// is cleared on unmount for the same reason, and the progress subscription
// is scoped to `refreshState.kind === 'refreshing'` so it un-subscribes the
// instant that's no longer true, including on unmount.
// ---------------------------------------------------------------------------

export interface UseRefreshModelsControllerResult {
  refreshState: RefreshButtonState
  onRefresh: () => void
}

/**
 * @param currentModelId the picker's currentModelId (see
 *   selectableModelsStore.ts's cacheKey) — threaded into refetchSelectableModels
 *   so the SAME cache entry this picker reads from gets refreshed. Undefined
 *   for a picker with no "current model" concept (the creation menu).
 */
export function useRefreshModelsController(
  currentModelId?: string
): UseRefreshModelsControllerResult {
  const [refreshState, setRefreshState] = useState<RefreshButtonState>({ kind: 'idle' })
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  useEffect(
    () => () => {
      mountedRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    []
  )

  useEffect(() => {
    if (refreshState.kind !== 'refreshing') return
    return window.api.routingProxy.onRefreshProgress(({ done, total }) => {
      setRefreshState((prev) => reduceRefreshButtonState(prev, { type: 'progress', done, total }))
    })
  }, [refreshState.kind])

  const onRefresh = useCallback((): void => {
    const next = reduceRefreshButtonState(refreshState, { type: 'click' })
    if (next === refreshState) return // already refreshing/updated
    setRefreshState(next)
    void (async () => {
      try {
        await window.api.routingProxy.refreshAuthFiles()
      } catch (err) {
        // Best-effort — see this file's header comment. Still proceed to
        // refetch + 'updated' below regardless.
        console.error('[useRefreshModelsController] refreshAuthFiles failed', err)
      }
      refetchSelectableModels(currentModelId)
      if (!mountedRef.current) return
      setRefreshState((prev) => reduceRefreshButtonState(prev, { type: 'settled' }))
      timerRef.current = setTimeout(() => {
        if (!mountedRef.current) return
        setRefreshState((prev) => reduceRefreshButtonState(prev, { type: 'timeout' }))
      }, UPDATED_HOLD_MS)
    })()
  }, [refreshState, currentModelId])

  return { refreshState, onRefresh }
}
