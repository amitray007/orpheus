// ---------------------------------------------------------------------------
// src/main/harness/codex/launch.ts
//
// B1 of the Phase B (multi-harness migration) Codex module. Composes a
// Codex `HarnessLaunch` from harness_settings (../settings.ts) + curated
// fields (./curated.ts) — the exact same KTD2 discipline
// composeClaudeHarnessLaunch (harness/claude/launch.ts) established: ZERO
// hardcoded typed passthrough settings, only the two curated concepts
// (model/effort) plus whatever the user has added as arg/env rows. Read
// that file's header first; this one only documents where Codex genuinely
// diverges, not the shared reasoning.
//
// DIVERGENCES FROM composeClaudeHarnessLaunch:
//
//   1. NO isClaude() GATE ON THE MODEL FLAG. Claude's claudeModelFlagValue
//      helper exists ONLY because Phase 0 severed launch-side model-routing
//      for Claude itself — passing a non-Claude model id to `claude --model`
//      would silently hit real api.anthropic.com with an id it doesn't
//      recognise. Codex has no such hazard: it is not the harness Orpheus
//      routes model ids away from, it simply forwards whatever id the user
//      picked (curated or custom, per CuratedField's allowCustom contract)
//      straight to `-m`. DO NOT copy Claude's gate over here "for safety" —
//      there is nothing for it to guard against on this harness, and adding
//      it would silently drop a valid custom Codex model id a user typed in.
//
//   2. SESSION-CONTINUITY ARGS ARE DISCOVERED, NOT PRE-ASSIGNED (C5). Codex
//      mints its own session id; there is no flag to pre-assign one (checked
//      against `codex --help`, `codex exec --help`, `codex resume --help` —
//      none expose an equivalent of Claude's `--session-id`). So unlike
//      Claude's claudeSessionArgs (a pure read of the already-known bound
//      id), Codex's codexSessionArgs (./session.ts) can only emit a
//      `['resume', <id>]` PREFIX once a PRIOR launch's discovery has found
//      and persisted Codex's own id for this workspace — see session.ts's
//      header for the full id-vs-session_id/thread_source mechanics. This
//      launch also SCHEDULES that discovery (scheduleCodexSessionDiscovery)
//      for the launch currently being composed, so the NEXT mount can
//      resume it. `resume` is a codex SUBCOMMAND, so its tokens are
//      prepended before every other flag below — a flag placed first would
//      not parse.
//
//   3. settingsJson IS ALWAYS ''. No `--settings <json>` (or equivalent)
//      flag exists on Codex (verified against `codex --help`) —
//      CODEX_CAPABILITIES.inlineSettingsJson is false for the same reason
//      (see curated.ts). There is no step 5 here the way Claude's launch.ts
//      has one; the field is simply always empty.
//
// Everything else — curated-first ordering, user arg/env row layering,
// env-collision precedence (curated wins), the workspace curated-override
// read, preLaunchSnippet/sourceZshrc wrapper-plumbing emission — is IDENTICAL
// in shape to Claude's emitter and reuses the exact same building blocks
// (resolveHarnessSettings, buildCuratedArgs/buildCuratedEnv, applyUserEnvRows
// re-implemented per-harness below since it is a pure function with no
// Claude-specific behavior — see the note on that below).
// ---------------------------------------------------------------------------

import type { HarnessLaunch } from '../../../shared/harness/types'
import { FLAG_DELIMITER } from '../../../shared/cliFlags'
import { resolveHarnessSettings, type HarnessSettingRow } from '../settings'
import { CODEX_CURATED, buildCuratedArgs, buildCuratedEnv } from './curated'
import { getClaudeWorkspaceSettings } from '../../claudeWorkspaceSettings'
import { codexSessionArgs, scheduleCodexSessionDiscovery } from './session'

const HARNESS_ID = 'codex-cli'

/**
 * Layers a per-WORKSPACE model/effort override on top of the (already
 * global -> project layered) harness_settings curated values — same shape
 * and same reasoning as Claude's withWorkspaceCuratedOverride
 * (harness/claude/launch.ts), reused via the SAME storage table.
 *
 * REUSE FINDING (per the B4 task brief): claude_workspace_settings is keyed
 * by `workspace_id` ONLY (see its schema.ts TableDef and
 * claudeWorkspaceSettings.ts's own header — "a thin shim over the shared
 * overridesStore factory, bound to claude_workspace_settings"). A
 * workspace_id is 1:1 with exactly one harness for that workspace's entire
 * lifetime (workspaces.harness_id is set once at creation — see C1's
 * createWorkspace() harnessId param), so there is no key-collision hazard in
 * reading/writing this table from a Codex workspace: a Codex workspace's row
 * in claude_workspace_settings is exclusively that Codex workspace's data,
 * never shared with or overwritten by a Claude workspace's row. The table
 * name is Claude-branded (a naming artifact of it predating the multi-
 * harness architecture entirely), but the STORAGE is not Claude-specific —
 * it is generic {model, effort, ...} keyed by workspace id. Reusing it here
 * (rather than inventing claude_workspace_settings' Codex-flavoured twin)
 * avoids a genuinely pointless schema fork for identical data. This
 * matches the B4 brief's own framing ("that table is keyed by workspace_id
 * ONLY, which is 1:1 with a harness, so reuse is structurally safe") and no
 * case was found where it does NOT hold — so this does not stop and report,
 * per the brief's own conditional ("if you find that genuinely cannot be
 * reused, STOP and report").
 *
 * 'auto' EFFORT SENTINEL — same as Claude's version: a workspace effort of
 * 'auto' (or '') means "no override", falling through to the already-
 * resolved project/global curated.effort rather than being emitted or
 * masking a real value.
 *
 * READ DEFENSIVELY — runs on every terminal mount; a throw from underneath
 * getClaudeWorkspaceSettings must not take the whole launch down.
 *
 * No workspaceId -> returns `curated` unchanged.
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
  const effortOverride = effort && effort !== 'auto' ? effort : undefined
  if (model === undefined && effortOverride === undefined) return curated
  return {
    model: model !== undefined ? model : curated.model,
    effort: effortOverride !== undefined ? effortOverride : curated.effort
  }
}

/**
 * Composes a Codex `HarnessLaunch` from resolved harness_settings + curated
 * fields. Mirrors composeClaudeHarnessLaunch's public signature (projectId?,
 * workspaceId?) — same descriptor contract (ComposeHarnessLaunch).
 *
 * COMPOSITION ORDER (same discipline as Claude's emitter — see that file's
 * doc comment for the full reasoning; only the divergences are called out
 * inline below):
 *
 *   1. SESSION-CONTINUITY PREFIX FIRST (C5) — `['resume', <id>]` when a
 *      prior discovery bound this workspace, else nothing. UNLIKE Claude
 *      (whose continuity tokens are typed flags placed AFTER curated
 *      model/effort), Codex's `resume` is a SUBCOMMAND and MUST be the
 *      first token(s) emitted or codex's arg parser won't recognise it —
 *      verified empirically: `codex resume --last --bogus-flag` reports the
 *      error against `Usage: codex resume ...` (proving `resume` parsed as
 *      the subcommand), while `codex --bogus-flag resume --last` reports it
 *      against the TOP-LEVEL `Usage: codex [OPTIONS] [PROMPT]` (proving a
 *      flag placed before `resume` never reaches the subcommand at all).
 *      See ./session.ts's header for the full discovery mechanics.
 *   2. THEN CURATED — model (`-m`), effort (`-c model_reasoning_effort=`).
 *      `resume` accepts these same options itself (confirmed via `codex
 *      resume --help`), so they compose correctly after the prefix.
 *   3. THEN USER ARG ROWS, in declared order (global rows first, then
 *      project-introduced keys).
 *   4. THEN USER ENV ROWS, layered on top of curated env, curated winning on
 *      key collision (same precedence rule as Claude's emitter).
 *   5. settingsJson — ALWAYS '' (see this file's header, divergence 3).
 *
 * SIDE EFFECT: also SCHEDULES discovery (scheduleCodexSessionDiscovery) for
 * this launch, capturing `Date.now()` as the mount-time floor at the moment
 * this function runs (i.e. before the process is even spawned) — see
 * session.ts's header on why that floor matters. This is a launch-time,
 * not a post-mount, hook because composeCodexHarnessLaunch is the only
 * call site this unit owns that fires once per real mount attempt; there is
 * no dedicated post-mount hook available to a harness module without
 * reaching into index.ts. A no-op (no workspaceId) skips scheduling.
 */
export function composeCodexHarnessLaunch(projectId?: string, workspaceId?: string): HarnessLaunch {
  const resolved = resolveHarnessSettings(HARNESS_ID, projectId)
  const curated = withWorkspaceCuratedOverride(resolved.curated ?? {}, workspaceId)

  if (workspaceId) {
    scheduleCodexSessionDiscovery(workspaceId, Date.now())
  }

  const flagTokens: string[] = [
    // Subcommand-first continuity prefix — see this function's doc comment,
    // ordering step 1. Empty array (a no-op spread) when unbound.
    ...codexSessionArgs(workspaceId),
    // Model then effort — same relative order as Claude's curated pair (no
    // isClaude() gate here; see this file's header, divergence 1).
    ...buildCuratedArgs(CODEX_CURATED.model, curated.model ?? ''),
    ...buildCuratedArgs(CODEX_CURATED.effort, curated.effort ?? ''),
    ...userArgTokens(resolved.args)
  ]

  const curatedEnv: Record<string, string> = {
    ...buildCuratedEnv(CODEX_CURATED.model, curated.model ?? ''),
    ...buildCuratedEnv(CODEX_CURATED.effort, curated.effort ?? '')
  }
  const envWithUserRows = applyUserEnvRows(curatedEnv, resolved.env)
  // Wrapper-plumbing env — harness-agnostic (harness-common.sh, sourced by
  // EVERY harness's own wrapper script, reads these directly). Identical
  // emission to Claude's launch.ts; see that file's doc comment for why
  // this lives here rather than in buildMountEnv.
  const env: Record<string, string> = { ...envWithUserRows }
  if (resolved.preLaunchSnippet) {
    env['ORPHEUS_PRE_LAUNCH_SNIPPET'] = resolved.preLaunchSnippet
  }
  if (resolved.sourceZshrc) {
    env['ORPHEUS_SOURCE_ZSHRC'] = '1'
  }

  return {
    flags: flagTokens.join(FLAG_DELIMITER),
    // No --settings equivalent exists on Codex — always empty. See this
    // file's header, divergence 3.
    settingsJson: '',
    env,
    model: curated.model ?? '',
    effort: curated.effort ?? ''
  }
}

/** Flattens enabled user arg rows into argv tokens, in declared order.
 *  Identical logic to Claude's launch.ts — pure, harness-agnostic. */
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
 *  CURATED WINS on key collision — identical rule and identical logic to
 *  Claude's launch.ts (applyUserEnvRows). Reimplemented here rather than
 *  imported: it is a tiny pure function with zero Claude-specific behavior,
 *  and importing across harness/claude <-> harness/codex for logic this
 *  trivial (a five-line loop, already covered by this file's own scenario
 *  in scripts/verify-harness-codex-launch.ts) would be more indirection than
 *  the reuse is worth — unlike buildCuratedArgs/buildCuratedEnv above, which
 *  encode a real, non-trivial emission-form contract worth keeping in
 *  exactly one place. Exported for the same test-seam reason Claude's
 *  version is: so the collision rule can be asserted directly. */
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
