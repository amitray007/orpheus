/**
 * tui-otui/components/IdleWorkspaceRow.tsx — a compact ONE-LINE row for an
 * idle workspace (view: all only). Third incarnation of this file: started
 * as IdleBox.tsx (a bordered ASCII box around a collapsed group), became
 * IdleGroup.tsx (chrome removed, but still a passive, non-selectable footnote
 * under a dim `idle` label), and is now IdleWorkspaceRow.tsx — the owner
 * decided idle workspaces must be selectable and openable ("I should be able
 * to open idle workspaces to activate it too"), which makes them ordinary
 * workspaces that happen to be quiet, not a separate passive group. That
 * kills the rationale for a shared group label/indent scheme (there's no
 * longer a meaningful "the group" to label — each row stands on its own,
 * exactly like a WorkspaceCard) — so the `idle` label and indentation are
 * gone too, not just the box.
 *
 * WHY ONE LINE, NOT A FULL 3-LINE WorkspaceCard
 * -----------------------------------------------------------------------
 * Per the owner's own instinct (option 2 of the choices put to them): this
 * keeps the density win that motivated collapsing idle workspaces in the
 * first place (expensive to spend 3 rows/idle workspace at 44x12 when
 * several are dormant) while making them first-class for selection. The
 * height difference from an active WorkspaceCard (1 row vs 3) itself signals
 * "nothing running here" — no extra glyph or label needed to say it.
 *
 * SELECTION MUST WORK IDENTICALLY TO WorkspaceCard — SAME GUTTER, SAME BG
 * -----------------------------------------------------------------------
 * This is the load-bearing requirement from the owner's follow-up: "the
 * selection gutter must work identically on those one-line rows: same
 * reserved column, same rune swap, same background tint spanning the full
 * padded width. A selectable thing that highlights differently from its
 * neighbours is worse than no collapse at all." So this component reuses
 * WorkspaceCard's exact per-line technique — gutterContentFor() for the
 * reserved 1-col gutter, bg spanning the FULL padded width via ONE `<text
 * bg={...}>` — rather than inventing a new one.
 *
 * PAD-BEFORE-BG DISCIPLINE (same as WorkspaceCard.tsx's file header)
 * -----------------------------------------------------------------------
 * Content is assembled into one string, padded to the full available width,
 * THEN handed to a single `<text bg={...}>` — never padding-after-styling.
 */

import { gutterContentFor } from '../theme.js'
import type { Palette } from '../theme.js'
import { displayTitleFor, truncate, type DisplayRow } from '../../tui/layout.js'
import { formatAge } from '../format.js'

export interface IdleWorkspaceRowProps {
  row: Extract<DisplayRow, { kind: 'workspace' }>
  selected: boolean
  /** Full width available, INCLUDING the 1-col gutter — matches
   *  WorkspaceCard's own `width` contract so idle rows align with the
   *  cards above them. */
  width: number
  palette: Palette
}

export function IdleWorkspaceRow(props: IdleWorkspaceRowProps): JSX.Element {
  const gutter = (): string => gutterContentFor(props.selected)
  const innerWidth = (): number => Math.max(1, props.width - 1)
  const bg = (): string | undefined => (props.selected ? props.palette.selectedBg : undefined)

  const line = (): string => {
    const age = formatAge(props.row.lastActivityAt)
    const titleBudget = Math.max(1, innerWidth() - age.length - 1)
    const title = truncate(displayTitleFor(props.row), titleBudget).padEnd(titleBudget)
    return `${title} ${age}`.padEnd(innerWidth())
  }

  return (
    <box flexDirection="row" height={1} flexShrink={0}>
      <text fg={props.palette.accent} bg={bg()}>
        {gutter()}
      </text>
      <text
        bg={bg()}
        fg={props.selected ? props.palette.text : props.palette.idle}
        wrapMode="none"
        overflow="hidden"
      >
        {line()}
      </text>
    </box>
  )
}
