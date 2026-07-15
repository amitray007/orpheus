import { createOverridesStore, validateCustomCliFlagsValue } from './overridesStore'
import type { ClaudeProjectSettings, ClaudeProjectSettingsOverrides } from '../shared/types'

// ---------------------------------------------------------------------------
// Thin shim over the shared overridesStore factory, bound to
// claude_project_settings. See overridesStore.ts for the shared
// get/update/cache-invalidate implementation.
//
// The project store is the ONLY overridesStore consumer that passes
// validateExtra — it adds customCliFlags on top of the shared
// {model, permissionMode, effort} trio (syntax-only, per the design doc).
// The workspace store (claudeWorkspaceSettings.ts) passes none, so it keeps
// its current three-key-only validation exactly as before.
// ---------------------------------------------------------------------------

const store = createOverridesStore<
  'projectId',
  ClaudeProjectSettingsOverrides,
  ClaudeProjectSettings
>({
  table: 'claude_project_settings',
  idColumn: 'project_id',
  idKey: 'projectId',
  validateExtra: (patch) => {
    if ('customCliFlags' in patch) {
      validateCustomCliFlagsValue(patch.customCliFlags, 'claudeProjectSettings')
    }
  }
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
