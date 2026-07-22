import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { ArrowClockwise, Check } from '@phosphor-icons/react'
import { refetchSelectableModels } from '@/lib/useSelectableModels'
import { reduceRefreshButtonState, type RefreshButtonState } from '@/lib/refreshModelsButtonLogic'

const UPDATED_HOLD_MS = 2000

// ---------------------------------------------------------------------------
// RefreshModelsButton — the pinned "Refresh models" control in the model-
// provider flyout's provider-list panel (model-routing unit 12, user-
// approved ASCII). Force re-pulls the routed model catalog + provider health
// from CLIProxyAPI and refetches the shared selectable-model list, so the
// picker reflects a background change (a provider connection recovering, a
// new model appearing) without the user closing and reopening the flyout.
//
// ONE shared component, imported by BOTH provider flyouts
// (overlay/kinds/ChipGroupedDropdown.tsx — the footer Model chip's flyout —
// and overlay/kinds/NewWorkspaceMenu.tsx — the "+ new workspace" creation
// menu's provider list) rather than a third near-duplicate copy of this
// logic; those two files are already close enough in shape that check:dup
// flags them, so this state machine + the two IPC/store calls it drives live
// in exactly one place.
//
// WHAT A CLICK DOES (in this exact order):
//   1. await window.api.routingProxy.refreshAuthFiles() — force re-pulls the
//      model catalog AND re-checks provider health server-side (internally
//      calls refreshCliProxyModelCache — this is the catalog+health re-pull,
//      not just an auth-file check), then broadcasts the routing-proxy
//      snapshot. Never lets a throw here break the button's own state
//      machine — refreshAuthFilesNow() itself no-ops cleanly if the proxy
//      isn't running (see manager.ts's own doc comment); any OTHER failure
//      (e.g. a network hiccup talking to the local proxy) is caught and
//      logged, and the button still proceeds to refetch + show "Updated" —
//      per spec, a failed background refresh is not this button's problem
//      to surface, only to attempt.
//   2. refetchSelectableModels(currentModelId) — the shared store's own
//      imperative refetch (selectableModelsStore.ts), immediate so THIS
//      window's picker updates without waiting on the push from step 1.
//
// EFFORT COVERAGE: effort ladders derive from the SAME selectable-model list
// (SelectableModel.effortLevels -> resolveEffortLevelsForScope in
// effortPickerOptions.ts) that refetchSelectableModels refreshes — so
// refreshing the model store refreshes the effort options automatically,
// with no separate per-chip effort refetch needed from here.
//
// DOUBLE-CLICK / UNMOUNT: reduceRefreshButtonState's own 'click' branch is a
// no-op once state is 'refreshing' or 'updated' (see that module's doc
// comment) — belt-and-suspenders with the DOM `disabled` attribute below,
// which covers the 'refreshing' case; state genuinely can't stack a second
// refresh from either angle. `mountedRef` guards every setState after the
// async work settles (the flyout can close mid-refresh) so no "set state on
// an unmounted component" warning/leak is possible; the "Updated" hold timer
// is cleared on unmount for the same reason.
// ---------------------------------------------------------------------------

export interface RefreshModelsButtonProps {
  /** The currentModelId this picker is scoped to — threaded straight into
   *  refetchSelectableModels so the SAME cache key this picker reads from
   *  (see selectableModelsStore.ts's cacheKey) gets refreshed. Undefined for
   *  a picker with no "current model" concept (the creation menu). */
  currentModelId?: string
  /** Extra class names merged onto the button — callers control layout
   *  (a full-width pinned row vs. a compact icon-button fallback). */
  className?: string
}

export function RefreshModelsButton({
  currentModelId,
  className
}: RefreshModelsButtonProps): React.JSX.Element {
  const [state, setState] = useState<RefreshButtonState>('idle')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  useEffect(
    () => () => {
      mountedRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    []
  )

  const handleClick = useCallback(
    (e: React.MouseEvent): void => {
      // Never select a provider/model, never trigger the flyout's own
      // outside-click/hover-dismissal — this button lives INSIDE the same
      // popover those mechanisms guard against dismissing.
      e.stopPropagation()
      if (reduceRefreshButtonState(state, 'click') === state) return // already refreshing/updated
      setState('refreshing')
      void (async () => {
        try {
          await window.api.routingProxy.refreshAuthFiles()
        } catch (err) {
          // Best-effort — see this file's header comment. Still proceed to
          // refetch + "Updated" below regardless.
          console.error('[RefreshModelsButton] refreshAuthFiles failed', err)
        }
        refetchSelectableModels(currentModelId)
        if (!mountedRef.current) return
        setState((prev) => reduceRefreshButtonState(prev, 'settled'))
        timerRef.current = setTimeout(() => {
          if (!mountedRef.current) return
          setState((prev) => reduceRefreshButtonState(prev, 'timeout'))
        }, UPDATED_HOLD_MS)
      })()
    },
    [state, currentModelId]
  )

  const label =
    state === 'idle' ? 'Refresh models' : state === 'refreshing' ? 'Refreshing…' : 'Updated'

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={state === 'refreshing'}
      className={[
        'w-full flex items-center gap-1.5 px-1.5 py-1.5 rounded-md text-xs text-left transition-colors duration-100',
        'text-text-muted hover:bg-surface-raised hover:text-text-secondary cursor-pointer',
        'disabled:cursor-not-allowed disabled:opacity-70',
        className ?? ''
      ].join(' ')}
    >
      {state === 'updated' ? (
        <Check size={12} weight="bold" className="flex-shrink-0 text-accent" />
      ) : (
        <ArrowClockwise
          size={12}
          weight="bold"
          className={['flex-shrink-0', state === 'refreshing' ? 'animate-spin' : ''].join(' ')}
        />
      )}
      {label}
    </button>
  )
}
