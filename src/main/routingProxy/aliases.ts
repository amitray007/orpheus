// ---------------------------------------------------------------------------
// src/main/routingProxy/aliases.ts
//
// Model-name aliasing (model-routing unit 08). Persists a mapping from a
// Claude-facing model name (e.g. 'sonnet', 'claude-opus-4-8' — anything a
// subagent's frontmatter might pin) to a routed model on a specific
// provider, so a request for that Claude name on a routed workspace resolves
// on the proxy side instead of failing with "unknown provider for model X".
//
// THIS DOES NOT PROXY CLAUDE TRAFFIC. Aliases only affect requests the
// routing proxy ALREADY receives on a routed workspace (ANTHROPIC_BASE_URL
// already points at CLIProxyAPI) — computeRoutingEnv (modelRouting.ts) still
// returns {} for Claude models, Claude mounts still make zero proxy/health
// calls, and no Claude credential is ever written into this table or
// config.yaml. See config.ts's toCliProxyModelEntry — an alias entry is
// exactly `{name: <upstream model>, alias: <claude name>}` on the target
// provider's own block, nothing more.
//
// Deliberately imports getDb() directly, matching storage.ts's convention
// for main-process persistence modules in this codebase (see that module's
// own doc comment) — this makes the module electron-touching, which is why
// the actual config-emission gate (aliasesToProviderModels) lives in the
// SEPARATE electron-free aliasResolve.ts module instead (manager.ts imports
// it from there directly) — see that module's own doc comment for why the
// split exists. Not exercised by the offline verify-aliases.ts harness
// itself (DB behavior is covered by test:db).
// ---------------------------------------------------------------------------

import { getDb } from '../db'

export interface ModelAlias {
  /** The Claude-facing name a subagent (or the user) might pin — e.g.
   *  'sonnet', 'opus', 'claude-sonnet-5'. Free-text, not validated against
   *  CLAUDE_MODEL_OPTIONS at the storage layer (see schema.ts's doc comment
   *  on this column) — validated at the IPC layer instead. */
  claudeName: string
  enabled: boolean
  /** Provider id (routingProxy/providers/registry.ts) owning the target
   *  model, or null when not yet configured. */
  targetProviderId: string | null
  /** Upstream model id on that provider, or null when not yet configured. */
  targetModelId: string | null
  updatedAt: number
}

interface ModelAliasRow {
  claude_name: string
  enabled: number
  target_provider_id: string | null
  target_model_id: string | null
  updated_at: number
}

function rowToAlias(row: ModelAliasRow): ModelAlias {
  return {
    claudeName: row.claude_name,
    enabled: row.enabled === 1,
    targetProviderId: row.target_provider_id,
    targetModelId: row.target_model_id,
    updatedAt: row.updated_at
  }
}

/** Every stored alias, ordered by claude_name for deterministic output
 *  (mirrors storage.ts's listProviderConfigs ordering rationale). */
export function listModelAliases(): ModelAlias[] {
  const rows = getDb()
    .prepare(
      `SELECT claude_name, enabled, target_provider_id, target_model_id, updated_at
       FROM routing_proxy_model_aliases ORDER BY claude_name ASC`
    )
    .all() as ModelAliasRow[]
  return rows.map(rowToAlias)
}

/** Upsert one alias row (create or update). `targetProviderId`/`targetModelId`
 *  may be null to represent "not mapped yet" — renderProvidersYaml skips any
 *  alias that isn't fully configured (see config.ts). */
export function upsertModelAlias(
  claudeName: string,
  patch: {
    enabled?: boolean
    targetProviderId?: string | null
    targetModelId?: string | null
  }
): void {
  const db = getDb()
  const existing = db
    .prepare('SELECT claude_name FROM routing_proxy_model_aliases WHERE claude_name = ?')
    .get(claudeName) as { claude_name: string } | undefined
  const now = Date.now()

  if (existing) {
    const sets: string[] = ['updated_at = ?']
    const params: unknown[] = [now]
    if (patch.enabled !== undefined) {
      sets.push('enabled = ?')
      params.push(patch.enabled ? 1 : 0)
    }
    if (patch.targetProviderId !== undefined) {
      sets.push('target_provider_id = ?')
      params.push(patch.targetProviderId)
    }
    if (patch.targetModelId !== undefined) {
      sets.push('target_model_id = ?')
      params.push(patch.targetModelId)
    }
    params.push(claudeName)
    db.prepare(
      `UPDATE routing_proxy_model_aliases SET ${sets.join(', ')} WHERE claude_name = ?`
    ).run(...params)
    return
  }

  db.prepare(
    `INSERT INTO routing_proxy_model_aliases
       (claude_name, enabled, target_provider_id, target_model_id, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    claudeName,
    (patch.enabled ?? true) ? 1 : 0,
    patch.targetProviderId ?? null,
    patch.targetModelId ?? null,
    now
  )
}

/** Remove one alias row entirely (distinct from disabling it). */
export function deleteModelAlias(claudeName: string): void {
  getDb().prepare('DELETE FROM routing_proxy_model_aliases WHERE claude_name = ?').run(claudeName)
}

/** Replace every stored alias row with the given list in one transaction —
 *  used by the "Use defaults" action so it's one atomic write, not N. */
export function replaceModelAliases(aliases: ModelAlias[]): void {
  const db = getDb()
  const tx = db.transaction((entries: ModelAlias[]) => {
    db.prepare('DELETE FROM routing_proxy_model_aliases').run()
    const insert = db.prepare(
      `INSERT INTO routing_proxy_model_aliases
         (claude_name, enabled, target_provider_id, target_model_id, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    const now = Date.now()
    for (const a of entries) {
      insert.run(a.claudeName, a.enabled ? 1 : 0, a.targetProviderId, a.targetModelId, now)
    }
  })
  tx(aliases)
}
