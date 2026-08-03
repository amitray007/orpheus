/**
 * tui/theme.ts — the single source of truth for every color, glyph, and
 * chrome character the TUI renders.
 *
 * No component references a raw hex/ANSI color or a decorative glyph
 * directly — everything is named here so a palette change is a one-file
 * edit, and so `sonarjs/no-duplicate-string` (threshold 5, see CLAUDE.md)
 * never trips on a literal like '#7c8cff' scattered across components.
 *
 * PALETTE VALUES ARE ARBITRARY HEX — chalk (which Ink's `color`/
 * `backgroundColor` route through) downsamples truecolor to 256/16/none
 * automatically per-terminal. Its real 256-color downsampler matches
 * against BOTH the 6x6x6 cube AND the 24-step grayscale ramp (xterm
 * indices 232-255) and picks whichever is closer — `paletteDriftReport()`
 * below reproduces that full algorithm (not a cube-only approximation) so
 * a future palette edit can check its actual downsample drift before
 * shipping. An earlier revision of this file constrained every value to
 * cube-exact steps based on a cube-only drift measurement that looked bad
 * (e.g. reported `selectedBg` #2a2e45 as "collapsing to near-black");
 * re-measuring with the grayscale ramp included showed the original
 * values survive downsampling fine (#2a2e45 -> ramp index 236 =
 * rgb(48,48,48), essentially preserved) — so there was no real problem,
 * and the cube constraint was reverted. Pick colors for how they look and
 * how distinct they are from each other; verify drift with
 * `paletteDriftReport()` if you're unsure, don't pre-constrain to a cube.
 *
 * ONE PALETTE, NOT A HAND-MAINTAINED PER-LEVEL SET
 * -----------------------------------------------------------------------
 * chalk's own downsampling is sufficient from truecolor all the way down
 * to 256-color — there's no need to hand-maintain a separate ANSI16
 * palette. `colorLevel()` still exists but currently has no palette-
 * selection or gating role at all; it's kept in place because *something*
 * in this file will eventually need to know the terminal's actual color
 * depth, and re-deriving it is more error-prone than keeping the one
 * already-correct implementation around.
 *
 * SELECTION MUST BE UNMISSABLE (see WorkspaceRow.tsx)
 * -----------------------------------------------------------------------
 * A real user reported that pressing up/down did not visibly highlight
 * the selected row. Root cause: the selection background tint
 * (`selectedBg`) was gated to medium/wide only, reasoning that a 44-col
 * narrow terminal had no "spare width" for it — but a `backgroundColor`
 * colors EXISTING characters, it doesn't consume extra columns, so that
 * reasoning was simply wrong (there never was a space constraint). At
 * narrow, that left only a 1-character gutter glyph and a text-color
 * change as signals — and for an `attention`-status row specifically
 * (already rendered bold regardless of selection), the text-color change
 * was the ONLY thing that changed, which is genuinely easy to miss at a
 * glance. Fix: the tint now applies at every breakpoint whenever a row is
 * selected — see WorkspaceRow.tsx's `rowBackground`.
 */

import * as tty from 'node:tty'
import type { Breakpoint } from './layout.js'

// ---------------------------------------------------------------------------
// Color level detection
// ---------------------------------------------------------------------------

export type ColorLevel = 0 | 1 | 2 | 3

/**
 * 0 = no color, 1 = 16-color, 2 = 256-color, 3 = truecolor. Uses Node's
 * built-in `WriteStream#getColorDepth`, which already honors NO_COLOR /
 * FORCE_COLOR / --color and the terminal's actual capabilities — no need
 * for a `chalk`/`supports-color` dependency just to re-derive this.
 *
 * `getColorDepth` only exists on `tty.WriteStream.prototype` — in
 * production `process.stdout` is always one (runTui() hard-requires
 * `isTTY === true` before ever mounting, see entry.ts), but a piped/
 * redirected stream (headless test harnesses, `orpheus tui | cat`) lacks
 * the method entirely. Its implementation only reads `env`/`process.
 * platform`, never `this`, so calling it unbound still correctly honors
 * NO_COLOR/FORCE_COLOR/CI env vars even off a non-TTY stream — falling
 * back to a bare `1` there would silently ignore an explicit
 * FORCE_COLOR=3 in exactly the no-color verification this function exists
 * to support.
 */
export function colorLevel(stream: NodeJS.WriteStream = process.stdout): ColorLevel {
  if (process.env.NO_COLOR != null && process.env.NO_COLOR !== '') return 0
  const getColorDepth =
    stream.getColorDepth?.bind(stream) ?? tty.WriteStream.prototype.getColorDepth
  const depth = getColorDepth()
  if (depth >= 24) return 3
  if (depth >= 8) return 2
  if (depth >= 4) return 1
  return 0
}

// ---------------------------------------------------------------------------
// Semantic palette
// ---------------------------------------------------------------------------

export interface Palette {
  /** Needs the user's attention right now — sorts first, reddest signal. */
  attention: string
  /** Actively running (in_progress) — calm but energetic. */
  working: string
  /** Waiting on the model / awaiting_input — cool, "in flight". */
  awaiting: string
  /** idle / muted metadata. */
  idle: string
  /**
   * SELECTION ONLY — the rail and the selected card's title. Nothing else.
   *
   * This colour previously did nine jobs at once (wordmark, project headers,
   * selection rail, selected title, scroll arrows, footer keys, help keys,
   * detail heading), which is why the UI read as uniformly purple: a hue
   * meaning "brand" AND "cursor" AND "key hint" AND "group label"
   * simultaneously carries no information. Selection is a *cursor*, so it
   * keeps the one job that genuinely needs an attention-grabbing hue, and
   * must stay distinct from every status colour above — otherwise a selected
   * row of some status and an unselected row of that same status blur
   * together.
   */
  accent: string
  /** The `Orpheus` wordmark. Its own colour so the brand mark is not the
   *  same ink as the selection cursor — they are unrelated concepts that
   *  happened to share a hex. */
  brand: string
  /** Project group headers. A structural label, not a cursor and not brand:
   *  it should read as quiet scaffolding that organises the list. */
  groupLabel: string
  /** Key glyphs in the footer and help overlay (`enter`, `j/k`, `q`). These
   *  are affordances, not selection state, so they get their own quiet hue
   *  rather than borrowing the cursor's. */
  keyHint: string
  /** Border/rule color at medium+ breakpoints. */
  border: string
  /** Secondary text — dimmer than primary but still readable at any level. */
  secondary: string
  /** Primary text — the card's title line when NOT selected. */
  text: string
  /** The card's line-1 model/effort token — deliberately dimmer than `text`
   *  so the title (line 2) stays the card's focal point. */
  modelText: string
  /** Background tint for the selected row — ALL breakpoints (see WorkspaceRow.tsx). */
  selectedBg: string
}

/**
 * Dark-background palette (this app's only wired palette today — a light
 * variant is a straightforward follow-up, not implemented since nothing
 * currently detects the terminal's background). Values are chosen for
 * legibility and for being mutually distinct, not constrained to a color
 * cube (see the file header) — run `paletteDriftReport()` after editing
 * any of these to confirm the 256-color downsample still lands close.
 *
 * CARD REDESIGN — VALUES UPDATED TO MATCH tui-otui/theme.ts's PALETTE
 * -----------------------------------------------------------------------
 * These are the exact hex values the card-redesign brief specifies (also
 * ported into tui-otui/theme.ts's PALETTE — see that file's own header for
 * the full per-value rationale):
 *   attention: #ff6b6b (was #ff5d62 — tuned off pure red, which vibrates
 *     against a near-black ground)
 *   working (displayed as "in progress"): #7aa2f7 (was #7fd88f — this hex
 *     was previously `awaiting`'s value; working/in-progress now takes it)
 *   awaiting: #ffcc66 (was #7aa2f7 — now has its own distinct yellow)
 *   idle: #8a90a6 (was #6b7089 — same neighborhood, nudged to the brief's
 *     exact suggested hex)
 * accent/border/secondary/text/modelText/selectedBg are unchanged from the
 * pre-redesign values.
 */
const DARK: Palette = {
  attention: '#ff6b6b',
  working: '#7aa2f7',
  awaiting: '#ffcc66',
  // Neutral grey, NOT the previous purple-tinted #8a90a6. That value and
  // `secondary` both snapped to the SAME 256-colour index (#8787af), so on a
  // 256-colour terminal an idle status and ordinary secondary text were
  // literally indistinguishable — and both carried a violet cast that fed
  // the "everything is purple" wash.
  idle: '#7d8590',
  // Cyan — the ONE saturated accent left, reserved for selection. Distinct
  // from attention (red), working (blue), awaiting (yellow) and idle (grey).
  // Deliberately not purple/magenta: with the wordmark, group labels and key
  // hints no longer sharing this hue, the cursor is the only thing that
  // reaches for the eye.
  accent: '#39c5cf',
  // Wordmark. Soft off-white with a cool cast — present without shouting,
  // and clearly not the cursor.
  brand: '#c9d1d9',
  // Project headers: quiet structural scaffolding. Dimmer than `text` so a
  // group label never competes with the workspace titles beneath it.
  groupLabel: '#8b949e',
  // Key glyphs. Muted green reads as "you can press this" without pulling
  // against the cursor's cyan or any status hue.
  keyHint: '#7ee787',
  border: '#30363d',
  // Neutral grey — the violet cast is gone here too (was #8b90a8).
  secondary: '#8b949e',
  text: '#e6edf3',
  // Neutral teal-grey — distinct from attention (red), working (blue),
  // awaiting (yellow) and idle (grey), so line 1's model token never reads
  // as a status colour.
  modelText: '#5fb3a3',
  // Cool near-neutral tint. Was #2a2e45, a visibly indigo block behind every
  // selected card; this reads as "lit" rather than "coloured".
  selectedBg: '#21262d'
}

/**
 * The active palette. There is only one (see the file header's "ONE
 * PALETTE" note) — colorLevel() isn't used to pick different hex values
 * at all. A future light-background palette would turn this into a real
 * function of terminal-background detection; nothing currently detects
 * that, so there's no parameter to thread through yet.
 */
export const activePalette: Palette = DARK

// ---------------------------------------------------------------------------
// 256-color downsample drift verification — not used at runtime, only by
// the render proof / manual palette audits (see the file header). Kept
// here rather than in a throwaway script so the NEXT palette edit has the
// check on hand. Reproduces xterm's REAL 256-color quantization: for each
// channel, checks distance against both the 6x6x6 color cube (216 colors,
// steps 00/5F/87/AF/D7/FF) AND the 24-step grayscale ramp (xterm indices
// 232-255, values 8,18,28...238) and reports whichever is closer overall —
// a cube-only check (an earlier version of this function) systematically
// over-reports drift for anything near-gray, which is exactly what
// `selectedBg` is.
// ---------------------------------------------------------------------------

const CUBE_STEPS = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff]
/** xterm-256 grayscale ramp: 24 steps, indices 232-255, value = 8 + 10*i. */
const GRAYSCALE_STEPS = Array.from({ length: 24 }, (_, i) => 8 + i * 10)

function nearestStep(channel: number, steps: number[]): number {
  return steps.reduce((closest, step) =>
    Math.abs(step - channel) < Math.abs(closest - channel) ? step : closest
  )
}

function channelDrift(
  channels: [number, number, number],
  snapped: [number, number, number]
): number {
  return channels.reduce((sum, c, i) => sum + Math.abs(c - snapped[i]!), 0)
}

function toHex(channels: [number, number, number]): string {
  return '#' + channels.map((c) => c.toString(16).padStart(2, '0')).join('')
}

export interface DriftEntry {
  name: string
  hex: string
  /** The nearest real 256-color match — either a cube color or a grayscale-ramp gray, whichever is closer. */
  snappedHex: string
  /** Which xterm-256 region the nearest match came from. */
  matchedFrom: 'cube' | 'grayscale'
  /** Sum of the absolute per-channel (R,G,B) distance to the nearest 256-color match. 0 = exact match. */
  drift: number
}

/** For each palette entry: its hex, the nearest ACTUAL 256-color match (cube or grayscale ramp), and the drift. */
export function paletteDriftReport(palette: Palette = DARK): DriftEntry[] {
  return Object.entries(palette).map(([name, hex]) => {
    const n = Number.parseInt(hex.slice(1), 16)
    const channels: [number, number, number] = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]

    const cubeSnapped = channels.map((c) => nearestStep(c, CUBE_STEPS)) as [number, number, number]
    const cubeDrift = channelDrift(channels, cubeSnapped)

    const grayValue = nearestStep(
      Math.round((channels[0] + channels[1] + channels[2]) / 3),
      GRAYSCALE_STEPS
    )
    const graySnapped: [number, number, number] = [grayValue, grayValue, grayValue]
    const grayDrift = channelDrift(channels, graySnapped)

    const useGray = grayDrift < cubeDrift
    const snapped = useGray ? graySnapped : cubeSnapped
    const drift = useGray ? grayDrift : cubeDrift

    return {
      name,
      hex,
      snappedHex: toHex(snapped),
      matchedFrom: useGray ? 'grayscale' : 'cube',
      drift
    }
  })
}

// ---------------------------------------------------------------------------
// Glyphs — single-width only (see docs/TUI_SPEC.md: no emoji, meaning is
// carried by colour+glyph together, never colour alone).
// ---------------------------------------------------------------------------

/** Left gutter accent bar for the selected row — narrow breakpoint. */
export const SELECTION_BAR = '▌'
/** Left gutter accent dot for the selected row — medium/wide breakpoint. */
export const SELECTION_DOT = '●'
/** Gutter placeholder for unselected rows — keeps columns from shifting. */
export const SELECTION_GUTTER_EMPTY = ' '
/** Rounded-border corners — modal surfaces ONLY (help overlay). Never a row, never the main list. */
export const BORDER_STYLE = 'round'
/** "N more" scroll affordance glyphs — always mounted, conditionally colored (see ScrollAffordance.tsx). */
export const SCROLL_UP_GLYPH = '▲'
export const SCROLL_DOWN_GLYPH = '▼'
/** Frames for the working-state spinner, driven by Ink's native `useAnimation` (see Spinner.tsx). */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
/** Tick interval for the spinner passed to `useAnimation({interval})` — see Spinner.tsx for why
 * this is deliberately slower than a typical 80-100ms spinner (SSH/phone link). */
export const SPINNER_INTERVAL_MS = 250
/** Separator between footer keymap hints, Lipgloss-style.
 *
 * CARD REDESIGN: was `' · '` (U+00B7 MIDDLE DOT) — confirmed
 * East_Asian_Width=Ambiguous per Unicode's EastAsianWidth.txt despite
 * looking like it should be narrow (see tui-otui/theme.ts's file header for
 * the verification method). A plain-ASCII `' - '` was tried first and
 * verified glyph-safe, but read as visual noise next to already-bold/
 * accent-colored key labels when reviewed live via tui-mcp. Settled on
 * three plain spaces — trivially Na (space is Na), zero extra glyphs, and
 * the live render reads cleaner. */
export const KEYMAP_SEPARATOR = '   '

/** Worktree-branch marker, prefixed to line 3 of a WorkspaceCard
 *  (`⎇ branch`) — U+2387, confirmed Narrow (N) in EastAsianWidth.txt. NOT
 *  the same export as layout.ts's `ROW_WORKTREE_GLYPH` (`»`) — that was the
 *  old one-line-row renderer's glyph (WorkspaceRow.tsx, deleted in the card
 *  redesign) and is unused now; this one is what WorkspaceCard.tsx actually
 *  imports and renders. */
export const WORKTREE_GLYPH = '⎇'

/** Horizontal rule character (Rule.tsx). Was `─` (U+2500 BOX DRAWINGS LIGHT
 *  HORIZONTAL, confirmed Ambiguous); replaced with `-` (U+002D
 *  HYPHEN-MINUS, confirmed Narrow). Not used by TitleBar.tsx (its own rule
 *  was dropped for a blank line — see TitleBar.tsx's file header); kept for
 *  other callers (e.g. DetailPane's internal layout). */
export const RULE_CHAR = '-'

/** Blank columns between the card list and the wide-tier detail pane. The
 *  divider itself is no longer a glyph constant: DetailPane draws it as its
 *  own left border (Ink's `borderStyle="single"`), because a separate rule
 *  column could not be kept row-aligned with the pane beside it — see
 *  DetailPane.tsx's header for the holes that produced. */
export const VRULE_PAD_X = 1

// ---------------------------------------------------------------------------
// Selection gutter — shared sizing between WorkspaceRow and ProjectHeaderRow
// so project names visually align with the workspace rows beneath them.
// ---------------------------------------------------------------------------

/** Gutter width in characters: 1 (bar) at narrow, 2 (dot + trailing space) at medium/wide. */
export function gutterWidthFor(breakpoint: Breakpoint): number {
  return breakpoint === 'narrow' ? 1 : 2
}

/** The gutter's rendered content for a row — bar/dot when selected, matching blank space otherwise. */
/**
 * The CARD gutter — 1 column, ASCII only, at every breakpoint.
 *
 * Deliberately NOT the `▌`/`●` glyphs gutterContentFor() uses for the older
 * one-line rows: both are East_Asian_Width=**A (Ambiguous)**, meaning a
 * CJK-configured terminal renders them TWO columns wide. In a card whose
 * every line is padded to an exact width, that one extra column overflows
 * the line and wraps it — silently, and only for some users. `|` is
 * East_Asian_Width=Na (Narrow), single-width everywhere by definition.
 *
 * The slot is always occupied — a space when unselected — so selecting a
 * card swaps a rune in place and can never shift layout by a cell.
 */
/**
 * The selection rail — U+258C LEFT HALF BLOCK. Repeated on each of the card's
 * three lines it joins vertically into ONE unbroken bar, which is the point:
 * an ASCII '|' repeated per row reads as three stacked pipes with visible
 * gaps at the row boundaries, not as a single marker for one object.
 *
 * This glyph is East_Asian_Width=**A (Ambiguous)** — 2 columns in a
 * CJK-configured terminal — and that is normally disqualifying here (see
 * ROW_WORKTREE_GLYPH's note in layout.ts). It is safe ONLY because the rail
 * lives in its own fixed-width <Box width={CARD_GUTTER_WIDTH}> sibling, never
 * inside a padded content string: a 2-column render clips at the box edge
 * instead of pushing the card's text one column right. Do NOT move this glyph
 * into a padEnd()'d line — every joining rail candidate (│ ┃ ▏ ▎) is
 * Ambiguous, so there is no ASCII escape hatch if that invariant breaks.
 */
export const CARD_GUTTER_SELECTED = '▌'
export const CARD_GUTTER_EMPTY = ' '
export const CARD_GUTTER_WIDTH = 1

/** Blank columns between the terminal edge and the rail, and again between
 *  the rail and the card text — so nothing sits flush against the border. */
export const CARD_PAD_GUTTER = 1

/** Blank columns held at the card's RIGHT edge, inside the selection tint.
 *  Without this the right-aligned status/elapsed token ends on the tint's
 *  last column — `idle 2h` sits flush against the highlight's border, which
 *  reads as clipped rather than as a padded object. Mirrors CARD_PAD_GUTTER
 *  on the left so the tinted block is symmetrically inset from its content. */
export const CARD_PAD_RIGHT = 1

/** Blank rows BELOW each card, separating it from the next. Lives here rather
 *  than in App.tsx so the card component (which renders the row) and the
 *  windowing height (which must budget for it) read the same constant. */
export const CARD_SEPARATOR_ROWS = 1

/** Card gutter content — see CARD_GUTTER_SELECTED. */
export function cardGutterFor(selected: boolean): string {
  return selected ? CARD_GUTTER_SELECTED : CARD_GUTTER_EMPTY
}

export function gutterContentFor(breakpoint: Breakpoint, selected: boolean): string {
  const width = gutterWidthFor(breakpoint)
  if (!selected) return SELECTION_GUTTER_EMPTY.repeat(width)
  const glyph = breakpoint === 'narrow' ? SELECTION_BAR : SELECTION_DOT
  return (glyph + SELECTION_GUTTER_EMPTY.repeat(width - 1)).slice(0, width)
}
