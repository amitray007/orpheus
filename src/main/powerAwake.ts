import { powerSaveBlocker, type BrowserWindow } from 'electron'
import { getDb } from './db'
import { onWorkspaceStatusChange, getAllWorkspaceStatuses } from './orpheusNotify'
import { PUSH_CHANNELS } from '../shared/ipc'
import type { KeepAwakeBaseMode, KeepAwakeMode, KeepAwakeState } from '../shared/types'

const RELEASE_GRACE_MS = 30_000

type BlockerType = 'prevent-app-suspension' | 'prevent-display-sleep'

// Persisted base preferences (mirrored to keep_awake_settings).
let baseMode: KeepAwakeBaseMode = 'auto'
let displayOn = false
let defaultTimerMinutes = 120

// Transient (never persisted) timer state.
let timerActive = false
let timerDeadline: number | null = null
let timerTimeout: ReturnType<typeof setTimeout> | null = null

// Blocker + grace state.
let blockerId: number | null = null
let blockerType: BlockerType | null = null
let releaseTimeout: ReturnType<typeof setTimeout> | null = null

// Wiring.
let getWindow: (() => BrowserWindow | null) | null = null
let unsubscribeStatus: (() => void) | null = null
let secondTick: ReturnType<typeof setInterval> | null = null

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function loadPersisted(): void {
  try {
    const row = getDb()
      .prepare('SELECT mode, display_on, timer_minutes FROM keep_awake_settings WHERE id = 1')
      .get() as { mode: KeepAwakeBaseMode; display_on: number; timer_minutes: number } | undefined
    if (row) {
      baseMode = row.mode
      displayOn = row.display_on === 1
      defaultTimerMinutes = row.timer_minutes
    }
  } catch (err) {
    console.error('[powerAwake] loadPersisted failed:', err)
  }
}

function savePersisted(): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO keep_awake_settings (id, mode, display_on, timer_minutes)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           mode = excluded.mode,
           display_on = excluded.display_on,
           timer_minutes = excluded.timer_minutes`
      )
      .run(baseMode, displayOn ? 1 : 0, defaultTimerMinutes)
  } catch (err) {
    console.error('[powerAwake] savePersisted failed:', err)
  }
}

// ---------------------------------------------------------------------------
// State computation
// ---------------------------------------------------------------------------

function countBusy(): number {
  let n = 0
  for (const s of getAllWorkspaceStatuses().values()) if (s === 'in_progress') n++
  return n
}

function effectiveMode(): KeepAwakeMode {
  return timerActive ? 'timer' : baseMode
}

function shouldHold(): boolean {
  if (timerActive) return true
  if (baseMode === 'on') return true
  if (baseMode === 'auto') return countBusy() > 0
  return false
}

function desiredType(): BlockerType {
  return displayOn ? 'prevent-display-sleep' : 'prevent-app-suspension'
}

function isHolding(): boolean {
  return blockerId !== null && powerSaveBlocker.isStarted(blockerId)
}

// ---------------------------------------------------------------------------
// Blocker control
// ---------------------------------------------------------------------------

function startBlocker(): void {
  const type = desiredType()
  if (isHolding()) {
    if (blockerType === type) return // already holding the right type
    powerSaveBlocker.stop(blockerId as number) // swap type with no gap
    blockerId = null
    blockerType = null
  }
  blockerId = powerSaveBlocker.start(type)
  blockerType = type
}

function stopBlocker(): void {
  if (isHolding()) powerSaveBlocker.stop(blockerId as number)
  blockerId = null
  blockerType = null
}

function clearReleaseTimer(): void {
  if (releaseTimeout) {
    clearTimeout(releaseTimeout)
    releaseTimeout = null
  }
}

// ---------------------------------------------------------------------------
// Reconcile — the single decision point
// ---------------------------------------------------------------------------

function reconcile(): void {
  if (shouldHold()) {
    clearReleaseTimer()
    startBlocker()
  } else if (isHolding() && baseMode === 'auto' && !timerActive) {
    // Auto just went idle — hold for the grace window before releasing.
    if (!releaseTimeout) {
      releaseTimeout = setTimeout(() => {
        releaseTimeout = null
        if (!shouldHold()) stopBlocker()
        broadcast()
      }, RELEASE_GRACE_MS)
    }
  } else {
    clearReleaseTimer()
    stopBlocker()
  }
  broadcast()
}

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------

function cancelTimer(): void {
  timerActive = false
  timerDeadline = null
  if (timerTimeout) {
    clearTimeout(timerTimeout)
    timerTimeout = null
  }
}

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

function getKeepAwakeState(): KeepAwakeState {
  return {
    mode: effectiveMode(),
    baseMode,
    keepDisplayOn: displayOn,
    isHolding: isHolding(),
    timerRemainingMs:
      timerActive && timerDeadline !== null ? Math.max(0, timerDeadline - Date.now()) : null,
    defaultTimerMinutes,
    busyCount: countBusy()
  }
}

function broadcast(): void {
  const win = getWindow?.()
  if (win && !win.isDestroyed())
    win.webContents.send(PUSH_CHANNELS.keepAwakeState, getKeepAwakeState())
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function setKeepAwakeMode(mode: KeepAwakeBaseMode): KeepAwakeState {
  baseMode = mode
  cancelTimer()
  savePersisted()
  reconcile()
  return getKeepAwakeState()
}

function setKeepAwakeDisplayOn(on: boolean): KeepAwakeState {
  displayOn = on
  savePersisted()
  reconcile() // swaps blocker type if currently holding
  return getKeepAwakeState()
}

function startKeepAwakeTimer(minutes: number): KeepAwakeState {
  defaultTimerMinutes = minutes
  timerActive = true
  timerDeadline = Date.now() + minutes * 60_000
  if (timerTimeout) clearTimeout(timerTimeout)
  timerTimeout = setTimeout(() => {
    cancelTimer()
    reconcile()
  }, minutes * 60_000)
  savePersisted() // persists defaultTimerMinutes; base mode untouched
  reconcile()
  return getKeepAwakeState()
}

function startPowerAwake(windowGetter: () => BrowserWindow | null): () => void {
  getWindow = windowGetter
  loadPersisted()
  unsubscribeStatus = onWorkspaceStatusChange(() => reconcile())
  // Refresh the UI countdown roughly every second while a timer runs.
  secondTick = setInterval(() => {
    if (timerActive) broadcast()
  }, 1000)
  reconcile()

  return () => {
    unsubscribeStatus?.()
    unsubscribeStatus = null
    cancelTimer()
    clearReleaseTimer()
    if (secondTick) {
      clearInterval(secondTick)
      secondTick = null
    }
    stopBlocker()
  }
}

export {
  startPowerAwake,
  getKeepAwakeState,
  setKeepAwakeMode,
  setKeepAwakeDisplayOn,
  startKeepAwakeTimer
}
