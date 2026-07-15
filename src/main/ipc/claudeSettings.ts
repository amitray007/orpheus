// ---------------------------------------------------------------------------
// src/main/ipc/claudeSettings.ts
//
// Claude Settings IPC (global + per-project + per-workspace layers), moved
// verbatim out of index.ts (STR-1). Covers claudeSettings:*,
// claudeProjectSettings:*, claudeWorkspaceSettings:*, and the footer
// Model/Effort chips (workspace:setModel/getEffectiveModel/setEffort/
// getEffectiveEffort) — all of these read/write the same layered settings
// stack and share the dirty-recompute + suppress-dirty machinery below, so
// they move together as one domain.
//
// `recomputeDirty` is index.ts-local in spirit (it was previously defined
// there) but every dependency it touches is a leaf export
// (workspaceResources accessors + composeClaudeLaunch + getWorkspace +
// getClaudeGlobalSettings), so it — along with its private helpers
// (launchEquals, parseFlagTokens, reconcileFlagsExceptTarget,
// setWorkspaceSettingAndSuppressDirty) — is fully self-contained here. No
// deps bag needed for this domain.
// ---------------------------------------------------------------------------

import { getWorkspace } from '../workspaces'
import {
  getClaudeGlobalSettings,
  updateClaudeGlobalSettings,
  composeClaudeLaunch
} from '../claudeSettings'
import type { ClaudeLaunch } from '../claudeSettings'
import { getClaudeProjectSettings, updateClaudeProjectSettings } from '../claudeProjectSettings'
import {
  getClaudeWorkspaceSettings,
  updateClaudeWorkspaceSettings
} from '../claudeWorkspaceSettings'
import type { ClaudeWorkspaceSettings, ClaudeEffort } from '../../shared/types'
import {
  getLaunchSnapshot,
  setLaunchSnapshot,
  deleteLaunchSnapshot,
  launchSnapshotEntries,
  launchSnapshotCount,
  setDirty
} from '../workspaceResources'
import { handle } from './handle'
import {
  FLAG_DELIMITER,
  groupTokensByFlag,
  splitFlagString,
  findFlagValue
} from '../../shared/cliFlags'

function launchEquals(a: ClaudeLaunch, b: ClaudeLaunch): boolean {
  if (a.flags !== b.flags || a.settingsJson !== b.settingsJson) return false
  const ak = Object.keys(a.env).sort()
  const bk = Object.keys(b.env).sort()
  if (ak.length !== bk.length) return false
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false
    if (a.env[ak[i]] !== b.env[ak[i]]) return false
  }
  return true
}

// Recomputes the dirty flag for every workspace with a tracked launch
// snapshot, comparing it against a freshly composed launch. Called whenever
// any settings layer (global/project/workspace) mutates.
function recomputeDirty(): void {
  if (launchSnapshotCount() === 0) return
  // Fetch global settings once — shared across all workspaces in the loop.
  // Each composeClaudeLaunch would otherwise run a redundant DB read.
  const globalSettings = getClaudeGlobalSettings()
  for (const [workspaceId, snap] of launchSnapshotEntries()) {
    const ws = getWorkspace(workspaceId)
    if (!ws) {
      // Workspace was archived/removed while a snapshot was still tracked
      // (e.g. archived mid-mount) — evict the stale entry instead of
      // leaving it around forever.
      deleteLaunchSnapshot(workspaceId)
      setDirty(workspaceId, false)
      continue
    }
    const fresh = composeClaudeLaunch(ws.projectId, workspaceId, globalSettings)
    setDirty(workspaceId, !launchEquals(snap, fresh))
  }
}

// Splits a composed `flags` string (0x1F-delimited argv tokens — see
// src/shared/cliFlags.ts) back into per-flag-name groups, reusing the exact
// same split + grouping helpers cliFlags.ts exposes for this purpose so this
// file never re-derives "what counts as a new flag entry" on its own.
function parseFlagTokens(flags: string): ReturnType<typeof groupTokensByFlag> {
  return groupTokensByFlag(splitFlagString(flags))
}

// Canonical flag names (WITH leading dashes, matching flagName()/
// groupTokensByFlag's output) for the two footer-chip dimensions this module
// reconciles. --model/--effort are Orpheus's own typed flags emitted by
// composeClaudeLaunch, never user-authored custom flags, so this static map
// is safe (not a general flagName-alias mechanism).
const FOOTER_CHIP_FLAG_NAME: Record<'model' | 'effort', string> = {
  model: '--model',
  effort: '--effort'
}

// Persists a model/effort change made via a footer dropdown chip (Model or
// Effort) AND neutralizes the resulting dirty delta for JUST that ONE flag
// dimension of the launch snapshot — because `/model <value>` or
// `/effort <value>` is typed into the terminal live by the caller immediately
// after this resolves, the running claude process already reflects the new
// value, so the stored snapshot must be updated to match reality without
// touching any OTHER pending genuine dirty delta (e.g. if the user separately
// changed permission-mode and hasn't restarted yet, that delta must still
// show "Restart to apply" afterwards).
//
// Algorithm (position-independent, multi-flag-safe — "reconstruct from
// fresh"): start from `fresh.flags`' token groups (guarantees compose's own
// deterministic token ordering), then for every flag NAME other than
// `flagName` whose tokens differ between the OLD snapshot and FRESH
// (including one having it and the other not), rewrite the working group
// list so that name's tokens match OLD's again — i.e. undo everything fresh
// changed EXCEPT the one flag we intentionally want reflected. The
// `flagName` group itself is always left as fresh's tokens. This guarantees
// `launchEquals(patchedSnapshot, fresh)` is true iff `flagName` was the ONLY
// thing that changed since mount: if nothing else changed, every
// non-`flagName` group is restored to OLD's (== fresh's, since nothing else
// diverged) value, so patched === fresh. If something else DID change, that
// other group is deliberately reverted to OLD's stale value, so patched !==
// fresh and recomputeDirty() below still correctly flags it.
// See `setWorkspaceSettingAndSuppressDirty` for why this exists.
function reconcileFlagsExceptTarget(
  oldFlags: string,
  freshFlags: string,
  flagName: 'model' | 'effort'
): string {
  const targetName = FOOTER_CHIP_FLAG_NAME[flagName]
  const oldGroups = parseFlagTokens(oldFlags)
  const freshGroups = parseFlagTokens(freshFlags)
  const oldByName = new Map(oldGroups.map((g) => [g.name, g.tokens]))
  const freshByName = new Map(freshGroups.map((g) => [g.name, g.tokens]))
  const allNames = new Set([...oldByName.keys(), ...freshByName.keys()])

  // Start from fresh's own group order/tokens, then override per-name below.
  const patchedByName = new Map(freshByName)
  for (const name of allNames) {
    if (name === targetName) continue // leave fresh's value — this is the wanted change
    const oldTokens = oldByName.get(name)
    const freshTokens = freshByName.get(name)
    const unchanged =
      oldTokens !== undefined &&
      freshTokens !== undefined &&
      oldTokens.length === freshTokens.length &&
      oldTokens.every((t, i) => t === freshTokens[i])
    if (unchanged) continue

    if (oldTokens !== undefined) {
      // Old had it (whether or not fresh does) — restore old's tokens.
      patchedByName.set(name, oldTokens)
    } else {
      // Old didn't have it but fresh does — remove fresh's tokens.
      patchedByName.delete(name)
    }
  }

  // Rebuild in fresh's group order (stable, deterministic — compose's own
  // ordering), appending any old-only groups (present in old, absent from
  // fresh, not the target) at the end; exact position doesn't matter there
  // since that branch only fires when some OTHER flag already diverged,
  // which already makes patched !== fresh regardless of splice position.
  const orderedNames = [...freshGroups.map((g) => g.name)]
  for (const name of patchedByName.keys()) {
    if (!orderedNames.includes(name)) orderedNames.push(name)
  }

  const patchedTokens: string[] = []
  for (const name of orderedNames) {
    const tokens = patchedByName.get(name)
    if (tokens) patchedTokens.push(...tokens)
  }
  return patchedTokens.join(FLAG_DELIMITER)
}

function setWorkspaceSettingAndSuppressDirty(
  workspaceId: string,
  patch: Partial<{ model: string; effort: ClaudeEffort }>,
  flagName: 'model' | 'effort'
): ClaudeWorkspaceSettings {
  const result = updateClaudeWorkspaceSettings(workspaceId, patch)

  const snap = getLaunchSnapshot(workspaceId)
  if (snap) {
    const ws = getWorkspace(workspaceId)
    if (ws) {
      // Recompose fresh — this reflects the NEW value (already persisted
      // above) plus whatever ELSE currently differs from the snapshot.
      const fresh = composeClaudeLaunch(ws.projectId, workspaceId)
      const patchedFlags = reconcileFlagsExceptTarget(snap.flags, fresh.flags, flagName)

      // Only `flags` changes; settingsJson/env stay from the OLD snapshot.
      setLaunchSnapshot(workspaceId, { ...snap, flags: patchedFlags })
    }
  }

  // Recompute dirty for ALL workspaces (cheap, existing behavior) — now that
  // the target flag's dimension of this workspace's snapshot matches fresh,
  // only a GENUINE pre-existing divergence (unrelated to flagName) would
  // still flag dirty.
  recomputeDirty()

  return result
}

export function registerClaudeSettingsIpc(): void {
  // ---------------------------------------------------------------------------
  // Claude Settings IPC (global)
  // ---------------------------------------------------------------------------

  handle('claudeSettings:get', () => getClaudeGlobalSettings())

  handle('claudeSettings:update', (_e, patch) => {
    const result = updateClaudeGlobalSettings(patch)
    recomputeDirty()
    return result
  })

  // ---------------------------------------------------------------------------
  // Per-project Claude Settings IPC
  // ---------------------------------------------------------------------------

  handle('claudeProjectSettings:get', (_e, { projectId }) => getClaudeProjectSettings(projectId))

  handle('claudeProjectSettings:update', (_e, args) => {
    const result = updateClaudeProjectSettings(args.projectId, args.patch)
    recomputeDirty()
    return result
  })

  // ---------------------------------------------------------------------------
  // Per-workspace Claude Settings IPC
  // ---------------------------------------------------------------------------

  handle('claudeWorkspaceSettings:get', (_e, { workspaceId }) =>
    getClaudeWorkspaceSettings(workspaceId)
  )

  handle('claudeWorkspaceSettings:update', (_e, args) => {
    const result = updateClaudeWorkspaceSettings(args.workspaceId, args.patch)
    recomputeDirty()
    return result
  })

  // Footer Model chip: persist a model override and suppress the resulting
  // dirty delta (the chip also injects `/model <value>` into the terminal live
  // right after this resolves, so the running process already matches — see
  // setWorkspaceSettingAndSuppressDirty above).
  handle('workspace:setModel', (_e, args) => {
    return setWorkspaceSettingAndSuppressDirty(args.workspaceId, { model: args.model }, 'model')
  })

  // Footer Model chip: read the TRUE effective model a workspace would launch
  // with right now (workspace override → project override → global setting),
  // by reusing composeClaudeLaunch verbatim — the single source of truth for
  // launch composition — instead of duplicating its resolution precedence.
  // findFlagValue is position-independent (no start-anchor needed, unlike
  // the old regex) — it finds --model by name wherever it lands in the
  // composed token stream.
  handle('workspace:getEffectiveModel', (_e, args) => {
    const ws = getWorkspace(args.workspaceId)
    const launch = composeClaudeLaunch(ws?.projectId, args.workspaceId)
    return { model: findFlagValue(launch.flags, '--model') ?? '' }
  })

  // Footer Effort chip: persist an effort override and suppress the resulting
  // dirty delta (the chip also injects `/effort <value>` into the terminal live
  // right after this resolves, so the running process already matches — see
  // setWorkspaceSettingAndSuppressDirty above).
  handle('workspace:setEffort', (_e, args) => {
    return setWorkspaceSettingAndSuppressDirty(args.workspaceId, { effort: args.effort }, 'effort')
  })

  // Footer Effort chip: read the TRUE effective effort a workspace would launch
  // with right now, by reusing composeClaudeLaunch verbatim. findFlagValue is
  // position-independent by construction (finds --effort by name wherever it
  // lands in the composed token stream), so no start-anchor caveat applies.
  handle('workspace:getEffectiveEffort', (_e, args) => {
    const ws = getWorkspace(args.workspaceId)
    const launch = composeClaudeLaunch(ws?.projectId, args.workspaceId)
    return { effort: findFlagValue(launch.flags, '--effort') ?? '' }
  })
}
