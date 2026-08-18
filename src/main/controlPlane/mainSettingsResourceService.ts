import { getClaudeGlobalSettings } from '../claudeSettings'
import { getClaudeProjectSettings } from '../claudeProjectSettings'
import {
  getClaudeWorkspaceSettings,
  updateClaudeWorkspaceSettings
} from '../claudeWorkspaceSettings'
import { withReconciledEffort } from '../effortReconciliation'
import { recomputeDirty } from '../ipc/claudeSettings'
import { listProjectSlashCommands, listProjectSubagents } from '../claudeAgents'
import { listProjectClaudeHooks } from '../claudeHooks'
import { listProjectMcpServers } from '../mcp'
import { getWorkspace } from '../workspaces'
import { getProject } from '../projects'
import { isDirty } from '../workspaceResources'
import { getDb } from '../db'
import { resolveHarness } from '../harness/registry'
import { createControlAuditStore } from './controlAudit'
import { SettingsResourceService } from './settingsResourceService'

export function createMainSettingsResourceService(): SettingsResourceService {
  return new SettingsResourceService({
    getWorkspace,
    getProject,
    getGlobalSettings: getClaudeGlobalSettings,
    getProjectSettings: getClaudeProjectSettings,
    getWorkspaceSettings: getClaudeWorkspaceSettings,
    // resolveHarness never throws and falls back to the Claude descriptor
    // for a missing/unknown harnessId — see
    // SettingsResourceServiceDeps.composeHarnessLaunch's doc comment for why
    // this seam exists instead of settingsResourceService.ts importing
    // resolveHarness directly.
    composeHarnessLaunch: (harnessId, projectId, workspaceId) =>
      resolveHarness(harnessId).composeLaunch(projectId, workspaceId),
    updateWorkspaceSettings: updateClaudeWorkspaceSettings,
    reconcileEffort: withReconciledEffort,
    recomputeDirty,
    isDirty,
    listProjectMcpServers,
    listProjectHooks: listProjectClaudeHooks,
    listProjectSlashCommands,
    listProjectSubagents,
    audit: createControlAuditStore(getDb())
  })
}
