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
}

/** Ported verbatim from tui/theme.ts's DARK palette. */
export const PALETTE: Palette = {
  attention: '#ff5d62',
  working: '#7fd88f',
  awaiting: '#7aa2f7',
  idle: '#6b7089',
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
  background: '#0f1117'
}

// ---------------------------------------------------------------------------
// Glyphs — single-width only, ported from tui/theme.ts + tui/layout.ts.
// ---------------------------------------------------------------------------

export const ATTENTION_GLYPH = '!'
export const WORKING_GLYPH = '●'
export const IDLE_GLYPH = '○'
export const WORKTREE_GLYPH = '»'
/** Simpler `└ ` scheme (not full ├─/│ continuation lines) — see App.tsx's
 * indentFor() doc comment for why this deviates from the design spec's
 * fuller ASCII-tree suggestion. */
export const CHILD_INDENT = '└ '
export const OPEN_GLYPH = '»'

export const SELECTION_BAR = '▌'
export const SELECTION_DOT = '●'
export const SELECTION_GUTTER_EMPTY = ' '
export const SCROLL_UP_GLYPH = '▲'
export const SCROLL_DOWN_GLYPH = '▼'
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
export const SPINNER_INTERVAL_MS = 250
export const KEYMAP_SEPARATOR = ' · '

/** Gutter width in characters: 1 (bar) at narrow, 2 (dot + trailing space) at medium/wide. */
export function gutterWidthFor(breakpoint: 'narrow' | 'medium' | 'wide'): number {
  return breakpoint === 'narrow' ? 1 : 2
}

/** The gutter's rendered content for a row — bar/dot when selected, matching blank space otherwise. */
export function gutterContentFor(
  breakpoint: 'narrow' | 'medium' | 'wide',
  selected: boolean
): string {
  const width = gutterWidthFor(breakpoint)
  if (!selected) return SELECTION_GUTTER_EMPTY.repeat(width)
  const glyph = breakpoint === 'narrow' ? SELECTION_BAR : SELECTION_DOT
  return (glyph + SELECTION_GUTTER_EMPTY.repeat(width - 1)).slice(0, width)
}
