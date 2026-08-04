/**
 * tui/components/TitleBar.tsx — dense one-row title bar with right-aligned
 * status, replacing Header.tsx's two-row (title, then a separate status
 * line) shape plus a bordered-box bottom rule.
 *
 * Direct port of tui-otui/components/TitleBar.tsx (OpenTUI/Solid) — see that
 * file's header for the full rationale this preserves:
 *
 * RENAME: filter -> view (card redesign). The underlying VALUE domain
 * ('active' | 'all' | 'used', still literally `Filter` from ../layout.js) is
 * unchanged; only the user/dev-facing NAME changed. Header text now reads
 * `view: active` / `view: all` / `view: used`, and the hidden-count hint
 * reads `N hidden (v)` (was `(f)`).
 *
 * NO CONNECTION GLYPH — `●`/`○` are both East_Asian_Width=Ambiguous. The
 * connection state is carried by its TEXT LABEL alone
 * ("connected"/"disconnected"/"connecting…") plus its color.
 *
 * FULL-WIDTH RULE BELOW THE BAR — 2 rows at EVERY breakpoint (title row +
 * rule), matching App.tsx's headerReservedFor(). An earlier revision left the
 * second row blank instead; the rule is what makes the top read as a nav bar
 * rather than as the first line of the list.
 *
 * WIDTH BUDGETING IS MANUAL — `width` (App.tsx passes the live CONTENT width,
 * already inset by the root frame's padding) drives an explicit split: the
 * title never truncates below the bare wordmark, and status takes what is
 * left after MIN_TITLE_GAP, disappearing entirely below MIN_STATUS_WIDTH
 * rather than degrading to an uninformative `...`. See those constants for
 * the narrow-terminal collision this arrangement fixes. The status CLUSTER
 * itself is now up to three independent parts (disconnected/connecting…,
 * N hidden (v), view: <name> — see buildStatusParts below) that no longer
 * all-or-nothing truncate together: buildStatusText greedy-prefix-fits them
 * in priority order instead, so the highest-priority facts survive even when
 * the lowest-priority one (the view name) has to be dropped.
 */

import * as React from 'react'
import { Box, Text } from 'ink'
import { type Filter, type ProjectScope } from '../layout.js'
import type { Palette } from '../theme.js'
import { NAV_DIVIDER_CHAR } from '../theme.js'

export interface TitleBarProps {
  scope?: ProjectScope
  connected: boolean
  disconnected: boolean
  hiddenCount: number
  /** Current picker filter — rendered as `view: <name>` in the status
   *  cluster (see the file header's "VIEW NAME" section for why this is
   *  now always-on rather than another conditional part). */
  view: Filter
  palette: Palette
  /** Live terminal width — drives the manual title/status split. */
  width: number
}

/** Brand mark glyph — U+2726 BLACK FOUR POINTED STAR, East_Asian_Width=N
 *  (single width, verified against EastAsianWidth.txt). Unlike the card's
 *  selection rail — which lives in a fixed-width Box and merely clips if a
 *  terminal renders it double-width — this glyph sits inline in a flowing
 *  text row, so an Ambiguous-width mark WOULD shift the status text right by
 *  a column in a CJK-configured terminal. `N` is safe; `◆ ● ▲ ■ ·` are all
 *  Ambiguous and must not be substituted here without re-checking. */
const BRAND_GLYPH = '\u2726'
const BRAND_NAME = 'Orpheus'

/** Columns the spacer between wordmark and status is never allowed to drop
 *  below — see the status-budget comment in TitleBar for the collision this
 *  prevents. */
const MIN_TITLE_GAP = 2
/** Below this many columns the status is dropped rather than truncated: a
 *  status clipped to `...` spends the row's scarcest columns saying nothing,
 *  and the connection state is still carried by colour. */
const MIN_STATUS_WIDTH = 12

/** Separator joining status-cluster parts — same three-space glyph-safe
 *  choice as theme.ts's KEYMAP_SEPARATOR, kept LOCAL rather than imported:
 *  that constant's own doc comment scopes it to the footer's keymap hints,
 *  and this is a different row with its own (shorter, ' - ') separator
 *  already established by the status cluster below — not worth coupling the
 *  two just to share one string. */
const STATUS_SEPARATOR = ' - '

/**
 * One entry in the status cluster's PRIORITY-ORDERED part list — priority
 * is greedy-prefix order (see buildStatusText below), highest first.
 */
interface StatusPart {
  text: string
  color: string
}

/**
 * VIEW NAME — now always-on, not conditional like `disconnected`/`hidden`.
 *
 * The task that dropped `view: all` from this bar (see the file header's
 * "SHOW ONLY WHAT THE USER CANNOT SEE FOR THEMSELVES" note) was right that
 * `all` said nothing extra — but that logic assumed only two filters, one of
 * which (`all`) was also the default. With THREE filters now in the cycle
 * (`used` added), the current view is no longer inferable from silence: a
 * blank status could mean `all` (nothing hidden) OR `used` (would also show
 * nothing under the old rule) OR the terminal is too narrow to say. So
 * `view: <name>` is now unconditionally part of the cluster.
 *
 * PRIORITY WHEN THEY CAN'T ALL FIT — greedy-prefix, NOT the old
 * truncate-the-joined-string approach (see buildStatusText's doc comment for
 * why that changed). Order, highest priority first:
 *
 *   1. disconnected/connecting… — the one fact this bar exists to surface
 *      that is otherwise INVISIBLE: with no connection, the picker's body
 *      shows either a frozen last-known list or the "Connecting…" line, and
 *      neither of those explains WHY. Nothing else in the UI carries this,
 *      so it always wins the budget.
 *   2. N hidden (v) — tells the user rows are being withheld AND which key
 *      reveals them; without it, an active/used-filtered empty-looking list
 *      reads as "there's nothing" rather than "there's more, filtered out".
 *   3. view: <name> — LOWEST priority of the three, on purpose: the view
 *      name is also visible indirectly (the row COUNT and the "no workspaces
 *      — press v to show all" hint change with it), so it is the one part
 *      that degrades gracefully if it has to be the one dropped. It is only
 *      actually dropped at the very narrowest widths where the connection
 *      state or hidden-count already consumed the whole budget — see
 *      buildStatusText's prefix-fit loop.
 *
 * This still respects the pre-existing "drop rather than truncate to a
 * meaningless stub" rule: nothing here is ever character-truncated with an
 * ellipsis. A part either renders in full or is omitted entirely.
 */
function buildStatusParts(
  connected: boolean,
  disconnected: boolean,
  hiddenCount: number,
  view: Filter,
  palette: Palette
): StatusPart[] {
  const parts: StatusPart[] = []
  if (!connected) {
    parts.push({
      text: disconnected ? 'disconnected' : 'connecting…',
      color: disconnected ? palette.attention : palette.idle
    })
  }
  if (hiddenCount > 0) {
    parts.push({ text: `${hiddenCount} hidden (v)`, color: palette.secondary })
  }
  parts.push({ text: `view: ${view}`, color: palette.secondary })
  return parts
}

/**
 * Greedy-prefix fit: walk `parts` in priority order, keeping each one only
 * while the running total (text + its leading separator, once there's a
 * prior part) still fits `budget`. This REPLACES the old
 * `truncate(statusText, statusBudget)` call, which sliced the joined string
 * at a column boundary and appended `...` — fine when there was only ever
 * one or two parts and losing the tail of the LAST one was acceptable, but
 * wrong once `view: <name>` must never be silently mangled into `view: a...`
 * (meaningless — same "truncated to a stub" problem MIN_STATUS_WIDTH already
 * exists to avoid at the whole-cluster level, just recurring per-part now
 * that the cluster has three independent facts instead of one blob). Once a
 * part doesn't fit, every lower-priority part after it is dropped too — the
 * result is always a real PREFIX of the priority list, never a hole punched
 * in the middle, so the parts that DO render always read as a coherent,
 * complete-in-itself list (e.g. never "hidden (v) - view: all" with
 * "disconnected" silently missing from the front).
 */
function buildStatusText(parts: StatusPart[], budget: number): StatusPart[] {
  const kept: StatusPart[] = []
  let used = 0
  for (const part of parts) {
    const cost = part.text.length + (kept.length > 0 ? STATUS_SEPARATOR.length : 0)
    if (used + cost > budget) break
    kept.push(part)
    used += cost
  }
  return kept
}

export function TitleBar({
  scope,
  connected,
  disconnected,
  hiddenCount,
  view,
  palette,
  width
}: TitleBarProps): React.JSX.Element {
  const scopeSuffix = scope != null ? ` — ${scope.name}` : null
  // Width budget still counts the FULL rendered mark (glyph + space + name +
  // any scope suffix), even though it renders as several <Text> nodes.
  const title = `${BRAND_GLYPH} ${BRAND_NAME}${scopeSuffix ?? ''}`

  // Title never shrinks below its own text — the brand is the one thing that
  // must always be legible. Status takes what's left after a REAL gap.
  //
  // The gap used to be 1 column, which is what let the status collide with
  // the wordmark on a narrow terminal: the status is right-aligned by a
  // flexGrow spacer, so once its truncated text filled the remainder the
  // spacer collapsed to nothing and `connected - view: active - ...` began
  // immediately after `Orpheus`. MIN_TITLE_GAP is what the spacer is
  // guaranteed to keep.
  //
  // And below MIN_STATUS_WIDTH the WHOLE cluster is dropped rather than
  // rendering a single truncated fragment: at that point there isn't even
  // room for "view: all" (9 chars, the shortest possible cluster), so
  // showing anything at all would be a meaningless stub. Above that floor,
  // buildStatusText's own greedy-prefix logic (see its doc comment) decides
  // which INDIVIDUAL parts survive — this floor and that function are two
  // different tiers of the same "drop rather than truncate to a stub" rule,
  // one at the cluster level, one at the per-part level.
  const statusBudget = Math.max(0, width - title.length - MIN_TITLE_GAP)
  const statusParts = buildStatusParts(connected, disconnected, hiddenCount, view, palette)
  const visibleStatusParts =
    statusBudget >= MIN_STATUS_WIDTH ? buildStatusText(statusParts, statusBudget) : []

  return (
    <Box flexDirection="column">
      <Box width={width}>
        {/* WORDMARK, not a heading. A leading accent glyph gives the brand a
            fixed visual anchor at the top-left, and the underline treats
            `Orpheus` as a mark rather than as the first line of content —
            without spending a whole row on a rule. `scope` (the --project
            name) stays un-underlined: it is context, not part of the mark. */}
        <Text bold color={palette.accent}>
          {BRAND_GLYPH}{' '}
        </Text>
        <Text bold underline color={palette.brand} wrap="truncate-end">
          {BRAND_NAME}
        </Text>
        {scopeSuffix != null ? (
          <Text color={palette.secondary} wrap="truncate-end">
            {scopeSuffix}
          </Text>
        ) : null}
        {/* minWidth is the GAP, not 0 — with 0 the spacer collapsed and the
            status ran straight into the wordmark on a narrow terminal. Yoga
            now cannot shrink it below the gap, so the separation holds even
            if the budget arithmetic above is ever wrong. */}
        <Box flexGrow={1} minWidth={MIN_TITLE_GAP} justifyContent="flex-end">
          {/* Each surviving part keeps its OWN colour (disconnected/connecting
              read in their alarm/idle hue, hidden-count and view stay
              secondary) rather than the whole cluster sharing one colour —
              see buildStatusParts's doc comment for why `view:` must not
              inherit the connection colour it used to be the only occupant
              of this slot. wrap="truncate-end" here is a pure safety net:
              buildStatusText already guarantees the joined text fits
              statusBudget, so this should never actually clip anything. */}
          <Text wrap="truncate-end">
            {visibleStatusParts.map((part, i) => (
              <React.Fragment key={part.text}>
                {i > 0 ? <Text color={palette.secondary}>{STATUS_SEPARATOR}</Text> : null}
                <Text color={part.color}>{part.text}</Text>
              </React.Fragment>
            ))}
          </Text>
        </Box>
      </Box>
      {/* Full-width rule: this is what turns the title row into a nav bar. */}
      <Box width={width}>
        <Text color={palette.border}>{NAV_DIVIDER_CHAR.repeat(Math.max(0, width))}</Text>
      </Box>
    </Box>
  )
}
