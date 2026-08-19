// ---------------------------------------------------------------------------
// src/shared/harness/projectDrawerSettings.ts
//
// Pure logic for the per-project Settings drawer (SettingsDrawer.tsx, H1
// support-multi-harness) re-pointed at harness_settings — the storage the
// live launch emitter (composeClaudeHarnessLaunch, wired as every harness
// descriptor's composeLaunch) actually reads, per fcb579cc/caedc46b. The
// drawer previously read/wrote claude_project_settings, which — confirmed by
// grepping every composeClaudeLaunch call site down to zero non-dirty-
// tracking callers — has had NO effect on what `claude` actually launches
// with since the U9 cutover. See this unit's own PR/report for the full
// investigation; this file is the fix's pure core.
//
// Lives in src/shared (not src/main or src/renderer) so both processes
// import the exact same decision functions — same rationale as
// curatedOptions.ts's header: check:arch forbids src/renderer -> src/main,
// and a main-only copy would let the two drift the way claude_project_settings
// and harness_settings already did once.
// ---------------------------------------------------------------------------

import type { HarnessCuratedSettings, HarnessSettingRow, HarnessSettings } from '../types'

// ---------------------------------------------------------------------------
// Which harness(es) does this project actually run?
// ---------------------------------------------------------------------------

/** Minimal shape this module needs off a workspace record — a structural
 *  type (mirrors settingsSectionGating.ts's SettingsSectionGateHarness
 *  precedent) so callers can pass a real WorkspaceRecord with no adapter. */
export interface HarnessMembershipWorkspace {
  harnessId: string
}

/**
 * The distinct set of harness ids actually present among a project's
 * workspaces, in first-seen order. This is the honesty check for the
 * override chip and the drawer's harness picker: a project's settings
 * drawer editing harness X only "overclaims" if some workspace in the
 * project runs a DIFFERENT harness — see countHonestProjectOverrides below,
 * which is what actually consumes this for the chip.
 *
 * `workspaces` may be null/empty (still loading, or a brand-new project with
 * no workspaces yet) — returns `[]` rather than throwing; every caller
 * already treats an empty/loading workspace list as "nothing to show yet".
 */
export function harnessesPresentInProject(
  workspaces: readonly HarnessMembershipWorkspace[] | null | undefined
): string[] {
  if (!workspaces || workspaces.length === 0) return []
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const ws of workspaces) {
    if (seen.has(ws.harnessId)) continue
    seen.add(ws.harnessId)
    ordered.push(ws.harnessId)
  }
  return ordered
}

/**
 * Whether the drawer should show a harness picker at all. Mirrors
 * NewWorkspaceMenu.tsx's existing `harnesses.length > 1` gate exactly (see
 * that file's handleTriggerClick / harnessId resolution) so a single-Claude
 * install renders identically to today — no picker, no visible change —
 * and a second registered harness makes the SAME condition true everywhere
 * a harness choice can appear, rather than each surface inventing its own
 * threshold.
 */
export function shouldShowProjectHarnessPicker(harnesses: readonly { id: string }[]): boolean {
  return harnesses.length > 1
}

/**
 * Resolves which harness id the drawer should edit, given the harnesses
 * registered, which ones the project's workspaces actually use, and any
 * explicit in-session picker selection.
 *
 * Precedence:
 *  1. An explicit `selectedHarnessId` that is still a REGISTERED harness id
 *     wins outright — once a user has chosen in this session, later
 *     project-membership data arriving (workspaces list finishing its
 *     fetch) must not silently yank the selection out from under them.
 *  2. Otherwise, the first harness actually present in the project
 *     (`harnessesInProject[0]`) — editing the drawer should default to
 *     "the harness this project is already using," not always harness #1
 *     in the registry.
 *  3. Otherwise (brand-new project, no workspaces yet, or membership still
 *     loading) fall back to the first REGISTERED harness — same bootstrap
 *     default NewWorkspaceMenu's fetchHarnesses uses (`list[0]?.id`).
 *  4. `''` only when there is no registered harness at all (harness:list
 *     still loading / fetch failed) — callers already gate rendering on a
 *     non-empty harnesses list before reaching this point.
 */
export function resolveDrawerHarnessId(
  registeredHarnesses: readonly { id: string }[],
  harnessesInProject: readonly string[],
  selectedHarnessId: string
): string {
  if (selectedHarnessId && registeredHarnesses.some((h) => h.id === selectedHarnessId)) {
    return selectedHarnessId
  }
  const registeredIds = new Set(registeredHarnesses.map((h) => h.id))
  const firstProjectHarnessRegistered = harnessesInProject.find((id) => registeredIds.has(id))
  if (firstProjectHarnessRegistered) return firstProjectHarnessRegistered
  return registeredHarnesses[0]?.id ?? ''
}

// ---------------------------------------------------------------------------
// Single-key arg row read/write (permission-mode's home in harness_settings)
// ---------------------------------------------------------------------------

/**
 * Reads the EFFECTIVE value of one keyed arg row (e.g. '--permission-mode')
 * out of an already-resolved, already-enabledOnly-filtered rows array — the
 * exact shape resolveHarnessSettings(...).args returns (see
 * src/main/harness/settings.ts). Mirrors composeClaudeHarnessLaunch's own
 * userArgTokens reading: a row with no stored value (bare flag) resolves to
 * '' , matching how a bare `--permission-mode` with no value would compose
 * (never actually shipped by Claude, but kept consistent rather than
 * special-cased). Returns undefined when the key has no row at all — "no
 * override; Claude's own default applies," the same meaning `undefined`
 * already carries for curated.model/curated.effort.
 *
 * Takes the RESOLVED rows (post scope-merge), not raw per-scope storage —
 * this function has no opinion about scope layering, that is
 * resolveHarnessSettings' job (src/main/harness/settings.ts), which this
 * intentionally does not reimplement.
 */
export function resolveArgRowValue(
  rows: readonly HarnessSettingRow[] | undefined,
  key: string
): string | undefined {
  const row = rows?.find((r) => r.key === key)
  if (!row) return undefined
  return row.value ?? ''
}

/**
 * Pure upsert-or-clear of ONE keyed row within a project (or any single)
 * scope's stored `args` array, preserving every other row's identity,
 * value, and relative order — the merge-write counterpart to
 * setCuratedModelEffort's "patch one field, leave the rest of the row
 * untouched" contract (src/main/harness/settings.ts), one level down at
 * row granularity instead of settings-object granularity.
 *
 * `nextValue: undefined` REMOVES the row entirely (not "disable it") — the
 * drawer's permission-mode Select has a clean "Use global" sentinel
 * ('default'), and a removed row is indistinguishable from "this scope
 * never had an opinion," which is exactly what "inherit from the scope
 * below" must mean. Disabling (enabled: false, row kept) is a different,
 * more advanced concept the harness settings page's row editor exposes
 * (toggle off but keep the value for later); the drawer's single-Select
 * field has no use for that middle state, so it always either sets an
 * enabled row with a value or removes the row outright.
 *
 * A row whose key does not yet exist is appended at the end (same
 * ordering convention mergeRowsByKey uses for a scope introducing a new
 * key) — never reordered into the shipped-defaults' position, since this
 * function has no defaultArgs knowledge (that's a UI-display-only overlay,
 * see mergeDefaultArgs's own doc comment — never written to storage).
 */
export function withArgRowSet(
  rows: readonly HarnessSettingRow[] | undefined,
  key: string,
  nextValue: string | undefined
): HarnessSettingRow[] | undefined {
  const existing = rows ?? []
  if (nextValue === undefined) {
    const filtered = existing.filter((r) => r.key !== key)
    return filtered.length > 0 ? filtered : undefined
  }
  const nextRow: HarnessSettingRow = { key, value: nextValue, enabled: true }
  const index = existing.findIndex((r) => r.key === key)
  if (index === -1) return [...existing, nextRow]
  const copy = existing.slice()
  copy[index] = nextRow
  return copy
}

// ---------------------------------------------------------------------------
// Applying the drawer's tri-state patch (model/effort/permissionMode)
// ---------------------------------------------------------------------------

/** The drawer's patch shape for one scope — mirrors
 *  harness:settings:updateProjectDrawer's IPC contract (src/shared/ipc.ts)
 *  exactly: an OMITTED key means "leave this field alone," `null` means
 *  "clear the override, inherit from below," and a string sets it. See
 *  that channel's own doc comment for why this deliberately does NOT reuse
 *  setCuratedModelEffort's undefined-only contract, which cannot express
 *  "clear." */
export type ProjectDrawerFieldPatch = {
  model?: string | null
  effort?: string | null
  permissionMode?: string | null
}

/**
 * Applies the drawer's tri-state patch to one scope's ALREADY-LOADED
 * HarnessSettings, returning the next HarnessSettings to persist (a new
 * object; never mutates `existing`). Every field the patch does not
 * mention is passed through unchanged — args rows other than
 * `permissionModeArgKey`, env, curatedOptions, and any curated key the
 * patch didn't touch.
 *
 * This is the merge core behind harness:settings:updateProjectDrawer
 * (src/main/ipc/claudeSettings.ts) — kept here, pure, so the exact
 * model/effort-vs-permissionMode merge behavior (which field lands in
 * `curated`, which lands in an `args` row, and the null-clears/undefined-
 * leaves-alone tri-state) is independently testable without a database.
 */
export function applyProjectDrawerPatch(
  existing: HarnessSettings,
  patch: ProjectDrawerFieldPatch,
  permissionModeArgKey: string
): HarnessSettings {
  const nextCurated: HarnessCuratedSettings = { ...existing.curated }
  // `patch.model === undefined` -> key absent from the patch -> leave
  // nextCurated.model exactly as it was copied from `existing.curated`
  // above. `null` -> clear (DELETE the key, not set it to `undefined` —
  // `{ model: undefined }` and `{}` are different objects under
  // assert.deepEqual/JSON.stringify, and setHarnessSettings round-trips
  // through JSON.stringify, so leaving an explicit `undefined` key would
  // silently vanish on the very next read anyway; deleting here makes the
  // in-memory shape match what storage would produce). A string -> set it.
  if (patch.model !== undefined) {
    if (patch.model === null) delete nextCurated.model
    else nextCurated.model = patch.model
  }
  if (patch.effort !== undefined) {
    if (patch.effort === null) delete nextCurated.effort
    else nextCurated.effort = patch.effort
  }
  const curatedTouched = patch.model !== undefined || patch.effort !== undefined
  // Drop an all-empty curated object rather than persist `{}` — matches
  // getHarnessSettings/setHarnessSettings' existing "absent means nothing
  // configured" convention (see settings.ts's own header) rather than
  // introducing a new, indistinguishable-from-unset empty-object state.
  const finalCurated =
    nextCurated.model === undefined && nextCurated.effort === undefined ? undefined : nextCurated

  const nextArgs =
    patch.permissionMode !== undefined
      ? withArgRowSet(existing.args, permissionModeArgKey, patch.permissionMode ?? undefined)
      : existing.args

  return {
    ...existing,
    ...(curatedTouched ? { curated: finalCurated } : {}),
    args: nextArgs
  }
}

// ---------------------------------------------------------------------------
// Honest override count (ProjectHeader's chip)
// ---------------------------------------------------------------------------

/** Which stored fields count as a project-scope "override" for the honest
 *  chip — curated model, curated effort, and the permission-mode arg row.
 *  These are exactly the three fields the drawer's re-pointed Model/Effort/
 *  Permission-mode controls write (see SettingsDrawer.tsx) — every other
 *  harness_settings row (arbitrary user-added args/env) is deliberately
 *  OUT of this count: those are edited on the Settings > Harness page, not
 *  this drawer, and folding them in would make the chip's number jump for
 *  edits the drawer had no part in and cannot itself reset. */
export function countProjectHarnessOverrides(
  projectSettings: HarnessSettings | undefined,
  permissionModeArgKey: string
): number {
  const curated: HarnessCuratedSettings = projectSettings?.curated ?? {}
  let count = 0
  if (curated.model !== undefined) count += 1
  if (curated.effort !== undefined) count += 1
  if (resolveArgRowValue(projectSettings?.args, permissionModeArgKey) !== undefined) count += 1
  return count
}

/**
 * Whether the project's override chip should render at all AND whether it
 * is safe to describe as applying to "this project" without qualification.
 *
 * THE HONESTY CHECK the override chip previously lacked: `overrideCount` on
 * its own says nothing about WHOSE workspaces those overrides reach. A
 * project can hold overrides for harness X while every current workspace in
 * it runs harness Y (the harness was switched, or the settings were set
 * before any workspace existed) — in that case the count is real but
 * "N overrides" as a bare project-wide claim is not: it should name the
 * harness those overrides apply to instead of implying blanket reach.
 *
 * `appliesToEveryWorkspace` is true when EITHER the project has no
 * workspaces yet (nothing to contradict "these will apply") OR every
 * harness actually present in the project is the same one the settings
 * were edited for — i.e. `harnessesInProject` is empty or is exactly
 * `[harnessId]`. False the moment a SECOND, different harness id shows up
 * in the project, even if `harnessId`'s workspaces are also present — the
 * chip must not claim reach over workspaces it does not affect.
 */
export function projectOverrideChipInfo(
  harnessId: string,
  overrideCount: number,
  harnessesInProject: readonly string[]
): { visible: boolean; appliesToEveryWorkspace: boolean } {
  const otherHarnessesPresent = harnessesInProject.some((id) => id !== harnessId)
  return {
    visible: overrideCount > 0,
    appliesToEveryWorkspace: !otherHarnessesPresent
  }
}
