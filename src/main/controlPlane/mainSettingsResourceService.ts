import { composeClaudeLaunch, getClaudeGlobalSettings } from '../claudeSettings'
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
import { createControlAuditStore } from './controlAudit'
import { SettingsResourceService } from './settingsResourceService'

export function createMainSettingsResourceService(): SettingsResourceService {
  return new SettingsResourceService({
    getWorkspace,
    getProject,
    getGlobalSettings: getClaudeGlobalSettings,
    getProjectSettings: getClaudeProjectSettings,
    getWorkspaceSettings: getClaudeWorkspaceSettings,
    composeLaunch: composeClaudeLaunch,
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
