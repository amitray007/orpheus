/**
 * tui/projectHeaderLayout.ts — pure width computation for the picker's
 * project group header line (ProjectGroupHeader.tsx): `name --------- N`.
 *
 * WHY ITS OWN FILE, NOT wizardLayout.ts OR INLINE IN THE COMPONENT
 * -----------------------------------------------------------------------
 * wizardLayout.ts's own file header explains why IT is a separate module
 * from layout.ts: pure width math needs to be exercisable by a no-Ink
 * assertion script. The same rationale applies here, but wizardLayout.ts
 * itself is scoped to the new-workspace WIZARD (its file header, its
 * exports, its harness in verify-tui-wizard.ts are all wizard-specific
 * concerns — model lists, provider rows, confirm summaries). The project
 * group header is a PICKER concern (rendered by tui/App.tsx's PickerBody,
 * consumed by ProjectGroupHeader.tsx), unrelated to the wizard's flow.
 * Folding it into wizardLayout.ts would make that module's name a lie for
 * anyone reading it top-down, and would mix two independently-testable
 * concerns into one file the way layout.ts/blocks.ts deliberately don't
 * (blocks.ts was split OUT of layout.ts for exactly this "distinct
 * concern, same purity contract" reason — see blocks.ts's own header). A
 * new sibling module, exercised by its own section of
 * scripts/verify-tui-blocks.ts (which already owns the header-height
 * regression guard this line's height feeds into), keeps each pure module
 * mapped to one renderer concern.
 *
 * STRUCTURED PARTS, NOT A FLAT STRING
 * -----------------------------------------------------------------------
 * The header wants three colours (name = groupLabel, rule = border, count =
 * secondary — see ProjectGroupHeader.tsx), so this returns the already
 * truncated/sized SEGMENTS rather than one pre-joined string: a caller that
 * needs a single flat string (this module's own width-invariant assertions
 * in scripts/verify-tui-blocks.ts) can still get one via `joinHeaderLine`,
 * but the component itself never has to re-derive where the name ends and
 * the rule begins by re-running truncation logic of its own.
 *
 * WHY `countGap` IS ITS OWN EXPLICIT FIELD, NOT INFERRED FROM name/rule
 * -----------------------------------------------------------------------
 * There are two genuinely different reasons `name` and `rule` can both be
 * `''`: (a) the ordinary case where the name is truncated all the way down
 * to nothing because even the rule was dropped and the name budget itself
 * hit zero — the count's own leading gap is still reserved and must render;
 * versus (b) the fully-degenerate case where `width` itself is smaller than
 * the count's own text — there both name AND the count's leading gap are
 * gone, because there was never enough room to reserve one. `joinHeaderLine`
 * cannot tell these apart by inspecting `name`/`rule` alone (both are `''`
 * in both cases) — hence `countGap` is threaded through explicitly by
 * `buildProjectGroupHeaderLine`, which DOES know which branch it took,
 * rather than re-derived by inference at join time.
 *
 * WIDTH CONTRACT
 * -----------------------------------------------------------------------
 * `joinHeaderLine(buildProjectGroupHeaderLine(...))` is ALWAYS exactly
 * `width` columns — the same "pad THEN color" discipline documented in
 * wizardLayout.ts's header and WorkspaceCard.tsx's: every segment is
 * already sized so a caller can wrap each in its own <Text color=...> with
 * no unpadded gaps between them. The count is NEVER truncated or dropped in
 * the normal path: it is reserved space FIRST, the name is truncated INTO
 * whatever's left, and the rule is dropped entirely (not partially drawn —
 * `rule` becomes `''`) once there's no room left for even one rule
 * character between the (possibly truncated) name and the count. Only when
 * `width` itself is smaller than the count's own text does the count get
 * right-truncated (kept as whole trailing digits) — the one case where the
 * "count never truncated" rule has no room to hold.
 */

import { truncate } from './layout.js'

/** One blank column between the (possibly-truncated) name and the rule, and
 *  again between the rule (or name, if the rule was dropped) and the count
 *  — mirrors the single-space breathing room used elsewhere in this file's
 *  sibling layout modules (e.g. wizardLayout.ts's suffix handling).
 *  Exported so the joining helper and the harness agree on the same
 *  literal gap width. */
export const HEADER_GAP_COLUMNS = 1

export interface ProjectHeaderLineParts {
  /** Truncated (never padded) project name. */
  name: string
  /** Rule-character run, possibly empty when there's no room for one. */
  rule: string
  /** The count — right-truncated only in the fully-degenerate case where
   *  `width` itself is smaller than the count's own text; otherwise always
   *  rendered in full. */
  count: string
  /** Whether a gap column belongs between whatever precedes it (name, or
   *  rule, or nothing) and `count` — see this file's header for why this
   *  can't be inferred from `name`/`rule` alone. */
  countGap: boolean
}

/**
 * Build the project group header's `name --------- N` line as
 * independently-colourable segments — see `ProjectHeaderLineParts` and this
 * file's header for the exact width contract.
 *
 * `ruleChar` must be a single-column (East_Asian_Width=Narrow or Neutral)
 * character — callers pass theme.ts's NAV_DIVIDER_CHAR ('-'); see that
 * constant's own doc comment for why box-drawing glyphs are disqualified.
 */
export function buildProjectGroupHeaderLine(
  name: string,
  count: number,
  width: number,
  ruleChar: string
): ProjectHeaderLineParts {
  const fullCountText = String(count)
  const safeWidth = Math.max(0, width)

  // The count is non-negotiable budget, reserved first. If even the count
  // alone doesn't fit, there is nothing sensible left to draw but the
  // (right-truncated) count itself — no name, no rule, no gap: there was
  // never a spare column to reserve for one.
  if (fullCountText.length >= safeWidth) {
    const countText = fullCountText.slice(Math.max(0, fullCountText.length - safeWidth))
    return { name: '', rule: '', count: countText, countGap: false }
  }

  // Budget left for "name + gap + [rule] + gap + count". The count's own
  // leading gap is reserved unconditionally from here on — every return
  // below this point sets `countGap: true`.
  const budgetForNameAndRule = safeWidth - fullCountText.length - HEADER_GAP_COLUMNS

  // No room for a rule at all — reserving just 1 rule column plus its
  // leading gap wouldn't leave the name a single column. Drop the rule
  // entirely, give 100% of the remaining budget to the name.
  const minRuleSlice = HEADER_GAP_COLUMNS + 1 // one gap + one rule char
  if (budgetForNameAndRule <= minRuleSlice) {
    const nameBudget = Math.max(0, budgetForNameAndRule)
    return { name: truncate(name, nameBudget), rule: '', count: fullCountText, countGap: true }
  }

  // Truncate the name to its OWN natural budget first (reserving at least
  // one rule column + its gap), so a short name doesn't get padded out by
  // truncate() eating the whole name-or-rule budget — the rule, not the
  // name, absorbs whatever space the name doesn't need.
  const maxNameBudget = budgetForNameAndRule - minRuleSlice
  const truncatedName = truncate(name, maxNameBudget)
  const ruleWidth = budgetForNameAndRule - HEADER_GAP_COLUMNS - truncatedName.length
  const rule = ruleChar.repeat(Math.max(0, ruleWidth))

  return { name: truncatedName, rule, count: fullCountText, countGap: true }
}

/**
 * Join `ProjectHeaderLineParts` back into the flat, EXACTLY-`width`-column
 * string the parts were sized for — used by the harness's width-invariant
 * assertions (scripts/verify-tui-blocks.ts) and available to any caller
 * that wants one plain string rather than colour segments.
 *
 * The gap before `rule` collapses to nothing when `rule` is empty (there's
 * no rule to separate the name from); the gap before `count` is whatever
 * `buildProjectGroupHeaderLine` decided via `countGap` — see this file's
 * header for why that can't be re-derived from `name`/`rule` alone.
 */
export function joinHeaderLine(parts: ProjectHeaderLineParts): string {
  const ruleSegment = parts.rule.length > 0 ? ' '.repeat(HEADER_GAP_COLUMNS) + parts.rule : ''
  const countGap = parts.countGap ? ' '.repeat(HEADER_GAP_COLUMNS) : ''
  return parts.name + ruleSegment + countGap + parts.count
}
