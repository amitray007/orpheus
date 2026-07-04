// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/editor/chromeTheme.ts
//
// The editor's NON-TOKEN chrome theme — background, foreground, cursor,
// selection, active-line highlight, gutter, line numbers, indent guides,
// scrollbars, focus ring — authored as a CodeMirror `EditorView.theme()`.
//
// docs/learnings/pierre-libraries.md §9 flags this as the gap: Shiki only
// colours the syntax TOKENS; everything else is CodeMirror's own DOM and must
// be themed separately or the editor won't match Pierre's <File> viewer. We
// close that gap by sourcing every chrome colour from the SAME `pierre-dark`
// theme JSON's `colors` map (`editor.background`, `editorCursor.foreground`,
// `editor.selectionBackground`, `editorLineNumber.foreground`, …) that Pierre's
// <File> renders with, and matching Pierre's typography exactly:
//   font-family : "SF Mono", Monaco, Consolas, … monospace  (--diffs-font-fallback)
//   font-size   : 13px                                       (--diffs-font-size)
//   line-height : 20px                                       (--diffs-line-height)
//   tab-size    : 2                                          (--diffs-tab-size)
// so toggling Viewer <-> Editor on the same file looks seamless.
// ---------------------------------------------------------------------------

import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import pierreDark from '@pierre/theme/pierre-dark'

// Pierre's <File> typography (from @pierre/diffs' shipped CSS custom-property
// defaults — see the doc comment above). Matched verbatim.
const FONT_FAMILY =
  '"SF Mono", Monaco, Consolas, "Ubuntu Mono", "Liberation Mono", "Courier New", monospace'
const FONT_SIZE = '13px'
const LINE_HEIGHT = '20px'
const TAB_SIZE = '2'

const colors = pierreDark.colors as Record<string, string>

// Pull each chrome colour from the pierre-dark map with a sensible fallback so a
// future theme edit that drops a key can't crash the editor.
const bg = colors['editor.background'] ?? '#0a0a0a'
// Re-exported so the read-only VIEWER (Pierre <File>) can paint its wrapper the
// SAME background. The <File> renders in a shadow root and only paints behind
// its actual text extent, so empty space below the last line / right of short
// lines would otherwise show the panel background as a seam. The viewer wrapper
// fills its region with this so viewer + editor read as one identical surface.
export const PIERRE_VIEWER_BG = bg
const fg = colors['editor.foreground'] ?? '#fafafa'
const cursor = colors['editorCursor.foreground'] ?? '#009fff'
const selectionBg = colors['editor.selectionBackground'] ?? '#009fff4d'
const activeLineBg = colors['editor.lineHighlightBackground'] ?? '#19283c8c'
const lineNumber = colors['editorLineNumber.foreground'] ?? '#737373'
const lineNumberActive = colors['editorLineNumber.activeForeground'] ?? '#a3a3a3'
const focusBorder = colors['focusBorder'] ?? '#009fff'

// Search-panel surfaces, all derived from the sourced pierre-dark values above
// so the find/replace UI reads as part of the same dark chrome (no new hex):
//   - panelBorder: a subtle divider from the foreground at low alpha.
//   - inputBg / buttonBg: a slightly raised dark from the foreground at very
//     low alpha over the editor background.
//   - accentSoft / accentSofter: translucent focus/accent blue for match
//     highlights and active toggles.
const panelBorder = `${fg}1f`
const inputBg = `${fg}0d`
const buttonBg = `${fg}14`
const buttonHoverBg = `${fg}1f`
const accentSoft = `${focusBorder}33`
const accentSofter = `${focusBorder}59`

/**
 * The pierre-dark surface palette the custom React search panel paints itself
 * with, so the app-native find/replace UI reads as part of the SAME dark editor
 * chrome (the editor is pierre-dark, independent of the app's accent). Every
 * value is sourced from the pierre-dark colours above — no new hex introduced.
 */
export const searchPanelPalette = {
  /** Panel + input + button text. */
  fg,
  /** Muted text (counts, placeholder, inactive icons). */
  muted: lineNumber,
  /** Editor background — the panel/input base. */
  bg,
  /** Subtle divider / control border. */
  border: panelBorder,
  /** Raised input background. */
  inputBg,
  /** Raised button background. */
  buttonBg,
  /** Button hover background. */
  buttonHoverBg,
  /** The pierre-dark focus/accent blue — focus rings + active toggles. */
  accent: focusBorder,
  /** Translucent accent for active-toggle fills. */
  accentSoft,
  /** Stronger translucent accent. */
  accentSofter,
  /** Monospace family matching the editor. */
  fontFamily: FONT_FAMILY
} as const

/**
 * The pierre-dark chrome theme for the CodeMirror editor. Dark-only (the Files
 * tab, like the viewer, is dark-only in Orpheus today). Applied alongside the
 * Shiki token bridge to reproduce the <File> look for the editable case.
 */
export const pierreDarkChromeTheme: Extension = EditorView.theme(
  {
    '&': {
      color: fg,
      backgroundColor: bg,
      fontSize: FONT_SIZE,
      height: '100%'
    },
    '.cm-scroller': {
      fontFamily: FONT_FAMILY,
      lineHeight: LINE_HEIGHT,
      tabSize: TAB_SIZE
    },
    '.cm-content': {
      caretColor: cursor
    },
    '&.cm-focused .cm-cursor': {
      borderLeftColor: cursor
    },
    // Selection — both the native selection layer and CM's drawn selection.
    '.cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: selectionBg
    },
    '&.cm-focused .cm-selectionBackground, &.cm-focused .cm-content ::selection': {
      backgroundColor: selectionBg
    },
    '.cm-activeLine': {
      backgroundColor: activeLineBg
    },
    // Gutter — matches the editor background so it reads as one surface (as
    // Pierre's <File> line-number gutter does), with muted numbers.
    '.cm-gutters': {
      backgroundColor: bg,
      color: lineNumber,
      border: 'none'
    },
    '.cm-lineNumbers .cm-gutterElement': {
      color: lineNumber,
      minWidth: '2.5ch',
      padding: '0 8px 0 12px'
    },
    '.cm-activeLineGutter': {
      backgroundColor: activeLineBg,
      color: lineNumberActive
    },
    '.cm-foldGutter .cm-gutterElement': {
      color: lineNumber
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: cursor
    },
    // Matching-bracket + focus outline use the theme's focus/accent blue.
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: `${focusBorder}33`,
      outline: `1px solid ${focusBorder}66`
    },
    '&.cm-editor.cm-focused': {
      outline: 'none'
    },
    '.cm-scroller::-webkit-scrollbar': {
      width: '10px',
      height: '10px'
    },
    '.cm-scroller::-webkit-scrollbar-thumb': {
      backgroundColor: `${fg}22`,
      borderRadius: '5px'
    },
    '.cm-scroller::-webkit-scrollbar-track': {
      backgroundColor: 'transparent'
    },
    // -- Find/Replace panel container -----------------------------------------
    // The panel's INNER UI is our own React component (EditorSearchPanel), which
    // paints its own surfaces from `searchPanelPalette` below. We only theme the
    // CM-owned panel CONTAINER here so it reads as one piece with the editor: a
    // pierre-dark background + a subtle bottom divider. (No default-panel
    // input/checkbox/button rules — the default panel is no longer rendered.)
    '.cm-panels': {
      backgroundColor: bg,
      color: fg
    },
    '.cm-panels.cm-panels-top': {
      borderBottom: `1px solid ${panelBorder}`
    },
    // Match highlights — translucent accent so found text stays visible on dark,
    // with a stronger variant for the currently-selected match.
    '.cm-searchMatch': {
      backgroundColor: accentSoft,
      outline: `1px solid ${accentSofter}`
    },
    '.cm-searchMatch-selected': {
      backgroundColor: accentSofter
    }
  },
  { dark: true }
)
