// ---------------------------------------------------------------------------
// src/shared/harness/worktreePaths.ts
//
// Pure derivation of a harness's own worktree directory (H1 follow-up,
// support-multi-harness) — the user's decision: each harness gets its own
// worktree directory, `.<harness>/worktrees/`, so a Claude workspace's
// worktrees live under `.claude/worktrees/` and a future Codex workspace's
// would live under `.codex/worktrees/`, derived from the workspace's
// harnessId rather than hardcoded.
//
// Lives in src/shared (not src/main) so main/worktrees.ts,
// main/sessions.ts, and main/workspaceOrchestration/mainAdapter.ts all
// derive from the SAME function rather than three independent hardcodings
// drifting the way `.claude/worktrees/` already had — see this unit's
// report for the concrete bug this closes (createWorktreeResumingSession's
// path reconstruction silently assuming every harness's worktrees live
// under `.claude/`).
//
// Deliberately dependency-free (no `node:path`) — same discipline as
// cliFlags.ts's own header: a plain string join keeps this importable from
// any process (main today; nothing renderer-side needs it yet, but nothing
// should have to change if that does) and trivially testable without
// Node's path module's platform-specific quirks (this only ever produces a
// POSIX-style relative segment, joined onto a real absolute path by the
// caller via node:path — see worktrees.ts's own call sites).
// ---------------------------------------------------------------------------

/**
 * The directory segment (relative, POSIX-style, no leading/trailing slash)
 * a harness's worktrees live under, e.g. `.claude/worktrees` for 'claude'.
 * Every caller that builds a real worktree path joins this onto an absolute
 * repo root via node:path — this function only decides the segment, not
 * the OS-specific join.
 */
export function worktreeDirSegment(harnessId: string): string {
  return `.${harnessId}/worktrees`
}

/**
 * The exact .gitignore line for a harness's worktree directory, e.g.
 * `.claude/worktrees/` (WITH the trailing slash — a gitignore convention
 * meaning "match this as a directory", and the exact string
 * ensureWorktreesGitignored's existing dedup check already compares
 * against for Claude, so this must produce byte-identical output for
 * 'claude' to avoid re-adding a second, redundant line to every repo that
 * already has the un-derived literal).
 */
export function worktreeGitignoreEntry(harnessId: string): string {
  return `${worktreeDirSegment(harnessId)}/`
}

// ---------------------------------------------------------------------------
// Worktree base-ref preference resolution (H1 follow-up, support-multi-
// harness) — the PURE precedence logic behind worktrees.ts's
// readWorktreeBaseRef. Extracted here (rather than inlined in that
// function) so the resolution ORDER is independently testable without a
// database or a real ~/.claude/settings.json — see that function's own doc
// comment for the full rationale (app_ui_state was invented as a home
// because `worktree.baseRef` was never a real Claude Code setting).
// ---------------------------------------------------------------------------

/**
 * Resolves the worktree base-ref preference from its two possible sources,
 * in precedence order: `appUiStateValue` (the new, owned home) wins if set;
 * otherwise `legacyClaudeSettingsValue` (the OLD ~/.claude/settings.json
 * location, read by the caller — this function does no I/O) applies;
 * otherwise 'fresh'.
 *
 * Both inputs are ALREADY the resolved two-value type or null/undefined —
 * this function has no opinion about how a raw JSON blob or DB row becomes
 * one of those; that parsing/reading is the caller's job (worktrees.ts).
 */
export function resolveWorktreeBaseRef(
  appUiStateValue: 'fresh' | 'head' | null | undefined,
  legacyClaudeSettingsValue: 'fresh' | 'head' | null | undefined
): 'fresh' | 'head' {
  if (appUiStateValue === 'head' || appUiStateValue === 'fresh') return appUiStateValue
  if (legacyClaudeSettingsValue === 'head' || legacyClaudeSettingsValue === 'fresh') {
    return legacyClaudeSettingsValue
  }
  return 'fresh'
}
