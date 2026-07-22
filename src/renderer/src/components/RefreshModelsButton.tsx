import { useCallback } from 'react'
import type React from 'react'
import { ArrowClockwise, Check } from '@phosphor-icons/react'
import { reduceRefreshButtonState, type RefreshButtonState } from '@/lib/refreshModelsButtonLogic'

// ---------------------------------------------------------------------------
// RefreshModelsButton — the pinned "Refresh models" control in the model-
// provider flyout's provider-list panel (model-routing unit 12, user-
// approved ASCII). PURE RENDER COMPONENT — props down, `onRefresh` up, ZERO
// window.api/IPC/store access of its own.
//
// WHY THIS IS PURE (the crash this fixes): this component renders INSIDE
// overlay/kinds/ChipGroupedDropdown.tsx and overlay/kinds/NewWorkspaceMenu.tsx
// — both of which render in the overlay's own, SEPARATE BrowserWindow (see
// overlayLayer.ts main-side / OverlayRoot.tsx renderer-side). That window's
// preload is src/preload/overlay.ts, which exposes ONLY `window.overlayApi`
// (onShow/onUpdate/sendEvent/ackPainted/reportSize) — there is NO
// `window.api` there at all. An earlier version of this component called
// window.api.routingProxy.refreshAuthFiles()/onRefreshProgress() and
// refetchSelectableModels() (which itself calls window.api.models.*)
// directly from here — every one of those calls threw
// "Cannot read properties of undefined (reading 'routingProxy')" the moment
// a real user clicked it, caught by the overlay's own OverlayErrorBoundary
// and surfaced as the "Something went wrong" crash card. TypeScript/lint/the
// offline verify-*.ts harnesses could not catch this: `window.api` is
// declared on the global `Window` type (see preload/index.d.ts), so every
// call type-checked cleanly: the failure is a RUNTIME window-boundary fact
// no static check in this repo's gate set observes.
//
// There's also a correctness reason beyond the crash, not just a process
// boundary one: even if window.api DID exist in the overlay window, calling
// refetchSelectableModels() there would refresh the OVERLAY window's OWN
// independent selectableModelsStore.ts module instance — but this flyout
// renders from the MAIN window's store (pushed in as the `groups` prop via
// updateChipGroupedDropdown/updateNewWorkspaceMenu, see those files' own
// "keep the open flyout in sync" effects). The refresh has to be driven from
// the MAIN window's store to have any visible effect on what's on screen —
// this component was structurally in the wrong process to ever work, crash
// or no crash.
//
// THE FIX: every window.api call + the reduceRefreshButtonState state
// machine's IMPERATIVE half (the click handler, the progress subscription,
// the "Updated" hold timer) now live in useRefreshModelsController.ts, a
// hook used ONLY by the two MAIN-window call sites
// (DropdownChip.tsx / components/dashboard/NewWorkspaceMenu.tsx — the
// "smart halves" that already own every other window.api.* call for their
// respective popovers, per WorkspaceSettingsCard.tsx's/that file's own
// documented "props down, events up" contract). This component just renders
// whatever `state` it's handed and calls `onRefresh()` on click — `onRefresh`
// is wired by each overlay kind to `emit('refresh')` (the SAME event-up
// mechanism every other action in these popovers already uses), which the
// main-window call site turns into the real refresh via the controller hook,
// then pushes the resulting `refreshState` back down as a prop — exactly
// mirroring how `groups`/`routingProxyEnabled` already flow.
//
// ONE shared component, imported by BOTH provider flyouts
// (overlay/kinds/ChipGroupedDropdown.tsx and
// overlay/kinds/NewWorkspaceMenu.tsx) rather than a third near-duplicate
// copy — those two files are already close enough in shape that check:dup
// flags them.
//
// Exact copy (per the approved ASCII + the "1/4" step-progress follow-up):
//   idle       -> "Refresh models" (refresh icon)
//   refreshing -> "Refreshing…"    (spinner, button disabled), with a "d/t"
//                 step count appended at the END once known — hidden (no
//                 count at all) until state.progress is non-null
//   updated    -> "Updated"        (check icon)
// ---------------------------------------------------------------------------

export interface RefreshModelsButtonProps {
  /** Current display state — computed and owned by the MAIN-window call
   *  site's useRefreshModelsController.ts, pushed down as a plain prop. */
  state: RefreshButtonState
  /** Called on click (after stopPropagation) — the call site turns this into
   *  emit('refresh'), routed back to the main window's controller hook. This
   *  component never decides what a refresh DOES, only when the user asked
   *  for one. */
  onRefresh: () => void
  /** Extra class names merged onto the button — callers control layout
   *  (a full-width pinned row vs. a compact icon-button fallback). */
  className?: string
}

export function RefreshModelsButton({
  state,
  onRefresh,
  className
}: RefreshModelsButtonProps): React.JSX.Element {
  const handleClick = useCallback(
    (e: React.MouseEvent): void => {
      // Never select a provider/model, never trigger the flyout's own
      // outside-click/hover-dismissal — this button lives INSIDE the same
      // popover those mechanisms guard against dismissing.
      e.stopPropagation()
      // Display-layer guard mirroring reduceRefreshButtonState's own 'click'
      // no-op (already refreshing/updated) — belt-and-suspenders with the
      // DOM `disabled` attribute below (which only covers 'refreshing'; this
      // also covers 'updated'). NOT the authoritative guard: the controller
      // hook applies the SAME reducer to its own state before doing
      // anything, so an emit that slips through here anyway is still a
      // clean no-op there, never a stacked refresh.
      if (reduceRefreshButtonState(state, { type: 'click' }) === state) return
      onRefresh()
    },
    [state, onRefresh]
  )

  const label =
    state.kind === 'idle'
      ? 'Refresh models'
      : state.kind === 'refreshing'
        ? 'Refreshing…'
        : 'Updated'
  const progressText =
    state.kind === 'refreshing' && state.progress
      ? `${state.progress.done}/${state.progress.total}`
      : null

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={state.kind === 'refreshing'}
      className={[
        'w-full flex items-center gap-1.5 px-1.5 py-1.5 rounded-md text-xs text-left transition-colors duration-100',
        'text-text-muted hover:bg-surface-raised hover:text-text-secondary cursor-pointer',
        'disabled:cursor-not-allowed disabled:opacity-70',
        className ?? ''
      ].join(' ')}
    >
      {state.kind === 'updated' ? (
        <Check size={12} weight="bold" className="flex-shrink-0 text-accent" />
      ) : (
        <ArrowClockwise
          size={12}
          weight="bold"
          className={['flex-shrink-0', state.kind === 'refreshing' ? 'animate-spin' : ''].join(' ')}
        />
      )}
      <span className="flex-1 truncate">{label}</span>
      {/* Step count — right-aligned at the END of the row, hidden until the
          first step reports (progressText is null until then). Never a
          separate sub-label; it's an addition to "Refreshing…", not a
          replacement. */}
      {progressText && (
        <span className="flex-shrink-0 text-[10px] tabular-nums opacity-70">{progressText}</span>
      )}
    </button>
  )
}
