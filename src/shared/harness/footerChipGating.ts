// ---------------------------------------------------------------------------
// src/shared/harness/footerChipGating.ts
//
// Pure decision functions for two footer/workspace-settings gating bugs
// found alongside B1's liveApply work (E1/E2/E3, support-multi-harness):
//
//   isModelEffectivelyClaude (E2) — DropdownChip.tsx's `currentModelIsClaude`
//   used `selectableModels.find(...)?.isClaude ?? modelValue === ''`. The
//   `?? modelValue === ''` tail meant an UNSET model (`modelValue === ''`,
//   the common default before a user ever picks one) resolved to "is
//   Claude" on every harness, not just during a transient fetch window —
//   including a harness that isn't Claude at all. An unset model has no
//   provider to ask, so this can only be answered from context: it's
//   Claude-equivalent (safe to build `/model`/`/effort` REPL text for) only
//   when the WORKSPACE's harness is itself Claude (composeClaudeLaunch's
//   empty-model default IS Claude picking its own default, e.g. bare
//   sonnet) — never as a blanket default for any harness.
//
//   shouldShowLocoToggle (E3) — WorkspaceSettingsPopover.tsx's Plugins
//   toggle appends `--dangerously-load-development-channels server:loco` to
//   customCliFlags unconditionally. That flag is Claude Code's own CLI
//   flag; on a harness that doesn't ship it, appending it writes an
//   unrecognized flag into that harness's launch args. Unlike every
//   decision in ./capabilityGating.ts, there is no HarnessCapabilities flag
//   for "owns this one hardcoded CLI flag" — it isn't a general capability
//   Orpheus reads back (see ./types.ts's CuratedField header on what earns
//   typed-capability status), it's a single Claude-specific dev-channel
//   switch. Gating on harness id here matches the existing precedent for
//   genuinely Claude-only UI (ClaudeAboutSection.tsx, ProviderIcon.tsx,
//   LimitsTab.tsx all gate `id === 'claude'` the same way) rather than
//   manufacturing a one-off capability flag for a single literal flag
//   string.
//
// Lives in src/shared (not inline in the two renderer components) for the
// same reason as every other file in this directory: importable, DOM/React
// -free, from a `bun run` verifier per CLAUDE.md's "assert behaviour, not
// source text" discipline.
// ---------------------------------------------------------------------------

import type { HarnessId } from './types'

/** Minimal shape this module needs from SelectableModel (src/shared/types.ts)
 *  — kept structural rather than importing the full interface so this stays
 *  a light, single-purpose dependency. */
export type SelectableModelIsClaudeLookup = { id: string; isClaude: boolean }

/**
 * Resolves whether `modelValue` should be treated as talking to Claude for
 * the purposes of gating a live-apply REPL injection (DropdownChip.tsx's
 * `/model`/`/effort` chips).
 *
 * - A model PRESENT in `selectableModels` answers from its own `isClaude`
 *   flag — unambiguous, no harness context needed.
 * - A model ABSENT from the list (transient fetch gap, or genuinely unset
 *   `''`) has no provider to ask. Previously this always resolved to
 *   `modelValue === ''`, i.e. "unset always means Claude" — wrong for a
 *   non-Claude harness, whose own empty-model default means "let THAT
 *   harness pick its own default," not Claude's. Falls back to whether the
 *   WORKSPACE's own harness is Claude instead: conservative in both
 *   directions — a Claude workspace mid-fetch still gets its live-apply
 *   chip (matching today's behavior for Claude, the regression net), and a
 *   non-Claude workspace never gets `/model`/`/effort` typed into it just
 *   because its model list hasn't loaded yet.
 */
export function isModelEffectivelyClaude(
  harnessId: HarnessId | null | undefined,
  selectableModels: readonly SelectableModelIsClaudeLookup[],
  modelValue: string
): boolean {
  const found = selectableModels.find((m) => m.id === modelValue)
  if (found) return found.isClaude
  return harnessId === 'claude'
}

/**
 * Whether the Plugins section's "Enable Loco Channel" toggle should be
 * shown at all — see this module's header for why this is a harness-id gate
 * rather than a capability one. `harnessId` absent/unresolved defaults to
 * shown (matches every existing call site's "assume Claude until told
 * otherwise" default for a workspace whose harness hasn't resolved yet, and
 * keeps a Claude-only install — the only registered harness today —
 * byte-identical to pre-fix behavior).
 */
export function shouldShowLocoToggle(harnessId: HarnessId | null | undefined): boolean {
  return !harnessId || harnessId === 'claude'
}
