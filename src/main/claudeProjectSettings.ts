import { createOverridesStore } from './overridesStore'
import type { ClaudeProjectSettings, ClaudeProjectSettingsOverrides } from '../shared/types'

// ---------------------------------------------------------------------------
// Thin shim over the shared overridesStore factory, bound to
// claude_project_settings. See overridesStore.ts for the shared
// get/update/cache-invalidate implementation.
// ---------------------------------------------------------------------------

const store = createOverridesStore<
  'projectId',
  ClaudeProjectSettingsOverrides,
  ClaudeProjectSettings
>({
  table: 'claude_project_settings',
  idColumn: 'project_id',
  idKey: 'projectId'
})

export function invalidateClaudeProjectSettingsCache(projectId: string): void {
  store.invalidateCache(projectId)
}

export function getClaudeProjectSettings(projectId: string): ClaudeProjectSettings {
  return store.get(projectId)
}

export function updateClaudeProjectSettings(
  projectId: string,
  patch: ClaudeProjectSettingsOverrides
): ClaudeProjectSettings {
  return store.update(projectId, patch)
}
