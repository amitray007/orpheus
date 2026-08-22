// ---------------------------------------------------------------------------
// src/renderer/src/lib/terminalQuantization.ts
//
// Pure height math for the workspace terminal column, extracted from
// WorkspaceView so it can be asserted directly (no DOM, no ResizeObserver, no
// devicePixelRatio guessing) instead of only through a rendered component.
//
// The terminal host is snapped DOWN to a whole multiple of the ghostty cell
// height so the native surface never renders a clipped half-row. Whatever the
// floor() leaves over is "slack", split above and below the terminal.
// ---------------------------------------------------------------------------

/** Result of quantizing a column. `null` means "not quantizable yet" — the
 *  caller keeps its plain flex-1 behaviour rather than committing to a
 *  fabricated height. */
export type QuantizedColumn = { height: number; slackTop: number } | null

/**
 * @param columnHeight  the whole column's CSS-px height
 * @param cellHeightPx  ghostty's cell height in PHYSICAL px (null/0 until known)
 * @param dpr           devicePixelRatio
 */
export function quantizeTerminalColumn(
  columnHeight: number,
  cellHeightPx: number | null,
  dpr: number
): QuantizedColumn {
  if (cellHeightPx == null || cellHeightPx <= 0) return null
  if (columnHeight <= 0) return null
  const ratio = dpr || 1
  const snappedCss = (Math.floor((columnHeight * ratio) / cellHeightPx) * cellHeightPx) / ratio
  const slack = columnHeight - snappedCss
  return { height: snappedCss, slackTop: Math.floor(slack / 2) }
}
