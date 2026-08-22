// ---------------------------------------------------------------------------
// scripts/verify-effort-chip-restart.ts
//
// Guards against a SILENT NO-OP in the footer Effort chip.
//
// THE BUG THIS EXISTS FOR: DropdownChip's effort handler was
//     const liveApply = buildLiveApplyText(harness.curated?.effort, value)
//     if (liveApply.kind === 'inject') { runInject(...) }
// with no `else`. For a harness whose curated.effort declares
// `restartRequired` — i.e. Codex, whose `/model` opens an interactive picker
// and takes no argument — the value was persisted and then NOTHING happened:
// no restart, no prompt, no feedback. The chip appeared to work while the
// running session kept its old effort. The model chip already handled this by
// falling through to auto-restart; effort did not.
//
// Asserted behaviourally over the real buildLiveApplyText and the real
// descriptors (never source-text greps for the logic itself — this repo has a
// documented case of a grep assertion passing against a dead
// `if (false && ...)` guard).
//
// UPDATED (support-multi-harness, footer-removal migration Phase 1): the
// decision this file guards — "what happens when a new effort value is
// picked" — moved out of DropdownChip.tsx's inline onSelect closure into a
// standalone pure function, decideEffortSelectionEffect
// (src/renderer/src/lib/modelEffortSelection.ts), so BOTH DropdownChip.tsx
// (the footer chip) and TitleBarUsageChips.tsx (the new title-bar chip) can
// call the identical decision instead of each re-deriving it. This file now
// asserts THAT function's branches directly — a strictly BETTER assertion
// than the structural source-text grep it replaces (the missing-`else` bug
// above is now impossible to reintroduce silently: any caller ignoring a
// SelectionEffect variant is a TypeScript exhaustiveness gap the compiler
// can flag, not a runtime-only omission a grep had to backstop). The two
// call sites are still checked structurally (section 3 below), narrowly
// scoped to "do they call decideEffortSelectionEffect and dispatch on
// 'inject'/'restart'/'dirtyOnly' at all" — not to re-verify the DECISION
// logic itself, which section 1/1b already do against the real function.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { buildLiveApplyText } from '../src/shared/harness/liveApply.ts'
import { CLAUDE_CURATED } from '../src/main/harness/claude/curated.ts'
import { CODEX_CURATED } from '../src/main/harness/codex/curated.ts'
import { decideEffortSelectionEffect } from '../src/renderer/src/lib/modelEffortSelection.ts'

// ---------------------------------------------------------------------------
// 1. The two harnesses genuinely differ here — this is what the chip must
//    handle, asserted against the REAL descriptors rather than fixtures.
// ---------------------------------------------------------------------------
{
  const claude = buildLiveApplyText(CLAUDE_CURATED.effort, 'high')
  assert.equal(claude.kind, 'inject', 'Claude effort must still live-apply via /effort')
  assert.equal(
    claude.kind === 'inject' ? claude.text : null,
    '/effort high',
    'Claude effort injects the concrete value, unchanged by this fix'
  )

  const codex = buildLiveApplyText(CODEX_CURATED.effort, 'high')
  assert.equal(
    codex.kind,
    'restartRequired',
    'Codex effort cannot live-apply — its /model opens an interactive picker and takes no argument, ' +
      'so restartRequired is the verified value, not a placeholder'
  )
}

// ---------------------------------------------------------------------------
// 2. Both branches are REACHABLE and DISTINCT. A handler that only acts on
//    'inject' silently drops the other — the exact shipped bug.
// ---------------------------------------------------------------------------
{
  const kinds = new Set(
    [CLAUDE_CURATED.effort, CODEX_CURATED.effort].map((f) => buildLiveApplyText(f, 'high').kind)
  )
  assert.deepEqual(
    [...kinds].sort(),
    ['inject', 'restartRequired'],
    'both live-apply kinds occur across real registered harnesses, so a handler must cover both'
  )
}

// ---------------------------------------------------------------------------
// 1b. decideEffortSelectionEffect (modelEffortSelection.ts) — the extracted
//     decision function ITSELF, asserted directly against the real curated
//     descriptors. This is the behavioral replacement for the old
//     structural source-text grep (section 3 used to read DropdownChip.tsx
//     as text): every branch a caller could take is asserted here against
//     the actual function, not a string match on where it's called from.
// ---------------------------------------------------------------------------
{
  // Claude: inject, regardless of restart-handler/activity state — a
  // same-backend live-apply never needs a restart at all.
  const claudeInject = decideEffortSelectionEffect(CLAUDE_CURATED.effort, 'high', true, 'working')
  assert.equal(claudeInject.kind, 'inject', 'Claude effort must live-apply via inject')
  assert.equal(
    claudeInject.kind === 'inject' ? claudeInject.text : null,
    '/effort high',
    'Claude effort injects the concrete value'
  )

  // Codex, restart handler present, NOT mid-task -> restart.
  const codexRestart = decideEffortSelectionEffect(CODEX_CURATED.effort, 'high', true, 'ready')
  assert.equal(
    codexRestart.kind,
    'restart',
    'a restartRequired harness with a restart handler and no in-flight turn must restart'
  )

  // Codex, restart handler present, but MID-TASK -> dirtyOnly (never
  // auto-kill an in-flight turn) — this is the exact missing-else shape the
  // original bug shipped: without this branch, a restartRequired harness
  // silently did nothing.
  const codexMidTask = decideEffortSelectionEffect(CODEX_CURATED.effort, 'high', true, 'working')
  assert.equal(
    codexMidTask.kind,
    'dirtyOnly',
    'a restartRequired harness must NOT auto-restart mid-task — the exact bug this file guards against'
  )

  // Codex, NO restart handler at all -> dirtyOnly (nothing else the caller
  // can do).
  const codexNoHandler = decideEffortSelectionEffect(CODEX_CURATED.effort, 'high', false, 'ready')
  assert.equal(
    codexNoHandler.kind,
    'dirtyOnly',
    'a restartRequired harness with no restart handler must degrade to dirtyOnly, never throw or silently drop the value'
  )
}

// ---------------------------------------------------------------------------
// 3. Structural backstop: BOTH real call sites (the footer chip and the
//    title-bar chip, support-multi-harness footer-removal migration Phase 1)
//    must still call decideEffortSelectionEffect and dispatch on its result
//    — narrowly scoped to "do they call the shared decision function and
//    handle 'inject'/'restart' at all", not to re-verify the DECISION logic
//    itself (section 1/1b already do that against the real function). A
//    caller that stopped calling decideEffortSelectionEffect (e.g. reverted
//    to reimplementing the branching inline) would silently duplicate this
//    logic rather than sharing it — exactly the drift CLAUDE.md's footer-
//    removal migration guidance warns against, since the footer dies in a
//    later phase and any UN-shared duplicate becomes orphaned.
// ---------------------------------------------------------------------------
{
  const fs = await import('node:fs')
  const callSites = [
    '../src/renderer/src/components/dashboard/footer/DropdownChip.tsx',
    '../src/renderer/src/components/dashboard/TitleBarUsageChips.tsx'
  ]
  for (const relPath of callSites) {
    const src = fs.readFileSync(new URL(relPath, import.meta.url), 'utf8')
    assert.ok(
      src.includes('decideEffortSelectionEffect('),
      `${relPath}: must call the shared decideEffortSelectionEffect rather than reimplementing the branching inline`
    )
    assert.ok(
      src.includes("effect.kind === 'inject'"),
      `${relPath}: must dispatch on the 'inject' branch of the returned effect`
    )
    assert.ok(
      src.includes("effect.kind === 'restart'"),
      `${relPath}: must dispatch on the 'restart' branch — a caller that only checks 'inject' silently drops the restartRequired case, the exact shipped bug`
    )
  }
}

console.log(
  '✓ the Effort chip acts on BOTH live-apply kinds: Claude injects /effort, a restartRequired harness (Codex) restarts (unless mid-task) — never a silent no-op, verified against the shared decideEffortSelectionEffect and both its real call sites'
)
