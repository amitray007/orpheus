import { createOverridesStore, validateCustomCliFlagsValue } from './overridesStore'
import type { ClaudeWorkspaceSettings, ClaudeWorkspaceSettingsOverrides } from '../shared/types'

// ---------------------------------------------------------------------------
// Thin shim over the shared overridesStore factory, bound to
// claude_workspace_settings. See overridesStore.ts for the shared
// get/update/cache-invalidate implementation.
//
// Like the project store, the workspace store adds customCliFlags on top of
// the shared {model, permissionMode, effort} trio (syntax-only, per the
// design doc) — workspace scope is the highest-precedence flag tier.
// ---------------------------------------------------------------------------

const store = createOverridesStore<
  'workspaceId',
  ClaudeWorkspaceSettingsOverrides,
  ClaudeWorkspaceSettings
>({
  table: 'claude_workspace_settings',
  idColumn: 'workspace_id',
  idKey: 'workspaceId',
  validateExtra: (patch) => {
    if ('customCliFlags' in patch && patch.customCliFlags != null) {
      validateCustomCliFlagsValue(patch.customCliFlags, 'claudeWorkspaceSettings')
    }
  }
})

export function invalidateClaudeWorkspaceSettingsCache(workspaceId: string): void {
  store.invalidateCache(workspaceId)
}

export function getClaudeWorkspaceSettings(workspaceId: string): ClaudeWorkspaceSettings {
  return store.get(workspaceId)
}

export function updateClaudeWorkspaceSettings(
  workspaceId: string,
  patch: ClaudeWorkspaceSettingsOverrides
): ClaudeWorkspaceSettings {
  return store.update(workspaceId, patch)
}
