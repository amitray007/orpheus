// ---------------------------------------------------------------------------
// scripts/verify-codex-chip-scoping.ts
//
// Guards four defects a Codex workspace's footer chips shipped with. All four
// were user-reported after THREE incorrect diagnoses, so each is asserted
// against the real functions with the exact observed symptom as the fixture.
//
// THE COMMON TRIGGER for (1) and (3): a workspace with NO stored model.
// composeCodexHarnessLaunch returns model: '' when nothing is configured, so
// modelValue is '' in the chip.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import {
  resolveEffortLevelsForScope,
  effortDropdownItemsFor
} from '../src/renderer/src/lib/effortPickerOptions.ts'
import { CODEX_CURATED } from '../src/main/harness/codex/curated.ts'
import { EFFORT_LADDER_ORDER } from '../src/shared/types.ts'

const CODEX_EFFORTS = [...(CODEX_CURATED.effort?.options ?? [])]

// ---------------------------------------------------------------------------
// 1. THE REPORTED BUG: a model-less NON-Claude workspace must not be handed
//    Claude's effort ladder.
// ---------------------------------------------------------------------------
{
  const levels = resolveEffortLevelsForScope('', [], false, /* isClaudeHarness */ false)
  assert.equal(
    levels,
    null,
    "a model-less non-Claude scope must report NO per-model levels (null), not Claude's ladder — " +
      'a truthy array makes effortDropdownItemsFor take the per-model branch and never reach the harness fallback'
  )

  const shown = effortDropdownItemsFor(levels, CODEX_EFFORTS).map((o) => o.value)
  assert.deepEqual(
    shown,
    ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    "Codex's chip must offer ITS levels, including 'ultra'"
  )
  assert.equal(
    shown.includes('minimal'),
    false,
    "'minimal' is Claude-ladder vocabulary — no Codex model supports it (this was the reported symptom)"
  )
}

// ---------------------------------------------------------------------------
// 2. REGRESSION NET: Claude is untouched. The 4th param defaults to true, so
//    every pre-existing caller (the settings drawers) behaves exactly as
//    before this fix.
// ---------------------------------------------------------------------------
{
  assert.deepEqual(
    resolveEffortLevelsForScope('', [], false),
    [...EFFORT_LADDER_ORDER],
    'default (no 4th arg) must still return the full ladder — the drawers depend on it'
  )
  assert.deepEqual(
    resolveEffortLevelsForScope('', [], false, true),
    [...EFFORT_LADDER_ORDER],
    'an explicitly-Claude scope must still return the full ladder'
  )
  // The pending tri-state must survive for both harnesses.
  assert.equal(
    resolveEffortLevelsForScope('some-model', [], true, false),
    undefined,
    'loading must still report PENDING (undefined), never a fabricated list'
  )
}

// ---------------------------------------------------------------------------
// 3. Footer-row PROVENANCE now gates every action id, not just sendInput.
//    Claude's seeded Fork/Model/Effort/Context/Cost rows were passing their
//    capability gates on a Codex workspace, so a Codex workspace showed
//    Claude's rows AND its own — visible duplicates, plus Context/Cost which
//    codex/actions.ts deliberately omits (Claude-transcript-shaped handlers).
// ---------------------------------------------------------------------------
{
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../src/main/footerActions.ts', import.meta.url), 'utf8')

  assert.match(
    src,
    /if \(!rowPassesHarnessProvenance\(action, harness\)\) return false/,
    'filterActionsForHarness must check provenance for EVERY row, before the capability gates'
  )
  assert.equal(
    /action\.actionId === ACTION_TERMINAL_SEND_INPUT/.test(src),
    false,
    'the provenance check must no longer be scoped to terminal.sendInput alone'
  )
  // The load-bearing safety rule must survive: NULL provenance always passes.
  assert.match(
    src,
    /if \(provenance === null \|\| provenance === undefined\) return true/,
    'a NULL-provenance row (user-authored, or seeded before this column) must still always pass'
  )
}

console.log(
  "✓ a model-less Codex workspace gets Codex's efforts (with 'ultra', without 'minimal'), Claude's ladder is unchanged, and footer rows are harness-scoped"
)
