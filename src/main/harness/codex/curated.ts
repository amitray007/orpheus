// ---------------------------------------------------------------------------
// src/main/harness/codex/curated.ts
//
// Codex CLI's descriptor data — B1 of the Phase B (multi-harness migration)
// Codex module. Mirrors src/main/harness/claude/curated.ts in shape and
// comment discipline; read that file's header first for the general
// rationale (why only model/effort are curated concepts, why `allowCustom`
// is always `true`, why capabilities live in their own leaf module rather
// than inline in registry.ts to keep the module graph acyclic).
//
// PROVENANCE — every fact below was VERIFIED against a live run of
// codex-cli 0.147.0 on this machine, not guessed from docs. See the B4
// task brief for the exact transcript. In short:
//   codex -m gpt-5.4-mini -c model_reasoning_effort=low --sandbox read-only "<prompt>"
// ran end-to-end and the session header echoed back "reasoning effort: low",
// proving the `-c key=value` pair is applied. `codex debug models` is the
// source for the model list and per-model effort defaults (visibility=list
// only — codex-auto-review is visibility=hide and is deliberately excluded).
// ---------------------------------------------------------------------------

import type {
  CuratedField,
  HarnessArgRow,
  HarnessCapabilities
} from '../../../shared/harness/types'
import { buildCuratedArgs, buildCuratedEnv } from '../claude/curated'

// Re-exported rather than re-implemented. buildCuratedArgs/buildCuratedEnv
// (src/main/harness/claude/curated.ts) already implement BOTH emission forms
// this file needs — the flag form AND the configFlag/configKey form Codex's
// effort field uses (`[configFlag, '<configKey>=<value>']`, exactly two argv
// tokens, never three or a joined string — see that function's own doc
// comment for why quoting must not happen here). scripts/verify-harness-
// curated.ts:306+ already asserts the configFlag/configKey branch against
// this exact implementation.
//
// FINDING (as requested by the B4 task brief): importing a "claude/" module
// from "codex/" reads oddly at first glance — the directory name suggests
// Claude-specific logic. It isn't; buildCuratedArgs/buildCuratedEnv are pure
// functions over CuratedField's shape and have no Claude-specific behavior
// (no reference to `claude`, no Claude-only branching). They ended up under
// harness/claude/ only because U3 (the unit that introduced CuratedField)
// happened to land alongside Claude's own descriptor, the first and at the
// time only harness. A follow-up could relocate them to a harness-neutral
// module (e.g. harness/curatedBuilders.ts) with Claude's and Codex's curated
// modules both importing from there — but that is a pure file-move refactor
// with no behavior change, out of scope for this unit, and reuse-over-
// duplication wins today regardless of which directory the reused code
// happens to sit in.
export { buildCuratedArgs, buildCuratedEnv }

// ---------------------------------------------------------------------------
// Curated fields
// ---------------------------------------------------------------------------

// Model slugs Codex actually lists (`codex debug models`, visibility=list).
// `codex-auto-review` is visibility=hide and is deliberately excluded — it
// is not a model a user picks from a launcher, it's an internal review
// mode. Order matches the source listing.
const CODEX_MODEL_SLUGS = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex-spark'
] as const

// Union of every effort value ANY listed model accepts. EFFORT VALIDITY IS
// PER-MODEL — re-verified against `codex debug models` on codex-cli 0.147.0:
//
//   gpt-5.6-sol          low medium high xhigh max ultra   (default low)
//   gpt-5.6-terra        low medium high xhigh max ultra   (default medium)
//   gpt-5.6-luna         low medium high xhigh max         (default medium)
//   gpt-5.5 / 5.4 /
//   5.4-mini / spark     low medium high xhigh             (spark default high)
//
// An earlier version of this comment claimed ultra/max were valid on
// sol/terra/LUNA — wrong: luna has max but NOT ultra. Only two models accept
// ultra. Corrected from the catalog rather than restated.
//
// `none` and `minimal` also exist in the binary's config-level effort enum
// but are advertised by no listed model, so they are deliberately not
// offered here.
//
// v1 ships this flat union with no per-model gating; an invalid pairing is
// rejected by the API rather than by the CLI upfront. Narrowing the offered
// list to the SELECTED model's own levels is the natural follow-up, and the
// catalog JSON already carries both the per-model levels and each model's
// default_reasoning_level to drive it. Safe meanwhile because
// curated.options is a UI suggestion list, never a validation whitelist
// (see CuratedField's own doc comment).
const CODEX_EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

// liveApply is `restartRequired` for BOTH fields below — now VERIFIED, no
// longer the conservative guess it started as.
//
// Codex's REPL does have `/model`, but it takes NO ARGUMENT: it opens an
// INTERACTIVE PICKER (choose a model, then choose a reasoning effort), which
// is a fundamentally different shape from Claude's `/model {value}` one-shot
// injection. Typing `/model gpt-5.6-terra` does not select that model. So
// there is no text Orpheus could inject to live-apply either concept, and
// `replInject` would leave a workspace sitting in a half-navigated picker —
// strictly worse than restarting. Reported from real use, and consistent
// with `codex --help`, which documents no argument-taking slash command.
//
// Do NOT "improve" this to replInject with a picker-driving keystroke
// sequence: that would encode Codex's current TUI layout as a protocol, and
// it would silently break the first time that picker's order or key handling
// changes. If Codex ever gains an argument-taking form, THAT is what to
// `replInject`, rather than re-deriving from scratch whether it was ever
// investigated.
const CODEX_LIVE_APPLY = { kind: 'restartRequired' } as const

export const CODEX_CURATED_MODEL: CuratedField = {
  flag: '-m',
  options: [...CODEX_MODEL_SLUGS],
  allowCustom: true,
  liveApply: CODEX_LIVE_APPLY
}

export const CODEX_CURATED_EFFORT: CuratedField = {
  configFlag: '-c',
  configKey: 'model_reasoning_effort',
  options: [...CODEX_EFFORT_VALUES],
  allowCustom: true,
  liveApply: CODEX_LIVE_APPLY
}

export const CODEX_CURATED = {
  model: CODEX_CURATED_MODEL,
  effort: CODEX_CURATED_EFFORT
}

// ---------------------------------------------------------------------------
// Default args
// ---------------------------------------------------------------------------

/**
 * The CLI args Codex ships with. DELIBERATE DIVERGENCE from Claude's
 * analogous CLAUDE_DEFAULT_ARGS row: Claude's `--permission-mode` default
 * row ships `enabled: false` (opt-in — see that file's doc comment), but
 * BOTH of Codex's rows below ship `enabled: true`. This was a USER DECISION,
 * not an oversight or a "fix" to bring the two in line — do not make them
 * match. Codex sandboxes by default and, left at its own defaults, prompts
 * for approval constantly; the whole point of these two rows shipping
 * enabled is to make a fresh Codex workspace usable out of the box the way
 * a fresh Claude workspace already is (Claude's permission prompting is far
 * less aggressive by default, which is exactly why ITS analogous row can
 * safely default to off).
 *
 * `--skip-git-repo-check` is DELIBERATELY ABSENT from this list. It was
 * shipped here (disabled) on the belief that it guards interactive Codex in
 * a non-git directory. IT DOES NOT EXIST ON THE INTERACTIVE BINARY — it is
 * an `exec`-only flag, and Orpheus launches the interactive TUI. Verified
 * against codex-cli 0.147.0:
 *
 *   codex --skip-git-repo-check --help
 *     -> error: unexpected argument '--skip-git-repo-check' found
 *   codex exec --skip-git-repo-check --help   -> accepted
 *
 * It is not valid on `codex resume` either, which is the path a bound
 * workspace takes. So enabling that row would have made the workspace fail
 * to launch with a clap parse error — a shipped landmine, harmless only
 * because it defaulted to off. Do not re-add it without exec-gating it.
 * (The refusal message it was justified by is exec-mode's; the interactive
 * TUI shows a trust PROMPT in an untrusted directory instead.)
 */
export const CODEX_DEFAULT_ARGS: HarnessArgRow[] = [
  { key: '--ask-for-approval', value: 'never', enabled: true },
  { key: '--sandbox', value: 'danger-full-access', enabled: true }
]

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * What Codex CLI supports. See CLAUDE_CAPABILITIES's doc comment
 * (harness/claude/curated.ts) for why this lives in its own leaf module
 * rather than inline in registry.ts (module-graph acyclicity).
 */
export const CODEX_CAPABILITIES: HarnessCapabilities = {
  // Codex has no PID/session-status registry analogous to Claude's
  // ~/.claude/sessions/<pid>.json, and `codex exec --json` (its
  // machine-readable event stream) is a DIFFERENT invocation mode than the
  // interactive TUI launch this harness composes — Orpheus's terminal-hosted
  // launch path never runs `codex exec`, so that JSON stream was never
  // reachable from here. TRUE as of the status-indicator unit
  // (support-multi-harness): a status source that DOES fit the interactive
  // launch path was found and wired instead —
  // src/main/harness/codex/statusState.ts combines on-disk signals the
  // interactive `codex` binary already produces as a side effect of running:
  // (1) the last recognized turn-lifecycle event_msg line in the workspace's
  // bound rollout file (~/.codex/sessions/<date>/rollout-*.jsonl, see
  // session.ts) — task_started/task_complete, plus turn_aborted as a real
  // third terminal marker (a turn that ends without a clean task_complete,
  // e.g. user-interrupted or errored) and turn_started/turn_complete as
  // defensive rename-aliases that do not currently occur in practice; (2)
  // whether a ~/.codex/thread-writer-locks/<session-uuid>.lock file still
  // exists (liveness — removed when the codex process exits, and this
  // unconditionally wins over any lifecycle event — the stuck-indicator
  // fix); and (3) for a terminal event, how long ago it happened compared
  // against the same staleAfterMinutes setting Claude's own status path
  // uses, to distinguish "just finished" (awaiting_input, renders as ready)
  // from "finished a while ago" (idle). See statusMap.ts's mapCodexStatus
  // for the exact truth table.
  //
  // ATTENTION IS DELIBERATELY NOT IMPLEMENTED — NOT AN OVERSIGHT, AND NOT
  // BECAUSE CODEX LACKS THE CONCEPT. Codex's shipped binary genuinely
  // contains approval-request event variants (exec_approval_request,
  // apply_patch_approval_request, request_user_input, elicitation_request,
  // collab_waiting_begin/_end) — approvals are real, and approved/denied/
  // abort decisions really happen. But these are emitted only on Codex's
  // LIVE event stream and are NEVER persisted into the on-disk rollout file
  // this status source reads. Verified empirically: 17 real rollouts ran
  // with approval_policy="on-request" (approvals genuinely enabled) across
  // 2088 patch/exec actions, and produced ZERO approval-shaped records in
  // the rollout files. Since the rollout is our only read-only source,
  // 'attention' is not derivable — a limitation of THIS OBSERVATION
  // CHANNEL, not of Codex's protocol. Do not "fix" this into a synthetic
  // attention state guessed from indirect signals.
  structuredStatus: true,
  // Codex writes its own on-disk conversation history (mirroring Claude's
  // ~/.claude/projects/<cwd>/*.jsonl transcript store in spirit, if not in
  // exact format) — the capability itself is real; ONLY this unit's own
  // session-CONTINUITY ARGS are deferred (see launch.ts's header: Codex
  // mints its own session id with no flag to pre-assign one, so v1 emits no
  // --resume/--session-id-equivalent tokens). transcriptSource wiring (which
  // file, which format) is left as the TODO(Phase 4/5) placeholder on the
  // descriptor itself, same as every other harness before its concrete
  // status/transcript source is defined.
  transcript: true,
  // Codex supports resuming a prior conversation by id in principle (`codex
  // resume`) — the capability is real. This unit's launch emitter does not
  // yet EXERCISE it (no continuity args composed today — see launch.ts's
  // header, divergence 2); wiring the actual --resume-equivalent flag into
  // composeCodexHarnessLaunch is deferred to C5, once Codex's resume/session
  // story is worked out in full. The flag describes what the harness CAN do,
  // not what this unit's emitter currently emits — same distinction
  // CLAUDE_CAPABILITIES.modelRouting draws for Claude (see that file's own
  // doc comment: "a statement about which requests get routed, not about
  // whether the harness supports [the capability]").
  resume: true,
  // Same "capability real, wiring deferred to C5" distinction as resume
  // above — Codex's resume mechanism is the basis a future fork
  // implementation would branch from.
  fork: true,
  // Codex reports token/usage figures (visible in its own session output) —
  // the app-side plumbing to surface it in Orpheus's UI is a later unit, not
  // yet built here, but the harness itself genuinely reports usage.
  usage: true,
  // A hooks MECHANISM exists on disk (~/.codex/hooks.json per Codex's own
  // docs), but nothing in Orpheus consumes it. Compare Claude's hooks:
  // true — that one is true because orpheusNotify.ts genuinely installs and
  // reads managed hooks (see CLAUDE.md's "Hooks are dormant enrichment, not
  // the status driver" paragraph — even Claude's hook STACK is live
  // plumbing, just not the status decider any more). Codex has no
  // equivalent live plumbing at all; the hook stack here is entirely
  // dormant on the Orpheus side, so false.
  hooks: false,
  // No `--settings <json>` (or equivalent) flag exists on Codex — verified
  // against `codex --help`/`codex exec --help`. composeCodexHarnessLaunch
  // (./launch.ts) always returns settingsJson: '' as a direct consequence.
  inlineSettingsJson: false,
  // CRITICAL / ToS-CRITICAL — MUST stay false. See
  // src/main/modelRouting.ts:10-14: for a Claude-model workspace,
  // applyModelRouting must be a byte-for-byte no-op — Claude traffic must
  // reach real api.anthropic.com via the official binary, never through a
  // third-party proxy. scripts/verify-harness-registry.ts asserts NO
  // descriptor other than 'claude' sets modelRouting: true; flipping this
  // to true would fail that suite outright.
  //
  // THIS IS A DIFFERENT QUESTION FROM WHETHER CODEX HAS A MODEL PICKER. It
  // does — CODEX_CURATED.model above IS a real, working model picker (the
  // `-m` flag, 7 real slugs). modelRouting specifically means "this
  // harness's traffic may be routed through Orpheus's own model-routing
  // proxy for non-Claude model ids" (src/main/modelRouting.ts) — a routing
  // capability Codex has no relationship to at all; it talks to its own
  // OpenAI-compatible backend directly via its own binary, never through
  // that proxy. Conflating "has a model picker" with "supports
  // modelRouting" is an easy mistake to make from the name alone — do not
  // make it here, and do not let a future reader "fix" this to true because
  // the model picker looks similar to Claude's.
  modelRouting: false,
  // True — the whole reason this flag exists. Codex sets the terminal
  // title to the git repo folder name (verified: identical across every
  // Codex workspace in the same repo), so unlike Claude there is no useful
  // fallback title today. src/main/harness/codex/titleGeneration.ts's
  // scheduler is gated on this flag (never on `harnessId === 'codex-cli'`
  // — see CLAUDE.md's capability-gating rule) and is wired from
  // composeCodexHarnessLaunch (./launch.ts).
  titleGeneration: true
}
