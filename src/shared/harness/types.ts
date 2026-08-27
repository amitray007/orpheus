// ---------------------------------------------------------------------------
// Harness descriptor types (Phase 1, P1.1).
//
// A "harness" is the coding-agent CLI a workspace runs (Claude Code today;
// Codex CLI / Gemini CLI in later phases — see the multi-harness migration
// roadmap, issue #187). This file defines the TYPE-LEVEL shape of a harness
// descriptor. It is pure: types and const literals only, no runtime logic,
// no imports from src/main, src/preload, or src/renderer (enforced by the
// `shared-not-to-*` dependency-cruiser rules — see .dependency-cruiser.cjs).
//
// THE CENTRAL DESIGN RULE OF THE WHOLE MIGRATION:
// UI and app logic must gate on CAPABILITY (HarnessCapabilities), never on
// harnessId. Checking `harnessId === 'claude'` to decide whether a feature
// is available re-couples the app to one harness and defeats the point of
// this abstraction. Check `capabilities.resume`, `capabilities.hooks`, etc.
// instead. harnessId is an identity/label, not a feature switch.
//
// Phase 1 itself is a zero-behavior-change refactor: Claude becomes the sole
// descriptor, and every byte reaching `claude` stays identical. Actual
// descriptor implementations live in src/main/harness/ (main-process code,
// e.g. the registry and composeLaunch bodies) — this file only declares the
// shapes they satisfy.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// HarnessId
// ---------------------------------------------------------------------------

// The id of a supported harness. Claude Code today; C1 (support-multi-harness)
// widens the TYPE so a second harness id is expressible, without yet adding a
// second descriptor (that's a later unit — see registry.ts's HARNESSES array,
// still `[CLAUDE_DESCRIPTOR]`).
//
// NAMING NOTE: from the SECOND harness onward (Phase 3's `codex-cli`, and
// later `gemini-cli`), harness ids take a `-cli` suffix. This is a locked
// decision from issue #187, adopted specifically to keep harness ids
// visually and namespace-distinct from PROVIDER ids — provider ids are
// persisted in `routing_proxy_providers` / `routing_proxy_model_aliases`
// (column `claude_name`) and must never be renamed, so a harness id that
// collided with (or resembled) a provider id would be a real hazard.
//
// Claude is deliberately exempted from the `-cli` suffix and stays the bare
// `'claude'`: Phase 1.3 (see roadmap) adds a DB column for harness id whose
// default is `'claude'`, and every existing row in the database implicitly
// "is" `'claude'` today. Using the bare id here means that default matches
// every pre-existing row with zero data migration. Do NOT rename this to
// `'claude-cli'` — that would require a data step this phase is explicitly
// scoped to avoid, for a rule that only needs to bind starting with the
// second harness.
//
// SHAPE: `'claude' | (string & {})` rather than a closed union. A closed
// union (`'claude' | 'codex-cli'`) would force this shared, DB-free file to
// know every future harness id in advance — but harness identity is DATA
// (registry.ts's HARNESSES array), not a compile-time enum, and a value read
// back from `workspaces.harness_id` is untrusted input that must be able to
// hold a stale/future/garbage string without a cast (see resolveHarness's
// own doc comment: an unknown id must resolve to Claude, never crash or hit
// a type error). The `& {}` intersection is the standard TS idiom for
// "widen to string but keep the literal `'claude'` for autocomplete/
// exhaustiveness checks" — plain `string` would drop that literal entirely.
// isKnownHarnessId (registry.ts) remains the actual runtime membership check
// against HARNESSES; this type only says "any string is structurally
// assignable," it does not claim the id is registered.
export type HarnessId = 'claude' | (string & {})

// ---------------------------------------------------------------------------
// HarnessCapabilities
// ---------------------------------------------------------------------------

// Feature flags describing what a harness supports. The app (UI and main
// process alike) must branch on these, not on HarnessId — see the file
// header. A harness that lacks a capability should have the corresponding UI
// affordance hidden or disabled rather than shown-and-failing.
export interface HarnessCapabilities {
  /** The harness exposes machine-readable status (busy/idle/waiting) the app
   *  can read to drive live activity indicators, e.g. Claude's
   *  ~/.claude/sessions/<pid>.json registry. When false, activity status
   *  cannot be shown for workspaces on this harness. */
  structuredStatus: boolean
  /** The harness writes a readable on-disk transcript (e.g. Claude's
   *  ~/.claude/projects/<cwd>/*.jsonl) the app can parse for session
   *  history, search, or display outside the live terminal. */
  transcript: boolean
  /** The harness supports resuming a prior conversation by id (e.g. Claude's
   *  `--resume <sessionId>`). When false, reopening a workspace must start a
   *  fresh conversation instead of continuing the old one. */
  resume: boolean
  /** The harness supports branching a new session off an existing one's
   *  history (fork), distinct from plain resume. */
  fork: boolean
  /** The harness reports token/cost usage the app can surface in the UI. */
  usage: boolean
  /** The harness supports lifecycle hooks (session start/stop, tool-use,
   *  etc.) the app can register into, e.g. Claude's managed hooks in
   *  ~/.claude/settings.json. */
  hooks: boolean
  /** The harness accepts an inline JSON settings blob at launch (e.g.
   *  Claude's `--settings <json>`) rather than requiring every setting to
   *  round-trip through an on-disk config file. */
  inlineSettingsJson: boolean
  /** The harness supports selecting/routing between multiple underlying
   *  models (e.g. Claude's model picker + provider routing). When false,
   *  model-selection UI should not be offered for this harness. */
  modelRouting: boolean
  /** The app should attempt to generate a sidebar title for a new workspace
   *  on this harness from the user's first prompt (a local-model best-effort
   *  background task — see src/main/harness/codex/titleGeneration.ts). False
   *  for a harness whose own title-derivation already works, so this stays
   *  a no-op there rather than a redundant second title source: Claude
   *  already derives a good sidebar title from its own transcript (see
   *  CLAUDE.md's Session domain-model paragraph), so this flag exists
   *  specifically for a harness whose terminal-title fallback is otherwise
   *  useless (Codex sets the terminal title to the git repo folder name,
   *  identical across every workspace in that repo). */
  titleGeneration: boolean
}

// ---------------------------------------------------------------------------
// HarnessLaunch
// ---------------------------------------------------------------------------

// The composed, ready-to-use launch payload a harness descriptor's
// composeLaunch produces. Field-for-field IDENTICAL to `ClaudeLaunch` in
// src/main/claudeSettings.ts — see that file for the canonical definition
// this type mirrors. Kept identical deliberately: Phase 1 rests on the
// guarantee that every byte reaching `claude` is unchanged, and the Claude
// descriptor's composeLaunch is meant to be a one-line delegation to
// composeClaudeLaunch. Do not reshape this "to improve it" — do that (if
// ever) as a separate, deliberate change with its own review.
export type HarnessLaunch = {
  /** Whitespace-separated CLI flags, e.g. "--model opus --permission-mode acceptEdits".
   *  Empty string when all settings are at their claude defaults. */
  flags: string
  /** Inline JSON blob for --settings, covering keys with no CLI flag equivalent
   *  (alwaysThinkingEnabled, outputStyle, tui, editorMode, prefersReducedMotion).
   *  Empty string when no such keys differ from claude's defaults. */
  settingsJson: string
  /** Environment variables to set in the surface process, e.g.
   *  { CLAUDE_CODE_NATIVE_CURSOR: '1' }. Empty object when all at defaults. */
  env: Record<string, string>
  /** Effective resolved model id (workspace → project → global), the same
   *  value emitted as the --model flag. Callers (buildMountEnv's routing
   *  conditional) use this to decide isClaude(model) without re-parsing
   *  `flags`. Empty string means claude's own default (bare sonnet). */
  model: string
  /** Effective resolved effort/reasoning-level (workspace → project →
   *  global), the same value emitted as the --effort flag when curated
   *  emits one. Added in A0 (support-multi-harness) so callers that need
   *  the resolved effort (the footer Effort chip, the TUI tree frame) can
   *  read it back structurally instead of grepping `flags` for `--effort`.
   *  Appended after `model` rather than inserted alongside it, and every
   *  other field is untouched, to preserve
   *  scripts/verify-harness-launch-parity.ts's byte-equality pin on `flags`
   *  between the old and new emitters — see this type's own header comment
   *  ("do not reshape this"). Empty string means no override (claude picks
   *  its own default), matching `model`'s empty-string convention. */
  effort: string
}

// ---------------------------------------------------------------------------
// CuratedField
// ---------------------------------------------------------------------------

// One of the three concepts Orpheus curates per harness — model, effort, or
// permission-mode (KTD3 of the multi-harness migration plan: these three are
// hardcoded per harness because they are stable AND Orpheus itself reads
// them back — commandServer.ts's TUI tree frame, tmuxHost.ts's
// TreeSourceWorkspace, settingsResourceService.ts's validator, and the
// footer's modelSelect/effortSelect pickers. Every other setting is
// user-supplied, untyped passthrough args/env — see KTD2).
//
// A harness expresses a curated concept ONE way: either as a CLI flag
// (Claude's `--model`) or as an environment variable (superset's Vibe
// harness, which has no model flag and reads `VIBE_ACTIVE_MODEL` instead).
// Never both for the same concept — that's what the `flag`/`env` union
// below encodes: exactly one discriminating key is present per shape, so a
// descriptor author cannot accidentally set both, and a builder can branch
// on `'flag' in field` without a runtime assertion. (Both shapes could in
// principle be collapsed into one interface with `flag?: string; env?: string`
// and an ad-hoc invariant comment, but a discriminated union lets the
// exclusivity be enforced by the type checker itself — see buildCuratedArgs/
// buildCuratedEnv in src/main/harness/claude/curated.ts, which each accept
// this type and simply don't have a "both" case to handle.)
//
// `options` is a curated SUGGESTION list for UI pickers — never a
// validation whitelist. `allowCustom: true` is not a toggle (there is no
// `false` case): every curated field must accept a value outside `options`,
// because a user's install may have models/effort levels/permission modes
// this build's curated list doesn't know about yet. It exists as an
// explicit literal-`true` field (rather than being implied) so a reader of
// a HarnessDescriptor sees the "always accept custom" contract stated right
// on the data, not only in this comment.
//
// EMISSION FORMS — a harness expresses the same concept in genuinely
// different argv shapes, so the descriptor declares HOW, not just WHAT:
//   flag        `--model opus`                     (Claude)
//   env         VIBE_ACTIVE_MODEL=opus             (a harness with no flag)
//   configKey   `-c model_reasoning_effort="high"` (Codex)
// The three are mutually exclusive per field — a union, so a descriptor that
// sets two is a compile error rather than a runtime branch nobody wrote.
//
// This is deliberately NOT a fixed set of flag names. An earlier revision
// modelled permission-mode as a curated concept because Claude has
// `--permission-mode`; but Codex says `--ask-for-approval never --sandbox
// danger-full-access`, Copilot says `--allow-all`, Gemini says `-y`. Those
// are not one field with different values, they are different argv shapes,
// and they belong in defaultArgs. Only model and effort survived that test:
// every target harness either has them or cleanly omits them, AND Orpheus
// reads them back for its own UI (TUI tree, CLI display, footer pickers),
// which is what earns a concept typed status rather than being a plain row.
export type CuratedField = {
  options: string[]
  allowCustom: true
  /** How (or whether) this harness can apply a NEW value to an ALREADY
   *  RUNNING process — distinct from `flag`/`env`/`configKey`, which
   *  describe how the value reaches the process at LAUNCH. A footer chip
   *  that lets a user change model/effort mid-session needs to know which
   *  of these two regimes it's in before it does anything, so this is a
   *  required field (not optional-and-guessed-from-absence): a harness
   *  that genuinely cannot live-apply must SAY so, not leave callers to
   *  infer "no liveApply case, must mean append nothing" and quietly type
   *  a would-be REPL command into a session that doesn't understand it.
   *
   *  `kind: 'replInject'` — the harness understands a slash-command-style
   *  line typed straight into the running REPL, e.g. Claude's `/model
   *  {value}`. `template` uses `{value}` as the sole interpolation point
   *  (a literal string substitution, not a template-literal expression —
   *  see buildLiveApplyText in ./liveApply.ts) so a caller
   *  never hand-assembles `` `/model ${value}` `` itself and risks drifting
   *  from what this descriptor declares. `submit` says whether the built
   *  text should be submitted (Enter) immediately after injection, mirroring
   *  DropdownChip.tsx's existing `runInject(text, submit, ...)` signature.
   *
   *  `kind: 'restartRequired'` — this harness has no live-apply path for
   *  the concept at all; the ONLY way to make a new value take effect is to
   *  restart the workspace's process. First-class, not the absence of a
   *  case, so a caller's switch/if over `liveApply.kind` is exhaustive
   *  rather than falling through an `undefined` branch nobody wrote. */
  liveApply: { kind: 'replInject'; template: string; submit: boolean } | { kind: 'restartRequired' }
} & (
  | { flag: string; env?: never; configKey?: never; configFlag?: never }
  | { flag?: never; env: string; configKey?: never; configFlag?: never }
  // configFlag is the carrier (Codex's `-c`), configKey the setting name.
  // Emitted as two tokens: [configFlag, `${configKey}=${value}`].
  | { flag?: never; env?: never; configKey: string; configFlag: string }
)

// One CLI argument as a structured row rather than a fragment of a command
// string. `value` absent means a bare flag (`--verbose`); present means the
// flag takes a value and both tokens are emitted. `enabled: false` keeps a
// row in storage while excluding it from the launch, so a user can park a
// flag without retyping it later.
export type HarnessArgRow = {
  key: string
  value?: string
  enabled: boolean
}

// ---------------------------------------------------------------------------
// HarnessDescriptor
// ---------------------------------------------------------------------------

// composeLaunch's signature mirrors composeClaudeLaunch(projectId, workspaceId)
// in src/main/claudeSettings.ts — its two public parameters (projectId,
// workspaceId), both optional strings, identifying which settings layers to
// read. composeClaudeLaunch also accepts a third, Claude-specific
// `precomputedGlobal` performance parameter; that is an implementation
// detail of the Claude descriptor, not part of the general descriptor
// contract, so it is intentionally not part of this type. The function type
// itself is declared structurally right here rather than importing
// `ClaudeLaunch`/anything from src/main — the implementation (living in
// src/main/harness/registry.ts) satisfies this shared-side shape, but the
// shape's declaration must not pull in main-process code.
export type ComposeHarnessLaunch = (projectId?: string, workspaceId?: string) => HarnessLaunch

// Describes one supported harness end-to-end: identity, how to find/launch
// its binary, what it can do, and how to compose its launch payload.
export interface HarnessDescriptor {
  /** Stable identifier — see HarnessId. */
  id: HarnessId
  /** Human-readable name for UI display, e.g. "Claude Code". */
  label: string
  /** Executable name probed on PATH, e.g. 'claude'. */
  binary: string
  /** Shell wrapper filename under resources/ that actually launches the
   *  harness inside the terminal surface, e.g. 'orpheus-claude.sh'. */
  wrapperScript: string
  /** What this harness supports — see HarnessCapabilities. UI must gate on
   *  these fields, never on `id`. */
  capabilities: HarnessCapabilities
  /** Icon name for the harness picker, as a Phosphor icon identifier the
   *  renderer maps to a component. A plain string (not an imported icon)
   *  because src/shared must not reach into the renderer — the picker owns
   *  the name->component mapping, this file owns only the identity. */
  icon?: string
  /** Default CLI args this harness ships with — Claude's
   *  `--dangerously-skip-permissions`, Codex's `--ask-for-approval never
   *  --sandbox danger-full-access`, Gemini's `-y`. THIS is where a
   *  harness-specific flag belongs; it is the reason permission-mode is not
   *  a curated concept.
   *
   *  These SEED as real, user-editable rows marked harness-provided rather
   *  than being an unconditional prefix. A user can disable or override a
   *  shipped default and see where it came from, and a later descriptor
   *  update can add a new default without clobbering their edits — neither
   *  of which works if defaults are an opaque, non-negotiable prefix.
   *
   *  Structured rows, never one command string: a security-relevant flag
   *  (skip-permissions, danger-full-access) must stay individually visible
   *  and toggleable rather than buried in free text nobody audits. */
  defaultArgs?: HarnessArgRow[]
  /** Which settings UI sections apply to this harness, as section ids (a
   *  string array rather than an enum: the set of sections is owned by the
   *  renderer's settings UI, not by this shared harness-descriptor type, and
   *  a plain string keeps this file from having to import or duplicate that
   *  enum). Used to decide which panels of the settings UI to show/hide per
   *  harness — e.g. Claude-only sections stay hidden for a harness that
   *  doesn't support them. */
  settingsSections: string[]
  /** Composes this harness's launch payload (flags/settingsJson/env/model)
   *  for a given project/workspace. See ComposeHarnessLaunch. */
  composeLaunch: ComposeHarnessLaunch
  /** The two curated concepts — model and effort — this harness exposes,
   *  each optional (a harness with no reasoning-effort control simply omits
   *  `effort`). See CuratedField above for the emission forms, the mutual
   *  exclusivity, and the always-accept-custom-values contract. Undeclared
   *  entirely for a harness that curates neither.
   *
   *  Deliberately only these two: they are the concepts Orpheus itself reads
   *  BACK (TUI tree frame, CLI display, footer model/effort pickers), which
   *  is what justifies a typed field over an ordinary arg row. Anything
   *  Orpheus merely forwards belongs in defaultArgs or user rows. */
  curated?: { model?: CuratedField; effort?: CuratedField }
  /** Known-good CLI versions for this harness, used to gate features that
   *  depend on a minimum version or to warn on an untested one. Moves here
   *  from KNOWN_GOOD_VERSIONS (currently a module-level Set in
   *  src/main/sessionState.ts) in Phase 1's P1.2 — declared now so that step
   *  has a field to populate. */
  knownGoodVersions: Set<string>
  /** TODO(Phase 4/5): where/how to read live structured status for this
   *  harness (e.g. a file-watch registry like Claude's
   *  ~/.claude/sessions/<pid>.json). Only meaningful when
   *  capabilities.structuredStatus is true. Left optional and undeclared in
   *  shape (not just unpopulated) because Phase 1 doesn't yet know what a
   *  second harness's status source will look like structurally — pinning a
   *  shape now risks guessing wrong. Revisit when Phase 4 defines it. */
  statusSource?: unknown
  /** TODO(Phase 4/5): where/how to read this harness's on-disk transcript
   *  (e.g. Claude's ~/.claude/projects/<cwd>/*.jsonl). Only meaningful when
   *  capabilities.transcript is true. Same rationale as statusSource: left
   *  as an optional `unknown` placeholder until Phase 5 defines the real
   *  shape from a second, structurally different harness. */
  transcriptSource?: unknown
}
