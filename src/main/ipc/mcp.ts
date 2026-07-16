// ---------------------------------------------------------------------------
// src/main/ipc/mcp.ts
//
// MCP server config IPC — moved verbatim out of index.ts (STR-1). Pure
// passthrough to ./mcp; closes over no index.ts state.
// ---------------------------------------------------------------------------

import { listMcpServers, addMcpServer, updateMcpServer, deleteMcpServer } from '../mcp'
import { handle } from './handle'
import { assertManagedConfigPath } from './validate'

export function registerMcpIpc(): void {
  handle('mcp:listServers', () => listMcpServers())
  handle('mcp:add', (_e, draft) => addMcpServer(draft))
  handle('mcp:update', (_e, args) => {
    assertManagedConfigPath(args.filePath, 'filePath')
    return updateMcpServer(args.filePath, args.oldName, args.draft)
  })
  handle('mcp:delete', (_e, args) => {
    assertManagedConfigPath(args.filePath, 'filePath')
    return deleteMcpServer(args.filePath, args.name)
  })
}
