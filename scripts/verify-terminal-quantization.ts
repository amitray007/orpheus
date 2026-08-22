// ---------------------------------------------------------------------------
// scripts/verify-terminal-quantization.ts
//
// Guards the workspace terminal's column height math.
//
// THE BUG: the footer's height was subtracted from the available column
// height UNCONDITIONALLY, and the absorbing wrapper around it painted a
// flex-1 band with its own background + seam border. WorkspaceFooter itself
// correctly returned null when the footer was toggled off — but the reserved
// height and the painted wrapper both remained, so hiding the footer left a
// footer-sized strip of empty chrome under the terminal instead of giving
// that space back.
//
// Asserted against the real exported function (no DOM), plus a structural
// pin that the wrapper is not rendered when the footer is hidden — the
// wrapper is JSX and cannot be driven from a plain harness.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { quantizeTerminalColumn } from '../src/renderer/src/lib/terminalQuantization.ts'

const FOOTER = 36
const CELL = 20 // physical px per ghostty cell row

// ---------------------------------------------------------------------------
// 1. THE REPORTED BUG: hiding the footer must return its height to the
//    terminal, not leave a reserved gap.
// ---------------------------------------------------------------------------
{
  const shown = quantizeTerminalColumn(1000, CELL, 1, true, FOOTER)
  const hidden = quantizeTerminalColumn(1000, CELL, 1, false, FOOTER)
  assert.ok(shown && hidden)
  assert.equal(shown.height, 960, 'with the footer shown: floor(1000-36 -> 964) to a 20px multiple')
  assert.equal(
    hidden.height,
    1000,
    'with the footer HIDDEN the terminal gets the whole column — no reserved footer band'
  )
  assert.ok(
    hidden.height > shown.height,
    'hiding the footer must GROW the terminal; the old code reserved its height either way'
  )
}

// ---------------------------------------------------------------------------
// 2. Whole-cell-row snapping is preserved in both states — a clipped half-row
//    is the defect this quantization exists to prevent.
// ---------------------------------------------------------------------------
{
  for (const visible of [true, false]) {
    for (const columnHeight of [500, 733, 1000, 1080]) {
      const q = quantizeTerminalColumn(columnHeight, CELL, 1, visible, FOOTER)
      if (!q) continue
      assert.equal(
        q.height % CELL,
        0,
        `height ${q.height} must be a whole multiple of the cell height (footerVisible=${visible})`
      )
      const available = columnHeight - (visible ? FOOTER : 0)
      assert.ok(q.height <= available, 'the terminal must never exceed the space available to it')
      assert.ok(available - q.height < CELL, 'slack must be less than one cell row')
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Slack is split, floored — the top spacer never takes more than half.
// ---------------------------------------------------------------------------
{
  const q = quantizeTerminalColumn(1000, CELL, 1, true, FOOTER)
  assert.ok(q)
  const slack = 1000 - FOOTER - q.height
  assert.equal(q.slackTop, Math.floor(slack / 2), 'slackTop is half the leftover, floored')
  assert.ok(q.slackTop <= slack, 'the top spacer can never exceed the total slack')
}

// ---------------------------------------------------------------------------
// 4. Degenerate inputs return null — the caller then keeps plain flex-1
//    rather than committing to a fabricated height.
// ---------------------------------------------------------------------------
{
  assert.equal(quantizeTerminalColumn(1000, null, 1, true, FOOTER), null, 'unknown cell height')
  assert.equal(quantizeTerminalColumn(1000, 0, 1, true, FOOTER), null, 'zero cell height')
  assert.equal(
    quantizeTerminalColumn(20, CELL, 1, true, FOOTER),
    null,
    'column smaller than footer'
  )
  assert.equal(quantizeTerminalColumn(FOOTER, CELL, 1, true, FOOTER), null, 'exactly the footer')
}

// ---------------------------------------------------------------------------
// 5. A fractional devicePixelRatio still yields whole PHYSICAL rows — the
//    snapping happens in physical px precisely because CSS px can be
//    fractional on a scaled display.
// ---------------------------------------------------------------------------
{
  const q = quantizeTerminalColumn(1000, CELL, 2, true, FOOTER)
  assert.ok(q)
  assert.equal(
    Math.round(q.height * 2) % CELL,
    0,
    'at dpr=2 the height must be a whole multiple of the cell height in PHYSICAL px'
  )
}

// ---------------------------------------------------------------------------
// 6. Structural: the absorbing wrapper must not render when the footer is
//    hidden. It is a painted flex-1 band (bg + seam border), so leaving it
//    would still show an empty strip even with the height fixed above.
// ---------------------------------------------------------------------------
{
  const fs = await import('node:fs')
  const view = fs.readFileSync(
    new URL('../src/renderer/src/components/dashboard/WorkspaceView.tsx', import.meta.url),
    'utf8'
  )
  assert.match(
    view,
    /\{!footerVisible \? null : quantized == null \? \(/,
    'the footer wrapper (and its painted band) must be skipped entirely when the footer is hidden'
  )
  assert.match(
    view,
    /\}, \[cellHeightPx, footerVisible\]\)/,
    'the quantizer must recompute when footerVisible flips — the ResizeObserver never fires for it'
  )
}

console.log(
  '✓ hiding the footer returns its height to the terminal and paints no empty band; whole-cell-row snapping and the slack split are preserved in both states'
)
