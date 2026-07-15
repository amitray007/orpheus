import { getDb } from './db'
import { logDiagMain } from './diagnostics'
import { DIAG_EVENTS } from '../shared/diagEvents'
import type { ClaudePermissionMode, ClaudeEffort } from '../shared/types'
import { parseFlagEntry } from '../shared/cliFlags'

// ---------------------------------------------------------------------------
// Generic factory for the claude_{project,workspace}_settings tables.
//
// Both tables share an identical shape: a single-column id (project_id /
// workspace_id), an overrides_json blob, and an updated_at timestamp. This
// factory captures the shared get/update/cache-invalidate behavior so the
// two per-entity modules (claudeProjectSettings.ts, claudeWorkspaceSettings.ts)
// can be thin shims that bind it to their table + id column.
// ---------------------------------------------------------------------------

type BaseOverrides = {
  model?: string
  permissionMode?: ClaudePermissionMode
  effort?: ClaudeEffort
}

type BaseRecord<IdKey extends string, Overrides> = {
  [K in IdKey]: string
} & {
  overrides: Overrides
  updatedAt: number
}

const VALID_PERMISSION_MODES: ClaudePermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions'
]
const VALID_EFFORTS: ClaudeEffort[] = ['auto', 'low', 'medium', 'high', 'xhigh', 'max']

function validateBasePatch(patch: BaseOverrides): void {
  if (
    patch.permissionMode !== undefined &&
    !VALID_PERMISSION_MODES.includes(patch.permissionMode)
  ) {
    throw new Error(`Invalid permissionMode: ${patch.permissionMode}`)
  }
  if (patch.effort !== undefined && !VALID_EFFORTS.includes(patch.effort)) {
    throw new Error(`Invalid effort: ${patch.effort}`)
  }
  if (patch.model !== undefined && typeof patch.model !== 'string') {
    throw new Error('model must be a string')
  }
}

/**
 * Shared syntax-only validator for a customCliFlags string[] value — reused
 * by both the project overrides store's validateExtra (below, via
 * claudeProjectSettings.ts) and claudeSettings.ts's global-settings
 * validatePatch, so the "syntax only, never flag existence" rule (see the
 * design doc) lives in exactly one place. Every entry must parse via
 * parseFlagEntry; hidden/unknown flags always pass — only lexical errors
 * (unbalanced quote, empty entry, no leading '-') reject.
 */
export function validateCustomCliFlagsValue(v: unknown, errorPrefix: string): void {
  if (!Array.isArray(v) || !(v as unknown[]).every((item) => typeof item === 'string')) {
    throw new Error(`${errorPrefix}: customCliFlags must be a string[]`)
  }
  for (const entry of v as string[]) {
    const parsed = parseFlagEntry(entry)
    if ('error' in parsed) {
      throw new Error(
        `${errorPrefix}: customCliFlags entry "${entry}" is invalid — ${parsed.error}`
      )
    }
  }
}

export type OverridesStoreConfig<IdKey extends string, Overrides> = {
  /** Table name, e.g. 'claude_project_settings' */
  table: string
  /** Id column name, e.g. 'project_id' */
  idColumn: string
  /** Key used on the returned record object, e.g. 'projectId' */
  idKey: IdKey
  /**
   * Optional per-store validation for keys beyond the shared
   * {model, permissionMode, effort} trio, run AFTER validateBasePatch. This
   * is how a store adds its own scope-specific keys (e.g. the project store's
   * customCliFlags) WITHOUT loosening validateBasePatch, which stays shared
   * and unchanged — critically, the workspace store passes no validateExtra
   * and so keeps its current three-key-only validation exactly as before.
   */
  validateExtra?: (patch: Overrides) => void
}

export type OverridesStore<Overrides extends BaseOverrides, Record> = {
  get: (id: string) => Record
  update: (id: string, patch: Overrides) => Record
  invalidateCache: (id: string) => void
}

export function createOverridesStore<
  IdKey extends string,
  Overrides extends BaseOverrides,
  Record extends BaseRecord<IdKey, Overrides>
>(config: OverridesStoreConfig<IdKey, Overrides>): OverridesStore<Overrides, Record> {
  const { table, idColumn, idKey, validateExtra } = config

  type Row = { overrides_json: string; updated_at: number } & { [K in string]: unknown }

  function rowToRecord(id: string, row: Row): Record {
    let overrides = {} as Overrides
    try {
      const parsed: unknown = JSON.parse(row.overrides_json)
      if (parsed && typeof parsed === 'object') overrides = parsed as Overrides
    } catch (err) {
      // corrupt JSON; treat as empty
      logDiagMain({
        category: 'anomaly',
        level: 'warn',
        event: DIAG_EVENTS.OVERRIDES_PARSE_FAILED,
        message: 'corrupt overrides_json',
        data: { id, err: String(err) }
      })
    }
    return { [idKey]: id, overrides, updatedAt: row.updated_at } as unknown as Record
  }

  // -------------------------------------------------------------------------
  // Module-level cache — keyed by id. Invalidated on write.
  // -------------------------------------------------------------------------

  const cache = new Map<string, Record>()

  function invalidateCache(id: string): void {
    cache.delete(id)
  }

  function get(id: string): Record {
    const cached = cache.get(id)
    if (cached) return cached

    const db = getDb()
    const row = db.prepare(`SELECT * FROM ${table} WHERE ${idColumn} = ?`).get(id) as
      | Row
      | undefined
    const result = row
      ? rowToRecord(id, row)
      : ({ [idKey]: id, overrides: {}, updatedAt: 0 } as unknown as Record)
    cache.set(id, result)
    return result
  }

  function update(id: string, patch: Overrides): Record {
    validateBasePatch(patch)
    validateExtra?.(patch)

    const db = getDb()
    const existing = get(id)

    // Merge: explicit `undefined` or `null` in patch means "clear that override"
    const merged: Overrides = { ...existing.overrides }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === null) {
        delete merged[key as keyof Overrides]
      } else {
        ;(merged as globalThis.Record<string, unknown>)[key] = value
      }
    }

    const json = JSON.stringify(merged)
    const now = Date.now()
    db.prepare(
      `INSERT INTO ${table} (${idColumn}, overrides_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(${idColumn}) DO UPDATE SET overrides_json = excluded.overrides_json, updated_at = excluded.updated_at`
    ).run(id, json, now)

    // Invalidate cache so next read (recomputeDirty, terminal:mount) sees fresh data
    invalidateCache(id)
    return get(id)
  }

  return { get, update, invalidateCache }
}
