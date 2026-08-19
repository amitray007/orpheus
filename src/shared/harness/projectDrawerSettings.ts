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
import { parseFlagEntry } from '../cliFlags'

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
  /** STILL SUPPORTED by this function and by the main-process IPC handler —
   *  the args-row plumbing (withArgRowSet, CLAUDE_PERMISSION_MODE_ARG_KEY)
   *  stays live for the Settings > Harness page and the default-args
   *  seeding path, which both still read/write this same row. But per the
   *  user's decision on this unit ("we follow global only"), the DRAWER no
   *  longer has a Permission-mode control and never sends this key — so
   *  this branch, while still correct and tested, currently has NO real
   *  caller. Kept rather than removed because deleting a working, tested
   *  code path serving OTHER callers' underlying storage would be the wrong
   *  kind of cleanup for a UI-only decision. */
  permissionMode?: string | null
  /** Whole-array replace (not a tri-state row merge like the three fields
   *  above) — CliFlagsEditor's onChange always hands back the FULL next
   *  list, already converted to rows by the caller via customCliFlagsToRows
   *  (see that function's own header for the lossy-conversion cases this
   *  can trigger). `undefined` leaves args rows OTHER than what this patch
   *  touches alone; `[]` clears every CLI-flag-originated row (still only
   *  the ones this drawer manages — see the merge note below on why this
   *  can't just replace `args` wholesale). */
  customCliFlags?: HarnessSettingRow[]
  /** Whole-array replace, same shape as customCliFlags above, for `env`
   *  rows — CustomEnvVarsEditor's onChange always hands back the full next
   *  Record, converted via customEnvVarsToRows. */
  customEnvVars?: HarnessSettingRow[]
  /** Whole-string replace for the free-text shell snippet. `null`/`''`
   *  clears it (see applyProjectDrawerPatch's own handling below);
   *  `undefined` leaves it alone. */
  preLaunchSnippet?: string | null
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
/** `patch.model === undefined` -> key absent from the patch -> leave the
 *  field exactly as it was copied from `existing.curated`. `null` -> clear
 *  (DELETE the key, not set it to `undefined` — `{ model: undefined }` and
 *  `{}` are different objects under assert.deepEqual/JSON.stringify, and
 *  setHarnessSettings round-trips through JSON.stringify, so leaving an
 *  explicit `undefined` key would silently vanish on the very next read
 *  anyway; deleting here makes the in-memory shape match what storage would
 *  produce). A string -> set it. Returns `{ touched, curated }` — `touched`
 *  tells the caller whether to assign `curated` on the result at all (a
 *  patch that never mentions model/effort must leave `existing.curated`'s
 *  presence/absence alone, not force an empty-object write). */
function mergeCuratedFieldPatch(
  existing: HarnessCuratedSettings | undefined,
  patch: Pick<ProjectDrawerFieldPatch, 'model' | 'effort'>
): { touched: boolean; curated: HarnessCuratedSettings | undefined } {
  const next: HarnessCuratedSettings = { ...existing }
  if (patch.model !== undefined) {
    if (patch.model === null) delete next.model
    else next.model = patch.model
  }
  if (patch.effort !== undefined) {
    if (patch.effort === null) delete next.effort
    else next.effort = patch.effort
  }
  const touched = patch.model !== undefined || patch.effort !== undefined
  // Drop an all-empty curated object rather than persist `{}` — matches
  // getHarnessSettings/setHarnessSettings' existing "absent means nothing
  // configured" convention (see settings.ts's own header) rather than
  // introducing a new, indistinguishable-from-unset empty-object state.
  const curated = next.model === undefined && next.effort === undefined ? undefined : next
  return { touched, curated }
}

export function applyProjectDrawerPatch(
  existing: HarnessSettings,
  patch: ProjectDrawerFieldPatch,
  permissionModeArgKey: string
): HarnessSettings {
  const { touched: curatedTouched, curated: finalCurated } = mergeCuratedFieldPatch(
    existing.curated,
    patch
  )

  const nextArgsAfterPermission =
    patch.permissionMode !== undefined
      ? withArgRowSet(existing.args, permissionModeArgKey, patch.permissionMode ?? undefined)
      : existing.args

  // customCliFlags is a WHOLESALE replace of `args` MINUS the permission-mode
  // row — see mergeCliFlagsRows's own doc comment for why exclude-one-key
  // rather than replace-everything is the right rule (this drawer and
  // Settings > Harness both write project-scope `args`; a wholesale replace
  // FROM the CLI-flags editor's own limited view would silently wipe any row
  // added on the OTHER page, and would wipe permission-mode specifically
  // since it is a real, syntactically-valid CLI flag that just happens to be
  // a DIFFERENT field in this drawer).
  const nextArgs =
    patch.customCliFlags !== undefined
      ? mergeCliFlagsRows(nextArgsAfterPermission, patch.customCliFlags, permissionModeArgKey)
      : nextArgsAfterPermission

  const nextEnv = patch.customEnvVars !== undefined ? patch.customEnvVars : existing.env

  const nextPreLaunchSnippet =
    patch.preLaunchSnippet !== undefined
      ? patch.preLaunchSnippet || undefined // '' and null both clear
      : existing.preLaunchSnippet

  // Spread `existing` first, then only assign keys that CHANGED — an
  // unconditional `args: nextArgs` etc. would set the property to
  // `undefined` even when nothing touched it (e.g. `{ args: undefined }`
  // when `existing.args` was already undefined and the patch never
  // mentioned args), which is a DIFFERENT object shape than omitting the
  // key entirely under assert.deepEqual/Object.keys, even though
  // JSON.stringify (what setHarnessSettings actually persists through)
  // happens to render both the same way. Caught by this file's own
  // verifier — see verify-project-drawer-settings.ts's "no stray
  // undefined-valued keys" case.
  const result: HarnessSettings = { ...existing }
  if (curatedTouched) {
    if (finalCurated === undefined) delete result.curated
    else result.curated = finalCurated
  }
  if (nextArgsAfterPermission !== existing.args || patch.customCliFlags !== undefined) {
    if (nextArgs === undefined) delete result.args
    else result.args = nextArgs
  }
  if (patch.customEnvVars !== undefined) {
    if (nextEnv === undefined || nextEnv.length === 0) delete result.env
    else result.env = nextEnv
  }
  if (patch.preLaunchSnippet !== undefined) {
    if (nextPreLaunchSnippet === undefined) delete result.preLaunchSnippet
    else result.preLaunchSnippet = nextPreLaunchSnippet
  }
  return result
}

/**
 * Replaces every `args` row EXCEPT `excludeKey` (permission-mode) with
 * `nextManagedRows`, preserving `excludeKey`'s row (if present) and its
 * position untouched. This is the rule that lets the drawer's CLI-flags
 * editor and its own Permission-mode row (or, going forward, the Settings >
 * Harness page's row editor) coexist in the SAME `args` array without
 * either one's save silently deleting the other's row — see
 * applyProjectDrawerPatch's own call-site comment for the fuller
 * "wholesale replace would wipe the other surface's rows" reasoning this
 * function exists to avoid.
 *
 * `nextManagedRows` is a COMPLETE replacement of the non-excluded set —
 * order becomes `nextManagedRows`' order, then `excludeKey`'s row appended
 * at the end if it existed and wasn't itself in `nextManagedRows` (it
 * shouldn't be — customCliFlagsToRows/rowsToCustomCliFlags never produce or
 * consume that key — but this stays defensive rather than assuming the
 * caller never passes it).
 */
function mergeCliFlagsRows(
  existing: readonly HarnessSettingRow[] | undefined,
  nextManagedRows: readonly HarnessSettingRow[],
  excludeKey: string
): HarnessSettingRow[] | undefined {
  const excludedRow = (existing ?? []).find((r) => r.key === excludeKey)
  const managed = nextManagedRows.filter((r) => r.key !== excludeKey)
  const merged = excludedRow ? [...managed, excludedRow] : managed
  return merged.length > 0 ? merged : undefined
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

// ---------------------------------------------------------------------------
// Custom CLI flags <-> harness_settings.args row conversion
//
// THE SHAPE MISMATCH — read before touching this section. `customCliFlags`
// (claude_project_settings, the drawer's PRE-H1-drawer-repoint storage) is a
// `string[]` of whole, possibly multi-token, possibly-quoted free-text
// entries (e.g. `--model opus`, `--append-system-prompt "be terse and
// kind"`, or in principle `--add-dir /a /b` as ONE entry). `harness_settings
// .args` is `HarnessSettingRow[] = {key, value?, enabled}[]` — ONE row per
// FLAG NAME, at most ONE value token. These are not the same shape:
//   - A flag name can appear in `args` at most once per scope —
//     mergeRowsByKey (settings.ts) COLLAPSES same-key rows within one
//     scope's array by construction (a Map keyed by row.key; a later row
//     with the same key overwrites, it does not append). So `customCliFlags`
//     entering the SAME flag name twice in one scope (e.g. two separate
//     `--add-dir` entries, the REPEATABLE case cliFlags.ts documents) has no
//     lossless representation as rows — the entries collapse to one.
//   - A `value` is emitted as exactly ONE argv token (userArgTokens in
//     harness/claude/launch.ts pushes `row.value` as a single string). A
//     parsed entry with 2 tokens (`[flag, value]`, the overwhelming common
//     case — including a quoted value, which tokenizeWords collapses to ONE
//     token before this ever sees it) converts losslessly. A parsed entry
//     with 3+ tokens (an unquoted flag taking multiple bare positional
//     words in one entry, e.g. a hand-typed `--add-dir /a /b`) does NOT: the
//     extra tokens are joined with a single space into `value`, which
//     changes how they reach argv — from TWO separate tokens to ONE token
//     containing a literal space. For a flag that expects two independent
//     path arguments, that is a behavior change, not just a display change.
//
// DECISION — convert what converts cleanly (the common 1-2-token case,
// last-entry-wins on a same-name collision — same "later overrides
// earlier" rule mergeRowsByKey already applies to every other args write),
// and report every LOSSY case back to the caller via `warnings` rather than
// silently dropping or mis-shaping data. The alternative (refuse to convert
// 3+-token entries, or refuse same-name collisions) would leave the user's
// EXISTING typed content orphaned with no path forward; degrading it
// visibly, with a warning the caller can surface, is more honest than
// either silent data loss or a hard refusal on save.
// ---------------------------------------------------------------------------

/** Result of converting a `customCliFlags` array to `harness_settings.args`
 *  rows. `rows` is the best-effort conversion; `warnings` lists every entry
 *  that could not convert losslessly (unparseable, a >2-token entry whose
 *  extra tokens were joined into one, or a flag name that collided with an
 *  earlier entry and was overwritten) — one human-readable string per
 *  affected case, safe to render directly in the UI. */
export interface CliFlagsConversionResult {
  rows: HarnessSettingRow[]
  warnings: string[]
}

/**
 * Converts a `customCliFlags`-shaped string array into `harness_settings
 * .args` rows. See this section's header comment for the exact lossy cases
 * and why they are handled by WARN-AND-CONVERT rather than refuse.
 *
 * Order: entries are processed in array order; a later entry sharing an
 * earlier entry's flag name OVERWRITES that row in place (matches
 * mergeRowsByKey's own within-scope collapse rule — the two would collapse
 * identically once written to storage regardless of what this function
 * does, so overwriting here rather than appending a row mergeRowsByKey
 * would immediately collapse anyway keeps this function's output
 * predictable from its own return value, not from a downstream merge).
 */
/** One parsed entry's conversion outcome: `error` for an unparseable entry
 *  (dropped, never a row); otherwise a row plus any warning the entry's OWN
 *  shape produced (a >2-token entry). The same-flag-collision warning is a
 *  property of the WHOLE list (whether an earlier entry already used this
 *  name), so it is decided by the caller's loop, not here. */
type CliFlagEntryOutcome = { error: string } | { row: HarnessSettingRow; warning?: string }

function convertOneCliFlagEntry(raw: string): CliFlagEntryOutcome {
  const parsed = parseFlagEntry(raw)
  if ('error' in parsed) return { error: parsed.error }
  const [, ...rest] = parsed.tokens
  const value = rest.length > 0 ? rest.join(' ') : undefined
  const warning =
    rest.length > 1
      ? `"${raw}" has multiple values after the flag; they were joined into one ("${rest.join(' ')}"), which changes how they reach the harness if it expects them as separate arguments.`
      : undefined
  return { row: { key: parsed.name, value, enabled: true }, warning }
}

export function customCliFlagsToRows(entries: readonly string[]): CliFlagsConversionResult {
  const rows: HarnessSettingRow[] = []
  const indexByKey = new Map<string, number>()
  const warnings: string[] = []

  for (const raw of entries) {
    const outcome = convertOneCliFlagEntry(raw)
    if ('error' in outcome) {
      warnings.push(`"${raw}" could not be converted (${outcome.error}) and was dropped.`)
      continue
    }
    if (outcome.warning) warnings.push(outcome.warning)

    const existingIndex = indexByKey.get(outcome.row.key)
    if (existingIndex !== undefined) {
      warnings.push(
        `"${raw}" uses the same flag ("${outcome.row.key}") as an earlier entry — only the last one is kept.`
      )
      rows[existingIndex] = outcome.row
    } else {
      indexByKey.set(outcome.row.key, rows.length)
      rows.push(outcome.row)
    }
  }

  return { rows, warnings }
}

/**
 * Inverse of customCliFlagsToRows — renders ENABLED `harness_settings.args`
 * rows back into `customCliFlags`-shaped entries, for displaying existing
 * row-backed state in the drawer's familiar free-text form. Lossless in
 * this direction (a row always has an unambiguous single-entry rendering);
 * only customCliFlagsToRows loses information, never this. Disabled rows
 * are omitted — the drawer's CLI-flags field has no "disabled but kept"
 * concept of its own (mirrors withArgRowSet's own scope-note on why the
 * drawer's simpler controls skip that middle state).
 */
export function rowsToCustomCliFlags(rows: readonly HarnessSettingRow[] | undefined): string[] {
  if (!rows) return []
  return rows.filter((r) => r.enabled).map((r) => (r.value ? `${r.key} ${r.value}` : r.key))
}

// ---------------------------------------------------------------------------
// Custom env vars <-> harness_settings.env row conversion
//
// UNLIKE customCliFlagsToRows above, this direction is LOSSLESS both ways —
// `customEnvVars: Record<string, string>` and `HarnessSettingRow[]` are
// already the same shape (one key, one value each); there is no lexing, no
// multi-token entries, no possibility of a value that can't fit one row.
// This is exactly why the user's decision (KEEP env vars, decide the
// CLI-flags conversion separately) treats the two fields differently — env
// vars needed no design decision at all, only wiring.
// ---------------------------------------------------------------------------

/** Converts a `customEnvVars`-shaped Record into `harness_settings.env`
 *  rows, one row per entry, all enabled. Object key iteration order is
 *  preserved (insertion order, per the JS spec for string keys) so the
 *  resulting row order matches what the user sees in the editor. */
export function customEnvVarsToRows(vars: Readonly<Record<string, string>>): HarnessSettingRow[] {
  return Object.entries(vars).map(([key, value]) => ({ key, value, enabled: true }))
}

/** Inverse of customEnvVarsToRows — renders ENABLED `harness_settings.env`
 *  rows back into a `customEnvVars`-shaped Record. A disabled row is
 *  omitted (same rationale as rowsToCustomCliFlags: the drawer's simpler
 *  controls have no "disabled but kept" concept). A row with no value
 *  becomes an empty string, matching how Record<string,string> has no
 *  "valueless key" representation of its own. */
export function rowsToCustomEnvVars(
  rows: readonly HarnessSettingRow[] | undefined
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const row of rows ?? []) {
    if (!row.enabled) continue
    result[row.key] = row.value ?? ''
  }
  return result
}
