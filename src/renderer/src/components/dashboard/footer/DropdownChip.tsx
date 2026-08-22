import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import type { ChipDropdownItem, ClaudeEffort, WorkspaceActivityDetail } from '@shared/types'
import type { HarnessId } from '@shared/harness/types'
import {
  capitalize,
  effortDropdownItemsFor,
  shouldRenderEffortChip
} from '@/lib/effortPickerOptions'
import { IconByName } from './iconMap'
import {
  showChipDropdown,
  hideChipDropdown,
  chipDropdownId,
  showChipGroupedDropdown,
  hideChipGroupedDropdown,
  updateChipGroupedDropdown,
  chipGroupedDropdownId,
  showChipTooltip,
  hideOverlayCard,
  chipTooltipId
} from '@/lib/overlayClient'
import { useOverlayHoverCard } from '@/lib/useOverlayHoverCard'
import { playSound } from '../../../lib/sound'
import { setWorkspaceModel } from '@/lib/workspaceModelStore'
import { setWorkspaceEffort } from '@/lib/workspaceEffortStore'
import { useModelEffortPickerState } from '@/lib/modelEffortPickerState'
import { decideModelSelectionEffect, decideEffortSelectionEffect } from '@/lib/modelEffortSelection'
import { buildModelDropdownItems, buildModelDropdownGroups } from '@/lib/modelPickerOptions'
import { ProviderIcon } from '@/components/ProviderIcon'
import { useHarnessForWorkspace } from '@/lib/harnessStore'
import type { FooterActionItem } from './useFooterActions'

// Diagonal-traversal close-delay for the model chip's provider -> model
// flyout submenu (ChipGroupedDropdown) — same 120/200ms timing
// NewWorkspaceMenu.tsx's own submenu uses (see that file's own doc comment
// for why: 120ms open matches every other hover-driven overlay in this app;
// 200ms close gives room to cross the row-to-submenu gap before it vanishes).
// Only the model chip opens a chipGroupedDropdown; effort/custom dropdowns
// stay on the flat, non-flyout ChipDropdown and never touch this timer.
const MODEL_SUBMENU_OPEN_DELAY_MS = 120
const MODEL_SUBMENU_CLOSE_DELAY_MS = 200

// Bounded retry policy for FIX B (bug 2): the overlay hide + focus-restore
// chain (runFocusRestoreChain in overlayLayer.ts) is still in flight when
// onSelect fires, so the FIRST inject attempt is deferred a macrotask, and a
// `busy` result is retried a few times (fixed 200ms apart, no tight loop)
// before giving up and surfacing a non-blocking notice instead of silently
// dropping the keystrokes.
const INJECT_RETRY_MAX_ATTEMPTS = 5
const INJECT_RETRY_DELAY_MS = 200

// ---------------------------------------------------------------------------
// DropdownChip — the footer's unified "opens a chipDropdown popover" chip.
// Generalizes the original ModelSelectChip pattern to cover THREE built-in
// dropdown-style actionIds:
//
//   - footer.modelSelect  — persists via workspace:setModel; a Claude->Claude
//     switch injects `/model` live, a switch involving a routed model
//     auto-restarts the workspace (unless it's mid-task — see onSelect)
//   - footer.effortSelect — persists via workspace:setEffort, injects `/effort`
//   - footer.dropdown     — fully custom, author-configured options
//     (item.params.options), no settings persistence, just injects the
//     configured text for whichever option was picked.
//
// All three share one overlay-wiring/render body (chipRef, open state,
// outside-pointerdown dismiss, the button JSX/classNames) — only the data
// source (`dropdownItems`/`selectedValue`/`faceLabel`/`onSelect`) differs,
// computed by a small dispatcher block keyed on `item.actionId`.
// ---------------------------------------------------------------------------

function labelForModel(value: string, models: { id: string; label: string }[]): string {
  if (!value) return 'Default'
  const known = models.find((o) => o.id === value)
  return known ? known.label : value
}

function labelForEffort(value: string): string {
  const v = value || 'auto'
  return capitalize(v)
}

/**
 * Sends terminal.sendInput and, if the workspace isn't injectable yet
 * (ActionResult.code === 'busy'), retries a bounded number of times via
 * setTimeout (no tight loop) rather than silently swallowing the result.
 * Module-scope (not a component-local useCallback) so the recursive
 * self-call isn't flagged by react-hooks/immutability — it takes its
 * workspaceId/onGiveUp inputs as plain arguments instead of closing over
 * component state.
 */
function injectWithRetry(
  workspaceId: string,
  text: string,
  submit: boolean,
  onGiveUp: (res: { code?: string; error?: string }) => void,
  attempt = 0
): void {
  window.api.actions
    .invoke({ id: 'terminal.sendInput', params: { text, submit }, workspaceId }, 'footer')
    .then((res) => {
      if (res.ok) return
      if (res.code === 'busy' && attempt < INJECT_RETRY_MAX_ATTEMPTS) {
        setTimeout(
          () => injectWithRetry(workspaceId, text, submit, onGiveUp, attempt + 1),
          INJECT_RETRY_DELAY_MS
        )
        return
      }
      // Exhausted retries (or a non-busy failure) — the setting is already
      // persisted (persist-first), so don't leave the user thinking nothing
      // happened; surface a notice instead of dropping the outcome silently.
      console.error('[DropdownChip] inject not sent', res)
      onGiveUp(res)
    })
    .catch((e) => {
      console.error('[DropdownChip] inject failed', e)
    })
}

interface DropdownChipProps {
  item: FooterActionItem
  workspaceId: string
  /** This workspace's harness id (WorkspaceRecord.harnessId), threaded down
   *  from WorkspaceView -> WorkspaceFooter so the model/effort chips can
   *  resolve THEIR workspace's real harness descriptor (curated.model/
   *  curated.effort's liveApply declarations) instead of assuming Claude.
   *  Absent falls back to Claude via useHarnessForWorkspace, same as main's
   *  resolveHarness(undefined). */
  harnessId?: HarnessId
  /** This workspace's project id (B4, support-multi-harness), threaded down
   *  from WorkspaceFooter (which already carries it for post-fork
   *  navigation) so the model/effort chips can resolve THIS project's
   *  curatedOptions overlay via useSelectableModels, instead of only ever
   *  seeing the global-scope option list. Absent resolves global scope
   *  only, same as models:listSelectable's own omitted-projectId
   *  contract. */
  projectId?: string
  enabled?: boolean
  /** Live activity detail — used ONLY by the model-select chip to decide
   *  whether an auto-restart is safe (see onSelect's routed-model branch
   *  below). 'working' means the workspace is mid-task; auto-restarting then
   *  would silently kill in-flight agent work, so that case falls back to
   *  the existing "Restart to apply" chip instead of restarting immediately. */
  activityDetail?: WorkspaceActivityDetail
  /** Restarts the workspace (destroy + remount) — threaded down from
   *  WorkspaceView's handleRestart, the SAME mechanism the "Restart to
   *  apply" dirty chip already uses. Used by the model-select chip to make a
   *  routed-model switch "just work" without the user hunting for a restart
   *  control, EXCEPT while the workspace is busy (see activityDetail above). */
  onRestart?: () => void
}

export function DropdownChip({
  item,
  workspaceId,
  harnessId,
  projectId,
  enabled = true,
  activityDetail,
  onRestart
}: DropdownChipProps): React.JSX.Element {
  const chipRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const openRef = useRef(false)
  // This workspace's resolved harness descriptor summary — never undefined
  // (falls back to Claude, see useHarnessForWorkspace's own doc comment).
  // Only the model/effort branches below read `.curated`; the
  // footer.dropdown branch (fully custom, author-configured options) never
  // touches it.
  const harness = useHarnessForWorkspace(harnessId)

  // Diagonal-traversal close-delay timer for the model chip's flyout submenu
  // — see this file's own MODEL_SUBMENU_*_DELAY_MS comment. Unused (never
  // armed/cleared) for footer.effortSelect/footer.dropdown, which never call
  // showChipGroupedDropdown at all.
  const submenuHoverCard = useOverlayHoverCard({
    openDelay: MODEL_SUBMENU_OPEN_DELAY_MS,
    closeDelay: MODEL_SUBMENU_CLOSE_DELAY_MS
  })

  // ---------------------------------------------------------------------
  // Notice tooltip — mirrors ActionChip's showTooltip useCallback exactly
  // (same chipTooltipId/showChipTooltip/hideOverlayCard pattern), used when
  // injectWithRetry gives up after exhausting its bounded retries so the
  // "busy" outcome is surfaced instead of silently dropped.
  // ---------------------------------------------------------------------
  const tooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tooltipOverlayId = useMemo(
    () => chipTooltipId(`${item.actionId}:${item.id}`),
    [item.actionId, item.id]
  )
  useEffect(() => {
    return () => {
      if (tooltipTimer.current) {
        clearTimeout(tooltipTimer.current)
        tooltipTimer.current = null
      }
      hideOverlayCard(tooltipOverlayId)
    }
  }, [tooltipOverlayId])

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

  // Deferred + bounded-retry inject, wired to this chip's showTooltip notice
  // for the give-up case. See the module-scope injectWithRetry doc comment
  // for the ordering/retry rationale.
  const runInject = useCallback(
    (text: string, submit: boolean, busyNotice: string): void => {
      // Defer the FIRST inject attempt to the next macrotask so the
      // overlay's hide + focus-restore chain (runFocusRestoreChain) runs
      // first and the terminal surface is focused/ready — the key ordering
      // fix for injection sometimes silently missing the terminal.
      setTimeout(() => {
        injectWithRetry(workspaceId, text, submit, () => {
          playSound('error')
          showTooltip(busyNotice)
        })
      }, 0)
    },
    [workspaceId, showTooltip]
  )

  // ---------------------------------------------------------------------
  // footer.modelSelect / footer.effortSelect: the shared read-side state
  // (effective model/effort values, the selectable model list, the current
  // model's real effort levels, the harness's own flat effort fallback) —
  // extracted to useModelEffortPickerState (support-multi-harness,
  // footer-removal migration Phase 1) so the title bar's own Model/Effort
  // chips (WorkspaceTitleBar.tsx) can assemble the IDENTICAL facts instead
  // of re-deriving this ~8-hook chain a second time. See that hook's own
  // doc comment for the full field-by-field rationale (unchanged from what
  // used to live inline here — this is a lift, not a rewrite).
  //
  // `enabled` gates the fetch/subscription to modelSelect/effortSelect only
  // (BUG B fix: DropdownChip also renders for footer.dropdown, which never
  // touches the model list — without this gate every chip instance fired
  // its own redundant models:listSelectable IPC call per workspace mount).
  // The hook itself is still called unconditionally on every render (Rules
  // of Hooks); only its internal subscription/IPC is skipped when disabled.
  const isModelSelect = item.actionId === 'footer.modelSelect'
  const isEffortSelect = item.actionId === 'footer.effortSelect'
  const needsModelList = isModelSelect || isEffortSelect
  const {
    modelValue,
    effortValue,
    selectableModels,
    currentModelIsClaude,
    currentModelEffortLevels,
    harnessEffortOptions,
    refetchAll: refetchPickerState
  } = useModelEffortPickerState(workspaceId, harness, harnessId, projectId, needsModelList)
  // Read via these refs (not the closed-over modelValue/effortValue) inside
  // handleClick below — that callback is memoized against a deliberately
  // narrow dep list (see its own eslint-disable comment) and would
  // otherwise stay pinned to whatever value was current the last time
  // handleClick itself got recreated, not the actual current one at click
  // time.
  const modelValueRef = useRef(modelValue)
  // eslint-disable-next-line react-hooks/refs -- intentional render-time ref mutation, same pattern as WorkspaceView.tsx's activeRef
  modelValueRef.current = modelValue
  const effortValueRef = useRef(effortValue)
  // eslint-disable-next-line react-hooks/refs -- intentional render-time ref mutation, same pattern as modelValueRef above
  effortValueRef.current = effortValue

  // PENDING (model-routing unit 11 bugfix): the effort chip's levels are the
  // "unknown yet" tri-state member — render the chip, but non-interactively,
  // rather than either hiding it (that's `null`'s job) or opening a
  // dropdown with fabricated options. Only meaningful for the effort chip
  // itself; false (never pending) for every other actionId.
  const isEffortPending = isEffortSelect && currentModelEffortLevels === undefined

  // ---------------------------------------------------------------------
  // Dispatcher: compute { dropdownItems, selectedValue, faceLabel, onSelect,
  // chipTitle } for whichever actionId this chip represents. Everything
  // after this block is shared/unconditional.
  // ---------------------------------------------------------------------
  let dropdownItems: ChipDropdownItem[] = []
  let selectedValue: string | undefined
  let faceLabel = item.label
  let faceProviderId: string | undefined
  let chipTitle = item.label
  let onSelect: (value: string) => void = () => {}

  if (item.actionId === 'footer.modelSelect') {
    // dropdownItems is unused for footer.modelSelect (it opens the grouped
    // flyout, buildModelDropdownGroups, below) — still computed for parity
    // with the other two branches so `dropdownItems` never needs a
    // conditional read at the call site; buildModelDropdownItems' O(models)
    // cost is negligible compared to the IPC round-trip already gating it.
    dropdownItems = buildModelDropdownItems(selectableModels)
    selectedValue = modelValue
    faceLabel = labelForModel(modelValue, selectableModels)
    // providerIconId when present, else providerId — a harness-sourced model
    // carries its HARNESS id ('codex-cli') as providerId, which ProviderIcon
    // does not know, so the chip face rendered no icon for Codex. See
    // SelectableModel.providerIconId.
    faceProviderId = (() => {
      const m = selectableModels.find((sm) => sm.id === modelValue)
      // providerIconId when present, else providerId — a harness-sourced
      // model carries its HARNESS id ('codex-cli') as providerId, which
      // ProviderIcon does not know.
      const fromModel = m?.providerIconId ?? m?.providerId
      if (fromModel) return fromModel
      // No model resolved — either none is stored (modelValue === '', the
      // chip face reads "Default") or the list hasn't loaded. Fall back to
      // the WORKSPACE'S HARNESS icon rather than letting the face drop to
      // the footer row's generic 'Robot': a model-less Codex workspace
      // should still look like Codex. `harness.icon` is the descriptor's
      // own icon id ('codex'), not its harness id.
      return harness.icon
    })()
    chipTitle = `${item.label}: ${faceLabel}`
    onSelect = (value: string): void => {
      const newModelIsClaude = selectableModels.find((m) => m.id === value)?.isClaude ?? false
      const previousModel = modelValue
      // Optimistic write into the SHARED per-workspace store (not local
      // state — see modelValue's own doc comment above) so BOTH this Model
      // chip AND the separate Effort chip instance (and the sidebar's
      // provider-icon prefix, WorkspaceProviderIcon) update immediately,
      // never leaving either stale until a remount.
      setWorkspaceModel(workspaceId, value)
      // Persist first (also suppresses the dirty flag when the switch is
      // live-applicable — see setWorkspaceSettingAndSuppressDirty's own
      // isLiveApplicableModelChange gate) so a genuinely busy workspace
      // still saves the setting even if injection never lands. The
      // cross-model effort reconciliation (model-routing unit 11, work item
      // 4) happens main-process-side, inside this SAME workspace:setModel
      // call (see registerClaudeSettingsIpc's handler) — the single choke
      // point every model-persisting path shares, so it isn't re-derived
      // here. The response reflects the (possibly reconciled) stored
      // effort; sync the SHARED effort store from it too — the main
      // process ALSO pushes workspace:effectiveSettingsChanged right after
      // this resolves (see registerClaudeSettingsIpc), so this optimistic
      // write is redundant-but-harmless with that push arriving a beat
      // later; it just removes the visible flicker while waiting for it.
      window.api.workspaces
        .setModel(workspaceId, value)
        .then((settings) => {
          if (settings.overrides.effort !== undefined) {
            setWorkspaceEffort(workspaceId, settings.overrides.effort)
          }
        })
        .catch((e) => {
          // Never swallow silently — a rejected model+effort write here
          // means the UI (modelValue/effortValue, already optimistically
          // updated above) has desynced from the DB, and the running
          // process is about to get an in-terminal `/model`/restart based
          // on a value that was never actually persisted. Revert the
          // optimistic store write so the chip goes back to showing the
          // value that's actually stored.
          console.error('[DropdownChip] setModel failed', e)
          setWorkspaceModel(workspaceId, previousModel)
          playSound('error')
          showTooltip('Model not saved — try again')
        })
      // The actual decision — inject vs. restart vs. dirty-chip-only — is
      // the extracted pure function decideModelSelectionEffect
      // (modelEffortSelection.ts, support-multi-harness footer-removal
      // migration Phase 1). See that function's own doc comment (a direct
      // port of this block's PRE-EXTRACTION logic) for the full "why" on
      // each branch — nothing here is a new decision, only the dispatch on
      // its result.
      const effect = decideModelSelectionEffect(
        currentModelIsClaude,
        newModelIsClaude,
        harness.curated?.model,
        value,
        !!onRestart,
        activityDetail
      )
      if (effect.kind === 'inject') {
        runInject(effect.text, effect.submit, 'Model set — applies next turn')
        return
      }
      if (effect.kind === 'restart') {
        playSound('success')
        showTooltip('Model set — restarting workspace…')
        onRestart?.()
      } else {
        playSound('success')
        showTooltip('Model set — restart workspace to apply')
      }
    }
  } else if (isEffortSelect) {
    // Options come from the CURRENT model's real effortLevels (model-routing
    // unit 11) — never a hardcoded list offered unconditionally. When
    // currentModelEffortLevels is null and the harness has no harness-level
    // curated.effort either, this workspace has no reasoning-effort control
    // at all; the chip renders nothing at all (see the early-return right
    // before the JSX below) rather than an empty/disabled dropdown. When
    // null but the harness DOES declare curated.effort (support-multi-
    // harness — a non-Claude harness's models never carry per-model levels,
    // see harnessEffortOptions' own doc comment above), fall back to the
    // harness's own flat list via harnessEffortOptionsFor, never through
    // the ladder-sorting effortOptionsFor (which would silently drop a
    // harness's custom effort values not spelled from Claude's ladder
    // vocabulary). While undefined (PENDING — levels not resolved yet, see
    // this tri-state's own doc comment above), dropdownItems is
    // deliberately left empty too: never fabricate a ladder as if it were
    // authoritative. The chip itself still renders (isEffortPending below,
    // computed from the SAME tri-state) with the persisted effortValue as
    // its face label — available from workspaceEffortStore independent of
    // the model list — just non-interactive until levels resolve.
    dropdownItems = effortDropdownItemsFor(currentModelEffortLevels, harnessEffortOptions)
    selectedValue = effortValue || 'auto'
    faceLabel = labelForEffort(effortValue)
    chipTitle = `${item.label}: ${faceLabel}`
    onSelect = (value: string): void => {
      const previousEffort = effortValue
      // Optimistic write into the SHARED per-workspace store (not local
      // state — see effortValue's own doc comment above).
      setWorkspaceEffort(workspaceId, value)
      window.api.workspaces
        .setEffort(workspaceId, value as ClaudeEffort)
        .then(() => {
          // Only decide the live-apply/restart effect AFTER the write is
          // confirmed persisted — a rejected write (e.g. an out-of-enum
          // value somehow reaching here) must never leave the running
          // process told about a value the DB doesn't actually have,
          // silently desyncing UI state from persisted state.
          //
          // decideEffortSelectionEffect (modelEffortSelection.ts,
          // support-multi-harness footer-removal migration Phase 1) is the
          // extracted pure decision — a direct port of this block's
          // pre-extraction logic. See that function's own doc comment: it
          // is a straight liveApply-kind dispatch (buildLiveApplyText
          // degrades safely on its own — no curated field -> 'none', a
          // harness that declares restartRequired -> 'restartRequired',
          // only a real `replInject` descriptor -> 'inject') plus the same
          // restart-unless-mid-task fallback the model chip uses.
          const effect = decideEffortSelectionEffect(
            harness.curated?.effort,
            value,
            !!onRestart,
            activityDetail
          )
          if (effect.kind === 'inject') {
            runInject(effect.text, effect.submit, 'Effort set — applies next turn')
            return
          }
          if (effect.kind === 'restart') {
            playSound('success')
            showTooltip('Effort set — restarting workspace…')
            onRestart?.()
          } else {
            playSound('success')
            showTooltip('Effort set — restart workspace to apply')
          }
        })
        .catch((e) => {
          // Revert the optimistic store write and surface the failure —
          // never swallow a rejected persistence write silently (a bare
          // `.catch(() => {})` here would show the user a new effort value
          // while the DB kept the old one, then emit the STALE value as
          // --effort on the next launch).
          console.error('[DropdownChip] setEffort failed', e)
          setWorkspaceEffort(workspaceId, previousEffort)
          playSound('error')
          showTooltip('Effort not saved — try again')
        })
    }
  } else if (item.actionId === 'footer.dropdown') {
    const options = Array.isArray(item.params.options)
      ? (item.params.options as Array<{ label: string; text: string; submit?: boolean }>)
      : []
    dropdownItems = options.map((o, i) => ({ value: i.toString(), label: o.label }))
    selectedValue = undefined
    faceLabel = item.label
    chipTitle = item.label
    onSelect = (value: string): void => {
      const idx = parseInt(value, 10)
      const option = options[idx]
      if (!option) return
      runInject(option.text, option.submit ?? true, 'Terminal busy — not sent')
    }
  }

  // The model chip opens the GROUPED (provider -> model flyout) popover;
  // every other DropdownChip caller (footer.effortSelect, footer.dropdown)
  // keeps opening the flat ChipDropdown, completely untouched by this
  // addition — see this file's own header comment and
  // ChipGroupedDropdown.tsx's for why this is a separate overlay kind rather
  // than a mode flag on the existing one.
  //
  // Memoized against `selectableModels` (itself reference-stable across
  // renders unless the store actually changed — see setEntry's own
  // reference-equality guard in selectableModelsStore.ts) rather than
  // recomputed as a plain `const` — the "keep the open flyout in sync"
  // effect below depends on this array's IDENTITY, and an unmemoized
  // recompute would give it a fresh reference (and thus fire that effect)
  // on every unrelated re-render of this component, not just an actual
  // model-list change.
  const dropdownGroups = useMemo(
    () => (isModelSelect ? buildModelDropdownGroups(selectableModels) : []),
    [isModelSelect, selectableModels]
  )
  const dropdownOverlayId = isModelSelect
    ? chipGroupedDropdownId(`${item.actionId}:${item.id}:${workspaceId}`)
    : chipDropdownId(`${item.actionId}:${item.id}:${workspaceId}`)

  const handleOpenGroupedDropdown = useCallback(
    (rect: { x: number; y: number; w: number; h: number }): void => {
      showChipGroupedDropdown(
        dropdownOverlayId,
        rect,
        {
          groups: dropdownGroups,
          selectedValue,
          title: item.label
        },
        {
          // Purely navigational — the kind already tracks activeProviderId
          // itself for rendering; this event exists only so the call site
          // COULD react (e.g. analytics), mirroring
          // NewWorkspaceMenuHandlers.onHoverProvider's contract. No
          // behavior needed here today.
          onHoverProvider: () => {},
          onEnterSubmenu: () => submenuHoverCard.clearTimer(),
          onLeaveSubmenu: () =>
            submenuHoverCard.armClose(() => {
              // Diagonal-traversal close timer expired with the pointer
              // outside both the provider list and the submenu — this
              // mirrors NewWorkspaceMenu's onLeaveSubmenu, but this popover
              // has no separate "close the submenu, stay open" state (there's
              // no top-line create-step to preserve here): letting the timer
              // run its course is a no-op unless the user has ALSO moved the
              // pointer off the whole card, in which case blur (below) or an
              // outside click already closes it. This handler exists mainly
              // to cancel the open-side of the SAME timer via clearTimer
              // above during genuine traversal.
            })
        },
        workspaceId
      )
        .then((res) => {
          openRef.current = false
          setOpen(false)
          if (!res) return
          onSelect(res.value)
        })
        .catch((e) => {
          openRef.current = false
          setOpen(false)
          console.error('[DropdownChip] grouped dropdown failed', e)
        })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dropdownGroups/selectedValue/onSelect/submenuHoverCard are recomputed/recreated fresh every render from item/workspaceId/local state; including them would churn the callback identity without changing behavior.
    [dropdownOverlayId, workspaceId, item.label]
  )

  // Keep the OPEN model flyout's `groups` in sync with this component's own
  // live state (model-routing unit 12) — mirrors components/dashboard/
  // NewWorkspaceMenu.tsx's identical "keep the open popover's props in
  // sync" effect. Without this, showChipGroupedDropdown's props (above) are
  // a ONE-TIME snapshot taken at open() time — a background provider-health
  // change would update this component's state on its next render but
  // never reach the already-open overlay. Gated on `open && isModelSelect`
  // so it's a no-op for the effort/custom-dropdown chip instances (which
  // never open a chipGroupedDropdown at all) and while the popover is
  // closed.
  useEffect(() => {
    if (!open || !isModelSelect) return
    updateChipGroupedDropdown(dropdownOverlayId, { groups: dropdownGroups })
  }, [open, isModelSelect, dropdownOverlayId, dropdownGroups])

  const handleClick = useCallback((): void => {
    if (!chipRef.current) return
    // PENDING: levels not resolved yet — never open a dropdown built from
    // fabricated/empty options (see isEffortPending's own doc comment).
    if (isEffortPending) return
    if (openRef.current) {
      // Currently open → close. Flip the ref synchronously so an immediate
      // follow-up click is treated as "closed" (will open), not another close.
      openRef.current = false
      setOpen(false)
      if (isModelSelect) hideChipGroupedDropdown(dropdownOverlayId)
      else hideChipDropdown(dropdownOverlayId)
      return
    }
    openRef.current = true
    setOpen(true)
    // Defense-in-depth for the cold-boot/background-refresh picker-staleness
    // bug: opening the picker is exactly when fresh data matters most.
    // refetchPickerState (useModelEffortPickerState's returned refetchAll)
    // refetches the selectable-model list (via the store's own imperative
    // refetch — same coalescing fetchKey already uses, not a parallel fetch
    // path) plus the effective model/effort in one call, so the picker
    // self-heals here even if a routingProxy:onSnapshot/workspace:
    // effectiveSettingsChanged push was ever missed. Internally reads
    // modelValueRef.current/effortValueRef.current (not the closed-over
    // modelValue/effortValue) for the same staleness reason handleClick's
    // own memoization would otherwise hit — see modelValueRef's own doc
    // comment.
    refetchPickerState()
    const r = chipRef.current.getBoundingClientRect()
    const rect = { x: r.left, y: r.top, w: r.width, h: r.height }

    // Blur the chip button so its native `title` tooltip (chipTitle, e.g.
    // "Model: Opus 4.8") is dismissed the instant the popover opens — a
    // native title tooltip is tracked by Chromium off this MAIN window's own
    // hover/focus state, which the overlay popover (a separate BrowserWindow
    // painted on top) does not revoke by opening; left focused, the stale
    // tooltip can still be visible underneath the popover for a beat. Both
    // dropdown paths (flat ChipDropdown and the grouped flyout) share this
    // one blur call so neither is more prone to the stray-tooltip artifact
    // than the other.
    if (
      document.activeElement instanceof HTMLElement &&
      chipRef.current.contains(document.activeElement)
    ) {
      document.activeElement.blur()
    }

    if (isModelSelect) {
      handleOpenGroupedDropdown(rect)
      return
    }

    showChipDropdown(
      dropdownOverlayId,
      rect,
      { items: dropdownItems, selectedValue, title: item.label },
      workspaceId
    )
      .then((res) => {
        // Settle path (select / cancel / outside-click / esc / hide). Always
        // reconcile both the ref and the state to closed.
        openRef.current = false
        setOpen(false)
        if (!res) return // Cancel/Escape/outside-click/IPC failure
        onSelect(res.value)
      })
      .catch((e) => {
        openRef.current = false
        setOpen(false)
        console.error('[DropdownChip] dropdown failed', e)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dropdownItems/selectedValue/onSelect are recomputed fresh every render from item/workspaceId/local state; including them would churn the callback identity without changing behavior. `open` is intentionally NOT a dep — the open/close decision now uses openRef (synchronous), not the lagging open state.
  }, [
    dropdownOverlayId,
    workspaceId,
    item.label,
    isModelSelect,
    handleOpenGroupedDropdown,
    isEffortPending
  ])

  // Outside-click dismissal while the dropdown is open — mirrors ActionChip's
  // prompt-popover pattern: the popover lives in a separate child
  // BrowserWindow, so only clicks in the main window/terminal reach here.
  //
  // IMPORTANT: ignore pointerdown events that originate INSIDE the chip's own
  // button (chipRef). Without this guard, re-clicking an OPEN chip fires
  // TWO handlers in sequence: (a) this document-level pointerdown listener
  // fires first (capturing phase happens before the button's own `click`),
  // closing the overlay and setOpen(false); then (b) the button's onClick
  // (handleClick) runs, sees `open` already false, and RE-OPENS it — so a
  // re-click never actually closes the dropdown. By bailing out when the
  // event target is inside chipRef, we let handleClick alone own the
  // open/close toggle for clicks on the chip itself; (b) outside clicks
  // (target NOT inside chipRef) still reach hideChipDropdown and dismiss the
  // overlay as before; (c) clicks on dropdown ROWS never reach this handler
  // at all — the item list lives in a separate overlay/child BrowserWindow,
  // so row clicks don't bubble into this window's document listener.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent): void => {
      if (chipRef.current && e.target instanceof Node && chipRef.current.contains(e.target)) {
        return
      }
      openRef.current = false // sync flip so a subsequent chip click opens cleanly
      if (isModelSelect) hideChipGroupedDropdown(dropdownOverlayId)
      else hideChipDropdown(dropdownOverlayId)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open, dropdownOverlayId, isModelSelect])

  // isEffortPending shares the SAME muted visual treatment as isDisabled
  // (enabled === false) — a different underlying concept (levels not
  // resolved yet, vs. this chip being contextually inapplicable right now),
  // but the same "not currently interactive" affordance, so it's folded
  // into the same className branch rather than adding a third visual state.
  const isDisabled = enabled === false || isEffortPending

  // Hide the effort control entirely for a model with no reasoning-effort
  // levels at all (model-routing unit 11, work item 3) — NEVER render it
  // disabled, since a disabled control implies the capability exists. This
  // runs after every hook above has already been called unconditionally
  // (Rules of Hooks), so it's safe as a plain early return here.
  // shouldRenderEffortChip is the same pure selector scripts/verify-effort-
  // levels.ts asserts directly (see effortPickerOptions.ts) — it treats the
  // PENDING (undefined) tri-state member as "render", so this early return
  // does NOT fire while pending; isEffortPending above is what keeps a
  // pending chip non-interactive instead. `!!harnessEffortOptions` is the
  // harness-level fallback signal (support-multi-harness) — a harness
  // declaring curated.effort keeps the chip visible even when the CURRENT
  // model's own per-model levels are null (see this function's own doc
  // comment on the null branch).
  if (isEffortSelect && !shouldRenderEffortChip(currentModelEffortLevels, !!harnessEffortOptions))
    return <></>

  return (
    <div ref={chipRef} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={handleClick}
        title={chipTitle}
        aria-label={chipTitle}
        className={[
          'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs',
          'transition-colors duration-150',
          'border border-transparent',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
          isDisabled
            ? 'text-text-muted bg-surface-overlay/40'
            : open
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
          {faceProviderId ? (
            <ProviderIcon providerId={faceProviderId} size={12} />
          ) : item.icon ? (
            <IconByName name={item.icon} size={12} />
          ) : null}
        </span>
        <span className="truncate max-w-[100px]">{faceLabel}</span>
        <IconByName name="CaretUp" size={9} className="flex-shrink-0 opacity-60" />
      </button>
    </div>
  )
}
