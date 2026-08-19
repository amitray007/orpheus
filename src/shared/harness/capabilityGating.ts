// ---------------------------------------------------------------------------
// src/shared/harness/capabilityGating.ts
//
// Multi-harness migration, unit C4 — pure decision functions for gating
// renderer display logic on HarnessCapabilities, instead of assuming every
// workspace is Claude (the bug this unit fixes: harnessStore.ts's
// CLAUDE_FALLBACK_SUMMARY previously hardcoded all eight capabilities to
// `true`, so a harness whose capabilities were genuinely unknown — either
// because the harness:list fetch hadn't resolved yet, or because the id
// wasn't found in the loaded list — was reported as having Claude's FULL
// capability set).
//
// Lives in src/shared (not inline in the renderer components) so:
//   1. It is importable, DOM/React-free, from scripts/verify-harness-
//      capability-gating.ts per CLAUDE.md's "assert behaviour, not source
//      text" discipline — the decisions here are directly callable and
//      directly assertable, not buried in JSX a text-grep could fake out.
//   2. The renderer components (Sidebar.tsx, WorkspacesView.tsx,
//      WorkspacesTab.tsx, WorkspaceTitleBar.tsx) call these functions rather
//      than re-implementing the same capability check four times, which
//      would risk the four call sites drifting out of sync.
//
// THE CENTRAL RULE (see ./types.ts's header): every function here gates on
// a CAPABILITY flag, never on harnessId. Every function is also a complete
// no-op for Claude's real capabilities (all-true) — see this module's own
// verifier for the regression-net assertion that proves that.
// ---------------------------------------------------------------------------

import type { HarnessCapabilities } from './types'

// ---------------------------------------------------------------------------
// Transcript-gated display (Sidebar.tsx's WorkspaceSubRow)
// ---------------------------------------------------------------------------

/**
 * Whether a transcript-derived session title should be looked up/used for
 * display. A harness without `capabilities.transcript` never writes a
 * parseable on-disk transcript, so any "sessionTitle" value the caller might
 * have looked up for it is not really transcript-derived — it should be
 * treated as absent so resolveWorkspaceName's ladder falls through to the
 * next rung (terminal title / lastTitle / muted placeholder), exactly as if
 * no session title had ever been found.
 */
export function shouldUseTranscriptDerivedTitle(capabilities: HarnessCapabilities): boolean {
  return capabilities.transcript
}

/**
 * Whether a transcript-derived mtime (jsonl file mtime, used as a freshness
 * fallback when there's no live activity timestamp yet) should be used. Same
 * gate as shouldUseTranscriptDerivedTitle — both readouts require a real
 * on-disk transcript to have produced them.
 */
export function shouldUseTranscriptDerivedFreshness(capabilities: HarnessCapabilities): boolean {
  return capabilities.transcript
}

// ---------------------------------------------------------------------------
// Structured-status-gated display (Sidebar.tsx's live activity dot)
// ---------------------------------------------------------------------------

/**
 * Whether live activity status (the busy/attention/ready dot driven by
 * useWorkspaceActivity) may be claimed/rendered for a workspace. A harness
 * without `capabilities.structuredStatus` has no machine-readable status
 * source the app can trust — any value already sitting in the activity
 * store for that workspace (stale from a prior harness, or simply never
 * meaningfully populated) must not be displayed as if it were live.
 */
export function shouldClaimLiveActivity(capabilities: HarnessCapabilities): boolean {
  return capabilities.structuredStatus
}

// ---------------------------------------------------------------------------
// Transcript-absent status group (WorkspacesView.tsx's deriveGroup,
// WorkspacesTab.tsx's statusToGroup)
// ---------------------------------------------------------------------------

/**
 * Both deriveGroup (WorkspacesView.tsx) and statusToGroup (WorkspacesTab.tsx)
 * special-case "no claudeSessionId yet" as 'waiting' — correct for a
 * transcript-CAPABLE harness (the workspace just hasn't started a session
 * yet, and 'waiting' is an honest, temporary read). For a transcript-
 * INCAPABLE harness, `claudeSessionId` can never populate (there is no
 * transcript to derive one from), so the SAME 'waiting' value would be a
 * permanent, misleading claim rather than a transient one.
 *
 * This function only answers "is treating an absent session id as a real
 * signal safe" — true means the caller's existing 'no session id -> waiting'
 * branch is correct as-is; false means the caller must not draw that
 * conclusion (the id being absent tells you nothing, because it can NEVER be
 * present for this harness). Callers decide what to render for the false
 * case in the shape their own return type allows — see
 * shouldTreatMissingSessionAsWaiting for the honest alternative.
 */
export function canMissingSessionIdImplyWaiting(capabilities: HarnessCapabilities): boolean {
  return capabilities.transcript
}

// ---------------------------------------------------------------------------
// Usage-gated hover-card calls (WorkspaceTitleBar.tsx's Details popover)
// ---------------------------------------------------------------------------

/**
 * Whether the usage/cost hover-card calls (session.getUsage,
 * session.getCost) should fire at all for this workspace's harness. A
 * harness without `capabilities.usage` has no usage/cost data source — the
 * calls are gated OFF entirely rather than fired-and-shown-empty-or-erroring,
 * so the popover renders cost/context as not-applicable (no field at all)
 * instead of a spinner that can never resolve.
 */
export function shouldFetchUsageDetails(capabilities: HarnessCapabilities): boolean {
  return capabilities.usage
}
