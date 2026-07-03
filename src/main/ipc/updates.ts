// ---------------------------------------------------------------------------
// src/main/ipc/updates.ts
//
// Updates + Claude-status IPC — moved verbatim out of index.ts (STR-1). Pure
// passthrough to ./updates and ./claudeStatus; closes over no index.ts state.
// ---------------------------------------------------------------------------

import { shell } from 'electron'
import { checkForUpdates, installUpdate, relaunchApp, getUpdateSnapshot } from '../updates'
import { getStatusSnapshot, refreshStatusNow } from '../claudeStatus'
import { handle } from './handle'

export function registerUpdatesIpc(): void {
  // ---------------------------------------------------------------------------
  // Updates IPC
  // ---------------------------------------------------------------------------

  handle('updates:check', () => checkForUpdates())
  handle('updates:install', () => {
    installUpdate()
  })
  handle('updates:restart', () => {
    relaunchApp()
  })
  handle('updates:getState', () => getUpdateSnapshot())

  // ---------------------------------------------------------------------------
  // Claude status IPC
  // ---------------------------------------------------------------------------

  handle('status:get', () => getStatusSnapshot())
  handle('status:refresh', async () => refreshStatusNow())
  handle('status:openPage', () => {
    shell.openExternal('https://status.claude.com').catch((err) => {
      console.warn('[status] openExternal failed:', err)
    })
  })
}
