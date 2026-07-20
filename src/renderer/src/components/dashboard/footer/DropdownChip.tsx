import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import type { ChipDropdownItem, ClaudeEffort } from '@shared/types'
import { IconByName } from './iconMap'
import {
  showChipDropdown,
  hideChipDropdown,
  chipDropdownId,
  showChipTooltip,
  hideOverlayCard,
  chipTooltipId
} from '@/lib/overlayClient'
import { playSound } from '../../../lib/sound'
import { useSelectableModels } from '@/lib/useSelectableModels'
import { buildModelDropdownItems } from '@/lib/modelPickerOptions'
import type { FooterActionItem } from './useFooterActions'

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
//   - footer.modelSelect  — persists via workspace:setModel, injects `/model`
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

const EFFORT_VALUES = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const

function capitalize(v: string): string {
  return v.charAt(0).toUpperCase() + v.slice(1)
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
  enabled?: boolean
}

export function DropdownChip({
  item,
  workspaceId,
  enabled = true
}: DropdownChipProps): React.JSX.Element {
  const chipRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const openRef = useRef(false)

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
  // ---------------------------------------------------------------------
  const [modelValue, setModelValue] = useState<string>('')
  const refetchEffectiveModel = useCallback((): void => {
    if (item.actionId !== 'footer.modelSelect') return
    window.api.workspaces
      .getEffectiveModel(workspaceId)
      .then((r) => setModelValue(r.model))
      .catch(() => {})
  }, [workspaceId, item.actionId])
  useEffect(() => {
    refetchEffectiveModel()
  }, [refetchEffectiveModel])

  // Data-driven model list (Claude always present; routed models gated on
  // proxy/provider health server-side) — see useSelectableModels' own doc
  // comment. Only fetched for the modelSelect chip; passing modelValue keeps
  // an already-selected-but-now-unavailable routed model represented (never
  // silently dropped from the dropdown, even though it can no longer be
  // freshly selected as "available").
  const { models: selectableModels } = useSelectableModels(
    item.actionId === 'footer.modelSelect' ? modelValue : undefined
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

  // ---------------------------------------------------------------------
  // Case 2 — footer.effortSelect: local state = effective effort value
  // ('' from the IPC means unset/auto — normalized to 'auto' below).
  // ---------------------------------------------------------------------
  const [effortValue, setEffortValue] = useState<string>('')
  const refetchEffectiveEffort = useCallback((): void => {
    if (item.actionId !== 'footer.effortSelect') return
    window.api.workspaces
      .getEffectiveEffort(workspaceId)
      .then((r) => setEffortValue(r.effort))
      .catch(() => {})
  }, [workspaceId, item.actionId])
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
  let chipTitle = item.label
  let onSelect: (value: string) => void = () => {}

  if (item.actionId === 'footer.modelSelect') {
    dropdownItems = buildModelDropdownItems(selectableModels)
    selectedValue = modelValue
    faceLabel = labelForModel(modelValue, selectableModels)
    chipTitle = `${item.label}: ${faceLabel}`
    onSelect = (value: string): void => {
      const newModelIsClaude = selectableModels.find((m) => m.id === value)?.isClaude ?? false
      setModelValue(value)
      // Persist first (also suppresses the dirty flag when the switch is
      // live-applicable — see setWorkspaceSettingAndSuppressDirty's own
      // isLiveApplicableModelChange gate) so a genuinely busy workspace
      // still saves the setting even if injection never lands.
      window.api.workspaces.setModel(workspaceId, value).catch(() => {})
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
      // "Restart to apply" chip is what surfaces the change instead.
      if (currentModelIsClaude && newModelIsClaude) {
        runInject(`/model ${value}`, true, 'Model set — applies next turn')
      } else {
        playSound('success')
        showTooltip('Model set — restart workspace to apply')
      }
    }
  } else if (item.actionId === 'footer.effortSelect') {
    dropdownItems = EFFORT_VALUES.map((v) => ({ value: v, label: capitalize(v) }))
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

  const dropdownOverlayId = chipDropdownId(`${item.actionId}:${item.id}:${workspaceId}`)

  const handleClick = useCallback((): void => {
    if (!chipRef.current) return
    if (openRef.current) {
      // Currently open → close. Flip the ref synchronously so an immediate
      // follow-up click is treated as "closed" (will open), not another close.
      openRef.current = false
      setOpen(false)
      hideChipDropdown(dropdownOverlayId)
      return
    }
    openRef.current = true
    setOpen(true)
    const r = chipRef.current.getBoundingClientRect()
    showChipDropdown(
      dropdownOverlayId,
      { x: r.left, y: r.top, w: r.width, h: r.height },
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
  }, [dropdownOverlayId, workspaceId, item.label])

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
      hideChipDropdown(dropdownOverlayId)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open, dropdownOverlayId])

  const isDisabled = enabled === false

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
          {item.icon ? <IconByName name={item.icon} size={12} /> : null}
        </span>
        <span className="truncate max-w-[100px]">{faceLabel}</span>
        <IconByName name="CaretUp" size={9} className="flex-shrink-0 opacity-60" />
      </button>
    </div>
  )
}
