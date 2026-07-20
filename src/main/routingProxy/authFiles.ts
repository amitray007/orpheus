// ---------------------------------------------------------------------------
// src/main/routingProxy/authFiles.ts
//
// Reads connected-account status from GET /v0/management/auth-files. This
// unit only DISPLAYS what's already connected — initiating a new OAuth login
// (auth-url + polling) is explicitly deferred to a later unit (see the
// module doc block at the bottom of manager.ts).
//
// Auth: Authorization: Bearer <managementSecret> (see lifecycle.ts). An
// empty secret makes every management route 404 (verified) — callers must
// have a real per-run secret before calling this.
// ---------------------------------------------------------------------------

import type { RoutingProxyAuthFile } from '../../shared/types'

export interface AuthFilesDeps {
  fetchJson: (url: string, headers: Record<string, string>) => Promise<unknown>
}

async function realFetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`)
  return res.json()
}

export function defaultAuthFilesDeps(): AuthFilesDeps {
  return { fetchJson: realFetchJson }
}

/** Normalize the management API's various status vocabularies down to ok/error/unknown. */
function normalizeHealth(raw: unknown): 'ok' | 'error' | 'unknown' {
  if (typeof raw === 'string') {
    const v = raw.toLowerCase()
    if (['ok', 'healthy', 'valid', 'active'].includes(v)) return 'ok'
    if (['error', 'invalid', 'expired', 'failed'].includes(v)) return 'error'
  }
  if (typeof raw === 'boolean') return raw ? 'ok' : 'error'
  return 'unknown'
}

/**
 * Fetch + normalize the auth-files list. Never throws — resolves to an empty
 * array on any network/parse failure (this is a display-only affordance;
 * a failure here shouldn't take down the whole Settings panel).
 */
export async function fetchRoutingProxyAuthFiles(
  baseUrl: string,
  managementSecret: string,
  deps: AuthFilesDeps = defaultAuthFilesDeps()
): Promise<RoutingProxyAuthFile[]> {
  try {
    const url = new URL('/v0/management/auth-files', baseUrl).toString()
    const data = await deps.fetchJson(url, { Authorization: `Bearer ${managementSecret}` })
    const list = Array.isArray(data)
      ? data
      : Array.isArray((data as { files?: unknown[] })?.files)
        ? (data as { files: unknown[] }).files
        : []
    return list.map((entry): RoutingProxyAuthFile => {
      const e = entry as Record<string, unknown>
      const provider =
        typeof e.provider === 'string'
          ? e.provider
          : typeof e.type === 'string'
            ? e.type
            : 'unknown'
      const label =
        typeof e.name === 'string'
          ? e.name
          : typeof e.file === 'string'
            ? e.file
            : typeof e.label === 'string'
              ? e.label
              : provider
      return { provider, label, health: normalizeHealth(e.status ?? e.health ?? e.valid) }
    })
  } catch {
    return []
  }
}
