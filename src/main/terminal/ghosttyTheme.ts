// Parity gaps vs ghostty (documented, not fixable without trade-offs):
//   - Ligatures: disabled — they break under the WebGL renderer (xterm.js #3303).
//   - Scrollback: capped at 5,000 lines vs ghostty's 2,000,000 (JS-heap constraint).
//   - selection-foreground may not render in all xterm versions (field accepted but ignored).
//   - GPU text shaping / Kitty graphics not supported.

import type { GhosttyParsedTheme } from '../../shared/types'

const PALETTE_NAMES: (keyof GhosttyParsedTheme)[] = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
]

export function parseGhosttyTheme(text: string): GhosttyParsedTheme {
  const theme: GhosttyParsedTheme = {}

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue

    const eqIdx = line.indexOf('=')
    if (eqIdx < 0) continue

    const key = line.slice(0, eqIdx).trim()
    const value = line.slice(eqIdx + 1).trim()

    if (key === 'palette') {
      // Format: "palette = N=#rrggbb"
      const innerEq = value.indexOf('=')
      if (innerEq < 0) continue
      const idxStr = value.slice(0, innerEq).trim()
      const color = value.slice(innerEq + 1).trim()
      const idx = parseInt(idxStr, 10)
      if (isNaN(idx) || idx < 0 || idx > 15) continue
      const name = PALETTE_NAMES[idx]
      if (name) theme[name] = color
    } else if (key === 'background') {
      theme.background = value
    } else if (key === 'foreground') {
      theme.foreground = value
    } else if (key === 'cursor-color') {
      theme.cursor = value
    } else if (key === 'cursor-text') {
      theme.cursorAccent = value
    } else if (key === 'selection-background') {
      theme.selectionBackground = value
    } else if (key === 'selection-foreground') {
      theme.selectionForeground = value
    }
  }

  return theme
}
