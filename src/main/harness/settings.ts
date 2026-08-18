import { randomUUID } from 'node:crypto'
import { getDb } from '../db'

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

export type HarnessSettings = {
  args?: HarnessSettingRow[]
  env?: HarnessSettingRow[]
  curated?: HarnessCuratedSettings
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

  const resolved: HarnessSettings = {}
  const resolvedArgs = enabledOnly(args)
  const resolvedEnv = enabledOnly(env)
  if (resolvedArgs) resolved.args = resolvedArgs
  if (resolvedEnv) resolved.env = resolvedEnv
  if (curated) resolved.curated = curated
  return resolved
}
