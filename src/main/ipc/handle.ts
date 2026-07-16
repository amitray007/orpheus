// ---------------------------------------------------------------------------
// src/main/ipc/handle.ts
//
// Diagnostics: typed IPC wrapper — times every handler, logs slow (>50ms) calls
// as PERF_IPC_ROUNDTRIP, captures and re-throws errors as ERROR_IPC_FAIL.
//
// Moved out of index.ts (STR-1 / C0) so every ipc/<domain>.ts module can
// import the same typed `handle()` without importing index.ts itself (that
// would create a circular dependency — index.ts is the one calling INTO
// domain modules, never the other way around).
// ---------------------------------------------------------------------------

import { ipcMain } from 'electron'
import { DIAG_EVENTS } from '../../shared/diagEvents'
import type { InvokeChannel, Req, Res } from '../../shared/ipc'
import { logDiagMain } from '../diagnostics'

// Every channel must be a key of InvokeChannelMap (src/shared/ipc.ts) — args
// and return type are checked against it. There is no permissive fallback:
// an unmapped channel is now a compile error (DUP-3 finalize, commit 3/3).
export function handle<C extends InvokeChannel>(
  channel: C,
  fn: (e: Electron.IpcMainInvokeEvent, ...args: Req<C>) => Res<C> | Promise<Res<C>>
): void {
  ipcMain.handle(channel, async (e, ...args) => {
    const start = Date.now()
    try {
      // The generic C collapses to a union across all channels inside this
      // shared implementation body — TS can't correlate `args` (unknown[]
      // from Electron's runtime signature) back to the specific `Req<C>`
      // tuple for whichever channel this particular registration is for.
      // The overload signature above is what actually enforces the
      // per-channel contract at every call site; this cast just satisfies
      // the implementation body, which is inherently untyped at this
      // boundary (the same widening the removed permissive overload used).
      const result = await fn(e, ...(args as Req<C>))
      const ms = Date.now() - start
      if (ms > 50) {
        logDiagMain({
          category: 'perf',
          level: 'info',
          event: DIAG_EVENTS.PERF_IPC_ROUNDTRIP,
          message: channel,
          durationMs: ms,
          data: { channel }
        })
      }
      return result
    } catch (err) {
      logDiagMain({
        category: 'error',
        level: 'error',
        event: DIAG_EVENTS.ERROR_IPC_FAIL,
        message: `${channel}: ${err instanceof Error ? err.message : String(err)}`,
        data: { channel, stack: err instanceof Error ? err.stack : null }
      })
      throw err
    }
  })
}
