// ---------------------------------------------------------------------------
// src/renderer/src/components/dashboard/TitleBarUsageChips.tsx
//
// Model/effort-removal migration, Phase 1 (support-multi-harness) — the
// title bar's chip row is now READ-ONLY: Context and Cost only. Read
// WorkspaceTitleBar.tsx's own comment right above where this is mounted
// (WorkbenchTopBarRegion, a SIBLING of the dormant/open ternary, immediately
// before WorkspaceSettingsPopover) for why it lives at that exact position;
// this file is only the chip ROW itself.
//
// WHY A SEPARATE FILE, NOT INLINE IN WorkspaceTitleBar.tsx — that file is
// already close to its own cognitive-complexity budget (see
// WorkbenchTopBarRegion's own extraction comment for the same discipline
// applied once already).
//
// MODEL/EFFORT CHIPS REMOVED HERE — Orpheus is dropping model/reasoning-
// effort management from its own UI entirely; the workspace now runs its
// harness and the user changes model/effort via the HARNESS's OWN controls
// (e.g. Claude Code's `/model`, Codex's picker). This file no longer renders
// a Model or Effort chip, nor any of the picker/dropdown/restart machinery
// that used to back them. The footer that used to carry those chips, and the
// shared model/effort selection layer behind it, have since been deleted
// outright — so this file is the ONLY place Orpheus surfaces per-workspace
// session facts, and it surfaces exactly two: context and cost.
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

import { useEffect, useState } from 'react'
import type React from 'react'
import { Gauge } from '@phosphor-icons/react'
import type { HarnessSummary, SessionUsage, SessionCost } from '@shared/types'
import { shouldFetchUsageDetails } from '@shared/harness/capabilityGating'

// Short token helper — same abbreviation rule as
// workspaceTitleBar.helpers.ts's shortTokens (kept as its own tiny copy
// here rather than importing the WorkspaceTitleBar module's own private
// helper cross-file — this one-liner is cheap enough that duplicating it
// is clearer than reaching into another component file's internals for a
// single format function).
function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`
  // ALWAYS a `k` suffix below 1M, including 0 and sub-1k values. A bare
  // `0` next to a gauge icon reads as a broken or unloaded chip; `0k` reads
  // as a real measurement that happens to be near zero. The unit is what
  // makes the number self-describing, so it stays even when rounding takes
  // the value to zero.
  return `${Math.round(n / 1_000)}k`
}

/** Compact context-chip label — "1.2k/200k" (no separators/percent — the
 *  title bar is tight on horizontal space; the fuller "1.2k / 200k · 85%"
 *  breakdown from the details hover-card stays there for the reader who
 *  wants it, see this file's own header on why that popover is untouched).
 *  '—' when either side is unknown, matching formatContextText's
 *  never-fabricate discipline in workspaceTitleBar.helpers.ts's sibling. */
function shortContextLabel(usage: SessionUsage | null): string {
  // USED TOKENS ONLY — deliberately not `used/budget`. The budget is a
  // constant per model, so repeating it in a space-constrained title bar
  // spends width on something that never changes and never prompts an
  // action. The full `used / budget (pct)` breakdown is still one hover
  // away in the chip's title attribute, which is where the detail belongs.
  if (!usage) return '—'
  return shortTokens(usage.lastTurnContextTokens)
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
}

/** One [icon][value] read-only chip — shared visual treatment for both
 *  chips, matching the title bar's existing controls (WorkspaceSettingsPopover's
 *  gear button, WorkbenchTopBarRegion's opener button): text-xs,
 *  text-muted, same rounded/padding scale. `truncate max-w` on the label
 *  mirrors the footer's DropdownChip.tsx `truncate max-w-[100px]`
 *  treatment — the title bar is even tighter on width than the footer, so
 *  this uses a smaller cap (see MAX_LABEL_WIDTH_PX) to make sure a long
 *  label can never push the settings gear off-screen.
 *
 *  Non-interactive by design: this row is read-only (see file header), so
 *  there is no button/click/focus-ring path here — only the plain `<span>`
 *  rendering used to exist for the (now-removed) case where a chip had no
 *  onClick. Keeping unused button/keyboard-focus semantics around for a
 *  chip nothing ever clicks would be a lie to screen readers. */
const MAX_LABEL_WIDTH_PX = 72

function ChipButton({ icon, label, title }: ChipButtonProps): React.JSX.Element {
  return (
    <span
      className="flex items-center gap-1 px-1.5 py-1 rounded-md text-xs flex-shrink-0 text-text-muted"
      title={title}
      aria-label={title}
    >
      {/* The icon slot is a fixed 12x12 box so icons align across chips —
          but only when there IS an icon. Rendering it unconditionally for an
          icon-less chip (Cost) would reserve 12px plus the flex gap and read
          as a mis-aligned indent. */}
      {icon != null && (
        <span className="flex-shrink-0 flex items-center" style={{ width: 12, height: 12 }}>
          {icon}
        </span>
      )}
      <span className="truncate" style={{ maxWidth: MAX_LABEL_WIDTH_PX }}>
        {label}
      </span>
    </span>
  )
}

interface TitleBarUsageChipsProps {
  workspaceId: string
  harness: HarnessSummary
}

/**
 * The title-bar's read-only Context / Cost chip row — see this file's
 * header for the full design rationale. Renders as an ordinary flex row;
 * the caller (WorkspaceTitleBar.tsx) is responsible for placement (sibling
 * of the dormant/open ternary, immediately before WorkspaceSettingsPopover).
 */
export function TitleBarUsageChips({
  workspaceId,
  harness
}: TitleBarUsageChipsProps): React.JSX.Element {
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
      {canFetchUsage && (
        <ChipButton
          icon={<Gauge size={12} />}
          label={shortContextLabel(usage)}
          title={
            usage?.contextBudget != null
              ? `Context: ${usage.lastTurnContextTokens.toLocaleString()} / ${usage.contextBudget.toLocaleString()} tokens (${Math.round(usage.usedPct)}%)`
              : 'Context: unknown'
          }
        />
      )}
      {canFetchUsage && (
        <ChipButton
          // No icon: the label is already `$0.00`, so a currency glyph beside
          // it is pure redundancy in a width-constrained bar. Context keeps
          // its gauge because `12k` alone doesn't say what it measures.
          icon={null}
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
