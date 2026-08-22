// ---------------------------------------------------------------------------
// src/renderer/src/lib/modelEffortSelection.ts
//
// Footer-removal migration, Phase 1 — the PURE "what happens when a new
// model/effort value is picked" decision, extracted out of
// components/dashboard/footer/DropdownChip.tsx's onSelect handlers so the
// title bar's new Model/Effort chips (WorkspaceTitleBar.tsx) can share the
// exact same decision tree instead of re-deriving it. Read DropdownChip.tsx
// in full before touching this file — its `onSelect` closures (footer.
// modelSelect / footer.effortSelect branches) are the ORIGINAL, hard-won
// logic this module lifts out; every branch/comment below is a direct
// port, not a re-derivation, and DropdownChip.tsx now calls THESE functions
// instead of containing the branching itself (see that file's diff).
//
// WHY PURE FUNCTIONS, NOT A HOOK — unlike modelEffortPickerState.ts (this
// directory), which legitimately needs hooks (it subscribes to per-workspace
// stores), the actual DECISION here — inject vs. restart vs. "dirty chip,
// user restarts manually" — is a plain function of a handful of already-
// resolved values (the harness's curated liveApply declaration, whether the
// switch crosses a Claude/non-Claude boundary, current activity). Keeping it
// a pure function (not a hook) is what makes it directly assertable by
// scripts/verify-model-effort-selection.ts without mounting React at all —
// exactly the "assert behaviour, not source text" discipline CLAUDE.md
// requires, and the same reasoning effortPickerOptions.ts's own header gives
// for staying pure.
//
// CALLER CONTRACT — this module decides WHAT should happen; it never calls
// window.api itself, never plays a sound, never shows a tooltip. The caller
// (DropdownChip.tsx's onSelect, or the title bar's own chip) is responsible
// for:
//   1. Persisting the value (workspace:setModel / workspace:setEffort) —
//      ALWAYS happens regardless of what this module returns; persistence
//      is the caller's job, done before or after consulting this module per
//      each function's own doc comment (see the "persist-first" ordering
//      DropdownChip.tsx already follows and preserves here).
//   2. Acting on the returned decision — injecting text via
//      terminal.sendInput, calling onRestart(), or doing nothing further
//      (the persisted value is enough; the existing "Restart to apply"
//      dirty chip surfaces the rest).
// ---------------------------------------------------------------------------

import type { CuratedField } from '@shared/harness/types'
import { buildLiveApplyText } from '@shared/harness/liveApply'

/** The three possible outcomes of picking a new model/effort value. Mirrors
 *  LiveApplyResult's `inject`/`restartRequired` split (liveApply.ts) plus one
 *  MORE case this module adds on top: `restartRequired` further branches on
 *  whether an auto-restart is actually SAFE right now (activityDetail !==
 *  'working') — DropdownChip.tsx's onSelect always folded that mid-task
 *  guard into the same branch as the routed-model/no-liveApply case, so
 *  this type keeps that same shape rather than introducing a fourth
 *  variant the original logic never distinguished. */
export type SelectionEffect =
  // Inject `text` into the terminal (submitting iff `submit`) — the running
  // process can apply this value to itself via a REPL command.
  | { kind: 'inject'; text: string; submit: boolean }
  // Safe to restart right now (not mid-task) and a restart handler exists —
  // caller should call onRestart().
  | { kind: 'restart' }
  // Either mid-task (activityDetail === 'working') or no onRestart handler
  // was supplied — the value is persisted, but the caller must leave it at
  // that; the existing "Restart to apply" dirty chip is what surfaces this
  // to the user, not an immediate auto-restart.
  | { kind: 'dirtyOnly' }

/**
 * Decides the side effect for a MODEL selection. Mirrors DropdownChip.tsx's
 * footer.modelSelect onSelect branch exactly (the `currentModelIsClaude &&
 * newModelIsClaude` gate, the buildLiveApplyText call, the routed-model
 * auto-restart-unless-mid-task fallback) — see that file's own inline
 * comments (kept verbatim there) for the full "why" on each branch; this
 * function is the DECISION half of that logic with the persistence/sound/
 * tooltip side effects stripped out for the caller to perform itself.
 *
 * @param currentModelIsClaude whether the model being switched AWAY FROM
 *   resolves as Claude — see isModelEffectivelyClaude (footerChipGating.ts),
 *   which the caller must have already used to compute this (not
 *   recomputed here, since that function needs the full selectableModels
 *   list + harness id this module deliberately doesn't take a dependency
 *   on, to stay a small, single-purpose decision function).
 * @param newModelIsClaude whether the NEWLY selected model resolves as
 *   Claude (from selectableModels.find(...)?.isClaude ?? false at the call
 *   site, matching DropdownChip.tsx's own lookup).
 * @param curatedModel the harness's curated.model field (harness.curated?.model)
 *   — undefined for a harness that doesn't curate a model concept at all.
 * @param newValue the newly-selected model id.
 * @param hasRestartHandler whether an onRestart callback was supplied at
 *   all (DropdownChip.tsx's own `if (onRestart && ...)` check) — a missing
 *   handler always degrades to dirtyOnly, matching the original code's
 *   `else` branch.
 * @param activityDetail current workspace activity — 'working' means a
 *   mid-task auto-restart would silently kill an in-flight agent turn, so
 *   that always degrades to dirtyOnly regardless of the liveApply/model
 *   type decision.
 */
export function decideModelSelectionEffect(
  currentModelIsClaude: boolean,
  newModelIsClaude: boolean,
  curatedModel: CuratedField | undefined,
  newValue: string,
  hasRestartHandler: boolean,
  activityDetail: string | undefined
): SelectionEffect {
  // A same-backend switch (Claude -> Claude REPL command, same running
  // process) is the ONLY case where curated.model.liveApply's replInject
  // form is meaningful — see buildLiveApplyText's own doc comment and
  // DropdownChip.tsx's inline comment on why a routed-model switch can
  // never use it (new process, different env, no in-terminal command
  // applies).
  if (currentModelIsClaude && newModelIsClaude) {
    const liveApply = buildLiveApplyText(curatedModel, newValue)
    if (liveApply.kind === 'inject') {
      return { kind: 'inject', text: liveApply.text, submit: liveApply.submit }
    }
    // 'restartRequired' (or the defensive 'none' case, which shouldn't
    // happen here since curated.model must be defined for this branch to
    // have been reached at all) falls through to the same restart-or-dirty
    // decision the routed-model branch below uses.
  }
  if (hasRestartHandler && activityDetail !== 'working') {
    return { kind: 'restart' }
  }
  return { kind: 'dirtyOnly' }
}

/**
 * Decides the side effect for an EFFORT selection. Mirrors DropdownChip.tsx's
 * footer.effortSelect onSelect branch — unlike the model branch, there is
 * no Claude/routed-model split here (buildLiveApplyText's own degrade-to-
 * none-safely contract already handles a harness with no curated.effort at
 * all), so this is a straight liveApply-kind dispatch plus the same
 * restart-unless-mid-task fallback as the model decision above.
 *
 * @param curatedEffort the harness's curated.effort field (harness.curated?.effort).
 * @param newValue the newly-selected effort value.
 * @param hasRestartHandler see decideModelSelectionEffect's doc comment.
 * @param activityDetail see decideModelSelectionEffect's doc comment.
 */
export function decideEffortSelectionEffect(
  curatedEffort: CuratedField | undefined,
  newValue: string,
  hasRestartHandler: boolean,
  activityDetail: string | undefined
): SelectionEffect {
  const liveApply = buildLiveApplyText(curatedEffort, newValue)
  if (liveApply.kind === 'inject') {
    return { kind: 'inject', text: liveApply.text, submit: liveApply.submit }
  }
  if (hasRestartHandler && activityDetail !== 'working') {
    return { kind: 'restart' }
  }
  return { kind: 'dirtyOnly' }
}
