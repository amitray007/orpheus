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

import type {
  CuratedField,
  HarnessArgRow,
  HarnessCapabilities
} from '../../../shared/harness/types'
import { CLAUDE_EFFORT_VALUES, CLAUDE_MODEL_OPTIONS } from '../../../shared/types'

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

export const CLAUDE_CURATED = {
  model: CLAUDE_CURATED_MODEL,
  effort: CLAUDE_CURATED_EFFORT
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
  if (!field || !value) return []
  // Flag form — Claude's `--model opus`.
  if (field.flag) return [field.flag, value]
  // Config-override form — Codex's `-c model_reasoning_effort="high"`. Two
  // argv tokens, the carrier flag then a single key=value token, NOT three:
  // `-c` takes one argument and the `=` is part of it.
  //
  // The value is passed through verbatim rather than quoted. Quoting is a
  // SHELL concern, and these tokens never transit a shell — they are joined
  // with 0x1F and split back into argv by the wrapper (see cliFlags.ts's
  // FLAG_DELIMITER rationale), so adding quotes here would send literal
  // quote characters to the binary.
  if (field.configFlag && field.configKey) {
    return [field.configFlag, `${field.configKey}=${value}`]
  }
  // Env form (or an unset field) contributes no argv — see buildCuratedEnv.
  return []
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

// ---------------------------------------------------------------------------
// Default args
// ---------------------------------------------------------------------------

/**
 * The CLI args Claude ships with. `--permission-mode` lives HERE, not as a
 * curated concept: it is a Claude flag, and the same intent is
 * `--ask-for-approval never --sandbox danger-full-access` on Codex,
 * `--allow-all` on Copilot, `-y` on Gemini. Those are different argv shapes,
 * not one field with different values, so modelling them as a shared typed
 * field was wrong — see CuratedField's header in shared/harness/types.ts.
 *
 * Seeded as an editable row rather than an unconditional prefix, and
 * disabled by default: it is security-relevant, so the user opts in rather
 * than discovering after the fact that Orpheus turned permission prompts off
 * for them.
 */
export const CLAUDE_DEFAULT_ARGS: HarnessArgRow[] = [
  { key: '--permission-mode', value: 'acceptEdits', enabled: false }
]

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * What Claude Code supports. Declared HERE rather than inline in
 * registry.ts to keep the module graph acyclic: session.ts needs Claude's
 * own capabilities to gate resume/fork, and reaching them through
 * resolveHarness() made session.ts depend on the registry, which depends on
 * launch.ts, which depends on session.ts — a cycle check:arch rejects.
 *
 * A harness module asking the registry about ITSELF was the design smell
 * behind that cycle. Its own facts belong in its own leaf module; the
 * registry composes them into a descriptor, and nothing inside the harness
 * needs to ask the registry who it is.
 */
export const CLAUDE_CAPABILITIES: HarnessCapabilities = {
  // sessionState.ts watches ~/.claude/sessions/<pid>.json (SESSIONS_DIR,
  // this file's sibling module) for live busy/idle/waiting status.
  structuredStatus: true,
  // Every claude session writes ~/.claude/projects/<encoded-cwd>/*.jsonl —
  // the app's authoritative transcript store (see CLAUDE.md's Session
  // domain-model paragraph; parsed by claudeActivityWindow.ts, etc.).
  transcript: true,
  // claudeSettings.ts's pushSessionContinuityFlags emits `--resume
  // <sessionId>` once a workspace's .jsonl exists.
  resume: true,
  // Real, wired feature: workspace.fork (src/main/actions/workspace.ts's
  // handleFork) clones a workspace and claudeSettings.ts's
  // pushSessionContinuityFlags emits `--session-id <new-uuid> --resume
  // <parent-uuid> --fork-session` on first launch of the fork. Distinct
  // from plain resume (branches history under a NEW id instead of
  // continuing the same one).
  fork: true,
  // Real, wired feature: claudeActivityWindow.ts parses claude's own
  // transcript .jsonl files for per-line token counts and rolls them into
  // ClaudeActivityWindowResult (tokenTotal, per-model activity), surfaced
  // in the renderer's dashboard pulse data (usePulseData.ts) via the
  // `claude:activityWindow` IPC channel (src/shared/ipc.ts:402).
  usage: true,
  // orpheusNotify.ts installs managed hooks into ~/.claude/settings.json
  // (SessionStart, etc.) — see CLAUDE.md's "Hooks are dormant enrichment"
  // paragraph: the hook plumbing itself is real and live, even though
  // status is no longer decided by hook events post Phase-2-cutover.
  hooks: true,
  // claudeSettings.ts's composeClaudeLaunch produces `settingsJson` for
  // ORPHEUS_CLAUDE_SETTINGS_JSON, consumed by resources/orpheus-claude.sh
  // via `claude --settings <json>`.
  inlineSettingsJson: true,
  // Describes what the HARNESS supports, not whether routing is currently
  // wired for it — those are different questions. Claude Code has a real
  // model picker (ClaudeGlobalSettings.model / --model) and is the one
  // harness whose traffic CAN be routed through the model-routing proxy
  // for non-Claude model ids (src/main/modelRouting.ts). Phase 0 severed
  // launch-side routing for Claude itself — applyModelRouting is a
  // byte-for-byte no-op whenever the resolved model IS a Claude model
  // (modelRouting.ts:10-14's ToS invariant) — but that's a statement about
  // which requests get routed, not about whether the harness supports
  // model selection/routing as a capability. `true` is correct here.
  // P1.7 will assert this is the ONLY descriptor with modelRouting: true,
  // which is a statement about the future non-Claude harnesses (Codex
  // CLI/Gemini CLI), not a contradiction of Claude having the capability.
  modelRouting: true
}
