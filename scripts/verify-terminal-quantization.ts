// ---------------------------------------------------------------------------
// scripts/verify-terminal-quantization.ts
//
// Guards the workspace terminal's column height math.
//
// The terminal host is snapped DOWN to a whole multiple of the ghostty cell
// height so the native surface never renders a clipped half-row. Whatever the
// floor() leaves over is "slack", split above (slackTop) and below the
// terminal. The footer has been removed from rendering entirely, so this
// quantizer no longer reserves any height for it — the whole column is
// available to the terminal.
//
// Asserted against the real exported function (no DOM).
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { quantizeTerminalColumn } from '../src/renderer/src/lib/terminalQuantization.ts'

const CELL = 20 // physical px per ghostty cell row

// ---------------------------------------------------------------------------
// 1. The whole column is available to the terminal — no reserved band.
// ---------------------------------------------------------------------------
{
  const q = quantizeTerminalColumn(1000, CELL, 1)
  assert.ok(q)
  assert.equal(
    q.height,
    1000,
    'the terminal gets the whole column: 1000 is already a 20px multiple'
  )
}

// ---------------------------------------------------------------------------
// 2. Whole-cell-row snapping — a clipped half-row is the defect this
//    quantization exists to prevent.
// ---------------------------------------------------------------------------
{
  for (const columnHeight of [500, 733, 1000, 1080]) {
    const q = quantizeTerminalColumn(columnHeight, CELL, 1)
    if (!q) continue
    assert.equal(
      q.height % CELL,
      0,
      `height ${q.height} must be a whole multiple of the cell height`
    )
    assert.ok(q.height <= columnHeight, 'the terminal must never exceed the space available to it')
    assert.ok(columnHeight - q.height < CELL, 'slack must be less than one cell row')
  }
}

// ---------------------------------------------------------------------------
// 3. Slack is split, floored — the top spacer never takes more than half.
// ---------------------------------------------------------------------------
{
  const q = quantizeTerminalColumn(733, CELL, 1)
  assert.ok(q)
  const slack = 733 - q.height
  assert.equal(q.slackTop, Math.floor(slack / 2), 'slackTop is half the leftover, floored')
  assert.ok(q.slackTop <= slack, 'the top spacer can never exceed the total slack')
}

// ---------------------------------------------------------------------------
// 4. Degenerate inputs return null — the caller then keeps plain flex-1
//    rather than committing to a fabricated height.
// ---------------------------------------------------------------------------
{
  assert.equal(quantizeTerminalColumn(1000, null, 1), null, 'unknown cell height')
  assert.equal(quantizeTerminalColumn(1000, 0, 1), null, 'zero cell height')
  assert.equal(quantizeTerminalColumn(0, CELL, 1), null, 'zero column height')
  assert.equal(quantizeTerminalColumn(-5, CELL, 1), null, 'negative column height')
}

// ---------------------------------------------------------------------------
// 5. A fractional devicePixelRatio still yields whole PHYSICAL rows — the
//    snapping happens in physical px precisely because CSS px can be
//    fractional on a scaled display.
// ---------------------------------------------------------------------------
{
  const q = quantizeTerminalColumn(1000, CELL, 2)
  assert.ok(q)
  assert.equal(
    Math.round(q.height * 2) % CELL,
    0,
    'at dpr=2 the height must be a whole multiple of the cell height in PHYSICAL px'
  )
}

// ---------------------------------------------------------------------------
// 6. Structural: the footer wrapper (and its render branching) must be gone
//    from WorkspaceView — the footer no longer renders at all.
// ---------------------------------------------------------------------------
{
  const fs = await import('node:fs')
  const view = fs.readFileSync(
    new URL('../src/renderer/src/components/dashboard/WorkspaceView.tsx', import.meta.url),
    'utf8'
  )
  assert.ok(
    !/WorkspaceFooter/.test(view),
    'WorkspaceFooter must not be referenced in WorkspaceView'
  )
  assert.ok(!/footerVisible/.test(view), 'footerVisible must not survive as a vestigial flag')
  assert.match(
    view,
    /\}, \[cellHeightPx\]\)/,
    'the quantizer must recompute when cellHeightPx resolves/changes'
  )
}

console.log(
  '✓ the terminal column claims the whole available height with whole-cell-row snapping and a floored slack split; the footer wrapper is gone entirely'
)
