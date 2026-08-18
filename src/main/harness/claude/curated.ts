// ---------------------------------------------------------------------------
// src/main/harness/claude/curated.ts
//
// Claude's three curated concepts (KTD3 of the multi-harness migration
// plan, unit U3): model, effort, permission-mode. These are hardcoded per
// harness because they are stable AND Orpheus itself reads them back
// (commandServer.ts's TUI tree frame, tmuxHost.ts's TreeSourceWorkspace,
// settingsResourceService.ts's validator, the footer's modelSelect/
// effortSelect pickers). Every other Claude setting stays untyped
// passthrough args/env (KTD2) — this file is deliberately narrow.
//
// REUSE, NOT DUPLICATE: the option lists below are read straight off the
// existing canonical arrays in src/shared/types.ts — CLAUDE_MODEL_OPTIONS
// and CLAUDE_EFFORT_VALUES already are that file's single source of truth
// (see CLAUDE_EFFORT_VALUES's own doc comment: five independent copies used
// to drift before that array existed). Adding a third copy here would
// reintroduce exactly the bug that array was created to kill, so this file
// derives from them instead of restating their contents.
//
// FLAGS VERIFIED against composeFlagTokens (src/main/claudeSettings.ts,
// ~lines 774-834): `--model`, `--permission-mode`, `--effort` are the exact
// tokens that function pushes today. Claude has no env-var form for any of
// the three (unlike superset's Vibe harness, which has no model flag and
// uses VIBE_ACTIVE_MODEL instead) — every CuratedField below uses `flag`,
// never `env`. scripts/verify-harness-curated.ts asserts these three
// strings match composeFlagTokens's actual output, not just this file's
// literals, so a future rename of one of those flags fails the harness
// instead of silently drifting.
// ---------------------------------------------------------------------------

import type { CuratedField } from '../../../shared/harness/types'
import {
  CLAUDE_EFFORT_VALUES,
  CLAUDE_MODEL_OPTIONS,
  type ClaudePermissionMode
} from '../../../shared/types'

// ClaudePermissionMode has no shared canonical VALUES array (unlike
// CLAUDE_EFFORT_VALUES) — it's a small, closed, rarely-changing union
// declared once in src/shared/types.ts. Restating its four members here as
// a typed tuple (rather than importing a values array that doesn't exist)
// keeps this file honest to "reuse what's canonical" while not inventing a
// new shared export purely for a one-off internal list; if a second harness
// ever needs the same list, promote this to a shared array at that point.
const CLAUDE_PERMISSION_MODES: readonly ClaudePermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions'
]

export const CLAUDE_CURATED_MODEL: CuratedField = {
  flag: '--model',
  options: CLAUDE_MODEL_OPTIONS.map((o) => o.value),
  allowCustom: true
}

export const CLAUDE_CURATED_EFFORT: CuratedField = {
  flag: '--effort',
  options: [...CLAUDE_EFFORT_VALUES],
  allowCustom: true
}

export const CLAUDE_CURATED_PERMISSION_MODE: CuratedField = {
  flag: '--permission-mode',
  options: [...CLAUDE_PERMISSION_MODES],
  allowCustom: true
}

export const CLAUDE_CURATED = {
  model: CLAUDE_CURATED_MODEL,
  effort: CLAUDE_CURATED_EFFORT,
  permissionMode: CLAUDE_CURATED_PERMISSION_MODE
}

// ---------------------------------------------------------------------------
// Builders — pure, degrade-to-empty (superset's pattern: callers spread the
// result unconditionally; a stale/unset value falls back to the CLI's own
// default rather than throwing).
// ---------------------------------------------------------------------------

/**
 * Returns the `[flag, value]` argv pair for a curated field's current
 * value, or `[]` when the field has no flag (env-based) or the value is
 * empty/unset. A value NOT present in `field.options` is still emitted —
 * that is the `allowCustom` contract (KTD3: "always expect custom values
 * for them too"), not an error case. This function never validates against
 * `options`; that list is a UI suggestion set only.
 */
export function buildCuratedArgs(field: CuratedField | undefined, value: string): string[] {
  if (!field || !field.flag || !value) return []
  return [field.flag, value]
}

/**
 * Returns the `{ [env]: value }` map for a curated field's current value,
 * or `{}` when the field has no env key (flag-based) or the value is
 * empty/unset. Same allowCustom contract as buildCuratedArgs: a custom
 * value is emitted exactly like a curated one.
 */
export function buildCuratedEnv(
  field: CuratedField | undefined,
  value: string
): Record<string, string> {
  if (!field || !field.env || !value) return {}
  return { [field.env]: value }
}
