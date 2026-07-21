import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import {
  EFFORT_LADDER_ORDER,
  type ChipDropdownItem,
  type ClaudeEffort,
  type WorkspaceActivityDetail
} from '@shared/types'
import { IconByName } from './iconMap'
import {
  showChipDropdown,
  hideChipDropdown,
  chipDropdownId,
  showChipGroupedDropdown,
  hideChipGroupedDropdown,
  chipGroupedDropdownId,
  showChipTooltip,
  hideOverlayCard,
  chipTooltipId
} from '@/lib/overlayClient'
import { useOverlayHoverCard } from '@/lib/useOverlayHoverCard'
import { playSound } from '../../../lib/sound'
import { useSelectableModels } from '@/lib/useSelectableModels'
import { setWorkspaceModel } from '@/lib/workspaceModelStore'
import { buildModelDropdownItems, buildModelDropdownGroups } from '@/lib/modelPickerOptions'
import { ProviderIcon } from '@/components/ProviderIcon'
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

function capitalize(v: string): string {
  return v.charAt(0).toUpperCase() + v.slice(1)
}

function labelForEffort(value: string): string {
  const v = value || 'auto'
  return capitalize(v)
}

/**
 * Build the effort chip's option list from the CURRENT model's real
 * `effortLevels` (model-routing unit 11) — never the old hardcoded
 * ['auto','low','medium','high','xhigh','max'] offered unconditionally for
 * every model. Options are rendered in ladder order (EFFORT_LADDER_ORDER),
 * with 'none' first when the model reports it (an off-ladder mode, sorted
 * ahead of the ladder itself) and 'auto' always leading — 'auto' is a
 * CLI-level "reset to model default", never a wire value, so it's offered
 * regardless of what the provider's levels array contains (mirrors today's
 * behavior for Claude).
 */
function effortOptionsFor(effortLevels: string[]): { value: string; label: string }[] {
  const hasNone = effortLevels.includes('none')
  const onLadder = EFFORT_LADDER_ORDER.filter((level) => effortLevels.includes(level))
  const ordered = hasNone ? ['none', ...onLadder] : onLadder
  return [
    { value: 'auto', label: 'Auto' },
    ...ordered.map((v) => ({ value: v, label: capitalize(v) }))
  ]
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
  enabled = true,
  activityDetail,
  onRestart
}: DropdownChipProps): React.JSX.Element {
  const chipRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const openRef = useRef(false)

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
  // Case 1 — footer.modelSelect: local state = effective model value.
  // Also fetched for footer.effortSelect (below), which needs to know the
  // CURRENT model's real effortLevels to build its own options.
  // ---------------------------------------------------------------------
  const isModelSelect = item.actionId === 'footer.modelSelect'
  const isEffortSelect = item.actionId === 'footer.effortSelect'
  const [modelValue, setModelValue] = useState<string>('')
  const refetchEffectiveModel = useCallback((): void => {
    if (!isModelSelect && !isEffortSelect) return
    window.api.workspaces
      .getEffectiveModel(workspaceId)
      .then((r) => setModelValue(r.model))
      .catch(() => {})
  }, [workspaceId, isModelSelect, isEffortSelect])
  useEffect(() => {
    refetchEffectiveModel()
  }, [refetchEffectiveModel])

  // Data-driven model list (Claude always present; routed models gated on
  // proxy/provider health server-side) — see useSelectableModels' own doc
  // comment. `enabled` gates the fetch to the modelSelect AND effortSelect
  // chips (BUG B fix: DropdownChip also renders for footer.dropdown, which
  // never touches the model list — without this gate every chip instance
  // fired its own redundant models:listSelectable IPC call per workspace
  // mount). effortSelect needs this list too now (model-routing unit 11) to
  // read the current model's real effortLevels. The hook itself is still
  // called unconditionally on every render (Rules of Hooks); only its
  // internal subscription/IPC is skipped when disabled. Passing modelValue
  // keeps an already-selected-but-now-unavailable routed model represented
  // (never silently dropped from the dropdown, even though it can no longer
  // be freshly selected as "available").
  const needsModelList = isModelSelect || isEffortSelect
  const { models: selectableModels } = useSelectableModels(
    needsModelList ? modelValue : undefined,
    needsModelList
  )
  // isClaude lookup for the CURRENT effective model, used below to decide
  // whether a model switch is live-applicable (see onSelect's own comment).
  // A model not present in the list (e.g. transient fetch gap) is treated as
  // non-Claude — the conservative choice, since injecting `/model` into a
  // routed workspace's terminal would be meaningless/wrong.
  const currentModelIsClaude = useMemo(
    () => selectableModels.find((m) => m.id === modelValue)?.isClaude ?? modelValue === '',
    [selectableModels, modelValue]
  )
  // The current model's real effort levels (model-routing unit 11) — null
  // means "no reasoning-effort control at all" for this model, which is the
  // signal the effortSelect branch below uses to hide its chip entirely
  // rather than render a disabled control (a disabled control would imply
  // the capability exists).
  //
  // modelValue === '' is NOT "unknown model" — it's the genuine, durable
  // "no explicit override" state (composeClaudeLaunch skips --model entirely
  // when s.model is empty, so claude picks its own default), which is only
  // ever reachable for Claude (a routed workspace always has an explicit
  // model id — see modelRouting.ts). Falling through to null here would wrongly
  // hide the effort chip for every workspace that has never had its model
  // touched. Since claude's own unspecified default is always SOME Claude
  // model, and every Claude model's levels are a subset of the full ladder
  // (CLAUDE_BUILTIN_EFFORT_LEVELS), the full ladder is used as the safe,
  // non-fabricated fallback for this one specific case — it is never applied
  // to a routed (non-Claude) model, which always resolves to a real entry.
  const currentModelEffortLevels = useMemo(() => {
    if (modelValue === '') return [...EFFORT_LADDER_ORDER]
    return selectableModels.find((m) => m.id === modelValue)?.effortLevels ?? null
  }, [selectableModels, modelValue])

  // ---------------------------------------------------------------------
  // Case 2 — footer.effortSelect: local state = effective effort value
  // ('' from the IPC means unset/auto — normalized to 'auto' below).
  // ---------------------------------------------------------------------
  const [effortValue, setEffortValue] = useState<string>('')
  const refetchEffectiveEffort = useCallback((): void => {
    if (!isEffortSelect) return
    window.api.workspaces
      .getEffectiveEffort(workspaceId)
      .then((r) => setEffortValue(r.effort))
      .catch(() => {})
  }, [workspaceId, isEffortSelect])
  useEffect(() => {
    refetchEffectiveEffort()
  }, [refetchEffectiveEffort])

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
    faceProviderId = selectableModels.find((m) => m.id === modelValue)?.providerId
    chipTitle = `${item.label}: ${faceLabel}`
    onSelect = (value: string): void => {
      const newModelIsClaude = selectableModels.find((m) => m.id === value)?.isClaude ?? false
      setModelValue(value)
      // Keep the sidebar's provider-icon prefix (WorkspaceProviderIcon) in
      // sync immediately — same cache the row's fetch-on-mount populates, so
      // switching models here never leaves the sidebar icon stale until a
      // remount.
      setWorkspaceModel(workspaceId, value)
      // Persist first (also suppresses the dirty flag when the switch is
      // live-applicable — see setWorkspaceSettingAndSuppressDirty's own
      // isLiveApplicableModelChange gate) so a genuinely busy workspace
      // still saves the setting even if injection never lands. The
      // cross-model effort reconciliation (model-routing unit 11, work item
      // 4) happens main-process-side, inside this SAME workspace:setModel
      // call (see registerClaudeSettingsIpc's handler) — the single choke
      // point every model-persisting path shares, so it isn't re-derived
      // here. The response reflects the (possibly reconciled) stored effort;
      // sync local state from it so the effort chip's face label never shows
      // a stale value while waiting for its own next refetch.
      window.api.workspaces
        .setModel(workspaceId, value)
        .then((settings) => {
          if (settings.overrides.effort !== undefined) setEffortValue(settings.overrides.effort)
        })
        .catch(() => {})
      // `/model <value>` is a Claude CLI slash command — it is only
      // meaningful for a Claude -> Claude switch (same backend, same running
      // process, just a different --model argument). A switch involving a
      // routed model needs a NEW process with different
      // ANTHROPIC_BASE_URL/ANTHROPIC_MODEL/ANTHROPIC_AUTH_TOKEN env (see
      // src/main/modelRouting.ts computeRoutingEnv), which no in-terminal
      // slash command can apply — injecting it there would be silently
      // wrong (either a no-op inside the wrong backend's REPL, or Claude's
      // own CLI misinterpreting a routed model id as one of its own).
      // Persisting the setting above already marks the workspace dirty via
      // the same isLiveApplicableModelChange gate main-side, so the existing
      // "Restart to apply" chip (DetailsCard/WorkspaceDrawer, both driven by
      // the same onRestart/handleRestart) is what surfaces the change if we
      // don't auto-restart below.
      if (currentModelIsClaude && newModelIsClaude) {
        runInject(`/model ${value}`, true, 'Model set — applies next turn')
        return
      }
      // Any switch involving a routed model (Claude->routed, routed->Claude,
      // routed->routed) needs a brand-new process — no in-terminal command
      // can apply it. Auto-restart so the switch "just works" WITHOUT the
      // user hunting for the restart control, UNLESS the workspace is
      // currently mid-task ('working' == WorkspaceStatus 'in_progress' — see
      // activityStore.ts's status->detail mapping): destroying the surface
      // then would silently kill an in-flight agent turn, which is worse
      // than a visible manual step. In that case fall back to the existing
      // "Restart to apply" chip — the setting is already persisted+dirty, so
      // the user sees the prompt as soon as they're free to act on it.
      if (onRestart && activityDetail !== 'working') {
        playSound('success')
        showTooltip('Model set — restarting workspace…')
        onRestart()
      } else {
        playSound('success')
        showTooltip('Model set — restart workspace to apply')
      }
    }
  } else if (isEffortSelect) {
    // Options come from the CURRENT model's real effortLevels (model-routing
    // unit 11) — never a hardcoded list offered unconditionally. When
    // currentModelEffortLevels is null, this model has no reasoning-effort
    // control at all; the chip renders nothing at all (see the early-return
    // right before the JSX below) rather than an empty/disabled dropdown.
    dropdownItems = currentModelEffortLevels ? effortOptionsFor(currentModelEffortLevels) : []
    selectedValue = effortValue || 'auto'
    faceLabel = labelForEffort(effortValue)
    chipTitle = `${item.label}: ${faceLabel}`
    onSelect = (value: string): void => {
      setEffortValue(value)
      window.api.workspaces.setEffort(workspaceId, value as ClaudeEffort).catch(() => {})
      runInject(`/effort ${value}`, true, 'Effort set — applies next turn')
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
  const dropdownGroups = isModelSelect ? buildModelDropdownGroups(selectableModels) : []
  const dropdownOverlayId = isModelSelect
    ? chipGroupedDropdownId(`${item.actionId}:${item.id}:${workspaceId}`)
    : chipDropdownId(`${item.actionId}:${item.id}:${workspaceId}`)

  const handleOpenGroupedDropdown = useCallback(
    (rect: { x: number; y: number; w: number; h: number }): void => {
      showChipGroupedDropdown(
        dropdownOverlayId,
        rect,
        { groups: dropdownGroups, selectedValue, title: item.label },
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

  const handleClick = useCallback((): void => {
    if (!chipRef.current) return
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
  }, [dropdownOverlayId, workspaceId, item.label, isModelSelect, handleOpenGroupedDropdown])

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

  const isDisabled = enabled === false

  // Hide the effort control entirely for a model with no reasoning-effort
  // levels at all (model-routing unit 11, work item 3) — NEVER render it
  // disabled, since a disabled control implies the capability exists. This
  // runs after every hook above has already been called unconditionally
  // (Rules of Hooks), so it's safe as a plain early return here.
  if (isEffortSelect && currentModelEffortLevels === null) return <></>

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
