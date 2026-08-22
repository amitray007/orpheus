// ---------------------------------------------------------------------------
// src/renderer/src/components/dashboard/TitleBarUsageChips.tsx
//
// Footer-removal migration, Phase 1 (support-multi-harness) — the
// title-bar's compact Model/Effort/Context/Cost chip row. Read
// WorkspaceTitleBar.tsx's own comment right above where this is mounted
// (WorkbenchTopBarRegion, a SIBLING of the dormant/open ternary, immediately
// before WorkspaceSettingsPopover) for why it lives at that exact position;
// this file is only the chip ROW itself.
//
// WHY A SEPARATE FILE, NOT INLINE IN WorkspaceTitleBar.tsx — that file is
// already close to its own cognitive-complexity budget (see
// WorkbenchTopBarRegion's own extraction comment for the same discipline
// applied once already). This row has its own non-trivial state (model/
// effort picker plumbing, a poll for context/cost) that deserves its own
// module boundary rather than growing the title bar file further.
//
// MODEL/EFFORT — reuses the EXACT SAME extracted logic
// components/dashboard/footer/DropdownChip.tsx now also calls:
// useModelEffortPickerState (lib/modelEffortPickerState.ts) for the read
// side, decideModelSelectionEffect/decideEffortSelectionEffect
// (lib/modelEffortSelection.ts) for the "what happens on selection"
// decision. This chip row also reuses the SAME overlay popover mechanism
// DropdownChip uses (showChipGroupedDropdown for the model flyout,
// showChipDropdown for the flat effort list) rather than rebuilding
// dropdown plumbing — see the task brief this file was built from, which
// explicitly prefers this over a from-scratch popover. The one piece of
// DropdownChip's mechanism NOT reused here is the diagonal-traversal
// submenu hover-timer (MODEL_SUBMENU_OPEN_DELAY_MS/MODEL_SUBMENU_CLOSE_DELAY_MS)
// — a nice-to-have UX polish for the flyout's provider-to-model traversal,
// not correctness-critical, and skipping it keeps this file meaningfully
// smaller; a future pass could lift THAT into a shared hook too if the
// title bar's flyout traversal turns out to feel abrupt without it.
//
// CONTEXT/COST — read via the EXISTING session.getUsage/session.getCost
// actions (window.api.actions.invoke), the exact same call shape
// WorkspaceTitleBar.tsx's own openDetailsPopover already uses (see that
// function, ~line 434-477) — no new IPC channel needed (see
// src/main/actions/sessionUsageReader.ts for the harness-dispatch seam that
// now sits behind those two actions). Gated on shouldFetchUsageDetails
// (capabilityGating.ts) — a harness without capabilities.usage renders NO
// context/cost chips at all, mirroring the details popover's own gate
// exactly (never zeros, never a spinner that can't resolve).
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { Sliders, Gauge, CurrencyDollarSimple, CaretUp } from '@phosphor-icons/react'
import type { HarnessId } from '@shared/harness/types'
import type { ClaudeEffort, HarnessSummary, SessionUsage, SessionCost } from '@shared/types'
import { shouldFetchUsageDetails } from '@shared/harness/capabilityGating'
import {
  effortDropdownItemsFor,
  shouldRenderEffortChip,
  capitalize
} from '@/lib/effortPickerOptions'
import { buildModelDropdownGroups } from '@/lib/modelPickerOptions'
import { useModelEffortPickerState } from '@/lib/modelEffortPickerState'
import { decideModelSelectionEffect, decideEffortSelectionEffect } from '@/lib/modelEffortSelection'
import { setWorkspaceModel } from '@/lib/workspaceModelStore'
import { setWorkspaceEffort } from '@/lib/workspaceEffortStore'
import { useWorkspaceActivity } from '@/lib/activityStore'
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
import { ProviderIcon } from '../ProviderIcon'
import { playSound } from '@/lib/sound'

// Short token helper — same abbreviation rule as
// workspaceTitleBar.helpers.ts's shortTokens (kept as its own tiny copy
// here rather than importing the WorkspaceTitleBar module's own private
// helper cross-file — this one-liner is cheap enough that duplicating it
// is clearer than reaching into another component file's internals for a
// single format function; both copies are asserted to agree by
// scripts/verify-title-bar-usage-chips.ts).
function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return `${n}`
}

/** Compact context-chip label — "1.2k/200k" (no separators/percent — the
 *  title bar is tight on horizontal space; the fuller "1.2k / 200k · 85%"
 *  breakdown from the details hover-card stays there for the reader who
 *  wants it, see this file's own header on why that popover is untouched).
 *  '—' when either side is unknown, matching formatContextText's
 *  never-fabricate discipline in workspaceTitleBar.helpers.ts's sibling. */
function shortContextLabel(usage: SessionUsage | null, contextBudget: number | null): string {
  if (contextBudget === null) return usage ? `${shortTokens(usage.lastTurnContextTokens)}/—` : '—'
  if (!usage) return `—/${shortTokens(contextBudget)}`
  return `${shortTokens(usage.lastTurnContextTokens)}/${shortTokens(contextBudget)}`
}

/** Compact cost-chip label. Mirrors formatCostText's hasUnknownPricing
 *  discipline (WorkspaceTitleBar.tsx) — never prints a bare "$0.00" when
 *  some spend is of unknown origin. */
function shortCostLabel(cost: SessionCost | null): string {
  if (!cost) return '—'
  const known = `$${cost.usd.toFixed(2)}`
  if (!cost.hasUnknownPricing) return known
  return cost.usd > 0 ? `${known}+` : '—'
}

interface ChipButtonProps {
  icon: React.ReactNode
  label: string
  title: string
  onClick?: () => void
  active?: boolean
  disabled?: boolean
  chipRef?: React.RefObject<HTMLButtonElement | null>
}

/** One [icon][value] chip — shared visual treatment for all four chips,
 *  matching the title bar's existing controls (WorkspaceSettingsPopover's
 *  gear button, WorkbenchTopBarRegion's opener button): text-xs,
 *  text-muted/hover-primary, same rounded/padding scale. `truncate max-w`
 *  on the label mirrors the footer's DropdownChip.tsx `truncate
 *  max-w-[100px]` treatment — the title bar is even tighter on width than
 *  the footer, so this uses a smaller cap (see MAX_LABEL_WIDTH_PX) to make
 *  sure a long model name can never push the settings gear off-screen. */
const MAX_LABEL_WIDTH_PX = 72

function ChipButton({
  icon,
  label,
  title,
  onClick,
  active,
  disabled,
  chipRef
}: ChipButtonProps): React.JSX.Element {
  const interactive = !!onClick && !disabled
  const className = [
    'flex items-center gap-1 px-1.5 py-1 rounded-md text-xs flex-shrink-0',
    'transition-colors duration-150',
    disabled
      ? 'text-text-muted/60'
      : active
        ? 'text-text-primary bg-surface-overlay'
        : interactive
          ? 'text-text-muted hover:text-text-primary hover:bg-surface-overlay'
          : 'text-text-muted',
    interactive
      ? 'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40'
      : ''
  ]
    .filter(Boolean)
    .join(' ')

  const content = (
    <>
      <span className="flex-shrink-0 flex items-center" style={{ width: 12, height: 12 }}>
        {icon}
      </span>
      <span className="truncate" style={{ maxWidth: MAX_LABEL_WIDTH_PX }}>
        {label}
      </span>
      {interactive && <CaretUp size={8} className="flex-shrink-0 opacity-60" />}
    </>
  )

  if (!interactive) {
    return (
      <span className={className} title={title} aria-label={title}>
        {content}
      </span>
    )
  }

  return (
    <button
      ref={chipRef}
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={className}
    >
      {content}
    </button>
  )
}

interface TitleBarUsageChipsProps {
  workspaceId: string
  projectId: string
  harnessId?: HarnessId | null
  harness: HarnessSummary
  onRestart?: () => void
}

/**
 * The title-bar's Model / Effort / Context / Cost chip row — see this
 * file's header for the full design rationale. Renders as an ordinary flex
 * row; the caller (WorkspaceTitleBar.tsx) is responsible for placement
 * (sibling of the dormant/open ternary, immediately before
 * WorkspaceSettingsPopover).
 */
export function TitleBarUsageChips({
  workspaceId,
  projectId,
  harnessId,
  harness,
  onRestart
}: TitleBarUsageChipsProps): React.JSX.Element {
  const modelChipRef = useRef<HTMLButtonElement>(null)
  const effortChipRef = useRef<HTMLButtonElement>(null)
  const [modelOpen, setModelOpen] = useState(false)
  const [effortOpen, setEffortOpen] = useState(false)

  // Same shared per-workspace activity store every other mid-task-guard
  // consumer reads (e.g. DropdownChip.tsx's own activityDetail prop,
  // threaded down from WorkspaceView's useWorkspaceActivity call) — read
  // directly here rather than threaded through another prop hop, since this
  // component already sits below WorkspaceView in the tree and the store is
  // the canonical source every other mid-task guard in the app already
  // uses.
  const activityDetail = useWorkspaceActivity(workspaceId)

  const {
    modelValue,
    effortValue,
    selectableModels,
    currentModelIsClaude,
    currentModelEffortLevels,
    harnessEffortOptions,
    refetchAll
  } = useModelEffortPickerState(workspaceId, harness, harnessId ?? undefined, projectId, true)

  const isEffortPending = currentModelEffortLevels === undefined
  const showEffortChip = shouldRenderEffortChip(currentModelEffortLevels, !!harnessEffortOptions)

  // Notice tooltip for a give-up/error case — mirrors DropdownChip.tsx's
  // showTooltip exactly (same chipTooltipId/showChipTooltip/hideOverlayCard
  // pattern), scoped to this chip row via its own overlay id namespace.
  const tooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tooltipOverlayId = chipTooltipId(`titleBarUsageChips:${workspaceId}`)
  useEffect(() => {
    return () => {
      if (tooltipTimer.current) clearTimeout(tooltipTimer.current)
      hideOverlayCard(tooltipOverlayId)
    }
  }, [tooltipOverlayId])
  function showTooltip(anchor: React.RefObject<HTMLButtonElement | null>, msg: string): void {
    if (tooltipTimer.current) clearTimeout(tooltipTimer.current)
    if (anchor.current) {
      const r = anchor.current.getBoundingClientRect()
      showChipTooltip(
        tooltipOverlayId,
        { x: r.left, y: r.top, w: r.width, h: r.height },
        { text: msg },
        workspaceId
      )
    }
    tooltipTimer.current = setTimeout(() => hideOverlayCard(tooltipOverlayId), 2500)
  }

  function runInject(text: string, submit: boolean): void {
    setTimeout(() => {
      void window.api.actions
        .invoke({ id: 'terminal.sendInput', params: { text, submit }, workspaceId }, 'title-bar')
        .catch((e) => console.error('[TitleBarUsageChips] inject failed', e))
    }, 0)
  }

  const modelDropdownGroups = buildModelDropdownGroups(selectableModels)
  const modelIconId = (() => {
    const m = selectableModels.find((sm) => sm.id === modelValue)
    return m?.providerIconId ?? m?.providerId ?? harness.icon
  })()
  const modelLabel = (() => {
    if (!modelValue) return 'Default'
    const known = selectableModels.find((m) => m.id === modelValue)
    return known ? known.label : modelValue
  })()

  function openModelPicker(): void {
    if (!modelChipRef.current) return
    refetchAll()
    const r = modelChipRef.current.getBoundingClientRect()
    setModelOpen(true)
    showChipGroupedDropdown(
      chipGroupedDropdownId(`titleBar.model:${workspaceId}`),
      { x: r.left, y: r.top, w: r.width, h: r.height },
      { groups: modelDropdownGroups, selectedValue: modelValue, title: 'Model' },
      { onHoverProvider: () => {}, onEnterSubmenu: () => {}, onLeaveSubmenu: () => {} },
      workspaceId,
      'bottom'
    )
      .then((res) => {
        setModelOpen(false)
        if (!res) return
        selectModel(res.value)
      })
      .catch((e) => {
        setModelOpen(false)
        console.error('[TitleBarUsageChips] model dropdown failed', e)
      })
  }

  function selectModel(value: string): void {
    const newModelIsClaude = selectableModels.find((m) => m.id === value)?.isClaude ?? false
    const previousModel = modelValue
    setWorkspaceModel(workspaceId, value)
    window.api.workspaces
      .setModel(workspaceId, value)
      .then((settings) => {
        if (settings.overrides.effort !== undefined) {
          setWorkspaceEffort(workspaceId, settings.overrides.effort)
        }
      })
      .catch((e) => {
        console.error('[TitleBarUsageChips] setModel failed', e)
        setWorkspaceModel(workspaceId, previousModel)
        playSound('error')
        showTooltip(modelChipRef, 'Model not saved — try again')
      })

    const effect = decideModelSelectionEffect(
      currentModelIsClaude,
      newModelIsClaude,
      harness.curated?.model,
      value,
      !!onRestart,
      activityDetail
    )
    if (effect.kind === 'inject') {
      runInject(effect.text, effect.submit)
      return
    }
    if (effect.kind === 'restart') {
      playSound('success')
      showTooltip(modelChipRef, 'Model set — restarting workspace…')
      onRestart?.()
    } else {
      playSound('success')
      showTooltip(modelChipRef, 'Model set — restart workspace to apply')
    }
  }

  const effortDropdownItems = effortDropdownItemsFor(currentModelEffortLevels, harnessEffortOptions)

  function openEffortPicker(): void {
    if (!effortChipRef.current || isEffortPending) return
    refetchAll()
    const r = effortChipRef.current.getBoundingClientRect()
    setEffortOpen(true)
    showChipDropdown(
      chipDropdownId(`titleBar.effort:${workspaceId}`),
      { x: r.left, y: r.top, w: r.width, h: r.height },
      { items: effortDropdownItems, selectedValue: effortValue || 'auto', title: 'Effort' },
      workspaceId,
      'bottom'
    )
      .then((res) => {
        setEffortOpen(false)
        if (!res) return
        selectEffort(res.value)
      })
      .catch((e) => {
        setEffortOpen(false)
        console.error('[TitleBarUsageChips] effort dropdown failed', e)
      })
  }

  function selectEffort(value: string): void {
    const previousEffort = effortValue
    setWorkspaceEffort(workspaceId, value)
    window.api.workspaces
      .setEffort(workspaceId, value as ClaudeEffort)
      .then(() => {
        const effect = decideEffortSelectionEffect(
          harness.curated?.effort,
          value,
          !!onRestart,
          activityDetail
        )
        if (effect.kind === 'inject') {
          runInject(effect.text, effect.submit)
          return
        }
        if (effect.kind === 'restart') {
          playSound('success')
          showTooltip(effortChipRef, 'Effort set — restarting workspace…')
          onRestart?.()
        } else {
          playSound('success')
          showTooltip(effortChipRef, 'Effort set — restart workspace to apply')
        }
      })
      .catch((e) => {
        console.error('[TitleBarUsageChips] setEffort failed', e)
        setWorkspaceEffort(workspaceId, previousEffort)
        playSound('error')
        showTooltip(effortChipRef, 'Effort not saved — try again')
      })
  }

  // Outside-click dismissal — mirrors DropdownChip.tsx's identical effect
  // (see that file's own comment on why pointerdown events originating
  // inside the chip button itself must be ignored, to avoid a re-click
  // immediately reopening what it just closed).
  useEffect(() => {
    if (!modelOpen && !effortOpen) return
    function onPointerDown(e: PointerEvent): void {
      const insideModel =
        modelChipRef.current && e.target instanceof Node && modelChipRef.current.contains(e.target)
      const insideEffort =
        effortChipRef.current &&
        e.target instanceof Node &&
        effortChipRef.current.contains(e.target)
      if (insideModel || insideEffort) return
      if (modelOpen) {
        setModelOpen(false)
        hideChipGroupedDropdown(chipGroupedDropdownId(`titleBar.model:${workspaceId}`))
      }
      if (effortOpen) {
        setEffortOpen(false)
        hideChipDropdown(chipDropdownId(`titleBar.effort:${workspaceId}`))
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [modelOpen, effortOpen, workspaceId])

  // ── Context/Cost — harness-gated, read via the existing session.getUsage/
  // session.getCost actions (see this file's header). Polled on a fixed
  // interval rather than pushed — usage/cost has no existing push channel,
  // and a lightweight poll matches the details hover-card's own on-demand
  // fetch cadence (open-triggered there; here, since the chip is always
  // visible rather than opened on hover, a modest interval keeps it fresh
  // without a new IPC push channel this phase doesn't need). Gated
  // entirely off (no interval even started) for a harness without
  // capabilities.usage — see shouldFetchUsageDetails' own doc comment.
  const canFetchUsage = shouldFetchUsageDetails(harness.capabilities)
  const [usage, setUsage] = useState<SessionUsage | null>(null)
  const [cost, setCost] = useState<SessionCost | null>(null)

  useEffect(() => {
    // No early setState-in-effect reset here (react-hooks/set-state-in-
    // effect forbids calling setState synchronously in an effect body,
    // which a `!canFetchUsage -> setUsage(null)` branch would do on every
    // render where this is false). Not resetting is harmless: usage/cost
    // are stale-but-unread in that case — the chips themselves are gated on
    // the SAME canFetchUsage flag at the render return below, so a harness
    // without capabilities.usage never displays whatever these hold.
    if (!canFetchUsage) return
    let cancelled = false
    function fetchOnce(): void {
      window.api.actions
        .invoke({ id: 'session.getUsage', params: {}, workspaceId }, 'title-bar-usage')
        .then((res) => {
          if (!cancelled && res.ok && res.value != null) setUsage(res.value as SessionUsage)
        })
        .catch(() => {})
      window.api.actions
        .invoke({ id: 'session.getCost', params: {}, workspaceId }, 'title-bar-usage')
        .then((res) => {
          if (!cancelled && res.ok && res.value != null) setCost(res.value as SessionCost)
        })
        .catch(() => {})
    }
    fetchOnce()
    const interval = setInterval(fetchOnce, 15_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [workspaceId, canFetchUsage])

  return (
    <div className="flex items-center gap-0.5 flex-shrink-0">
      <ChipButton
        chipRef={modelChipRef}
        icon={modelIconId ? <ProviderIcon providerId={modelIconId} size={12} /> : null}
        label={modelLabel}
        title={`Model: ${modelLabel}`}
        active={modelOpen}
        onClick={openModelPicker}
      />
      {showEffortChip && (
        <ChipButton
          chipRef={effortChipRef}
          icon={<Sliders size={12} />}
          label={capitalize(effortValue || 'auto')}
          title={`Effort: ${capitalize(effortValue || 'auto')}`}
          active={effortOpen}
          disabled={isEffortPending}
          onClick={openEffortPicker}
        />
      )}
      {canFetchUsage && (
        <ChipButton
          icon={<Gauge size={12} />}
          label={shortContextLabel(usage, usage?.contextBudget ?? null)}
          title={
            usage?.contextBudget != null
              ? `Context: ${usage.lastTurnContextTokens.toLocaleString()} / ${usage.contextBudget.toLocaleString()} tokens (${Math.round(usage.usedPct)}%)`
              : 'Context: unknown'
          }
        />
      )}
      {canFetchUsage && (
        <ChipButton
          icon={<CurrencyDollarSimple size={12} />}
          label={shortCostLabel(cost)}
          title={
            cost
              ? cost.hasUnknownPricing
                ? 'Session cost (some usage has unknown pricing)'
                : `Session cost: $${cost.usd.toFixed(4)}`
              : 'Cost: unknown'
          }
        />
      )}
    </div>
  )
}
