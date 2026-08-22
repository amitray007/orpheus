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
 * @param footerVisible whether the footer will actually render — its height is
 *   reserved ONLY when true. It used to be subtracted unconditionally, so
 *   turning the footer off left a footer-sized band of empty chrome under the
 *   terminal instead of returning that height to the terminal.
 */
export function quantizeTerminalColumn(
  columnHeight: number,
  cellHeightPx: number | null,
  dpr: number,
  footerVisible: boolean,
  footerHeightPx: number
): QuantizedColumn {
  if (cellHeightPx == null || cellHeightPx <= 0) return null
  const available = columnHeight - (footerVisible ? footerHeightPx : 0)
  if (available <= 0) return null
  const ratio = dpr || 1
  const snappedCss = (Math.floor((available * ratio) / cellHeightPx) * cellHeightPx) / ratio
  const slack = available - snappedCss
  return { height: snappedCss, slackTop: Math.floor(slack / 2) }
}
