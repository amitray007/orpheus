// ---------------------------------------------------------------------------
// scripts/verify-model-effort-selection.ts
//
// Behavior guard for src/renderer/src/lib/modelEffortSelection.ts — the pure
// "what happens when a new model/effort value is picked" decision extracted
// out of components/dashboard/footer/DropdownChip.tsx's onSelect handlers
// (footer-removal migration Phase 1, support-multi-harness) so the title
// bar's own Model/Effort chips (TitleBarUsageChips.tsx) can share the exact
// same decision instead of re-deriving it.
//
// This file focuses on decideModelSelectionEffect — the MORE complex of the
// two decision functions (it has the extra currentModelIsClaude/
// newModelIsClaude Claude-vs-routed-model gate the effort decision doesn't).
// decideEffortSelectionEffect's own branches are asserted in
// scripts/verify-effort-chip-restart.ts (section 1b) alongside the
// pre-existing regression-net assertions that already lived there for the
// Effort chip's restartRequired bug — see that file's header for why it was
// the natural home rather than duplicating a second harness here.
//
// No Electron/DB dependency (this module is pure, over shared/harness types
// only) — plain bun, matching every other pure-logic verifier in this
// family (e.g. verify-codex-chip-scoping.ts, verify-effort-chip-restart.ts).
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { decideModelSelectionEffect } from '../src/renderer/src/lib/modelEffortSelection.ts'
import { CLAUDE_CURATED } from '../src/main/harness/claude/curated.ts'
import { CODEX_CURATED } from '../src/main/harness/codex/curated.ts'

// ---------------------------------------------------------------------------
// 1. Claude -> Claude switch: live-apply via inject (curated.model.liveApply
//    is a real replInject descriptor for Claude — see curated.ts).
// ---------------------------------------------------------------------------
{
  const effect = decideModelSelectionEffect(
    /* currentModelIsClaude */ true,
    /* newModelIsClaude */ true,
    CLAUDE_CURATED.model,
    'opus',
    /* hasRestartHandler */ true,
    /* activityDetail */ 'ready'
  )
  assert.equal(
    effect.kind,
    'inject',
    'a same-backend Claude->Claude switch must live-apply via inject'
  )
  assert.equal(
    effect.kind === 'inject' ? effect.text : null,
    '/model opus',
    'the injected text must be the concrete /model command'
  )
}

// ---------------------------------------------------------------------------
// 2. Claude -> routed (non-Claude) model: NEVER inject (no in-terminal
//    command can apply a routed model's env-var-driven switch) — falls
//    through to restart-or-dirtyOnly, same as the Codex case below.
// ---------------------------------------------------------------------------
{
  const effect = decideModelSelectionEffect(
    /* currentModelIsClaude */ true,
    /* newModelIsClaude */ false,
    CLAUDE_CURATED.model,
    'grok-4.5',
    /* hasRestartHandler */ true,
    /* activityDetail */ 'ready'
  )
  assert.equal(
    effect.kind,
    'restart',
    'a switch involving a routed model must never inject — it needs a brand-new process'
  )
}

// ---------------------------------------------------------------------------
// 3. Codex model switch (curated.model.liveApply is restartRequired — see
//    codex/curated.ts's CODEX_LIVE_APPLY): restart when safe.
// ---------------------------------------------------------------------------
{
  const effect = decideModelSelectionEffect(
    /* currentModelIsClaude */ false,
    /* newModelIsClaude */ false,
    CODEX_CURATED.model,
    'gpt-5.4',
    /* hasRestartHandler */ true,
    /* activityDetail */ 'idle'
  )
  assert.equal(effect.kind, 'restart', 'a Codex model switch must restart when not mid-task')
}

// ---------------------------------------------------------------------------
// 4. THE MID-TASK GUARD: any restart-eligible switch must degrade to
//    dirtyOnly while activityDetail === 'working' — auto-restarting during
//    an in-flight agent turn would silently kill it.
// ---------------------------------------------------------------------------
{
  const effect = decideModelSelectionEffect(
    /* currentModelIsClaude */ false,
    /* newModelIsClaude */ false,
    CODEX_CURATED.model,
    'gpt-5.4',
    /* hasRestartHandler */ true,
    /* activityDetail */ 'working'
  )
  assert.equal(
    effect.kind,
    'dirtyOnly',
    'a restart-eligible model switch must NOT auto-restart while the workspace is mid-task'
  )
}

// ---------------------------------------------------------------------------
// 5. No restart handler at all -> dirtyOnly, regardless of activity.
// ---------------------------------------------------------------------------
{
  const effect = decideModelSelectionEffect(
    /* currentModelIsClaude */ false,
    /* newModelIsClaude */ false,
    CODEX_CURATED.model,
    'gpt-5.4',
    /* hasRestartHandler */ false,
    /* activityDetail */ 'ready'
  )
  assert.equal(
    effect.kind,
    'dirtyOnly',
    'with no restart handler supplied, the caller has nothing else to do but leave the value persisted+dirty'
  )
}

console.log(
  '✓ decideModelSelectionEffect: Claude->Claude injects, any routed-model switch restarts (unless mid-task or no handler) — matching Claude and Codex real curated descriptors'
)
