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

// Tokenizes a composed `flags` string into `{ name, raw }` pairs, one per
// `--flag [value]` occurrence. `raw` is the exact matched substring (leading
// whitespace trimmed) so tokens can be spliced back into a flags string
// losslessly — e.g. "--model claude-opus-4-8" or "--debug" (no value).
function parseFlagTokens(flags: string): Array<{ name: string; raw: string }> {
  const tokens: Array<{ name: string; raw: string }> = []
  const re = /(?:^|\s)--([a-zA-Z-]+)(?:\s+(\S+))?/g
  let match: RegExpExecArray | null
  while ((match = re.exec(flags)) !== null) {
    tokens.push({ name: match[1], raw: match[0].trim() })
  }
  return tokens
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
// fresh"): start from `fresh.flags` (guarantees compose's own deterministic
// token ordering), then for every flag NAME other than `flagName` whose token
// differs between the OLD snapshot and FRESH (including one having it and the
// other not), rewrite the working string so that name's token matches OLD's
// value again — i.e. undo everything fresh changed EXCEPT the one flag we
// intentionally want reflected. The `flagName` token itself is always left as
// fresh's value. This guarantees `launchEquals(patchedSnapshot, fresh)` is
// true iff `flagName` was the ONLY thing that changed since mount: if nothing
// else changed, every non-`flagName` token is restored to OLD's (== fresh's,
// since nothing else diverged) value, so patched === fresh. If something else
// DID change, that other token is deliberately reverted to OLD's stale value,
// so patched !== fresh and recomputeDirty() below still correctly flags it.
// Reconstructs `fresh.flags` with every flag NAME other than `flagName`
// restored to its OLD token text wherever old and fresh disagree (including
// one side having the flag and the other not). `flagName` itself is always
// left as fresh's value. See `setWorkspaceSettingAndSuppressDirty` for why.
function reconcileFlagsExceptTarget(
  oldFlags: string,
  freshFlags: string,
  flagName: 'model' | 'effort'
): string {
  const oldByName = new Map(parseFlagTokens(oldFlags).map((t) => [t.name, t.raw]))
  const freshByName = new Map(parseFlagTokens(freshFlags).map((t) => [t.name, t.raw]))
  const allNames = new Set([...oldByName.keys(), ...freshByName.keys()])

  let patchedFlags = freshFlags
  for (const name of allNames) {
    if (name === flagName) continue // leave fresh's value — this is the wanted change
    const oldRaw = oldByName.get(name)
    const freshRaw = freshByName.get(name)
    if (oldRaw === freshRaw) continue // unchanged — nothing to restore

    if (freshRaw !== undefined && oldRaw !== undefined) {
      // Present in both, but differing value — replace fresh's token text
      // with old's token text.
      patchedFlags = patchedFlags.replace(freshRaw, oldRaw)
    } else if (freshRaw !== undefined && oldRaw === undefined) {
      // Fresh has it, old didn't — remove fresh's token.
      patchedFlags = patchedFlags.replace(freshRaw, '').trim()
    } else if (oldRaw !== undefined && freshRaw === undefined) {
      // Old had it, fresh doesn't — append old's token back (exact insertion
      // position doesn't matter: this branch only runs when some OTHER flag
      // already changed, which already makes patched !== fresh, satisfying
      // the invariant regardless of where we splice it back in).
      patchedFlags = `${patchedFlags} ${oldRaw}`.trim()
    }
  }
  // Normalize whitespace left behind by removals/replacements.
  return patchedFlags.replace(/\s+/g, ' ').trim()
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
  handle('workspace:getEffectiveModel', (_e, args) => {
    const ws = getWorkspace(args.workspaceId)
    const launch = composeClaudeLaunch(ws?.projectId, args.workspaceId)
    const m = launch.flags.match(/^--model\s+(\S+)/)
    return { model: m ? m[1] : '' }
  })

  // Footer Effort chip: persist an effort override and suppress the resulting
  // dirty delta (the chip also injects `/effort <value>` into the terminal live
  // right after this resolves, so the running process already matches — see
  // setWorkspaceSettingAndSuppressDirty above).
  handle('workspace:setEffort', (_e, args) => {
    return setWorkspaceSettingAndSuppressDirty(args.workspaceId, { effort: args.effort }, 'effort')
  })

  // Footer Effort chip: read the TRUE effective effort a workspace would launch
  // with right now, by reusing composeClaudeLaunch verbatim. Not anchored to
  // start-of-string (unlike model) because --effort is not always flagParts[0].
  handle('workspace:getEffectiveEffort', (_e, args) => {
    const ws = getWorkspace(args.workspaceId)
    const launch = composeClaudeLaunch(ws?.projectId, args.workspaceId)
    const m = launch.flags.match(/(?:^|\s)--effort\s+(\S+)/)
    return { effort: m ? m[1] : '' }
  })
}
