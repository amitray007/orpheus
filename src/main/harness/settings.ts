import { randomUUID } from 'node:crypto'
import { getDb } from '../db'
import { withArgRowSet } from '../../shared/harness/projectDrawerSettings'

// ---------------------------------------------------------------------------
// src/main/harness/settings.ts
//
// Read/write + scope-layering for the generic `harness_settings` table (U1,
// multi-harness architecture plan — see src/main/db/schema.ts's
// harness_settings TableDef and its header comment for the storage-shape
// rationale). This module is the ONLY place that talks to that table; every
// caller goes through getHarnessSettings / setHarnessSettings /
// resolveHarnessSettings below.
//
// SCOPE_ID SENTINEL — read this before touching this file. The table's
// conceptual key is (harness_id, scope, scope_id) with scope_id semantically
// absent for 'global' scope, but SQLite's unique index treats every NULL as
// distinct from every other NULL, so a NULL scope_id would never dedupe and
// every "global" write would silently insert a new row instead of updating
// the existing one. schema.ts's fix is a reserved '' sentinel for scope_id
// at global scope. normalizeScopeId() below is the single choke point that
// applies it — called on EVERY read and EVERY write, no exceptions, so a
// missing/undefined scopeId always round-trips as the same '' row.
// ---------------------------------------------------------------------------

export type HarnessSettingsScope = 'global' | 'project'

export type HarnessSettingRow = {
  key: string
  value?: string
  enabled: boolean
}

export type HarnessCuratedSettings = {
  model?: string
  effort?: string
}

/** One curated field's user overlay onto a descriptor's shipped `options`
 *  list (CuratedField.options, src/shared/harness/types.ts) — the DATA
 *  shape B3 (support-multi-harness) adds so a user can add a value the
 *  descriptor doesn't ship, hide ones they never use, and reorder their
 *  favourites to the top, all WITHOUT touching `curated` (the currently
 *  SELECTED model/effort value, above — unrelated field, unrelated
 *  semantics).
 *
 *  OVERLAY, NOT REPLACEMENT — this is the load-bearing design choice.
 *  `add`/`hide`/`order` store a DELTA against the descriptor's live
 *  `options`, not a copied, frozen snapshot of the resolved list. The same
 *  reasoning as `defaultArgs` seeding into the args editor as real,
 *  editable rows rather than an opaque prefix (see HarnessDescriptor's own
 *  doc comment): a frozen full-list copy would silently stop tracking the
 *  descriptor the moment it ships a new model, permanently hiding
 *  anything added after the user's copy was taken. A delta re-plays
 *  cleanly against whatever `options` the running build currently has.
 *  See resolveCuratedOptions (src/shared/harness/curatedOptions.ts) for the
 *  exact algorithm that re-plays this delta into a final ordered list. */
export type CuratedFieldOptionsOverlay = {
  /** Extra values to append that the descriptor's `options` doesn't ship
   *  (a fine-tune id, a model released after this build). Arbitrary
   *  strings — matches CuratedField.allowCustom's "never validates against
   *  options" contract; the UI shows a non-blocking warning chip for one
   *  that isn't in the descriptor list, it never refuses it. */
  add?: string[]
  /** Values to exclude from the resolved list. Hide, never delete: a
   *  descriptor-shipped option a user hides today may be exactly what they
   *  want back tomorrow, and — the single most important invariant of this
   *  type — a hidden value that is CURRENTLY SELECTED (HarnessCuratedSettings
   *  .model/.effort resolves to it) must still appear in the resolved list,
   *  or the user loses the ability to see what they're actually running. */
  hide?: string[]
  /** Explicit ordering: values named here come first, in this order;
   *  anything not named keeps its relative position after them. Naming a
   *  value that no longer exists (removed from the descriptor, or hidden)
   *  is ignored rather than thrown — order is advisory over whatever the
   *  final set turns out to be, not a hard list that must exactly match. */
  order?: string[]
}

/** Per-harness, per-scope user curation of the model/effort OPTION LISTS —
 *  sibling to `curated` above, not a replacement for it. `curated.model` is
 *  "which model is selected"; `curatedOptions.model` is "which models does
 *  the picker even offer, and in what order". Both fields can be undefined
 *  independently (a harness with curated.model set but no curatedOptions
 *  override just uses the descriptor's `options` as-is). Keyed by the same
 *  CuratedFieldName ('model' | 'effort') the rest of this codebase already
 *  uses (see CuratedFieldName in harnessSettingsLogic.ts). */
export type HarnessCuratedOptionsSettings = {
  model?: CuratedFieldOptionsOverlay
  effort?: CuratedFieldOptionsOverlay
}

/**
 * Free-text shell run in the harness's OWN wrapper script, right before the
 * harness binary starts (e.g. `eval "$(direnv export zsh)"`) — H1
 * (support-multi-harness) revival of the project Settings drawer's "Custom
 * shell before harness" field. NOT a CLI arg row and NOT a process-env row:
 * it is `resources/harness-common.sh`'s ORPHEUS_PRE_LAUNCH_SNIPPET, read by
 * the SHARED wrapper base every harness's own launch script sources (see
 * that file's header) via plain shell `eval`, not passed to the harness
 * binary's argv or env at all. That is what earns it a dedicated top-level
 * field here rather than living in `args`/`env`: a value here is never
 * emitted as `--flag value` or `KEY=value`, so folding it into either row
 * kind would misrepresent what it actually does.
 *
 * HARNESS-AGNOSTIC BY DESIGN — harness-common.sh is not Claude-specific
 * (every harness's wrapper sources it per its own header comment: "the
 * sourcing wrapper... runs the harness-specific invocation using `flags`",
 * with the shared PATH/shell-init logic living in the common file), so this
 * field lives here in the GENERIC HarnessSettings type, not in Claude's own
 * curated.ts, even though only Claude's composeClaudeHarnessLaunch emits it
 * today (see that file for the emission + the reasoning on why this one
 * exception to KTD2's "zero typed passthrough" rule is justified the same
 * way U5's session-continuity exception is — except this one DOES
 * generalize to every harness, which is the opposite of session
 * continuity's "does NOT generalize" justification, and exactly why this
 * lives in the shared module instead of a harness-specific one).
 *
 * Merged global -> project like curated.model/curated.effort (see
 * mergeCurated below) — a later scope's defined value wins outright,
 * `undefined` at a scope leaves an earlier scope's value untouched.
 */
export type HarnessSettings = {
  args?: HarnessSettingRow[]
  env?: HarnessSettingRow[]
  curated?: HarnessCuratedSettings
  curatedOptions?: HarnessCuratedOptionsSettings
  preLaunchSnippet?: string
  /** Whether to source the user's full interactive shell rc (e.g. ~/.zshrc)
   *  before the harness starts — same ORPHEUS_* wrapper-plumbing family as
   *  preLaunchSnippet above (harness-common.sh reads ORPHEUS_SOURCE_ZSHRC
   *  directly), same harness-agnostic justification, same global -> project
   *  scalar layering (mergeScalar below). Global-scope-only today: the
   *  project Settings drawer does not offer this control (removed per
   *  product decision — see SettingsDrawer.tsx's own header), but the field
   *  itself is not scope-restricted by this type; a project override would
   *  resolve correctly if a caller ever wrote one. */
  sourceZshrc?: boolean
}

function normalizeScopeId(scope: HarnessSettingsScope, scopeId?: string): string {
  // Global scope has no real scope_id — always collapse to the '' sentinel
  // regardless of what's passed in, so callers can't accidentally create a
  // second global row by passing undefined once and '' another time.
  if (scope === 'global') return ''
  if (!scopeId) {
    throw new Error(`harnessSettings: scope_id is required for scope '${scope}'`)
  }
  return scopeId
}

/**
 * Read the raw stored settings for one exact (harnessId, scope, scopeId)
 * row. Never throws on a missing row — returns `{}`, the same "nothing
 * configured at this scope" value a fresh install would see.
 */
export function getHarnessSettings(
  harnessId: string,
  scope: HarnessSettingsScope,
  scopeId?: string
): HarnessSettings {
  const normalizedScopeId = normalizeScopeId(scope, scopeId)
  const row = getDb()
    .prepare(
      `SELECT settings_json FROM harness_settings WHERE harness_id = ? AND scope = ? AND scope_id = ?`
    )
    .get(harnessId, scope, normalizedScopeId) as { settings_json: string } | undefined

  if (!row) return {}
  try {
    return JSON.parse(row.settings_json) as HarnessSettings
  } catch {
    // Corrupt/foreign JSON in the column must not crash a settings read —
    // treat it the same as "nothing configured" rather than throwing.
    return {}
  }
}

/**
 * Upsert the settings for one exact (harnessId, scope, scopeId) row. Uses a
 * real UPSERT against the table's unique index (idx_harness_settings_key)
 * rather than read-then-write, so two concurrent writers can't race a
 * check-then-insert into duplicate rows — SQLite serializes the conflict
 * resolution itself.
 */
export function setHarnessSettings(
  harnessId: string,
  scope: HarnessSettingsScope,
  scopeId: string | undefined,
  settings: HarnessSettings
): void {
  const normalizedScopeId = normalizeScopeId(scope, scopeId)
  const settingsJson = JSON.stringify(settings)
  const now = Date.now()

  getDb()
    .prepare(
      `INSERT INTO harness_settings (id, harness_id, scope, scope_id, settings_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(harness_id, scope, scope_id) DO UPDATE SET
         settings_json = excluded.settings_json,
         updated_at = excluded.updated_at`
    )
    .run(randomUUID(), harnessId, scope, normalizedScopeId, settingsJson, now)
}

/**
 * Merge-writes ONLY curated.model/curated.effort into one (harnessId, scope,
 * scopeId) row, preserving that row's existing args/env and any other
 * curated key untouched (e.g. setting model alone never drops a
 * previously-stored effort). A0 (support-multi-harness): the write path for
 * the footer Model/Effort chips, so a chip change persists through the SAME
 * storage the launch emitter (composeClaudeHarnessLaunch) and the other
 * footer chip both read — closing the split-brain where
 * workspace:setModel/setEffort wrote only claude_workspace_settings /
 * claude_global_settings and harness_settings.curated silently went stale.
 *
 * Pass `undefined` for a key to leave that key's stored value alone (NOT to
 * clear it) — matching setHarnessSettings' own "whole-row replace" semantics
 * would otherwise make a model-only chip write silently erase a previously
 * stored effort, and vice versa.
 */
export function setCuratedModelEffort(
  harnessId: string,
  scope: HarnessSettingsScope,
  scopeId: string | undefined,
  patch: { model?: string; effort?: string }
): void {
  const existing = getHarnessSettings(harnessId, scope, scopeId)
  const nextCurated: HarnessCuratedSettings = { ...existing.curated }
  if (patch.model !== undefined) nextCurated.model = patch.model
  if (patch.effort !== undefined) nextCurated.effort = patch.effort
  setHarnessSettings(harnessId, scope, scopeId, { ...existing, curated: nextCurated })
}

/**
 * Merge-writes preLaunchSnippet/sourceZshrc — the ORPHEUS_* wrapper-plumbing
 * scalars (see HarnessSettings' own doc comments) — at one exact scope.
 * Global-settings-page write path (H1 follow-up, support-multi-harness):
 * the project Settings drawer has its own dedicated tri-state channel
 * (harness:settings:updateProjectDrawer / applyProjectDrawerPatch) for
 * preLaunchSnippet at project scope; this is the sibling for the GLOBAL
 * scope page (ClaudeToolsSection.tsx), which needs only these two fields,
 * not the drawer's full model/effort/args/env surface.
 *
 * Tri-state, same contract as applyProjectDrawerPatch: a key ABSENT from
 * `patch` leaves that field's stored value untouched; `null` clears it
 * (deletes the key rather than storing `undefined` — see
 * applyProjectDrawerPatch's own comment for why that distinction matters
 * once the value round-trips through JSON.stringify); a real value sets it.
 */
export function setShellInit(
  harnessId: string,
  scope: HarnessSettingsScope,
  scopeId: string | undefined,
  patch: { preLaunchSnippet?: string | null; sourceZshrc?: boolean | null }
): void {
  const existing = getHarnessSettings(harnessId, scope, scopeId)
  const next: HarnessSettings = { ...existing }
  if (patch.preLaunchSnippet !== undefined) {
    if (patch.preLaunchSnippet === null) delete next.preLaunchSnippet
    else next.preLaunchSnippet = patch.preLaunchSnippet
  }
  if (patch.sourceZshrc !== undefined) {
    if (patch.sourceZshrc === null) delete next.sourceZshrc
    else next.sourceZshrc = patch.sourceZshrc
  }
  setHarnessSettings(harnessId, scope, scopeId, next)
}

/**
 * Merge-writes ONE keyed row within `args` — set (upsert, always enabled) or
 * clear (remove the row entirely) — preserving that row's existing env,
 * curated, curatedOptions, and every OTHER args row untouched. H1
 * (support-multi-harness): the write path for the project Settings drawer's
 * Permission-mode control, which has no curated-field home (see
 * CLAUDE_DEFAULT_ARGS's doc comment in harness/claude/curated.ts —
 * permission-mode is a plain `--permission-mode` arg row, not a curated
 * concept, because the same intent takes a different argv shape per
 * harness) but still needs a single-Select "Use global / set an override"
 * UX exactly like model/effort get from setCuratedModelEffort above.
 *
 * Delegates the actual array surgery to withArgRowSet (src/shared/harness/
 * projectDrawerSettings.ts) so the pure upsert-or-remove logic is
 * independently testable and shared with any renderer-side preview that
 * needs the same transform, rather than reimplemented here.
 *
 * `value: undefined` REMOVES the row (falls through to whatever the next
 * scope down resolves to — see withArgRowSet's own doc comment for why a
 * removed row, not a disabled one, is the right "inherit" representation
 * for a single-Select control). A defined `value` always upserts an
 * ENABLED row — the drawer has no separate enabled/disabled toggle for
 * this field, unlike the harness settings page's full row editor.
 */
export function setArgRowValue(
  harnessId: string,
  scope: HarnessSettingsScope,
  scopeId: string | undefined,
  key: string,
  value: string | undefined
): void {
  const existing = getHarnessSettings(harnessId, scope, scopeId)
  const nextArgs = withArgRowSet(existing.args, key, value)
  setHarnessSettings(harnessId, scope, scopeId, { ...existing, args: nextArgs })
}

// ---------------------------------------------------------------------------
// Layering
// ---------------------------------------------------------------------------

/**
 * Filter out disabled rows. Disabled rows are preserved in storage (so a
 * user can re-enable a flag without retyping it) but excluded from every
 * resolved/effective view — the shape callers like launch composition
 * actually consume.
 */
function enabledOnly(rows: HarnessSettingRow[] | undefined): HarnessSettingRow[] | undefined {
  if (!rows) return undefined
  return rows.filter((row) => row.enabled)
}

// args/env LAYERING DECISION — merge-by-key across scopes, not
// whole-array replacement.
//
// Reasoning: a user editing scopes in the Settings UI adds a handful of
// project- or workspace-specific rows (e.g. one extra --add-dir at
// workspace scope) on top of a global baseline (e.g. --verbose,
// ANTHROPIC_LOG=debug at global scope) that they still expect to apply
// everywhere. Whole-array replacement would mean a single workspace-scope
// row silently discards every global row the moment ANY workspace override
// exists — invisible in the UI (each scope's editor only shows what THAT
// scope stores) and surprising in the terminal (flags the user still sees
// listed at global scope stop taking effect). Merge-by-key matches the
// mental model this codebase already ships for curated fields ("workspace
// overrides globaly, only for the keys it sets") and for
// claude_workspace_settings' customCliFlags/customEnvVars layering
// precedent (composeClaudeLaunch appends the syntax-only overrides on top
// of the global set rather than replacing it).
//
// Mechanics: process scopes in precedence order (global, then project, then
// workspace). A later scope's row for the same `key` REPLACES the earlier
// one in place (value AND enabled both come from the later scope — an
// explicit `enabled: false` at workspace scope can suppress a global row
// without deleting it from either scope's storage). A later scope's row
// with a new `key` is appended after the existing ones, preserving overall
// order: global rows first (in their stored order), then any
// project-introduced keys, then any workspace-introduced keys. Disabled
// rows are filtered out only at the very end (enabledOnly), so a workspace
// `enabled: false` override of a global `enabled: true` row correctly
// excludes it from the merged result.
function mergeRowsByKey(
  layers: Array<HarnessSettingRow[] | undefined>
): HarnessSettingRow[] | undefined {
  const merged: HarnessSettingRow[] = []
  const indexByKey = new Map<string, number>()
  let sawAny = false

  for (const layer of layers) {
    if (!layer) continue
    sawAny = true
    for (const row of layer) {
      const existingIndex = indexByKey.get(row.key)
      if (existingIndex === undefined) {
        indexByKey.set(row.key, merged.length)
        merged.push(row)
      } else {
        merged[existingIndex] = row
      }
    }
  }

  return sawAny ? merged : undefined
}

// preLaunchSnippet/sourceZshrc LAYERING — plain last-defined-wins, same rule
// mergeCurated applies to curated.model/curated.effort one field at a time.
// A single scalar value (free-text string, or boolean) has no sane per-key
// merge (unlike args/env rows, which are independent addressable units) —
// the whole value is one editorial decision, so a MORE SPECIFIC scope
// defining it replaces an earlier scope's value entirely, and a scope with
// NO opinion (key absent) leaves an earlier scope's value untouched.
// Generic over T rather than two near-identical string/boolean copies —
// preLaunchSnippet (string) and sourceZshrc (boolean) are the same merge
// shape, just a different payload type.
function mergeScalar<T>(layers: Array<T | undefined>): T | undefined {
  let merged: T | undefined
  for (const layer of layers) {
    if (layer !== undefined) merged = layer
  }
  return merged
}

function mergeCurated(
  layers: Array<HarnessCuratedSettings | undefined>
): HarnessCuratedSettings | undefined {
  let merged: HarnessCuratedSettings | undefined
  for (const layer of layers) {
    if (!layer) continue
    merged = { ...merged, ...layer }
  }
  return merged
}

// curatedOptions LAYERING DECISION — field-level whole-value replacement,
// NOT mergeRowsByKey's merge-by-key. This deliberately diverges from how
// args/env layer across scopes, and the divergence is the point, not an
// oversight — read this before "fixing" it to look more like args/env.
//
// args/env merge BY KEY because each row is an independent, addressable
// unit (one flag, one env var) and a project adding ONE extra row on top of
// a global baseline is exactly what a user expects. A curatedOptions
// overlay for one field (add/hide/order) is not a bag of independent rows —
// it's ONE coherent editorial decision about the whole options list for
// that field. "Global says [opus, sonnet], project reorders to [sonnet,
// opus]" has no sane per-key merge: order is inherently a property of the
// WHOLE list, not of any single entry, so there is nothing to merge
// key-by-key. The only well-defined operation once a more specific scope
// expresses ANY opinion about a field's overlay is "this scope's overlay
// for this field wins entirely" — same precedent as mergeCurated (above)
// for the plain curated.model/curated.effort SELECTED value, just applied
// one level down at the {add,hide,order} bundle granularity instead of the
// scalar-value granularity.
//
// Mechanics: process scopes in precedence order; whichever scope defines an
// overlay for a given field (model/effort) LAST wins for that field, taken
// as-is (the whole {add,hide,order} object, not merged with an earlier
// scope's overlay for the same field). A scope with no opinion about a
// field (key absent, not merely empty) leaves an earlier scope's overlay
// for that field untouched — so a project overriding ONLY `effort` does not
// erase a global `model` overlay, exactly mirroring mergeCurated's
// per-key-spread behavior one level down.
function mergeCuratedOptions(
  layers: Array<HarnessCuratedOptionsSettings | undefined>
): HarnessCuratedOptionsSettings | undefined {
  let merged: HarnessCuratedOptionsSettings | undefined
  for (const layer of layers) {
    if (!layer) continue
    merged = { ...merged, ...layer }
  }
  return merged
}

/**
 * Resolve the effective settings by layering global -> project (later wins
 * per key). Missing rows at either scope resolve to `{}`, never a throw. The
 * returned args/env arrays have disabled rows already excluded — callers
 * building launch composition never need to filter again.
 *
 * Two scopes, not three: workspace scope was removed deliberately (see
 * HARNESS_SETTINGS_SCOPE in src/main/db/schema.ts). There is no vestigial
 * workspaceId parameter, because a parameter that silently does nothing is
 * worse than one that does not exist — a caller passing it would reasonably
 * expect a workspace layer to apply.
 */
export function resolveHarnessSettings(harnessId: string, projectId?: string): HarnessSettings {
  // The scope ids are OPTIONAL and each layer is skipped independently. The
  // global layer ALWAYS applies — it has no id to be missing — so a caller
  // with no project/workspace context still gets the user's global settings.
  //
  // This is deliberately owned here rather than by each caller: a caller that
  // guarded on `projectId && workspaceId` before calling would silently drop
  // the global layer entirely, composing a launch as though nothing were
  // configured. That failure is invisible — no error, just a bare invocation
  // and settings that appear saved in the UI but never take effect.
  const global = getHarnessSettings(harnessId, 'global')
  const project = projectId ? getHarnessSettings(harnessId, 'project', projectId) : {}

  const args = mergeRowsByKey([global.args, project.args])
  const env = mergeRowsByKey([global.env, project.env])
  const curated = mergeCurated([global.curated, project.curated])
  const curatedOptions = mergeCuratedOptions([global.curatedOptions, project.curatedOptions])
  const preLaunchSnippet = mergeScalar([global.preLaunchSnippet, project.preLaunchSnippet])
  const sourceZshrc = mergeScalar([global.sourceZshrc, project.sourceZshrc])

  const resolved: HarnessSettings = {}
  const resolvedArgs = enabledOnly(args)
  const resolvedEnv = enabledOnly(env)
  if (resolvedArgs) resolved.args = resolvedArgs
  if (resolvedEnv) resolved.env = resolvedEnv
  if (curated) resolved.curated = curated
  if (curatedOptions) resolved.curatedOptions = curatedOptions
  if (preLaunchSnippet !== undefined) resolved.preLaunchSnippet = preLaunchSnippet
  if (sourceZshrc !== undefined) resolved.sourceZshrc = sourceZshrc
  return resolved
}
