// Closed vocabulary of diagnostic event keys. Use ONLY these as DiagEvent.event
// so `GROUP BY event` can find recurring problems without key drift.
// Phase 1 wires only the error.* keys; the rest are reserved for Phase 2.
export const DIAG_EVENTS = {
  // error (Phase 1)
  ERROR_UNCAUGHT: 'error.uncaught',
  ERROR_UNHANDLED_REJECTION: 'error.unhandled_rejection',
  ERROR_RENDERER: 'error.renderer',
  ERROR_NATIVE: 'error.native',
  ERROR_IPC_FAIL: 'error.ipc_fail',
  // lifecycle (Phase 2 — reserved)
  TERMINAL_MOUNT: 'terminal.mount',
  TERMINAL_HIDE: 'terminal.hide',
  TERMINAL_DESTROY: 'terminal.destroy',
  TERMINAL_REATTACH: 'terminal.reattach',
  TERMINAL_SURFACE_CREATED: 'terminal.surface_created',
  TERMINAL_FIRST_FRAME: 'terminal.first_frame',
  WORKSPACE_SWITCH: 'workspace.switch',
  WORKSPACE_ACTIVATE: 'workspace.activate',
  HOOK_ACTIVITY: 'hook.activity',
  // perf (Phase 2 — reserved)
  PERF_TERMINAL_MOUNT: 'perf.terminal_mount',
  PERF_WORKSPACE_SWITCH: 'perf.workspace_switch',
  PERF_IPC_ROUNDTRIP: 'perf.ipc_roundtrip',
  PERF_SLOW_OP: 'perf.slow_op',
  // anomaly (Phase 2 — reserved)
  TERMINAL_INPUT_STUCK: 'terminal.input_stuck',
  TERMINAL_FOCUS_RECLAIMED: 'terminal.focus_reclaimed',
  ACTIVITY_WATCHDOG_FIRED: 'activity.watchdog_fired',
  OVERLAY_RETRY: 'overlay.retry',
  OVERLAY_FALLBACK: 'overlay.fallback'
} as const

export type DiagEventKey = (typeof DIAG_EVENTS)[keyof typeof DIAG_EVENTS]
