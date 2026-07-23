// ---------------------------------------------------------------------------
// src/main/routingProxy/providers/storage.ts
//
// Persistence for per-provider configuration (unit C: storage). Two tables
// (see src/main/db/schema.ts): routing_proxy_providers (one row per
// configured provider) and routing_proxy_provider_api_keys (one row per
// stored credential entry, FK-cascaded on the parent). Row<->ProviderConfig
// mapping lives here so callers (IPC handlers, config.ts's caller in
// manager.ts) work with the typed ProviderConfig/ProviderApiKeyEntry shapes
// from providers/types.ts, never raw SQL rows.
//
// Deliberately imports getDb() directly (like powerAwake.ts /
// actions/audit.ts do) rather than taking a DB handle as a parameter —
// matches the existing convention for main-process persistence modules in
// this codebase. Not exercised by the offline verify-providers.ts harness
// (which is electron-free); DB behavior is covered by test:db instead.
// ---------------------------------------------------------------------------

import { getDb } from '../../db'
import type { ProviderApiKeyEntry, ProviderAuthMethod, ProviderConfig } from './types'

interface ProviderRow {
  provider_id: string
  enabled: number
  auth_method: ProviderAuthMethod
  base_url: string | null
  display_name: string | null
  prefix: string | null
  updated_at: number
}

interface ApiKeyRow {
  id: string
  provider_id: string
  api_key: string
  prefix: string | null
  base_url: string | null
  proxy_url: string | null
  disable_cooling: number
  models_json: string
  excluded_models_json: string
  sort_order: number
  created_at: number
}

function rowToApiKeyEntry(row: ApiKeyRow): ProviderApiKeyEntry {
  let models: ProviderApiKeyEntry['models']
  try {
    const parsed = JSON.parse(row.models_json) as unknown
    if (Array.isArray(parsed) && parsed.length > 0) models = parsed as ProviderApiKeyEntry['models']
  } catch {
    models = undefined
  }
  let excludedModels: string[] | undefined
  try {
    const parsed = JSON.parse(row.excluded_models_json) as unknown
    if (Array.isArray(parsed) && parsed.length > 0) excludedModels = parsed as string[]
  } catch {
    excludedModels = undefined
  }

  return {
    id: row.id,
    apiKey: row.api_key,
    prefix: row.prefix ?? undefined,
    baseUrl: row.base_url ?? undefined,
    proxyUrl: row.proxy_url ?? undefined,
    disableCooling: row.disable_cooling === 1 ? true : undefined,
    models,
    excludedModels
  }
}

/** Read every configured provider, each with its stored API-key entries
 *  attached in stored order. Ordered by provider_id for a deterministic,
 *  stable config.yaml generation order (see config.ts's renderProvidersYaml
 *  doc comment). */
export function listProviderConfigs(): ProviderConfig[] {
  const db = getDb()
  const providerRows = db
    .prepare(
      `SELECT provider_id, enabled, auth_method, base_url, display_name, prefix, updated_at
       FROM routing_proxy_providers ORDER BY provider_id ASC`
    )
    .all() as ProviderRow[]

  return providerRows.map((row) => {
    const keyRows = db
      .prepare(
        `SELECT id, provider_id, api_key, prefix, base_url, proxy_url, disable_cooling,
                models_json, excluded_models_json, sort_order, created_at
         FROM routing_proxy_provider_api_keys
         WHERE provider_id = ? ORDER BY sort_order ASC, created_at ASC`
      )
      .all(row.provider_id) as ApiKeyRow[]

    return {
      providerId: row.provider_id,
      enabled: row.enabled === 1,
      authMethod: row.auth_method,
      apiKeys: keyRows.map(rowToApiKeyEntry),
      baseUrl: row.base_url ?? undefined,
      displayName: row.display_name ?? undefined,
      prefix: row.prefix ?? undefined
    }
  })
}

export function getProviderConfig(providerId: string): ProviderConfig | null {
  return listProviderConfigs().find((p) => p.providerId === providerId) ?? null
}

/** Upsert a provider's top-level row (enabled/authMethod/baseUrl/...) —
 *  never touches its api-key rows (see replaceProviderApiKeys). */
export function upsertProviderRow(
  providerId: string,
  patch: Partial<Pick<ProviderConfig, 'enabled' | 'authMethod' | 'displayName' | 'prefix'>> & {
    /** `null` explicitly clears the stored base-url (distinct from
     *  `undefined`, which leaves it untouched). */
    baseUrl?: string | null
  }
): void {
  const db = getDb()
  const existing = db
    .prepare('SELECT provider_id FROM routing_proxy_providers WHERE provider_id = ?')
    .get(providerId) as { provider_id: string } | undefined

  const enabled = patch.enabled ?? false
  const authMethod = patch.authMethod ?? 'apiKey'
  const now = Date.now()

  if (existing) {
    const sets: string[] = ['updated_at = ?']
    const params: unknown[] = [now]
    if (patch.enabled !== undefined) {
      sets.push('enabled = ?')
      params.push(patch.enabled ? 1 : 0)
    }
    if (patch.authMethod !== undefined) {
      sets.push('auth_method = ?')
      params.push(patch.authMethod)
    }
    if (patch.baseUrl !== undefined) {
      sets.push('base_url = ?')
      params.push(patch.baseUrl)
    }
    if (patch.displayName !== undefined) {
      sets.push('display_name = ?')
      params.push(patch.displayName)
    }
    if (patch.prefix !== undefined) {
      sets.push('prefix = ?')
      params.push(patch.prefix)
    }
    params.push(providerId)
    db.prepare(`UPDATE routing_proxy_providers SET ${sets.join(', ')} WHERE provider_id = ?`).run(
      ...params
    )
    return
  }

  db.prepare(
    `INSERT INTO routing_proxy_providers
       (provider_id, enabled, auth_method, base_url, display_name, prefix, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    providerId,
    enabled ? 1 : 0,
    authMethod,
    patch.baseUrl ?? null,
    patch.displayName ?? null,
    patch.prefix ?? null,
    now
  )
}

/** Replace ALL api-key rows for a provider with the given list, in a single
 *  transaction (delete-then-insert — simplest correct semantics for "the UI
 *  saved this exact list"; entry count is always small, so this is cheap). */
export function replaceProviderApiKeys(providerId: string, keys: ProviderApiKeyEntry[]): void {
  const db = getDb()
  const tx = db.transaction((entries: ProviderApiKeyEntry[]) => {
    db.prepare('DELETE FROM routing_proxy_provider_api_keys WHERE provider_id = ?').run(providerId)
    const insert = db.prepare(
      `INSERT INTO routing_proxy_provider_api_keys
         (id, provider_id, api_key, prefix, base_url, proxy_url, disable_cooling,
          models_json, excluded_models_json, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    entries.forEach((entry, idx) => {
      insert.run(
        entry.id,
        providerId,
        entry.apiKey,
        entry.prefix ?? null,
        entry.baseUrl ?? null,
        entry.proxyUrl ?? null,
        entry.disableCooling ? 1 : 0,
        JSON.stringify(entry.models ?? []),
        JSON.stringify(entry.excludedModels ?? []),
        idx,
        Date.now()
      )
    })
  })
  tx(keys)
}

/** Remove a provider entirely (row + cascaded api-key rows). */
export function deleteProviderConfig(providerId: string): void {
  getDb().prepare('DELETE FROM routing_proxy_providers WHERE provider_id = ?').run(providerId)
}
