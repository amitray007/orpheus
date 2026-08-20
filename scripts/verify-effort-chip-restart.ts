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
// `if (false && ...)` guard). The one structural assertion is a targeted
// backstop for the exact missing-`else` shape, since a handler that ignores a
// case is legal TypeScript and typecheck cannot see it.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { buildLiveApplyText } from '../src/shared/harness/liveApply.ts'
import { CLAUDE_CURATED } from '../src/main/harness/claude/curated.ts'
import { CODEX_CURATED } from '../src/main/harness/codex/curated.ts'

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
// 3. Structural backstop: the effort handler must ACT on restartRequired.
//    Narrowly scoped to the effort branch's own shape — a missing `else` is
//    legal TypeScript, so nothing else can catch its return.
// ---------------------------------------------------------------------------
{
  const fs = await import('node:fs')
  const src = fs.readFileSync(
    new URL('../src/renderer/src/components/dashboard/footer/DropdownChip.tsx', import.meta.url),
    'utf8'
  )

  const effortIdx = src.indexOf('buildLiveApplyText(harness.curated?.effort')
  assert.ok(effortIdx > 0, 'sanity: the effort handler still calls buildLiveApplyText')
  // The block that follows must both inject AND handle the other case.
  const block = src.slice(effortIdx, effortIdx + 1400)
  assert.match(
    block,
    /Effort set — restarting workspace…/,
    'the effort handler must restart on restartRequired, not silently persist and stop'
  )
  assert.match(
    block,
    /Effort set — restart workspace to apply/,
    'the effort handler must still fall back to the manual prompt mid-task, never auto-kill an in-flight turn'
  )
  assert.match(
    block,
    /activityDetail !== 'working'/,
    'the restart must be guarded on activityDetail — auto-restarting during a turn would kill it'
  )
}

console.log(
  '✓ the Effort chip acts on BOTH live-apply kinds: Claude injects /effort, a restartRequired harness (Codex) restarts — never a silent no-op'
)
