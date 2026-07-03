// ---------------------------------------------------------------------------
// scripts/verify-workbench-reducer.ts
//
// U4 (P1) — exhaustive verification of the pure Workbench transition reducer
// (src/renderer/src/components/workbench/workbenchReducer.ts). There is no
// renderer test runner in this repo (see CLAUDE.md); this mirrors the
// existing `scripts/verify-migration-engine.ts` convention: a script run
// directly (no bundler/framework), asserting every cell of the transition
// table in docs/brainstorms/2026-07-02-workbench-panes-requirements.md §4 so
// a future change to the reducer can't silently break a transition.
//
// Run via `bun run scripts/verify-workbench-reducer.ts` (the `test:workbench`
// package.json script), NOT plain `node --experimental-strip-types` —
// workbenchReducer.ts now imports runtime values (not just types) from a
// sibling module (../../lib/workbenchStore, extensionless per this repo's
// bundler-resolution convention), which plain Node ESM can't resolve without
// an explicit extension. Bun's resolver handles it natively, matching how
// Vite/tsc (moduleResolution: "bundler") already resolve it everywhere else.
// ---------------------------------------------------------------------------

import assert from 'node:assert'
import {
  workbenchReducer,
  type WorkbenchState
} from '../src/renderer/src/components/workbench/workbenchReducer.ts'

const STATES: WorkbenchState[] = ['dormant', 'open', 'expanded']

function expect(
  state: WorkbenchState,
  actionType: Parameters<typeof workbenchReducer>[1]['type'],
  want: WorkbenchState
): void {
  const got = workbenchReducer(state, { type: actionType })
  assert.equal(got, want, `workbenchReducer(${state}, ${actionType}) = ${got}, expected ${want}`)
}

// ── open: dormant -> open; open/expanded unchanged ─────────────────────────
expect('dormant', 'open', 'open')
expect('open', 'open', 'open')
expect('expanded', 'open', 'expanded')

// ── toggleExpand: open <-> expanded; dormant unchanged (no-op) ─────────────
expect('open', 'toggleExpand', 'expanded')
expect('expanded', 'toggleExpand', 'open')
expect('dormant', 'toggleExpand', 'dormant')

// ── restoreToOpen: expanded -> open; dormant/open unchanged ────────────────
expect('expanded', 'restoreToOpen', 'open')
expect('open', 'restoreToOpen', 'open')
expect('dormant', 'restoreToOpen', 'dormant')

// ── close: any -> dormant ───────────────────────────────────────────────────
for (const s of STATES) expect(s, 'close', 'dormant')

// ── stepDown: expanded -> open, open -> dormant, dormant unchanged (no-op) ─
expect('expanded', 'stepDown', 'open')
expect('open', 'stepDown', 'dormant')
expect('dormant', 'stepDown', 'dormant')

// ── toggle (Cmd/Ctrl+\): dormant -> open; open|expanded -> dormant ─────────
expect('dormant', 'toggle', 'open')
expect('open', 'toggle', 'dormant')
expect('expanded', 'toggle', 'dormant')

// ── Full round-trip sanity: dormant -> open -> expanded -> open -> dormant
let s: WorkbenchState = 'dormant'
s = workbenchReducer(s, { type: 'open' })
assert.equal(s, 'open')
s = workbenchReducer(s, { type: 'toggleExpand' })
assert.equal(s, 'expanded')
s = workbenchReducer(s, { type: 'restoreToOpen' })
assert.equal(s, 'open')
s = workbenchReducer(s, { type: 'close' })
assert.equal(s, 'dormant')

console.log('verify-workbench-reducer: all transitions OK')
