// ---------------------------------------------------------------------------
// DashboardTopBar — the greeting at the top of the Dashboard page. Time-of-day
// PLUS the user's GitHub name (D4) — "Good morning, {name}" — computed from
// the current hour and the `githubUsername` persisted on app_ui_state. The
// name paints instantly from the shared uiState store (no fetch-on-mount
// flash) and is refreshed silently in the background on every app open via
// `github:refreshUsername`. The Dashboard is fixed to a 7-day window (see
// DashboardView) — that's deliberately NOT surfaced as a control in the UI,
// so there's no range picker here anymore.
// ---------------------------------------------------------------------------

import { useEffect } from 'react'
import { useUiState, updateUiState } from '@/lib/uiStateStore'
import { greetingWithName } from './dashboardHome.helpers'

export function DashboardTopBar(): React.JSX.Element {
  const uiState = useUiState()
  const greeting = greetingWithName(new Date().getHours(), uiState?.githubUsername ?? null)

  // Fire-and-forget background refresh, once per mount (i.e. once per app
  // open — DashboardTopBar mounts with the Dashboard). Silent: no loading
  // state, no skeleton. updateUiState locally patches the store with the
  // resolved name the moment it resolves, since this IPC handler has no
  // mainWindow ref to broadcast uiState:changed with (see
  // src/main/ipc/git.ts's github:refreshUsername handler doc comment) — a
  // null result (gh missing/unauth/network) leaves the stored name as-is.
  useEffect(() => {
    window.api.github
      .refreshUsername()
      .then((name) => {
        if (name) updateUiState({ githubUsername: name })
      })
      .catch(() => {
        // Total on the main side already (never rejects) — this catch is
        // just defensive against an unexpected IPC-layer failure.
      })
  }, [])

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="text-[22px] font-semibold tracking-tight text-text-primary">{greeting}</div>
    </div>
  )
}
