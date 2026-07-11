/**
 * Pure (non-React) helpers for the dashboard-home components. Kept in a
 * dedicated file (rather than alongside DashboardTopBar.tsx) so that file
 * only exports the component — required for Fast Refresh
 * (react-refresh/only-export-components).
 */

export type DashboardRange = 'all' | '30d' | '7d'

/** "Good morning" <12, "Good afternoon" <18, else "Good evening". */
export function greetingForHour(hour: number): string {
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}
