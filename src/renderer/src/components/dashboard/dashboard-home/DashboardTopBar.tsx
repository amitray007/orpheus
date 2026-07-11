// ---------------------------------------------------------------------------
// DashboardTopBar — the greeting at the top of the Dashboard page. Time-of-day
// ONLY (no date, no counts, no live badge, per spec) computed from the current
// hour. The Dashboard is fixed to a 7-day window (see DashboardView) — that's
// deliberately NOT surfaced as a control in the UI, so there's no range picker
// here anymore.
// ---------------------------------------------------------------------------

import { greetingForHour } from './dashboardHome.helpers'

export function DashboardTopBar(): React.JSX.Element {
  const greeting = greetingForHour(new Date().getHours())

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="text-[15px] font-semibold tracking-tight text-text-primary">{greeting}</div>
    </div>
  )
}
