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
// codex-cli 0.148.0 on this machine, not guessed from docs. See the B4
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

// Union of every effort value ANY listed model accepts (`low`, `medium`,
// `high`, `xhigh`, `max`, `ultra`), per model listed in the task brief. Note
// EFFORT VALIDITY IS PER-MODEL — `ultra`/`max` are only valid on
// gpt-5.6-sol/-terra/-luna, and an invalid pairing fails as an HTTP 400
// AFTER the session has already started (not a clean upfront CLI rejection).
// v1 deliberately ships this flat union with no per-model gating; narrowing
// the offered list to what the CURRENTLY SELECTED model actually supports is
// a follow-up (curated.options here is a UI suggestion list only, never a
// validation whitelist — see CuratedField's own doc comment — so shipping
// the superset is safe, just not maximally helpful).
const CODEX_EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

// liveApply is `restartRequired` for BOTH fields below. This is an HONEST
// "unverified", not an assumed-absent: nobody has confirmed whether Codex's
// interactive REPL has a slash-command (or similar) surface that could
// live-apply a new model/effort mid-session the way Claude's `/model
// {value}` does. Ship the conservative case (a footer chip change requires
// a workspace restart to take effect) and leave this comment so a later
// unit knows to go CHECK Codex's REPL surface before flipping this to
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
 * `--skip-git-repo-check` ships DISABLED, unlike the two rows above. Codex
 * refuses to run outside a trusted/git directory ("Not inside a trusted
 * directory and --skip-git-repo-check was not specified.") — that is a
 * genuine safety feature (it stops Codex from getting `danger-full-access`
 * sandbox rights in a directory with no version control to recover from a
 * mistake), so a non-git workspace should fail loudly by default and the
 * user opts into skipping the check, not the other way around.
 */
export const CODEX_DEFAULT_ARGS: HarnessArgRow[] = [
  { key: '--ask-for-approval', value: 'never', enabled: true },
  { key: '--sandbox', value: 'danger-full-access', enabled: true },
  { key: '--skip-git-repo-check', enabled: false }
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
  // ~/.claude/sessions/<pid>.json. Its own machine-readable event stream is
  // `codex exec --json`, which is a DIFFERENT invocation mode than the
  // interactive TUI launch this harness composes (`codex -m ... "<prompt>"`
  // / plain interactive `codex`) — Orpheus's terminal-hosted launch path
  // never runs `codex exec`, so that JSON stream is not reachable from here.
  // False until (if ever) a follow-up wires a status source that actually
  // fits the interactive launch path.
  structuredStatus: false,
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
  modelRouting: false
}
