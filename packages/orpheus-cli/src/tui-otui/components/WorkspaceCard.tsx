/**
 * tui-otui/components/WorkspaceCard.tsx — a 3-line workspace card, the core
 * of the card-based picker redesign (replaces WorkspaceRow.tsx +
 * WorkspaceTable.tsx's per-workspace row rendering at every breakpoint).
 *
 * CARD SHAPE (exactly 3 lines, always — never collapses to 2)
 * -----------------------------------------------------------------------
 * 1. `model effort` left, `status elapsed` right — same line.
 * 2. Workspace title (displayTitleFor()).
 * 3. `⎇ branch` — rendered BLANK (not omitted) when there's no worktree
 *    branch, so every card is exactly 3 lines tall regardless of content.
 *    A variable card height would make the scroll-window math and the
 *    "no vertical shift on selection" requirement much harder to reason
 *    about and verify — see App.tsx's file header.
 *
 * SELECTION — RESERVE THE GUTTER SLOT, SWAP THE RUNE (ported from Charm's
 * soft-serve three-line card picker technique, per the task brief)
 * -----------------------------------------------------------------------
 * Every card has a 1-column leading gutter on ALL THREE lines — ` ` normal,
 * `|` selected. Same column, same width, always present. Three signals on
 * the selected card, on all three lines:
 *   1. Gutter rune: ` ` -> `|` (theme.ts's gutterContentFor).
 *   2. Background tint across the FULL card width, all 3 lines.
 *   3. Bold on the title line ONLY (line 2) — line 1/3 get the bg tint but
 *      not forced bold; attention status text is always bold regardless of
 *      selection (matches the pre-redesign WorkspaceRow.tsx precedent:
 *      `props.selected || props.row.status === 'attention' ? BOLD :
 *      undefined`, applied here to whichever text carries the status word —
 *      line 1's right-aligned status token).
 *
 * THE "PAD BEFORE BG" DISCIPLINE (gh-dash's `.Width(w).Background(...)` bug
 * class — see WorkspaceTable.tsx's file header, point 3, for the fuller
 * postmortem of the SAME bug class in the table renderer this replaces)
 * -----------------------------------------------------------------------
 * Every line of a card is built as ONE string: content assembled, then
 * padded to the card's FULL available width, THEN handed to a single
 * `<text bg={...}>` covering the whole line. Line 1 has two visually
 * distinct zones (left model/effort, right status/elapsed) built from a
 * KNOWN split point (computed once in line1Parts(), not re-derived by
 * scanning the padded string) so the two `<span>` children inside ONE
 * `<text bg={...}>` always reconstruct the exact padded line with zero
 * unstyled seam — the background prop is set exactly once per line, on the
 * outer `<text>`.
 *
 * AGENT NAME SEAM (intentionally not plumbed — see docs/TUI_SPEC.md /
 * claudeSettings.ts's resolveEffectiveModelAndEffort for what IS wired)
 * -----------------------------------------------------------------------
 * No per-workspace agent-identity field exists yet (this app only launches
 * the `claude` CLI today — see CLAUDE.md's "Claude launch composition"
 * section). The seam is marked at the exact spot an agent token would be
 * prepended to line 1, below.
 */

import { TextAttributes } from '@opentui/core'
import { WORKTREE_GLYPH, gutterContentFor } from '../theme.js'
import type { Palette } from '../theme.js'
import { displayTitleFor, truncate, type DisplayRow } from '../../tui/layout.js'
import { formatAge, formatModelEffort } from '../format.js'
import type { WorkspaceStatus } from '../types.js'

/** Exactly four status words, one each — see docs/TUI_SPEC.md's "STATUS
 *  VOCABULARY" section. Note "in progress" has a space (display word),
 *  unlike the wire enum's underscore. */
const STATUS_LABEL: Record<WorkspaceStatus, string> = {
  attention: 'attention',
  in_progress: 'in progress',
  awaiting_input: 'awaiting',
  idle: 'idle'
}

function statusColor(status: WorkspaceStatus, palette: Palette): string {
  if (status === 'attention') return palette.attention
  if (status === 'in_progress') return palette.working
  if (status === 'awaiting_input') return palette.awaiting
  return palette.idle
}

export interface WorkspaceCardProps {
  row: Extract<DisplayRow, { kind: 'workspace' }>
  /** Effective model/effort for this workspace — looked up by App.tsx from
   *  the raw TreeFrame (NOT threaded through DisplayRow/flattenTree, which
   *  live in tui/layout.ts and are out of scope to extend for this task —
   *  see App.tsx's file header for the lookup-by-id approach this uses
   *  instead). */
  model: string | null
  effort: string | null
  selected: boolean
  /** Full width available for the card content, INCLUDING the 1-col
   *  gutter — i.e. the terminal's content width at this breakpoint. */
  width: number
  palette: Palette
}

/** Line 1's left (model/effort) + right (status/elapsed) split, already
 *  padded so `left.length + right.length === innerWidth` exactly — the two
 *  pieces concatenate back to the full padded line with no gap arithmetic
 *  needed at the JSX call site. */
function line1Parts(
  modelEffort: string,
  statusRight: string,
  innerWidth: number
): { left: string; right: string } {
  // status/elapsed must stay fully visible (more time-sensitive than the
  // model/effort token) — truncate the LEFT side first if the line is tight.
  const rightBudget = Math.min(statusRight.length, innerWidth)
  const right = statusRight.slice(statusRight.length - rightBudget)
  const leftBudget = Math.max(0, innerWidth - rightBudget)
  const left = truncate(modelEffort, leftBudget).padEnd(leftBudget)
  return { left, right: right.padStart(rightBudget) }
}

export function WorkspaceCard(props: WorkspaceCardProps): JSX.Element {
  const gutter = (): string => gutterContentFor(props.selected)
  const innerWidth = (): number => Math.max(1, props.width - 1)
  const bg = (): string | undefined => (props.selected ? props.palette.selectedBg : undefined)

  // ---- Line 1: model/effort (left) + status/elapsed (right) ----
  // AGENT NAME SEAM: intentionally omitted — no per-workspace agent-identity
  // field exists yet; see docs/TUI_OPENTUI_DESIGN.md/task history for
  // context. When one exists, prefix it here, before modelEffortText.
  const modelEffortText = (): string => formatModelEffort(props.model, props.effort)
  const statusWord = (): string => STATUS_LABEL[props.row.status]
  const elapsed = (): string => formatAge(props.row.lastActivityAt)
  const statusRight = (): string => `${statusWord()} ${elapsed()}`
  const line1 = (): { left: string; right: string } =>
    line1Parts(modelEffortText(), statusRight(), innerWidth())
  const statusBold = (): boolean => props.row.status === 'attention'

  // ---- Line 2: title ----
  const titleText = (): string =>
    truncate(displayTitleFor(props.row), innerWidth()).padEnd(innerWidth())

  // ---- Line 3: branch (blank when none — card stays exactly 3 lines) ----
  const branchText = (): string => {
    if (props.row.worktreeBranch == null) return ''.padEnd(innerWidth())
    const raw = `${WORKTREE_GLYPH} ${props.row.worktreeBranch}`
    return truncate(raw, innerWidth()).padEnd(innerWidth())
  }

  return (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row" height={1} flexShrink={0}>
        <text fg={props.palette.accent} bg={bg()}>
          {gutter()}
        </text>
        <text bg={bg()} wrapMode="none" overflow="hidden">
          <span fg={props.palette.modelText}>{line1().left}</span>
          <span
            fg={statusColor(props.row.status, props.palette)}
            attributes={statusBold() ? TextAttributes.BOLD : undefined}
          >
            {line1().right}
          </span>
        </text>
      </box>
      <box flexDirection="row" height={1} flexShrink={0}>
        <text fg={props.palette.accent} bg={bg()}>
          {gutter()}
        </text>
        <text
          bg={bg()}
          fg={props.selected ? props.palette.accent : props.palette.text}
          attributes={TextAttributes.BOLD}
          wrapMode="none"
          overflow="hidden"
        >
          {titleText()}
        </text>
      </box>
      <box flexDirection="row" height={1} flexShrink={0}>
        <text fg={props.palette.accent} bg={bg()}>
          {gutter()}
        </text>
        <text bg={bg()} fg={props.palette.secondary} wrapMode="none" overflow="hidden">
          {branchText()}
        </text>
      </box>
    </box>
  )
}
