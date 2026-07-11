// ---------------------------------------------------------------------------
// DashboardTopBar — V1 REBUILD: now renders ONLY the greeting (time-of-day +
// GitHub name, D4 — "Good morning, {name}"), sized up to ~26px to match
// dashboard-v3.html's `.hero .greet .hi` (27px). Bumped from the old 22px
// since the greeting used to anchor its own row; now it sits alongside the
// inline stats row inside DashboardView's `.hero` flex container, so it
// needs the extra visual weight to stay the clear anchor of that row. The
// inline stats themselves (Sessions/Tokens/Streak/Peak hour) moved OUT of
// this component and into DashboardView directly — this file no longer owns
// any layout beyond its own greeting text, so it doesn't need pulse data
// threaded through it.
//
// Name resolution is unchanged: computed from the current hour and the
// `githubUsername` persisted on app_ui_state, paints instantly from the
// shared uiState store (no fetch-on-mount flash), and is refreshed silently
// in the background on every app open via `github:refreshUsername`. The
// Dashboard is fixed to a 7-day window (see DashboardView) — deliberately
// NOT surfaced as a control here, so there's no range picker.
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
    <div className="text-[26px] leading-tight font-semibold tracking-tight text-text-primary">
      {greeting}
    </div>
  )
}
