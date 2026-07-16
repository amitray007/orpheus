// ---------------------------------------------------------------------------
// src/main/ipc/claudeHooks.ts
//
// Claude Hooks (settings.json hook config, not Orpheus's own notify hooks)
// IPC — moved verbatim out of index.ts (STR-1). Pure passthrough to
// ./claudeHooks; closes over no index.ts state.
// ---------------------------------------------------------------------------

import { shell } from 'electron'
import { listClaudeHooks, addHook, updateHook, deleteHook } from '../claudeHooks'
import { handle } from './handle'
import { assertManagedConfigPath } from './validate'

export function registerClaudeHooksIpc(): void {
  handle('claudeHooks:list', () => listClaudeHooks())
  handle('claudeHooks:openFile', async (_e, { filePath }) => {
    assertManagedConfigPath(filePath, 'filePath')
    await shell.openPath(filePath)
  })
  handle('claudeHooks:add', (_e, draft) => addHook(draft))
  handle('claudeHooks:update', (_e, args) => {
    assertManagedConfigPath(args.filePath, 'filePath')
    return updateHook(args.filePath, args.event, args.matcherEntryIdx, args.hookIdx, args.draft)
  })
  handle('claudeHooks:delete', (_e, args) => {
    assertManagedConfigPath(args.filePath, 'filePath')
    return deleteHook(args.filePath, args.event, args.matcherEntryIdx, args.hookIdx)
  })
}
