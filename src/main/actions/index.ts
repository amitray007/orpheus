// ---------------------------------------------------------------------------
// actions/index.ts — Boot function that registers all Quick Actions primitives
//
// Call bootActions() once on app startup (before any IPC can fire) to
// populate the registry. All consumers (IPC handlers, subscriptions) then
// reach through registry.invoke() or registry.list().
//
// Terminal primitives (phase 1) are registered here so they're invoke-able
// via both actions.invoke() AND the direct IPC handlers in index.ts.
// The direct IPC handlers remain for backward compat — they call the same
// underlying functions; this registration adds the registry surface.
// ---------------------------------------------------------------------------

import { register } from './registry'
import type { ActionResult } from '../../shared/types'

// Session handlers
import { handleGetMeta, handleGetUsage, handleGetCost, handleGetLastTurn } from './session'

// Workspace handlers
import {
  handleFork,
  handleArchive,
  handleRename,
  handleDuplicate,
  handleGetActivityStatus
} from './workspace'

// Re-export registry + subscriptions for use by index.ts IPC handlers
export { invoke, list } from './registry'
export { getAuditHistory } from './audit'
export { startSubscription, stopSubscription, registerWebContentsCleanup } from './subscriptions'

// ---------------------------------------------------------------------------
// Terminal primitives adapter
//
// The phase-1 terminal handlers live in terminal.ts and receive the addon
// reference at call time (to avoid circular deps). We provide thin wrappers
// here that delegate through the loadTerminalAddon() path.
//
// These wrappers are intentionally limited: they are stub registrations that
// let actions.invoke('terminal.*') work for future callers. The direct IPC
// handlers in index.ts remain the primary path and continue to work unchanged.
// ---------------------------------------------------------------------------

let addonRef: {
  sendInput: (workspaceId: string, utf8Text: string) => boolean
  sendKeys: (
    workspaceId: string,
    keys: Array<{ keycode: number; mods?: number; action?: 'press' | 'release' | 'repeat' }>
  ) => boolean
} | null = null

/** Called from index.ts once the addon is loaded, to wire terminal actions. */
export function setTerminalAddonRef(addon: typeof addonRef): void {
  addonRef = addon
}

// ---------------------------------------------------------------------------
// bootActions — register all actions
// ---------------------------------------------------------------------------

export function bootActions(): void {
  // -------------------------------------------------------------------------
  // session.* — kind: query
  // -------------------------------------------------------------------------

  register({
    id: 'session.getMeta',
    kind: 'query',
    validate: (_p) => true, // no params required
    handler: handleGetMeta
  })

  register({
    id: 'session.getUsage',
    kind: 'query',
    validate: (_p) => true,
    handler: handleGetUsage
  })

  register({
    id: 'session.getCost',
    kind: 'query',
    validate: (_p) => true,
    handler: handleGetCost
  })

  register({
    id: 'session.getLastTurn',
    kind: 'query',
    validate: (_p) => true,
    handler: handleGetLastTurn
  })

  // -------------------------------------------------------------------------
  // workspace.* — kind: mutator
  // -------------------------------------------------------------------------

  register({
    id: 'workspace.fork',
    kind: 'mutator',
    validate: (p) => {
      if (p === null || typeof p !== 'object') return false
      const params = p as Record<string, unknown>
      if ('name' in params && params['name'] !== undefined && typeof params['name'] !== 'string')
        return false
      if (
        'worktree' in params &&
        params['worktree'] !== undefined &&
        typeof params['worktree'] !== 'boolean'
      )
        return false
      return true
    },
    handler: handleFork
  })

  register({
    id: 'workspace.archive',
    kind: 'mutator',
    validate: (_p) => true, // workspaceId from invocation, no params needed
    handler: handleArchive
  })

  register({
    id: 'workspace.rename',
    kind: 'mutator',
    validate: (p) => {
      if (p === null || typeof p !== 'object') return false
      const params = p as Record<string, unknown>
      return typeof params['name'] === 'string' && (params['name'] as string).trim() !== ''
    },
    handler: handleRename
  })

  register({
    id: 'workspace.duplicate',
    kind: 'mutator',
    validate: (p) => {
      if (p === null || typeof p !== 'object') return false
      const params = p as Record<string, unknown>
      if ('name' in params && params['name'] !== undefined && typeof params['name'] !== 'string')
        return false
      return true
    },
    handler: handleDuplicate
  })

  register({
    id: 'workspace.getActivityStatus',
    kind: 'query',
    validate: (_p) => true,
    handler: handleGetActivityStatus
  })

  // -------------------------------------------------------------------------
  // terminal.* — kind: mutator (phase-1 re-registration for registry surface)
  // These delegate through the addonRef set by setTerminalAddonRef().
  // -------------------------------------------------------------------------

  register({
    id: 'terminal.sendInput',
    kind: 'mutator',
    validate: (p) => {
      if (p === null || typeof p !== 'object') return false
      const params = p as Record<string, unknown>
      if (typeof params['text'] !== 'string') return false
      if (
        'submit' in params &&
        params['submit'] !== undefined &&
        typeof params['submit'] !== 'boolean'
      )
        return false
      return true
    },
    handler: async (params, workspaceId): Promise<ActionResult> => {
      if (!addonRef) return { ok: false, code: 'failed', error: 'Terminal addon not loaded' }
      const { sendInput, sendKeys } = await import('./terminal')
      const result = sendInput(addonRef, workspaceId, params['text'] as string)
      if (!result.ok) return result
      // When submit:true, follow the text with a real Return key event so
      // claude's input handler registers it as "submit" (not just a newline byte).
      // kVK_Return = 0x24 (macOS Carbon virtual keycode for Return).
      if (params['submit'] === true) {
        return sendKeys(addonRef, workspaceId, [{ keycode: 0x24, mods: 0 }])
      }
      return result
    }
  })

  register({
    id: 'terminal.sendKeys',
    kind: 'mutator',
    validate: (p) => {
      if (p === null || typeof p !== 'object') return false
      return Array.isArray((p as Record<string, unknown>)['keys'])
    },
    handler: async (params, workspaceId): Promise<ActionResult> => {
      if (!addonRef) return { ok: false, code: 'failed', error: 'Terminal addon not loaded' }
      const { sendKeys } = await import('./terminal')
      return sendKeys(
        addonRef,
        workspaceId,
        params['keys'] as Array<{
          keycode: number
          mods?: number
          action?: 'press' | 'release' | 'repeat'
        }>
      )
    }
  })

  register({
    id: 'terminal.submit',
    kind: 'mutator',
    validate: (_p) => true,
    handler: async (_params, workspaceId): Promise<ActionResult> => {
      if (!addonRef) return { ok: false, code: 'failed', error: 'Terminal addon not loaded' }
      const { submit } = await import('./terminal')
      return submit(addonRef, workspaceId)
    }
  })

  register({
    id: 'terminal.clearInput',
    kind: 'mutator',
    validate: (_p) => true,
    handler: async (_params, workspaceId): Promise<ActionResult> => {
      if (!addonRef) return { ok: false, code: 'failed', error: 'Terminal addon not loaded' }
      const { clearInput } = await import('./terminal')
      return clearInput(addonRef, workspaceId)
    }
  })

  register({
    id: 'terminal.canInject',
    kind: 'query',
    validate: (_p) => true,
    handler: async (_params, workspaceId): Promise<ActionResult<boolean>> => {
      const { canInject } = await import('./terminal')
      return { ok: true, value: canInject(workspaceId) }
    }
  })

  console.log('[actions] registered', 5 + 6, 'actions')
}
