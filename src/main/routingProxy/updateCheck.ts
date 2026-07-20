// ---------------------------------------------------------------------------
// src/main/routingProxy/updateCheck.ts
//
// "Check for updates" for the managed proxy component — mirrors the shape of
// src/main/updates.ts's checkForUpdates/getUpdateSnapshot (current vs
// latest, availability, checkedAt/error), but the source of truth here is
// GitHub's releases API for router-for-me/CLIProxyAPI rather than the
// homebrew tap. This ONLY reports availability — it never auto-installs; a
// new version still requires an explicit install action (see manager.ts).
// ---------------------------------------------------------------------------

import { GITHUB_API_LATEST_RELEASE, PINNED_VERSION } from './constants'
import type { RoutingProxyUpdateCheckResult } from '../../shared/types'

export interface UpdateCheckDeps {
  fetchJson: (url: string) => Promise<unknown>
}

async function realFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(10_000)
  })
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`)
  return res.json()
}

export function defaultUpdateCheckDeps(): UpdateCheckDeps {
  return { fetchJson: realFetchJson }
}

function normalizeTag(tag: string): string {
  return tag.startsWith('v') ? tag.slice(1) : tag
}

/**
 * Compares the pinned/installed version against GitHub's latest release tag
 * for router-for-me/CLIProxyAPI. `current` defaults to the build-pinned
 * version but callers should pass the actually-installed version once known
 * (they may differ if the user installed an older pinned version from a
 * previous Orpheus build and hasn't reinstalled).
 */
export async function checkRoutingProxyUpdate(
  current: string = PINNED_VERSION,
  deps: UpdateCheckDeps = defaultUpdateCheckDeps()
): Promise<RoutingProxyUpdateCheckResult> {
  const checkedAt = Date.now()
  try {
    const data = (await deps.fetchJson(GITHUB_API_LATEST_RELEASE)) as { tag_name?: string }
    const latest = data.tag_name ? normalizeTag(data.tag_name) : null
    if (!latest) {
      return {
        current,
        latest: null,
        available: false,
        checkedAt,
        error: 'No tag_name in response'
      }
    }
    return { current, latest, available: latest !== current, checkedAt }
  } catch (err) {
    return {
      current,
      latest: null,
      available: false,
      checkedAt,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}
