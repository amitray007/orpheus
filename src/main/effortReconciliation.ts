// ---------------------------------------------------------------------------
// src/main/effortReconciliation.ts — cross-model effort reconciliation
// (model-routing unit 11, work item 4).
//
// Effort is emitted as `--effort <value>` by composeFlagTokens, which becomes
// output_config.effort on the wire for a routed model — so a stale value
// silently rides along when the user switches models (e.g. `xhigh` on Opus
// stays stored after switching to a [low,medium,high] model, and the PROXY
// silently clamps it, with nothing telling the user). This is the ONE place
// that logic lives — a leaf module (imports only composeClaudeLaunch/
// resolveEffortLevelsForModelId/listCliProxyModelCacheEntries/clampEffortTo
// SupportedLevel, no `electron`) so it can be called from EVERY path that
// can persist a model change:
//   - src/main/ipc/claudeSettings.ts's four handlers (workspace:setModel —
//     the footer chip AND the creation menu, which both write through it;
//     claudeWorkspaceSettings:update — WorkspaceDrawer;
//     claudeProjectSettings:update — SettingsDrawer; claudeSettings:update —
//     global ClaudeGeneralSection)
//   - src/main/commandServer.ts's `ws new` handler (the CLI/command-server
//     path, which persists workspace overrides DIRECTLY via
//     updateClaudeWorkspaceSettings, bypassing the IPC layer entirely — it
//     must call this same reconciliation, not a re-derived copy)
// Previously this lived inline in ipc/claudeSettings.ts, which meant
// commandServer.ts had no way to reuse it without importing an IPC-layer
// module (or, worse, re-deriving its own copy) — moved here specifically so
// every persistence path shares ONE implementation.
// ---------------------------------------------------------------------------

import { composeClaudeLaunch } from './claudeSettings'
import { resolveEffortLevelsForModelId } from './models/selectable'
import { listCliProxyModelCacheEntries } from './models/sources/cliproxy'
import { clampEffortToSupportedLevel } from '../shared/types'
import type { ClaudeEffort } from '../shared/types'
import { findFlagValue } from '../shared/cliFlags'

/**
 * Reads the effective effort a scope would currently launch with — the SAME
 * composeClaudeLaunch primitive workspace:getEffectiveEffort reads from, so
 * "what's the effort right now" is computed identically everywhere.
 */
export function readEffectiveEffort(
  projectId: string | undefined,
  workspaceId: string | undefined
): string {
  const launch = composeClaudeLaunch(projectId, workspaceId)
  return findFlagValue(launch.flags, '--effort') ?? ''
}

/**
 * Resolves the NEW effort value for a model change, or undefined when no
 * reconciliation is needed (current effort is already supported / 'auto' /
 * unresolvable model).
 */
function reconcileEffortForModelChange(
  newModelId: string,
  currentEffort: string
): ClaudeEffort | undefined {
  const newLevels = resolveEffortLevelsForModelId(newModelId, listCliProxyModelCacheEntries())
  const resolved = clampEffortToSupportedLevel(currentEffort || 'auto', newLevels)
  if (resolved === (currentEffort || 'auto')) return undefined
  return resolved as ClaudeEffort
}

/**
 * Shared "reconcile effort into this patch" step — the ONE call every
 * model-persisting path makes. Only fires when the patch sets `model` to a
 * NEW value AND doesn't already explicitly set `effort` itself (an explicit
 * user-provided effort in the same patch is never overridden by an
 * automatic reconciliation — this is what lets `ws new --model X --effort Y`
 * keep the user's explicit Y even if it looks unusual for X). Mutates
 * nothing — returns a patch with `effort` added when reconciliation is
 * needed, or the original patch object unchanged (same reference) otherwise,
 * so a no-reconciliation call is a no-op allocation-wise too.
 */
export function withReconciledEffort<T extends { model?: string; effort?: ClaudeEffort }>(
  patch: T,
  projectId: string | undefined,
  workspaceId: string | undefined
): T {
  if (patch.model === undefined || patch.effort !== undefined) return patch
  const currentEffort = readEffectiveEffort(projectId, workspaceId)
  const reconciledEffort = reconcileEffortForModelChange(patch.model, currentEffort)
  if (reconciledEffort === undefined) return patch
  return { ...patch, effort: reconciledEffort }
}
