// ---------------------------------------------------------------------------
// src/main/ipc/keepAwake.ts
//
// Keep Awake IPC — moved verbatim out of index.ts (STR-1). Pure passthrough
// to ./powerAwake; closes over no index.ts state.
// ---------------------------------------------------------------------------

import {
  getKeepAwakeState,
  setKeepAwakeMode,
  setKeepAwakeDisplayOn,
  startKeepAwakeTimer
} from '../powerAwake'
import { handle } from './handle'

export function registerKeepAwakeIpc(): void {
  handle('keepAwake:get', () => getKeepAwakeState())
  handle('keepAwake:setMode', (_e, mode) => setKeepAwakeMode(mode))
  handle('keepAwake:setDisplayOn', (_e, on) => setKeepAwakeDisplayOn(on))
  handle('keepAwake:startTimer', (_e, minutes) => startKeepAwakeTimer(minutes))
}
