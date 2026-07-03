// ---------------------------------------------------------------------------
// src/main/ipc/actions.ts
//
// Quick Actions registry IPC — moved verbatim out of index.ts (STR-1). Pure
// passthrough to ./actions/index (a leaf); closes over no index.ts state.
// actions:subscribe uses BrowserWindow.fromWebContents to scope its push
// updates to the requesting renderer window, same as other subscribe-style
// handlers elsewhere in the app.
// ---------------------------------------------------------------------------

import { BrowserWindow } from 'electron'
import {
  invoke as actionsInvoke,
  list as actionsList,
  getAuditHistory,
  startSubscription,
  stopSubscription
} from '../actions/index'
import type { ActionInvocation } from '../../shared/types'
import { PUSH_CHANNELS } from '../../shared/ipc'
import { handle } from './handle'

export function registerActionsIpc(): void {
  handle('actions:invoke', (_e, { actionId, params, workspaceId, consumerHint }) => {
    const invocation: ActionInvocation = { id: actionId, params, workspaceId }
    return actionsInvoke(invocation, consumerHint ?? 'ipc')
  })

  handle('actions:list', () => actionsList())

  handle('actions:history', (_e, { workspaceId, limit }) => getAuditHistory(workspaceId, limit))

  handle('actions:subscribe', (e, { subscriptionId, actionId, params, workspaceId }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    startSubscription(subscriptionId, actionId, params, workspaceId, (value) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send(PUSH_CHANNELS.actionsSubscriptionUpdate, { subscriptionId, value })
      }
    })
    return { ok: true as const }
  })

  handle('actions:unsubscribe', (_e, { subscriptionId }) => {
    stopSubscription(subscriptionId)
    return { ok: true as const }
  })
}
