import { logDiag } from '@/lib/diag'
import { DIAG_EVENTS } from '@shared/diagEvents'

// Input-gated freeze detection + auto-heal. Native pushes two monotonic counters:
//   inputTick — bumped on real terminal key/mouse input
//   liveTick  — bumped on every draw / IO wakeup (the render pipeline ran)
// Rule: if inputTick advanced but liveTick did NOT advance within CHECK_MS, the
// surface is frozen -> recovery ladder (kick -> remount). Healthy idle is never
// flagged (no input -> no check). Always runs; logDiag is gated by the anomaly
// category inside logDiag itself.

const CHECK_MS = 600

let activeWs: string | null = null
let requestRemountCb: (() => void) | null = null

let lastInputTick = 0
let lastLiveTick = 0
let lastOccluded = false

let armed = false
let armSnapshotLive = 0
let armTimer: ReturnType<typeof setTimeout> | null = null
let recovering = false
let armedAtMs = 0

export function setActiveWatchdogWorkspace(
  workspaceId: string | null,
  requestRemount: (() => void) | null
): void {
  activeWs = workspaceId
  requestRemountCb = requestRemount
  disarm()
}

function disarm(): void {
  armed = false
  if (armTimer) {
    clearTimeout(armTimer)
    armTimer = null
  }
}

function onLiveness(d: { inputTick: number; liveTick: number; occluded: boolean }): void {
  lastOccluded = d.occluded
  const inputAdvanced = d.inputTick > lastInputTick
  lastInputTick = d.inputTick
  lastLiveTick = d.liveTick

  if (inputAdvanced && activeWs && !armed && !recovering) {
    armed = true
    armSnapshotLive = d.liveTick
    armedAtMs = performance.now()
    if (armTimer) clearTimeout(armTimer)
    armTimer = setTimeout(checkFreeze, CHECK_MS)
  }
}

function checkFreeze(): void {
  armed = false
  armTimer = null
  if (!activeWs) return
  if (lastLiveTick > armSnapshotLive) return // pipeline responded -> healthy
  void recover(activeWs)
}

async function recover(ws: string): Promise<void> {
  recovering = true
  const snapshot = {
    inputTick: lastInputTick,
    liveTick: lastLiveTick,
    occluded: lastOccluded,
    msSinceArm: Math.round(performance.now() - armedAtMs)
  }
  logDiag({
    category: 'anomaly',
    level: 'warn',
    event: DIAG_EVENTS.TERMINAL_INPUT_STUCK,
    workspaceId: ws,
    message: 'input produced no render within window',
    data: snapshot
  })
  const t0 = performance.now()
  const liveBefore = lastLiveTick

  // L1 - kick (force-cycle focus/occlusion).
  try {
    await window.api.terminal.focus(ws)
  } catch {
    /* ignore */
  }
  await delay(CHECK_MS)
  if (lastLiveTick > liveBefore) {
    logDiag({
      category: 'anomaly',
      level: 'info',
      event: DIAG_EVENTS.TERMINAL_AUTO_RECOVERED,
      workspaceId: ws,
      data: { level: 1, recovered: true, msToRecover: Math.round(performance.now() - t0) }
    })
    recovering = false
    return
  }

  // L2 - re-mount (the manual "switch view and back" recovery, automated).
  const liveBeforeL2 = lastLiveTick
  try {
    requestRemountCb?.()
  } catch {
    /* ignore */
  }
  await delay(CHECK_MS * 2)
  const ok = lastLiveTick > liveBeforeL2
  logDiag({
    category: 'anomaly',
    level: ok ? 'info' : 'error',
    event: DIAG_EVENTS.TERMINAL_AUTO_RECOVERED,
    workspaceId: ws,
    data: { level: 2, recovered: ok, msToRecover: Math.round(performance.now() - t0) }
  })
  recovering = false
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

let subscribed = false
function ensureSubscribed(): void {
  if (subscribed) return
  subscribed = true
  try {
    window.api.terminal.onLiveness(onLiveness)
  } catch {
    /* ignore */
  }
}
ensureSubscribed()
