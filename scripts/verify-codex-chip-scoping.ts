// ---------------------------------------------------------------------------
// scripts/verify-codex-chip-scoping.ts
//
// Guards defects a Codex workspace's footer Model/Effort chips shipped with.
// Both were user-reported after THREE incorrect diagnoses, so each is
// asserted against the real functions with the exact observed symptom as the
// fixture.
//
// THE COMMON TRIGGER: a workspace with NO stored model. composeCodexHarness
// Launch returns model: '' when nothing is configured, so modelValue is ''
// in the chip.
//
// A third guard — footer-ROW provenance gating (a Claude-seeded
// footer_actions_global row hidden from a Codex workspace) — lived here
// until the footer-actions backend removal (footer-removal migration,
// sub-step 3). src/main/footerActions.ts (filterActionsForHarness,
// rowPassesHarnessProvenance, FOOTER_ACTION_GATES) is gone; that guard was a
// source-grep against that file and had no other home, so it was deleted
// with it rather than repointed — there is no successor behavior to guard,
// the feature it protected no longer exists. The Model/Effort chip-scoping
// guards below are UNRELATED to footer-actions rows (they gate the DropdownChip
// picker's option list, not a stored action row) and remain live.
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

console.log(
  "✓ a model-less Codex workspace gets Codex's efforts (with 'ultra', without 'minimal'), Claude's ladder is unchanged"
)
