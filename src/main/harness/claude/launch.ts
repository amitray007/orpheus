// ---------------------------------------------------------------------------
// src/main/harness/claude/launch.ts
//
// U4 of the multi-harness migration plan: produces a `HarnessLaunch` for
// Claude from THREE sources — U3's curated fields (model/effort/
// permission-mode), U2's generic harness_settings rows
// (resolveHarnessSettings), and U5's session-continuity tokens
// (claudeSessionArgs, ./session.ts).
//
// KTD2 — ZERO TYPED PASSTHROUGH SETTINGS. This is the whole point of this
// file. It does NOT read `claude_global_settings`, does NOT import anything
// from src/main/claudeSettings.ts, and does NOT port any of the 94 typed
// settings that file composes today (alwaysThinkingEnabled, outputStyle,
// tui, editorMode, customCliFlags, customEnvVars, etc.). Every one of those
// concepts is, for this emitter, just a user-supplied arg row or env row —
// R5: "all other configuration is user-supplied arg rows and env rows.
// Nothing else is hardcoded or maintained by Orpheus." Do not add a single
// hardcoded flag/env emission here beyond the three curated fields; that
// would silently reintroduce the 94-column maintenance burden this unit
// exists to kill. Session continuity (U5) is a DELIBERATE exception to
// "nothing else is hardcoded": it isn't one of the 94 passthrough settings
// at all — it's Orpheus's own workspace<->transcript identity bookkeeping
// (claudeSessionId/forkedFromSessionId live on the workspace row, not in
// claude_global_settings), gated behind capabilities.resume/fork exactly
// because it does NOT generalize to every harness. See session.ts's header.
//
// NOT WIRED YET. Nothing calls this module — the registry's Claude
// descriptor still points `composeLaunch` at composeClaudeLaunch (see
// registry.ts's own comment: "Phase 1 ... zero-behavior-change"). U7 proves
// this emitter's output is equivalent (or documents where it deliberately
// diverges, e.g. this KTD2 cutover) before U9 switches the descriptor over.
// This file is additive only.
// ---------------------------------------------------------------------------

import type { HarnessLaunch } from '../../../shared/harness/types'
import { FLAG_DELIMITER } from '../../../shared/cliFlags'
import { resolveHarnessSettings, type HarnessSettingRow } from '../settings'
import { CLAUDE_CURATED, buildCuratedArgs, buildCuratedEnv } from './curated'
import { isClaude } from '../../models/registry'
import { claudeSessionArgs } from './session'

const HARNESS_ID = 'claude'

/**
 * Gate --model on the value actually being a Claude model.
 *
 * This mirrors composeFlagTokens's own coercion (claudeSettings.ts, the
 * `s.model && !isClaude(s.model)` branch) and it is NOT optional: Phase 0
 * severed launch-side CLIProxyAPI routing, so a non-Claude model id passed
 * through to `claude --model <id>` would run against the real
 * api.anthropic.com with an id it does not recognise — a silent failure that
 * announces itself nowhere. Emitting nothing lets claude fall back to its own
 * default instead.
 *
 * Note this is deliberately narrower than the curated `allowCustom` contract,
 * which is about the UI not restricting what a user may TYPE. A custom value
 * is still stored and still shown; it simply is not forwarded as --model
 * unless the binary would understand it. Keyed on isClaude (the model
 * registry) rather than modelRouting's isRoutedModel for the same reason
 * P0.3 was: the two coincide today, but Phase 6 re-lands routing on
 * (harness, model) and they stop meaning the same thing.
 */
function claudeModelFlagValue(model: string | undefined): string {
  if (!model || !isClaude(model)) return ''
  return model
}

/**
 * Composes a Claude `HarnessLaunch` from resolved harness_settings +
 * curated fields. Mirrors composeClaudeLaunch's public signature
 * (projectId?, workspaceId?) so it's a drop-in candidate once U9 cuts over.
 *
 * COMPOSITION ORDER (load-bearing — see the per-step notes below and U4's
 * test scenarios, which assert this exact ordering):
 *
 *   1. CURATED FIRST — model, effort, permission-mode, via
 *      buildCuratedArgs/buildCuratedEnv. These are Orpheus's three stable,
 *      app-read-back concepts (KTD3) and always take the front of the argv/
 *      env so a user's custom rows can be read, visually, as "everything
 *      after the curated trio."
 *   2. THEN SESSION-CONTINUITY TOKENS (U5), via claudeSessionArgs —
 *      `--resume`/`--session-id`/`--fork-session`. Placed here to match
 *      composeClaudeLaunch's own order exactly: composeFlagTokens
 *      (src/main/claudeSettings.ts) calls pushSessionContinuityFlags AFTER
 *      all of its typed curated flags (model, effort, permission-mode,
 *      fallback-model, etc.) and BEFORE customCliFlags are appended. This
 *      emitter has no fallback-model or other typed passthrough (KTD2), so
 *      "after curated, before user rows" is the direct equivalent —
 *      required for U7's byte-equality parity gate, where ordering counts.
 *   3. THEN USER ARG ROWS, in their resolveHarnessSettings-declared order
 *      (global rows first, then project-introduced keys, then
 *      workspace-introduced keys — see settings.ts's mergeRowsByKey doc
 *      comment). A bare row (`value` undefined) emits just its key, e.g. a
 *      user adding `--verbose` with no value. Mirrors customCliFlags being
 *      the last thing appended in composeFlagTokens, so a user's override
 *      still wins by last-flag-wins in claude's own parser.
 *   4. THEN USER ENV ROWS, same ordering rule, layered on top of curated
 *      env — see the ENV-KEY COLLISION note below for precedence when a
 *      user row's key matches a curated field's env key.
 *   5. `settingsJson` — ONLY emitted from user-supplied settings-json rows.
 *      HarnessSettings (settings.ts) has no settings-json row kind yet — no
 *      row `key`/`value` shape maps to "this goes into --settings" today,
 *      unlike args/env which are explicit sibling arrays. Until that shape
 *      exists, this always returns '' (composeClaudeLaunch's own "bare
 *      invocation" default for an all-unset state — see its doc comment).
 *      NOTHING is hardcoded here to fill it.
 *
 * ENV-KEY COLLISION PRECEDENCE — CURATED WINS.
 * A user could add an env row whose key happens to match a curated field's
 * `env` key (Claude's three curated fields are all flag-based today, so
 * this cannot actually collide yet — see curated.ts's header: "every
 * CuratedField below uses `flag`, never `env`" — but a future harness with
 * e.g. `curated.model = { env: 'MODEL', ... }` makes this live). Decision:
 * CURATED WINS on collision. Reasoning — curated fields are the concepts
 * Orpheus itself reads back for UI (footer model/effort pickers, the TUI
 * tree frame) and persists through a dedicated, validated path
 * (HarnessCuratedSettings), not free text; if a stray/stale user env row
 * silently overrode the curated value, the UI picker and the actual launch
 * would show two different models with no visible reason why. A user who
 * wants to override the curated value has the dedicated curated control for
 * that purpose — an untyped env row is not the intended override channel
 * for a concept Orpheus curates. Implemented by building the env object
 * curated-first, then applying user rows with `??=`-style skip-if-present
 * rather than blind overwrite, so a colliding user key is dropped, not
 * shadowed only in appearance.
 */
export function composeClaudeHarnessLaunch(
  projectId?: string,
  workspaceId?: string
): HarnessLaunch {
  // Both ids are optional and resolveHarnessSettings skips each missing layer
  // independently — crucially it ALWAYS reads the global layer, so a call with
  // neither id still composes the user's global settings rather than a bare
  // invocation.
  const resolved = resolveHarnessSettings(HARNESS_ID, projectId)
  const curated = resolved.curated ?? {}

  const flagTokens: string[] = [
    // ORDER IS LOAD-BEARING: model -> permission-mode -> effort, matching
    // composeFlagTokens's own emission order (claudeSettings.ts:813, :821,
    // :826). Not alphabetical, not the order the fields are declared in —
    // the order the OLD emitter uses, because verify-harness-launch-parity
    // asserts byte-equality between the two and a reordering here is a real
    // (if subtle) behavior change in the composed argv.
    ...buildCuratedArgs(CLAUDE_CURATED.model, claudeModelFlagValue(curated.model)),
    ...buildCuratedArgs(CLAUDE_CURATED.effort, curated.effort ?? ''),
    ...claudeSessionArgs(workspaceId),
    ...userArgTokens(resolved.args)
  ]

  const curatedEnv: Record<string, string> = {
    ...buildCuratedEnv(CLAUDE_CURATED.model, curated.model ?? ''),
    ...buildCuratedEnv(CLAUDE_CURATED.effort, curated.effort ?? ''),
    ...buildCuratedEnv(CLAUDE_CURATED.effort, curated.effort ?? '')
  }
  const env = applyUserEnvRows(curatedEnv, resolved.env)

  return {
    flags: flagTokens.join(FLAG_DELIMITER),
    // No settings-json row kind exists in HarnessSettings yet (see step 4
    // above) — nothing to emit, and nothing hardcoded to fill the gap.
    settingsJson: '',
    env,
    model: curated.model ?? ''
  }
}

/** Flattens enabled user arg rows into argv tokens, in declared order. A row
 *  with no `value` (or an empty string) is a bare flag — just its key. */
function userArgTokens(rows: HarnessSettingRow[] | undefined): string[] {
  if (!rows) return []
  const tokens: string[] = []
  for (const row of rows) {
    tokens.push(row.key)
    if (row.value) tokens.push(row.value)
  }
  return tokens
}

/** Layers enabled user env rows on top of an already-curated env map.
 *  CURATED WINS on key collision — see composeClaudeHarnessLaunch's doc
 *  comment for the reasoning. Returns a new object; never mutates
 *  `curatedEnv` in place. Exported (in addition to its use above) so
 *  scripts/verify-harness-claude-launch.ts can assert the collision rule
 *  directly against the real function — Claude's own curated fields are all
 *  flag-based today (see curated.ts's header), so composeClaudeHarnessLaunch
 *  itself can never exercise a live collision; this seam lets the rule be
 *  tested against real behavior anyway, ahead of the future harness that
 *  makes it reachable end-to-end. */
export function applyUserEnvRows(
  curatedEnv: Record<string, string>,
  rows: HarnessSettingRow[] | undefined
): Record<string, string> {
  const env = { ...curatedEnv }
  if (!rows) return env
  for (const row of rows) {
    if (row.key in env) continue
    env[row.key] = row.value ?? ''
  }
  return env
}
