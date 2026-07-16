// ---------------------------------------------------------------------------
// src/main/ipc/claudeAgents.ts
//
// Claude Agents IPC (slash commands + subagents) — moved verbatim out of
// index.ts (STR-1). Pure passthrough to ./claudeAgents; closes over no
// index.ts state.
// ---------------------------------------------------------------------------

import {
  listSlashCommands,
  listSubagents,
  addSlashCommand,
  updateSlashCommand,
  deleteSlashCommand,
  addSubagent,
  updateSubagent,
  deleteSubagent
} from '../claudeAgents'
import { handle } from './handle'
import { assertManagedConfigPath } from './validate'

export function registerClaudeAgentsIpc(): void {
  handle('claudeAgents:listSlashCommands', () => listSlashCommands())
  handle('claudeAgents:listSubagents', () => listSubagents())

  handle('claudeAgents:addSlashCommand', (_e, draft) => addSlashCommand(draft))
  handle('claudeAgents:updateSlashCommand', (_e, args) => {
    assertManagedConfigPath(args.filePath, 'filePath')
    return updateSlashCommand(args.filePath, args.draft)
  })
  handle('claudeAgents:deleteSlashCommand', (_e, args) => {
    assertManagedConfigPath(args.filePath, 'filePath')
    return deleteSlashCommand(args.filePath)
  })

  handle('claudeAgents:addSubagent', (_e, draft) => addSubagent(draft))
  handle('claudeAgents:updateSubagent', (_e, args) => {
    assertManagedConfigPath(args.filePath, 'filePath')
    return updateSubagent(args.filePath, args.draft)
  })
  handle('claudeAgents:deleteSubagent', (_e, args) => {
    assertManagedConfigPath(args.filePath, 'filePath')
    return deleteSubagent(args.filePath)
  })
}
