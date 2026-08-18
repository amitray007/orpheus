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
import { composeClaudeLaunch } from '../claudeSettings'
import { CLAUDE_CURATED } from './claude/curated'

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
  capabilities: {
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
  },
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
  composeLaunch: composeClaudeLaunch,
  // U3's curated concepts — model/effort/permission-mode. See
  // src/main/harness/claude/curated.ts for the values (reused from
  // src/shared/types.ts's CLAUDE_MODEL_OPTIONS/CLAUDE_EFFORT_VALUES, not
  // duplicated) and the flag verification against composeFlagTokens.
  curated: CLAUDE_CURATED,
  knownGoodVersions: CLAUDE_KNOWN_GOOD_VERSIONS
}

export const HARNESSES: HarnessDescriptor[] = [CLAUDE_DESCRIPTOR]

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
 *  place "is this a thing we know how to launch" is decided. */
export function isKnownHarnessId(id: string): id is HarnessId {
  return HARNESSES.some((h) => h.id === id)
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
