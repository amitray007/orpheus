/**
 * terminalLiveness.ts — harness-agnostic "has this workspace's terminal
 * produced any output yet" tracker, plus the pure overlay-readiness OR
 * this fix hinges on.
 *
 * WHY THIS EXISTS. Codex's own session-readiness signal —
 * hasObservedCodexStatus (harness/codex/statusState.ts) — can only ever
 * become true once statusState.ts's reconcile loop has evaluated a
 * workspace's Codex session at least once, which in turn requires the
 * workspace's `claude_session_id` to already be bound (loadCodexWorkspaceRows
 * filters `claude_session_id IS NOT NULL`). Binding itself is discovered
 * ASYNCHRONOUSLY, from whatever Codex writes to its own rollout file, on a
 * BOUNDED retry schedule (scheduleCodexSessionDiscovery, ./session.ts —
 * delays of 1.5s/4s/10s after launch). If the user's first prompt lands
 * later than that window — or Codex is simply slow to flush its
 * session_meta line — the workspace never binds during this schedule, which
 * means hasObservedCodexStatus can NEVER fire for it, not "fires late": the
 * observedWorkspaces set in statusState.ts is unreachable for a workspace
 * whose row still has `claude_session_id = NULL`. Gating the loading
 * overlay's readiness check on hasObservedCodexStatus ALONE therefore
 * deadlocks that workspace behind the loading-overlay's 10s fallback timer
 * on every mount, even though the terminal itself is alive and already
 * printing Codex's own UI.
 *
 * THE SIGNAL. The native terminal surface's title callback
 * (addon.setTitleCallback, wired in index.ts's ensureTerminalCallbackWiring)
 * fires the instant libghostty has real title text to report — direct proof
 * the pane is alive and producing output, independent of anything Codex has
 * written to disk. Verified against real boot logs: for a Codex workspace,
 * "[title] native fired" logs twice well inside the first couple of
 * seconds, long before the loading overlay's 10s fallback would ever trip.
 * This module tracks only THAT fact — "has the title callback fired at
 * least once for this workspaceId" — nothing about what the title actually
 * says, and nothing about dedupe/change-detection (index.ts's own dedupe
 * skip logic, just below where markTerminalTitleObserved is called, is a
 * SEPARATE concern: whether to touch the DB/broadcast a title change. A
 * title callback firing with the SAME text as last time still proves the
 * terminal is alive, so this tracker must be updated on every invocation,
 * not just on an actual title change).
 *
 * POPULATED FOR EVERY WORKSPACE, CONSULTED ONLY FOR CODEX. index.ts's title
 * callback handler calls markTerminalTitleObserved for every claude-
 * workspace-keyed surface — Claude and Codex alike — because the callback
 * has no harness context of its own and threading one through would only
 * serve this one call site. That's harmless: Claude already has a strictly
 * stronger, purpose-built readiness signal (isWorkspaceSessionReady, backed
 * by ~/.claude/sessions/<pid>.json) and never calls
 * hasObservedTerminalTitle/resolveCodexOverlayReadiness at all — see
 * index.ts's isWorkspaceSessionReadyForHarness, whose Claude branch is
 * untouched by this fix. Populating the set for Claude workspaces too is
 * simply unused work for them, never a behavior change.
 *
 * ELECTRON/DB-FREE BY DESIGN — a module-level Set plus pure functions over
 * it, mirroring statusState.ts's own leaf-module split (see that file's
 * comment on why isLockHeld/readLockHeldSessionIds-style logic lives in
 * statusMap.ts instead of statusState.ts itself): this file must be
 * importable directly by scripts/verify-loading-overlay.ts under plain
 * `bun run`, so nothing here may import `electron` or `./db`, even
 * transitively.
 */

const observedTitleWorkspaces = new Set<string>()

/** Records that the native terminal title callback has fired at least once
 *  for this workspaceId. Idempotent — safe to call on every callback
 *  invocation, not just the first. */
export function markTerminalTitleObserved(workspaceId: string): void {
  observedTitleWorkspaces.add(workspaceId)
}

/** Returns true once markTerminalTitleObserved has been called at least
 *  once for this workspaceId. */
export function hasObservedTerminalTitle(workspaceId: string): boolean {
  return observedTitleWorkspaces.has(workspaceId)
}

/** Removes a workspace's entry so this set doesn't grow unbounded over the
 *  app's lifetime. Call from the same per-workspace teardown path that
 *  clears the other transient per-workspace maps/sets (index.ts's
 *  teardownWorkspaceResources) once a workspace is archived, destroyed, or
 *  removed. Idempotent — deleting an absent key is a no-op. */
export function pruneTerminalLivenessEntry(workspaceId: string): void {
  observedTitleWorkspaces.delete(workspaceId)
}

/**
 * Decides Codex overlay readiness from its TWO independent signals, ORed
 * together: hasObservedStatus (statusState.ts's hasObservedCodexStatus —
 * Codex's session-binding-based signal, unchanged, still the preferred
 * signal when it's available) and hasObservedTitle (this module's
 * hasObservedTerminalTitle — the harness-independent terminal-liveness
 * proof-of-life this fix adds). Either signal alone is sufficient: a
 * workspace whose session bound and was reconciled at least once is ready
 * even before any title fires (the pre-existing behavior, preserved
 * exactly); a workspace whose session hasn't bound yet — the case this fix
 * targets — is still ready the instant its terminal proves it's alive and
 * drawing output, rather than waiting on a session-binding signal that may
 * never arrive at all.
 *
 * Pure and trivially total: no fs/DB/timer access, so this is the exact
 * function scripts/verify-loading-overlay.ts calls to prove the OR is wired
 * correctly, not a reimplementation of it.
 */
export function resolveCodexOverlayReadiness(
  hasObservedStatus: boolean,
  hasObservedTitle: boolean
): boolean {
  return hasObservedStatus || hasObservedTitle
}
