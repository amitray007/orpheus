// ---------------------------------------------------------------------------
// actions/terminal.ts — Quick Actions phase 1: terminal interaction primitives
//
// Exposes five operations:
//   sendInput    — write UTF-8 text into a workspace's PTY
//   sendKeys     — send one or more synthetic key events
//   submit       — sugar: sendInput("\r")
//   clearInput   — sugar: sendKeys with Ctrl-U (clears the line)
//   canInject    — true only when the workspace is idle or awaiting_input
//
// All mutating functions guard on canInject() first.  When the workspace is
// busy they return { ok: false, code: 'busy' } without queuing anything.
//
// Threading: the NAPI addon exposes synchronous functions that must be called
// on the main thread.  Electron's ipcMain handlers already run on the main
// thread, so no additional dispatch is needed here.
// ---------------------------------------------------------------------------

import { getWorkspaceActivity } from '../orpheusNotify'
import type { ActionResult, TerminalSendKeyDescriptor } from '../../shared/types'

// ---------------------------------------------------------------------------
// Addon access — lazy to mirror the pattern in index.ts.
// We can't import loadTerminalAddon() directly (it's not exported from
// index.ts), so we accept the addon reference as a parameter.  The IPC
// handlers in index.ts pass it in at call time, keeping this module free of
// circular dependencies.
//
// All public exports accept an `addon` parameter typed as the minimal slice
// they need.  index.ts passes the full GhosttyNativeAddon.
// ---------------------------------------------------------------------------

type SendInputFn = (workspaceId: string, utf8Text: string) => boolean
type SendKeysFn = (
  workspaceId: string,
  keys: Array<{ keycode: number; mods?: number; action?: 'press' | 'release' | 'repeat' }>
) => boolean

type TerminalAddonSlice = {
  sendInput: SendInputFn
  sendKeys: SendKeysFn
}

type DestroyFn = (workspaceId: string) => void
type DestroyAddonSlice = { destroy: DestroyFn }

// ---------------------------------------------------------------------------
// macOS virtual key codes and modifiers.
// kVK_ANSI_U = 0x20 (Ctrl-U: clear line)
// kVK_ANSI_C = 0x08 (Ctrl-C: cancel / interrupt)
// GHOSTTY_MODS_CTRL = 1 << 1 = 2
// ---------------------------------------------------------------------------
const VKEY_U = 0x20
const VKEY_C = 0x08

// ghostty_input_mods_e bit for Control (GHOSTTY_MODS_CTRL = 1 << 1 = 2).
const MODS_CTRL = 2

// ---------------------------------------------------------------------------
// canInject — checks the live workspace activity status.
// Returns true only for 'idle' and 'awaiting_input'; rejects 'in_progress',
// 'attention', and 'archived'.
// ---------------------------------------------------------------------------
export function canInject(workspaceId: string): boolean {
  const status = getWorkspaceActivity(workspaceId)
  return status === 'idle' || status === 'awaiting_input'
}

// ---------------------------------------------------------------------------
// sendInput — write raw UTF-8 text into the workspace's PTY.
// ---------------------------------------------------------------------------
export function sendInput(
  addon: TerminalAddonSlice,
  workspaceId: string,
  text: string
): ActionResult {
  if (!canInject(workspaceId)) {
    return { ok: false, code: 'busy', error: 'Workspace is busy' }
  }
  try {
    const ok = addon.sendInput(workspaceId, text)
    if (!ok) {
      return { ok: false, code: 'not_found', error: 'No terminal surface for workspace' }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, code: 'failed', error: String(err) }
  }
}

// ---------------------------------------------------------------------------
// sendKeys — synthesise one or more key events.
// ---------------------------------------------------------------------------
export function sendKeys(
  addon: TerminalAddonSlice,
  workspaceId: string,
  keys: TerminalSendKeyDescriptor[]
): ActionResult {
  if (!canInject(workspaceId)) {
    return { ok: false, code: 'busy', error: 'Workspace is busy' }
  }
  try {
    const ok = addon.sendKeys(workspaceId, keys)
    if (!ok) {
      return { ok: false, code: 'not_found', error: 'No terminal surface for workspace' }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, code: 'failed', error: String(err) }
  }
}

// ---------------------------------------------------------------------------
// submit — send a carriage-return to confirm the current prompt line.
// ---------------------------------------------------------------------------
export function submit(addon: TerminalAddonSlice, workspaceId: string): ActionResult {
  return sendInput(addon, workspaceId, '\r')
}

// ---------------------------------------------------------------------------
// clearInput — Ctrl-U: clear the current input line (readline / zsh / bash).
// Sends a single key event with keycode=kVK_ANSI_U and mods=CTRL.
// ---------------------------------------------------------------------------
export function clearInput(addon: TerminalAddonSlice, workspaceId: string): ActionResult {
  return sendKeys(addon, workspaceId, [{ keycode: VKEY_U, mods: MODS_CTRL, action: 'press' }])
}

// ---------------------------------------------------------------------------
// destroyTerminalSurface — tear down a workspace's libghostty surface.
// Safe to call even if the surface was never mounted; errors are swallowed.
// Used by workspace.archive to ensure the NSView is freed before the DB row
// is deleted.
// ---------------------------------------------------------------------------
export function destroyTerminalSurface(addon: DestroyAddonSlice, workspaceId: string): void {
  try {
    addon.destroy(workspaceId)
  } catch {
    // Surface was never mounted or already destroyed — ignore.
  }
}

// ---------------------------------------------------------------------------
// cancel — Ctrl-C: interrupt the running process / cancel input.
// Sends a single key event with keycode=kVK_ANSI_C and mods=CTRL.
// Unlike clearInput, cancel does NOT guard on canInject() — it should work
// even when the workspace is busy (that's precisely when you want to cancel).
// ---------------------------------------------------------------------------
export function cancel(addon: TerminalAddonSlice, workspaceId: string): ActionResult {
  try {
    const ok = addon.sendKeys(workspaceId, [{ keycode: VKEY_C, mods: MODS_CTRL, action: 'press' }])
    if (!ok) {
      return { ok: false, code: 'not_found', error: 'No terminal surface for workspace' }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, code: 'failed', error: String(err) }
  }
}
