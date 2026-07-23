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

import type { BrowserWindow } from 'electron'
import { getWorkspace } from '../workspaces'
import {
  getClaudeGlobalSettings,
  updateClaudeGlobalSettings,
  composeClaudeLaunch
} from '../claudeSettings'
import { getClaudeAuthEnv } from '../claudeAuth'
import { isLiveApplicableModelChange } from '../modelRouting'
import { getClaudeProjectSettings, updateClaudeProjectSettings } from '../claudeProjectSettings'
import {
  getClaudeWorkspaceSettings,
  updateClaudeWorkspaceSettings
} from '../claudeWorkspaceSettings'
import type { ClaudeWorkspaceSettings, ClaudeEffort } from '../../shared/types'
import { withReconciledEffort } from '../effortReconciliation'
import {
  getLaunchSnapshot,
  setLaunchSnapshot,
  deleteLaunchSnapshot,
  launchSnapshotEntries,
  launchSnapshotCount,
  setDirty
} from '../workspaceResources'
import type { LaunchSnapshot } from '../workspaceResources'
import { handle } from './handle'
import { PUSH_CHANNELS } from '../../shared/ipc'
import {
  FLAG_DELIMITER,
  groupTokensByFlag,
  splitFlagString,
  findFlagValue
} from '../../shared/cliFlags'

// Compares two env-like records by key/value (order-independent). Shared by
// launchEquals for both the settings `env` layer and the `authEnv` layer.
function envEquals(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a).sort()
  const bk = Object.keys(b).sort()
  if (ak.length !== bk.length) return false
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false
    if (a[ak[i]] !== b[ak[i]]) return false
  }
  return true
}

function launchEquals(a: LaunchSnapshot, b: LaunchSnapshot): boolean {
  if (a.flags !== b.flags || a.settingsJson !== b.settingsJson) return false
  if (!envEquals(a.env, b.env)) return false
  // Auth env (cloud_provider, api key/token, base URL, etc.) is merged in
  // downstream of composeClaudeLaunch (see buildMountEnv), so it must be
  // compared separately — this is the fix for auth changes not marking the
  // workspace dirty. NEVER log these values.
  if (!envEquals(a.authEnv, b.authEnv)) return false
  return true
}

// Recomputes the dirty flag for every workspace with a tracked launch
// snapshot, comparing it against a freshly composed launch. Called whenever
// any settings layer (global/project/workspace) OR auth layer mutates.
// Exported so registerClaudeAuthIpc (a separate IPC domain — auth changes
// alter the env layer merged downstream of composeClaudeLaunch, see
// LaunchSnapshot) can trigger the same drift recheck.
export function recomputeDirty(): void {
  if (launchSnapshotCount() === 0) return
  // Fetch global settings once — shared across all workspaces in the loop.
  // Each composeClaudeLaunch would otherwise run a redundant DB read.
  const globalSettings = getClaudeGlobalSettings()
  // getClaudeAuthEnv is cached (invalidated on updateClaudeAuth) and identical
  // for every workspace (auth is global, not per-workspace), so read once.
  const authEnv = getClaudeAuthEnv()
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
    setDirty(workspaceId, !launchEquals(snap, { ...fresh, authEnv }))
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

/**
 * Broadcasts workspace:effectiveSettingsChanged for every currently-mounted
 * workspace (bugfix, model-routing unit 11) — pushed after EVERY model/
 * effort-persisting handler below, since a global or project-scope change
 * can affect many workspaces at once (not just the one the caller named),
 * exactly mirroring recomputeDirty()'s own "iterate every tracked launch
 * snapshot" scope. A workspace-scoped change (workspace:setModel) only
 * actually affects itself, but broadcasting for every mounted workspace here
 * too is harmless (the renderer store just re-applies the same value) and
 * keeps this ONE code path for all four call sites rather than a narrower
 * single-workspace variant plus a broader multi-workspace one.
 *
 * getMainWindow may be null (no window yet, e.g. very early boot) — the
 * push is simply skipped then, same as every other push-channel call site
 * in this codebase (see uiState:update's identical guard).
 */
function broadcastEffectiveSettingsForMountedWorkspaces(
  getMainWindow: () => BrowserWindow | null
): void {
  if (launchSnapshotCount() === 0) return
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  const globalSettings = getClaudeGlobalSettings()
  for (const [workspaceId] of launchSnapshotEntries()) {
    const ws = getWorkspace(workspaceId)
    if (!ws) continue // evicted by recomputeDirty's own pass; nothing to push
    const fresh = composeClaudeLaunch(ws.projectId, workspaceId, globalSettings)
    win.webContents.send(PUSH_CHANNELS.workspaceEffectiveSettingsChanged, {
      workspaceId,
      model: fresh.model,
      effort: findFlagValue(fresh.flags, '--effort') ?? ''
    })
  }
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
  flagName: 'model' | 'effort',
  getMainWindow: () => BrowserWindow | null
): ClaudeWorkspaceSettings {
  const result = updateClaudeWorkspaceSettings(workspaceId, patch)

  const snap = getLaunchSnapshot(workspaceId)
  if (snap) {
    const ws = getWorkspace(workspaceId)
    if (ws) {
      // Recompose fresh — this reflects the NEW value (already persisted
      // above) plus whatever ELSE currently differs from the snapshot.
      const fresh = composeClaudeLaunch(ws.projectId, workspaceId)

      // Model changes are only suppressible when the switch stays on the
      // same backend (Claude -> Claude). A Claude<->routed (or
      // routed<->different-routed) switch needs a new process with
      // different env, so it must fall through to a genuine dirty flag
      // ("Restart to apply") rather than being silently marked clean.
      const suppressible =
        flagName !== 'model' ||
        isLiveApplicableModelChange(findFlagValue(snap.flags, '--model') ?? '', fresh.model)

      if (suppressible) {
        const patchedFlags = reconcileFlagsExceptTarget(snap.flags, fresh.flags, flagName)
        // Only `flags` changes; settingsJson/env stay from the OLD snapshot.
        setLaunchSnapshot(workspaceId, { ...snap, flags: patchedFlags })
      }
      // else: leave the snapshot untouched — recomputeDirty() below will
      // then see the new model in `fresh` diverge from the stale snapshot
      // and correctly mark the workspace dirty.
    }
  }

  // Recompute dirty for ALL workspaces (cheap, existing behavior) — now that
  // the target flag's dimension of this workspace's snapshot matches fresh
  // (when suppressible), only a GENUINE pre-existing divergence (unrelated
  // to flagName) would still flag dirty. When NOT suppressible, the model
  // divergence itself is what (correctly) flags dirty here.
  recomputeDirty()
  // Bugfix (model-routing unit 11): push the fresh effective {model,effort}
  // for every mounted workspace so the footer's model AND effort chips (two
  // separate DropdownChip instances) react live, without waiting for a
  // remount — see broadcastEffectiveSettingsForMountedWorkspaces' own doc
  // comment.
  broadcastEffectiveSettingsForMountedWorkspaces(getMainWindow)

  return result
}

export interface ClaudeSettingsIpcDeps {
  getMainWindow: () => BrowserWindow | null
}

export function registerClaudeSettingsIpc(deps: ClaudeSettingsIpcDeps): void {
  // ---------------------------------------------------------------------------
  // Claude Settings IPC (global)
  // ---------------------------------------------------------------------------

  handle('claudeSettings:get', () => getClaudeGlobalSettings())

  // Reconciles effort against a model change (model-routing unit 11, work
  // item 4) — see withReconciledEffort's own doc comment. Global scope has
  // no workspaceId/projectId; composeClaudeLaunch(undefined, undefined)
  // reads the global row directly, which is exactly "effective effort at
  // global scope" (nothing above it to inherit from). A global-scope change
  // can affect every mounted workspace with no override of its own, so the
  // broadcast below iterates all of them (see its own doc comment) rather
  // than a single workspaceId.
  handle('claudeSettings:update', (_e, patch) => {
    const reconciledPatch = withReconciledEffort(patch, undefined, undefined)
    const result = updateClaudeGlobalSettings(reconciledPatch)
    recomputeDirty()
    broadcastEffectiveSettingsForMountedWorkspaces(deps.getMainWindow)
    return result
  })

  // ---------------------------------------------------------------------------
  // Per-project Claude Settings IPC
  // ---------------------------------------------------------------------------

  handle('claudeProjectSettings:get', (_e, { projectId }) => getClaudeProjectSettings(projectId))

  // Reconciles effort against a model change at project scope — see
  // withReconciledEffort's own doc comment. workspaceId is intentionally
  // undefined here: this reconciles against the EFFECTIVE effort a project
  // (with no workspace override) would launch with, matching what the
  // project-level model change itself applies to.
  handle('claudeProjectSettings:update', (_e, args) => {
    const reconciledPatch = withReconciledEffort(args.patch, args.projectId, undefined)
    const result = updateClaudeProjectSettings(args.projectId, reconciledPatch)
    recomputeDirty()
    broadcastEffectiveSettingsForMountedWorkspaces(deps.getMainWindow)
    return result
  })

  // ---------------------------------------------------------------------------
  // Per-workspace Claude Settings IPC
  // ---------------------------------------------------------------------------

  handle('claudeWorkspaceSettings:get', (_e, { workspaceId }) =>
    getClaudeWorkspaceSettings(workspaceId)
  )

  // Reconciles effort against a model change at workspace scope (e.g. a
  // model switch made via WorkspaceDrawer rather than the footer chip) — see
  // withReconciledEffort's own doc comment.
  handle('claudeWorkspaceSettings:update', (_e, args) => {
    const ws = getWorkspace(args.workspaceId)
    const reconciledPatch = withReconciledEffort(args.patch, ws?.projectId, args.workspaceId)
    const result = updateClaudeWorkspaceSettings(args.workspaceId, reconciledPatch)
    recomputeDirty()
    broadcastEffectiveSettingsForMountedWorkspaces(deps.getMainWindow)
    return result
  })

  // Footer Model chip (and the creation-menu's creation-time model write,
  // which uses this SAME channel — see NewWorkspaceMenu.tsx): persist a
  // model override and suppress the resulting dirty delta (the chip also
  // injects `/model <value>` into the terminal live right after this
  // resolves, so the running process already matches — see
  // setWorkspaceSettingAndSuppressDirty above). Also reconciles the
  // workspace's stored effort against the NEW model's real levels (model-
  // routing unit 11, work item 4) — folded into the SAME patch/DB write as
  // the model change so setWorkspaceSettingAndSuppressDirty's existing
  // dirty-recompute machinery surfaces a genuine effort divergence via the
  // existing "Restart to apply" chip, with no new UI needed: only `model`
  // (the flagName argument) is treated as the intentionally-suppressed
  // dimension, so if effort also changed here, reconcileFlagsExceptTarget
  // restores the OLD effort to the snapshot and recomputeDirty correctly
  // flags the divergence.
  handle('workspace:setModel', (_e, args) => {
    const ws = getWorkspace(args.workspaceId)
    const reconciledPatch = withReconciledEffort(
      { model: args.model },
      ws?.projectId,
      args.workspaceId
    )
    return setWorkspaceSettingAndSuppressDirty(
      args.workspaceId,
      reconciledPatch,
      'model',
      deps.getMainWindow
    )
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
    return setWorkspaceSettingAndSuppressDirty(
      args.workspaceId,
      { effort: args.effort },
      'effort',
      deps.getMainWindow
    )
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
