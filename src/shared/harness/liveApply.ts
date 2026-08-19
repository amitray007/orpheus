// ---------------------------------------------------------------------------
// src/shared/harness/liveApply.ts
//
// Builds the injectable text (if any) for applying a curated field's new
// value to an ALREADY-RUNNING process — the shared logic behind
// DropdownChip.tsx's Model/Effort chips (B1, support-multi-harness).
// Previously the renderer hardcoded `/model ${value}` / `/effort ${value}`
// directly; those are Claude REPL slash commands and would be typed as
// literal text into a harness that doesn't understand them. This is now
// data-driven off CuratedField.liveApply (./types.ts) instead.
//
// Lives in src/shared (not src/main) because BOTH the renderer
// (DropdownChip.tsx's onSelect handlers) and main-process verification
// (scripts/verify-harness-curated.ts) need it, and check:arch forbids
// src/renderer -> src/main. Pure and side-effect-free — no IPC/DOM
// dependency; the caller decides what to DO with the result (inject via
// terminal.sendInput, or show a restart prompt), this function only decides
// WHAT text (if any) to build.
// ---------------------------------------------------------------------------

import type { CuratedField } from './types'

export type LiveApplyResult =
  // The field has a repl-injectable template — inject `text`, submitting
  // (Enter) iff `submit` is true.
  | { kind: 'inject'; text: string; submit: boolean }
  // The field exists but declares `restartRequired` — no text to inject;
  // the caller must restart the workspace (or prompt the user to) instead.
  | { kind: 'restartRequired' }
  // No curated field at all (harness doesn't curate this concept, or the
  // caller has nothing to apply) — nothing to do.
  | { kind: 'none' }

/**
 * Resolves what a curated field's `liveApply` declaration means for a
 * concrete `value`: injectable text, a restart-required signal, or nothing.
 *
 * `field` is `undefined` for a harness that doesn't curate this concept at
 * all (e.g. no `effort` control) — degrades to `{ kind: 'none' }` rather
 * than throwing, matching buildCuratedArgs/buildCuratedEnv's existing
 * degrade-to-empty convention in src/main/harness/claude/curated.ts. An
 * empty `value` also degrades to `'none'`: there is nothing meaningful to
 * type into a REPL for "no value chosen."
 *
 * Template interpolation is a single literal `{value}` substitution (not a
 * template-literal expression) — see CuratedField.liveApply's own doc
 * comment for why callers must go through this function instead of
 * hand-assembling the string themselves.
 */
export function buildLiveApplyText(
  field: CuratedField | undefined,
  value: string
): LiveApplyResult {
  if (!field || !value) return { kind: 'none' }
  if (field.liveApply.kind === 'restartRequired') return { kind: 'restartRequired' }
  return {
    kind: 'inject',
    text: field.liveApply.template.replace('{value}', value),
    submit: field.liveApply.submit
  }
}
