// ---------------------------------------------------------------------------
// src/main/harness/claude/launch.ts
//
// U4 of the multi-harness migration plan: produces a `HarnessLaunch` for
// Claude from THREE sources — U3's curated fields (model/effort), U2's
// generic harness_settings rows (resolveHarnessSettings), and U5's
// session-continuity tokens (claudeSessionArgs, ./session.ts).
//
// KTD2 — ZERO TYPED PASSTHROUGH SETTINGS. This is the whole point of this
// file. It does NOT read `claude_global_settings`, does NOT import anything
// from src/main/claudeSettings.ts, and does NOT port any of the 94 typed
// settings that file composes today (alwaysThinkingEnabled, outputStyle,
// tui, editorMode, customCliFlags, customEnvVars, etc.). Every one of those
// concepts is, for this emitter, just a user-supplied arg row or env row —
// R5: "all other configuration is user-supplied arg rows and env rows.
// Nothing else is hardcoded or maintained by Orpheus." Do not add a single
// hardcoded flag/env emission here beyond the two curated fields; that
// would silently reintroduce the 94-column maintenance burden this unit
// exists to kill. Session continuity (U5) is a DELIBERATE exception to
// "nothing else is hardcoded": it isn't one of the 94 passthrough settings
// at all — it's Orpheus's own workspace<->transcript identity bookkeeping
// (claudeSessionId/forkedFromSessionId live on the workspace row, not in
// claude_global_settings), gated behind capabilities.resume/fork exactly
// because it does NOT generalize to every harness. See session.ts's header.
//
// WIRED (U9 cutover). registry.ts's CLAUDE_DESCRIPTOR now points
// `composeLaunch` at composeClaudeHarnessLaunch directly — every mount goes
// through this emitter, not composeClaudeLaunch. composeClaudeLaunch
// (src/main/claudeSettings.ts) still exists and still works; it is simply no
// longer what a mount runs. U7's parity gate
// (scripts/verify-harness-launch-parity.ts) is what proved this emitter's
// output equivalent (or documented where it deliberately diverges, e.g. this
// KTD2 cutover) before the switch — it keeps running post-cutover as a
// regression guard, not a pre-cutover gate. Reverting is the one line in
// registry.ts.
// ---------------------------------------------------------------------------

import type { HarnessLaunch } from '../../../shared/harness/types'
import { FLAG_DELIMITER } from '../../../shared/cliFlags'
import { resolveHarnessSettings, type HarnessSettingRow } from '../settings'
import { CLAUDE_CURATED, buildCuratedArgs, buildCuratedEnv } from './curated'
import { isClaude } from '../../models/registry'
import { claudeSessionArgs } from './session'
import { getClaudeWorkspaceSettings } from '../../claudeWorkspaceSettings'

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
 * A0 (support-multi-harness) — layers a per-WORKSPACE model/effort override
 * on top of the (already global -> project layered) harness_settings
 * curated values, without ever writing that override INTO harness_settings.
 *
 * harness_settings has only 'global' and 'project' scope (see settings.ts's
 * own doc comment on why a workspace tier was deliberately not added), but
 * the footer Model/Effort chips are a genuinely per-workspace control
 * (claude_workspace_settings, keyed by workspace_id) — picking Opus in one
 * workspace must never change what a SIBLING workspace in the same project
 * effectively launches with. Writing a workspace-scoped chip change into
 * harness_settings' project scope would do exactly that (every workspace in
 * the project would snap to whichever one was changed last), so
 * ipc/claudeSettings.ts's write path deliberately keeps writing ONLY
 * claude_workspace_settings for a workspace-originated change (see
 * setWorkspaceSettingAndSuppressDirty's own WORKSPACE-SCOPE DECISION
 * comment). This function is the read-side half of that design: it resolves
 * the effective curated value the same way composeClaudeLaunch's
 * mergeWorkspaceOverrides did — workspace override wins when set, otherwise
 * falls through to the (already-resolved) global/project curated value —
 * entirely at read time, so the workspace layer never touches storage
 * shared by other workspaces.
 *
 * 'auto' EFFORT SENTINEL — same translation as the
 * unify-model-effort-into-harness-settings data step (data-steps.ts): the
 * legacy claude_workspace_settings.overrides.effort column still allows the
 * literal string 'auto' (composeFlagTokens's `s.effort && s.effort !==
 * 'auto'` guard treats it as "no override, let claude pick" and never
 * emits it as a flag value), but harness_settings.curated has no such
 * sentinel — an ABSENT curated.effort is what "no override" means there
 * (buildCuratedArgs's skip-if-empty contract). So a workspace effort of
 * 'auto' (or '') is treated here exactly like an unset workspace override:
 * it falls through to the already-resolved project/global curated.effort,
 * rather than being carried across and either emitted as the invalid
 * `--effort auto` or silently masking a real project/global value. A
 * workspace effort that IS a real value (low/medium/high/etc.) still wins
 * over project/global, same as model.
 *
 * READ DEFENSIVELY — this runs on every terminal mount. getClaudeWorkspaceSettings
 * itself already degrades a missing row to `{ overrides: {} }` (overridesStore.ts's
 * `get`), but a throw from underneath it (e.g. getDb() failing) must not take
 * the whole launch down with it — caught here and treated as "no override".
 *
 * No workspaceId -> returns `curated` unchanged (no override to apply).
 */
function withWorkspaceCuratedOverride(
  curated: { model?: string; effort?: string },
  workspaceId: string | undefined
): { model?: string; effort?: string } {
  if (!workspaceId) return curated
  let model: string | undefined
  let effort: string | undefined
  try {
    const ws = getClaudeWorkspaceSettings(workspaceId)
    model = ws.overrides.model
    effort = ws.overrides.effort
  } catch {
    return curated
  }
  // 'auto' (and '', for symmetry with buildCuratedArgs's own empty-string
  // skip) means "no override" — see the 'auto' SENTINEL note above.
  const effortOverride = effort && effort !== 'auto' ? effort : undefined
  if (model === undefined && effortOverride === undefined) return curated
  return {
    model: model !== undefined ? model : curated.model,
    effort: effortOverride !== undefined ? effortOverride : curated.effort
  }
}

/**
 * Composes a Claude `HarnessLaunch` from resolved harness_settings +
 * curated fields. Mirrors composeClaudeLaunch's public signature
 * (projectId?, workspaceId?) so it's a drop-in candidate once U9 cuts over.
 *
 * COMPOSITION ORDER (load-bearing — see the per-step notes below and U4's
 * test scenarios, which assert this exact ordering):
 *
 *   1. CURATED FIRST — model, effort, via buildCuratedArgs/buildCuratedEnv.
 *      These are Orpheus's two stable, app-read-back concepts (KTD3) and
 *      always take the front of the argv/env so a user's custom rows can be
 *      read, visually, as "everything after the curated pair."
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
  const curated = withWorkspaceCuratedOverride(resolved.curated ?? {}, workspaceId)

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
    ...buildCuratedEnv(CLAUDE_CURATED.effort, curated.effort ?? '')
  }
  const envWithUserRows = applyUserEnvRows(curatedEnv, resolved.env)
  // H1 (support-multi-harness) — ANOTHER deliberate exception to KTD2's
  // "zero typed passthrough" rule, same shape as U5's session-continuity
  // exception above but the OPPOSITE justification: session continuity does
  // NOT generalize to every harness (see session.ts's header), while
  // preLaunchSnippet DOES — resources/harness-common.sh (sourced by every
  // harness's own wrapper script, not just orpheus-claude.sh) reads
  // ORPHEUS_PRE_LAUNCH_SNIPPET directly and `eval`s it, with zero Claude-
  // specific logic involved. It is Orpheus's own wrapper-plumbing env var,
  // not a `claude` CLI flag or a setting `claude` itself understands, so it
  // does not belong in `resolved.args`/`resolved.env` (a user-supplied ROW
  // there IS passed straight to the harness binary — this is not). Reading
  // it here (rather than emitting it generically from buildMountEnv in
  // orpheusSurfaceAdapter.ts) avoids a second DB read of harness_settings
  // per mount; resolveHarnessSettings already resolved it above as part of
  // this same call, harness-agnostically.
  const env: Record<string, string> = { ...envWithUserRows }
  if (resolved.preLaunchSnippet) {
    env['ORPHEUS_PRE_LAUNCH_SNIPPET'] = resolved.preLaunchSnippet
  }

  return {
    flags: flagTokens.join(FLAG_DELIMITER),
    // No settings-json row kind exists in HarnessSettings yet (see step 4
    // above) — nothing to emit, and nothing hardcoded to fill the gap.
    settingsJson: '',
    env,
    model: curated.model ?? '',
    // A0 (support-multi-harness) — structured effort alongside `model`, so
    // callers (workspace:getEffectiveEffort) can read the resolved effort
    // back without grepping `flags` for `--effort`. Additive field; every
    // other property above is unchanged, preserving
    // verify-harness-launch-parity's byte-equality pin on `flags`/`model`.
    effort: curated.effort ?? ''
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
