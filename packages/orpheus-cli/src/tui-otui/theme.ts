/**
 * tui-otui/theme.ts — semantic palette + glyphs for the OpenTUI picker.
 *
 * Ported VALUES (not structure) from tui/theme.ts's DARK palette and glyph
 * set — see that file's big header comment for the full rationale (chalk's
 * 256-color downsample behavior, the "selection tint at every breakpoint"
 * bug post-mortem). OpenTUI's `fg`/`backgroundColor` props take hex strings
 * directly and the renderer does its own truecolor->256->16 degradation, so
 * there's no chalk-specific downsampling to reproduce here — the hex values
 * are carried over as-is because they were already chosen for legibility and
 * mutual distinctness, which holds regardless of which library degrades them.
 *
 * DARK-ONLY, LIKE THE INK VERSION
 * -----------------------------------------------------------------------
 * `renderer.themeMode` (via useRenderer() in Solid) CAN report "dark" |
 * "light" | null, and OpenCode's own theme system branches on it. This build
 * stays dark-only: no light palette has been designed against real terminal
 * screenshots, and shipping an unverified light palette risks a worse
 * regression (illegible text) than staying dark-only like the Ink version
 * did. App.tsx reads themeMode only to log a debug line if it's ever
 * something other than "dark"/null — see its file header.
 *
 * NO STRUCTURAL Palette/DARK SPLIT LIKE tui/theme.ts
 * -----------------------------------------------------------------------
 * tui/theme.ts separates "Palette" (semantic roles) from "DARK" (the actual
 * hex values) because it anticipated a future light palette needing the same
 * shape. Same anticipation applies here, so the shape is kept, just declared
 * directly as one exported `PALETTE` object (OpenTUI/Solid convention is
 * lowerCamel/UPPER_SNAKE constants rather than a re-exported `activePalette`
 * alias) — a future light palette would follow the exact same pattern the
 * Ink version documents.
 *
 * GLYPH-SAFETY OVERHAUL (card redesign — do not reintroduce ambiguous glyphs)
 * -----------------------------------------------------------------------
 * Every "fancy" glyph previously in this file (`●` U+25CF, `○` U+25CB,
 * `◆` U+25C6, `▲` U+25B2, `▼` U+25BC, `▌` U+258C, `│` U+2502, `─` U+2500,
 * `·` U+00B7) is East_Asian_Width=Ambiguous per the Unicode Consortium's own
 * EastAsianWidth.txt — meaning it renders as TWO columns on a terminal
 * configured for CJK, silently breaking every column alignment in this app.
 * Verified against the actual data file, not guessed — `string-width`
 * (already a dependency, used by tui/layout.ts's truncate()) measures the
 * OPTIMISTIC non-CJK case and will happily report 1 for these, so it must
 * NEVER be used to validate glyph safety; only a real EastAsianWidth.txt
 * lookup counts as verification. Every glyph below is either from the
 * pre-verified safe list (Na/N basic ASCII punctuation, plus `…` U+2026 and
 * `⎇`/`»` which were separately confirmed Narrow) or was independently
 * looked up against the same file.
 */

export interface Palette {
  /** Needs the user's attention right now — sorts first, reddest signal. */
  attention: string
  /** Actively running (in_progress) — calm but energetic. */
  working: string
  /** Waiting on the model / awaiting_input — cool, "in flight". */
  awaiting: string
  /** idle / muted metadata. */
  idle: string
  /** Brand/selection accent — gutter bar/dot, active project headers, selected-row text. */
  accent: string
  /** Border/rule color at medium+ breakpoints. */
  border: string
  /** Secondary text — dimmer than primary but still readable at any level. */
  secondary: string
  /** Background tint for the selected row — ALL breakpoints. */
  selectedBg: string
  /** Background tint for a currently tmux-hosted ("open") row — distinct from selectedBg. */
  openBg: string
  /** Primary/default text color. */
  text: string
  /** App background. */
  background: string
  /** model/effort text color — distinct from all four status hues so the
   *  two systems (status vs model/effort) never look related at a glance. */
  modelText: string
}

/**
 * Status colors updated for the card redesign (task brief's exact hexes):
 *   attention: #ff6b6b (was #ff5d62 — "reds tuned off pure: #ff0000
 *     vibrates against a near-black ground")
 *   working (displayed as "in progress"): #7aa2f7 (was #7fd88f — this hex
 *     was previously `awaiting`'s value; working/in-progress now takes it)
 *   awaiting: #ffcc66 (NEW — previously awaiting shared working's old hex;
 *     now has its own distinct yellow)
 *   idle: #8a90a6 (nudged from #6b7089 to the brief's exact suggested hex —
 *     same neighborhood, kept for consistency with the brief)
 */
export const PALETTE: Palette = {
  attention: '#ff6b6b',
  working: '#7aa2f7',
  awaiting: '#ffcc66',
  idle: '#8a90a6',
  accent: '#bb9af7',
  border: '#3b3f58',
  secondary: '#8b90a8',
  selectedBg: '#2a2e45',
  // A dimmer, cooler tint than selectedBg — "this workspace is live in tmux"
  // is a state, not a cursor position, so it must stay visually subordinate
  // to the (brighter, purple-accented) keyboard-focus row per the task's
  // three-way row state requirement. Distinct hue from selectedBg (which
  // leans toward the accent purple) so the two never look like the same
  // signal at a glance.
  openBg: '#1f2937',
  text: '#e3e5f0',
  background: '#0f1117',
  // Neutral teal-grey — distinct from attention (#ff6b6b red), working
  // (#7aa2f7 blue), awaiting (#ffcc66 yellow), and idle (#8a90a6 grey-blue).
  modelText: '#5fb3a3'
}

// ---------------------------------------------------------------------------
// Glyphs — VERIFIED single-width only. See file header for the verification
// method. Every entry below is either plain ASCII (Na/N by construction) or
// was independently checked against EastAsianWidth.txt.
// ---------------------------------------------------------------------------

/** Worktree-branch marker, prefixed to line 3 of a card (`⎇ branch`).
 *  U+2387 — confirmed Narrow (N) in EastAsianWidth.txt; pre-verified safe
 *  per the task brief, kept unchanged from its prior use as a "keep using
 *  it" glyph. */
export const WORKTREE_GLYPH = '⎇'

/** "This workspace is live in tmux" marker — U+00BB, confirmed Narrow (N);
 *  pre-verified safe, kept unchanged. */
export const OPEN_GLYPH = '»'

/** Gutter rune: reserved 1-column-wide leading slot on every card line.
 *  Selected: `|` (U+007C, Na). Unselected: ` ` (space, Na). No bar/dot
 *  distinction anymore — see App.tsx/WorkspaceCard.tsx for the "reserve the
 *  slot, swap the rune" technique this replaces SELECTION_BAR/SELECTION_DOT
 *  with. */
export const GUTTER_SELECTED = '|'
export const GUTTER_EMPTY = ' '

/** Footer/keymap hint separator — was `' · '` (U+00B7 MIDDLE DOT, confirmed
 *  AMBIGUOUS despite looking like it should be narrow). Tried a plain-ASCII
 *  `' - '` (U+002D HYPHEN-MINUS, confirmed Narrow) first — verified glyph-
 *  safe, but reviewed live via tui-mcp against a plain triple-space and the
 *  dash read as visual noise next to already-bold/accent-colored key labels
 *  (each key is already visually distinct without a punctuation separator).
 *  Settled on three plain spaces — still trivially Na (space is Na), zero
 *  extra glyphs, and the live render reads cleaner. */
export const KEYMAP_SEPARATOR = '   '

/**
 * Horizontal rule character, used only where a rule still renders (the
 * card redesign drops the TitleBar's own rule entirely in favor of a blank
 * line — see App.tsx/TitleBar.tsx — but Rule.tsx itself is kept for other
 * callers, e.g. HelpOverlay's internal layout). Was `─` (U+2500 BOX DRAWINGS
 * LIGHT HORIZONTAL, confirmed Ambiguous); replaced with `-` (U+002D
 * HYPHEN-MINUS, confirmed Narrow).
 */
export const RULE_CHAR = '-'

/**
 * Vertical rule character for the wide master/detail split — the only
 * vertical rule in the whole layout, and it disappears entirely below the
 * wide breakpoint. Was `│` (U+2502 BOX DRAWINGS LIGHT VERTICAL, confirmed
 * Ambiguous); replaced with `|` (U+007C VERTICAL LINE, confirmed Narrow —
 * already verified above as the gutter rune).
 */
export const VRULE_CHAR = '|'

/** Gutter width in characters: always 1 — the reserved-gutter-slot
 *  technique (task brief's "reserve the slot, swap the rune"). Kept as a
 *  named export (rather than an inline literal) so every card line agrees
 *  on the same width without re-deriving it. */
export const CARD_GUTTER_WIDTH = 1

/** The gutter's rendered content for a card line — `|` when the card is
 *  selected, a single space otherwise. Same column, same width, on ALL
 *  THREE lines of a card, always present — never added/removed on
 *  selection (see WorkspaceCard.tsx for how this is applied per-line). */
export function gutterContentFor(selected: boolean): string {
  return selected ? GUTTER_SELECTED : GUTTER_EMPTY
}
