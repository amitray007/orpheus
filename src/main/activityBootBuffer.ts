// ---------------------------------------------------------------------------
// Activity boot buffer — delivery-side fix for the "renderer wasn't ready
// yet" race that dropped a workspace's post-restart status dot.
//
// THE RACE THIS CLOSES: at boot, index.ts's onActivityBatch listener
// (activitySink.ts) calls webContents.send() as soon as the BrowserWindow
// OBJECT exists, but Electron drops any ipcRenderer.send() made before the
// renderer's JS has actually loaded, mounted React, and run its
// onActivityBatch subscription effect (Dashboard.tsx) — there is no queue on
// Electron's side. Reconcilers that dispatch a workspace's very first status
// of the boot (e.g. harness/codex/statusState.ts's synchronous initial
// `reconcile()`, fired moments after createWindow()) can therefore have
// their ONE broadcast for a workspace vanish into the void — and since
// orpheusNotify.ts's dedup (activityMap/lastBroadcastDetail) is now warm
// with that value, no later tick re-sends it. Net effect: a permanently
// missing status dot for any workspace whose status doesn't change again
// after boot.
//
// THE FIX (this module): buffer activity updates that arrive before the
// renderer is DEFINITELY ready (signalled by workbenchControl.ts's
// `control:rendererReady`, invoked from inside Dashboard.tsx's own mount
// effect — the most precise signal available, since it fires only after
// React has committed and the onActivityBatch listener is registered on the
// renderer side; did-finish-load is NOT enough, as it fires before that).
// Once ready fires, the buffered updates are merged (last-write-per-
// workspace wins, matching activitySink.ts's own pendingBatch coalescing)
// and handed back as one batch to flush. Everything staged AFTER ready
// passes straight through, unbuffered — this module never touches
// orpheusNotify.ts's dedup gates, it only fixes whether a value that dedup
// already decided to send actually reaches a listener that exists yet.
//
// RE-ARMABLE BY DESIGN: a later reload (dev HMR, or a real crash-recovery
// reload) flips the renderer back to not-ready — workbenchControl.ts already
// resets readyWebContentsId to null on 'did-start-loading'/'render-process-
// gone'/'destroyed', and index.ts's rendererWorkspaceOpenReady flag follows
// the same pattern for the workspace-open-request queue. A reloaded renderer
// hits the EXACT same "first observation after ready never reached a
// listener" gap for any workspace whose status hasn't changed since the
// reload (orpheusNotify's dedup is warm from before the reload, so nothing
// re-drives a broadcast). So this buffer supports being unarmed again via
// `reset()` and re-armed for a subsequent `markReady()` — it is NOT a
// one-shot-for-the-process's-whole-lifetime buffer.
//
// Kept as a plain, Electron-free, directly-callable class so
// scripts/verify-codex-status.ts can exercise the REAL merge/flush logic
// under `bun run`, per this repo's "assert behaviour, not source text" rule.
// ---------------------------------------------------------------------------

import type { ActivityUpdate } from './activitySink'

export class ActivityBootBuffer {
  private ready = false
  private readonly pending = new Map<string, ActivityUpdate>()

  /** True once markReady() has been called and not since reset(). */
  isReady(): boolean {
    return this.ready
  }

  /**
   * Route one update. Returns the update itself (to send immediately) when
   * the buffer is ready/passthrough, or null when it was buffered instead
   * (merged into `pending`, keyed by workspaceId — last write for a given
   * workspace wins, same coalescing semantics as activitySink.ts's own
   * pendingBatch).
   */
  stage(update: ActivityUpdate): ActivityUpdate | null {
    if (this.ready) return update
    this.pending.set(update.workspaceId, update)
    return null
  }

  /**
   * Flip into ready/passthrough mode and return every update buffered so
   * far, merged into one batch (insertion order, one entry per
   * workspaceId). Returns an empty array when nothing was buffered — the
   * caller should skip sending in that case rather than emit a no-op batch.
   * Idempotent: calling markReady() again while already ready returns [].
   */
  markReady(): ActivityUpdate[] {
    if (this.ready) return []
    this.ready = true
    const flushed = Array.from(this.pending.values())
    this.pending.clear()
    return flushed
  }

  /**
   * Unarm the buffer so subsequent stage() calls buffer again until the next
   * markReady() — for a renderer reload, not the initial boot case (which
   * only ever calls markReady() once). Also clears any stale pending entries
   * from before the reload, since a fresh renderer load will re-run its own
   * mount effects and doesn't need boot-buffered values from a previous
   * renderer instance.
   */
  reset(): void {
    this.ready = false
    this.pending.clear()
  }
}
