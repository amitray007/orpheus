// ---------------------------------------------------------------------------
// src/main/harness/registry.ts
//
// The declarative harness list. THIS is "add a harness" in this codebase:
// append one HarnessDescriptor object below. Model this file's discipline on
// src/main/routingProxy/providers/registry.ts (PROVIDERS/getProviderDescriptor/
// isKnownProviderId) — same shape, same data-only-removal guarantee, applied
// to harnesses instead of routing providers.
//
// Phase 1 (issue #187) makes the launch path descriptor-shaped with Claude as
// the SOLE descriptor and is a zero-behavior-change refactor: every byte
// reaching `claude` must stay identical to what composeClaudeLaunch already
// produced before this file existed. See src/shared/harness/types.ts for the
// full type contract (HarnessId/HarnessCapabilities/HarnessLaunch/
// HarnessDescriptor) and its central design rule: app code gates on
// CAPABILITY, never on harnessId.
//
// DATA-ONLY REMOVAL DISCIPLINE (mirrors the providers registry exactly):
// removing a descriptor from HARNESSES below must never delete a user's
// stored rows. A workspace's `harness_id` column (added in Phase 1.3) simply
// stops matching any known descriptor if its harness is later removed —
// resolveHarness() below is the load-bearing guard that makes a stale/unknown
// id INERT (falls back to Claude) rather than a crash. Do not "clean up" rows
// referencing a removed harness id as part of removing its descriptor; that
// is a separate, deliberate data migration if it's ever wanted at all.
// ---------------------------------------------------------------------------

import type { HarnessDescriptor, HarnessId } from '../../shared/harness/types'
import { isKnownHarnessId as isKnownHarnessIdPure } from '../../shared/harness/membership'
import { composeClaudeHarnessLaunch } from './claude/launch'
import { CLAUDE_CAPABILITIES, CLAUDE_CURATED, CLAUDE_DEFAULT_ARGS } from './claude/curated'
import { CLAUDE_DEFAULT_ACTIONS } from './claude/actions'
import { composeCodexHarnessLaunch } from './codex/launch'
import { CODEX_CAPABILITIES, CODEX_CURATED, CODEX_DEFAULT_ARGS } from './codex/curated'
import { CODEX_DEFAULT_ACTIONS } from './codex/actions'

// Known-good `claude --version` strings, used by sessionState.ts to warn
// (once per version, non-fatal) when a session file reports a version this
// build hasn't been validated against. MOVED here from sessionState.ts's
// former module-level `KNOWN_GOOD_VERSIONS` constant — see the Claude
// descriptor's `knownGoodVersions` field below for the sole remaining
// definition; sessionState.ts now reads it off this descriptor.
const CLAUDE_KNOWN_GOOD_VERSIONS = new Set(['2.1.190', '2.1.198', '2.1.207'])

// The Claude Code descriptor — today's only harness.
const CLAUDE_DESCRIPTOR: HarnessDescriptor = {
  id: 'claude',
  label: 'Claude Code',
  binary: 'claude',
  wrapperScript: 'orpheus-claude.sh',
  // Provider icon id for the harness picker — renderer resolves this via
  // ProviderIcon.tsx's KnownProviderIconId (src/renderer/src/components/
  // ProviderIcon.tsx), which renders the official Claude brand mark. Kept a
  // plain string here (not the renderer's union type) because src/shared
  // must not import renderer code — the name->component mapping stays in
  // the renderer, which falls back gracefully for an id it doesn't know.
  icon: 'claude',
  capabilities: CLAUDE_CAPABILITIES,
  // Real SectionId values from the renderer's settings UI (see
  // src/renderer/src/components/dashboard/SettingsView.tsx's `SectionId`
  // type and its `claude-*` tab registrations) — not invented. `src/main`
  // must not import from `src/renderer` (check:arch), so these are plain
  // string literals, kept in sync by hand. Only the Claude-labelled tabs are
  // listed; the `orpheus-*` tabs (appearance, sidebar, model-routing, etc.)
  // are app-level settings that apply regardless of harness and aren't
  // gated per-descriptor here.
  settingsSections: [
    'claude-general',
    'claude-display',
    'claude-permissions',
    'claude-auth',
    'claude-memory',
    'claude-tools',
    'claude-slash-commands',
    'claude-subagents',
    'claude-hooks',
    'claude-developer',
    'claude-about'
  ],
  // Field-for-field identical to ClaudeLaunch (see HarnessLaunch's doc
  // comment in src/shared/harness/types.ts) — a direct pass-through, no
  // reshaping, no cast needed.
  // U9 CUTOVER — the descriptor now composes from harness_settings (curated
  // + user arg/env rows) instead of claude_global_settings' 121 typed
  // columns. composeClaudeLaunch still exists and still works; it is simply
  // no longer what a mount runs. Reverting is this one line.
  //
  // Gated on scripts/verify-harness-launch-parity.ts, which drives BOTH
  // emitters over the same fixtures and asserts byte-equality across the
  // surface they share. Two deliberate divergences are pinned there rather
  // than hidden: typed passthroughs (which the new system expresses as user
  // env rows) and --permission-mode (now an opt-in default arg row). A third
  // — the old path emitting `--model sonnet` from a schema column default on
  // a fresh install — is resolved by this cutover in favour of NOT pinning:
  // an unconfigured workspace now lets claude choose its own default.
  composeLaunch: composeClaudeHarnessLaunch,
  // U3's curated concepts — model/effort. See src/main/harness/claude/curated.ts
  // for the values (reused from src/shared/types.ts's
  // CLAUDE_MODEL_OPTIONS/CLAUDE_EFFORT_VALUES, not duplicated) and the flag
  // verification against composeFlagTokens.
  curated: CLAUDE_CURATED,
  // Claude's shipped default arg (--permission-mode, disabled by default —
  // see CLAUDE_DEFAULT_ARGS's doc comment). Seeded into the Settings UI's
  // args editor as a visible, user-editable row rather than an invisible
  // launch-time prefix.
  defaultArgs: CLAUDE_DEFAULT_ARGS,
  // R8/U6's seed data — see src/main/harness/claude/actions.ts's header for
  // why this is not yet wired into any seeding call site.
  defaultActions: CLAUDE_DEFAULT_ACTIONS,
  knownGoodVersions: CLAUDE_KNOWN_GOOD_VERSIONS
}

// Known-good `codex --version` string, verified on this machine per B1's
// live-run provenance note in codex/curated.ts's header.
// Verified against the binary the LOGIN shell resolves — which is what
// orpheus-codex.sh (`#!/bin/zsh -l`) actually launches. An earlier value of
// '0.148.0' was wrong: that came from a different shim on PATH, and would
// have made every real launch report an untested version.
const CODEX_KNOWN_GOOD_VERSIONS = new Set(['0.147.0', '0.148.0'])

// The Codex CLI descriptor — Phase B's second harness (issue #187).
const CODEX_DESCRIPTOR: HarnessDescriptor = {
  // 'codex-cli', NOT bare 'codex'. This is load-bearing, not a style choice:
  // src/main/routingProxy/providers/registry.ts already defines a ROUTING
  // PROVIDER with id 'codex', and src/main/models/selectable.ts does
  // `providerId: harnessId` — harness ids and provider ids share ONE
  // namespace in the model picker. A bare 'codex' harness id would make the
  // two indistinguishable there. The '-cli' suffix convention is the locked
  // decision from issue #187 documented in src/shared/harness/types.ts's
  // HarnessId doc comment (lines ~36-49) for exactly this reason. Do not
  // "simplify" this to 'codex'.
  id: 'codex-cli',
  label: 'Codex',
  binary: 'codex',
  wrapperScript: 'orpheus-codex.sh',
  // 'codex' here is a SEPARATE field from `id` above — this is the provider
  // icon id the harness picker resolves via ProviderIcon.tsx's
  // KnownProviderIconId (renders the OpenAI mark), not the harness's own
  // identity. icon:'codex' + id:'codex-cli' renders correctly with zero
  // ProviderIcon changes needed.
  icon: 'codex',
  capabilities: CODEX_CAPABILITIES,
  // Codex owns none of Claude's 11 claude-* settings sections — an empty
  // list here is a correct visual no-op, not a bug. settingsSectionGating.ts
  // gates on the REGISTERED SET (`harnesses.some(...)`), not on the active
  // workspace's harness, because SettingsView is a single app-wide page with
  // no workspace scope (see that file's header). Claude's 11 sections keep
  // showing because CLAUDE still declares them; this stays per-registration,
  // not per-workspace.
  settingsSections: [],
  composeLaunch: composeCodexHarnessLaunch,
  curated: CODEX_CURATED,
  defaultArgs: CODEX_DEFAULT_ARGS,
  defaultActions: CODEX_DEFAULT_ACTIONS,
  knownGoodVersions: CODEX_KNOWN_GOOD_VERSIONS
}

export const HARNESSES: HarnessDescriptor[] = [CLAUDE_DESCRIPTOR, CODEX_DESCRIPTOR]

/** Returns the descriptor for `id`, or `undefined` if `id` names no known
 *  harness (removed or never-existed). Mirrors the providers registry's
 *  getProviderDescriptor in spirit but returns `undefined` rather than
 *  `null` — plain Array.prototype.find's natural result, since callers here
 *  (isKnownHarnessId, resolveHarness) only need truthy/falsy. */
export function getHarnessDescriptor(id: string): HarnessDescriptor | undefined {
  return HARNESSES.find((h) => h.id === id)
}

/** Structural membership check — never true for an id absent from HARNESSES.
 *  Mirrors isKnownProviderId's role on the routing-provider side: the one
 *  place "is this a thing we know how to launch" is decided.
 *
 *  Delegates to src/shared/harness/membership.ts's pure predicate, passing
 *  the REAL, live descriptor ids (HARNESSES.map(h => h.id)) rather than
 *  that module's own HARNESS_IDS constant — so a caller reaching this
 *  export (the electron-reaching one) always sees the actual registry,
 *  never a copy that could have drifted. Callers that cannot afford this
 *  module's electron-reaching import chain (e.g.
 *  src/main/controlPlane/workspaceCapabilities.ts) should import the pure
 *  version directly from shared/harness/membership.ts instead — see that
 *  file's header for why, and scripts/verify-doctor.ts for the assertion
 *  that keeps HARNESS_IDS from drifting away from this list. */
export function isKnownHarnessId(id: string): id is HarnessId {
  return isKnownHarnessIdPure(
    id,
    HARNESSES.map((h) => h.id)
  )
}

/**
 * Resolves a (possibly stale/unknown/absent) harness id to a descriptor.
 * NEVER THROWS — always returns a usable descriptor.
 *
 * This is load-bearing, not defensive filler: a workspace's `harness_id`
 * column can hold a value this build doesn't recognize (a descriptor
 * removed in a later change, or a row written by a newer build and read by
 * an older one after a rollback). Falling back to Claude means that
 * workspace still launches — with Claude — rather than the app crashing or
 * refusing to open it. An inert/unknown harness id must be exactly that:
 * inert, not fatal.
 */
export function resolveHarness(id: string | null | undefined): HarnessDescriptor {
  if (!id) return CLAUDE_DESCRIPTOR
  return getHarnessDescriptor(id) ?? CLAUDE_DESCRIPTOR
}
