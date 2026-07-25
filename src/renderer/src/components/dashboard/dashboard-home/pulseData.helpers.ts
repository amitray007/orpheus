// Pure activity display helpers shared by Home pages.

export type { WeeklyActivityDay } from '@shared/types'

/** Format an hour-of-day (0-23) as a LOCALE-AWARE clock label, e.g. 22 -> "10
 *  PM" for a 12h-locale user, "22" for a 24h-locale one. Per the mockup's
 *  explicit note ("use toLocaleTimeString, not a hardcoded format") — this
 *  used to hand-roll AM/PM, which silently assumed every user runs a 12h
 *  clock; `toLocaleTimeString` instead follows the OS's actual 12h/24h
 *  preference. The hour is dropped into a throwaway local Date (this
 *  function only ever receives an hour-of-day integer, not a real date) and
 *  formatted with `hour: 'numeric'` only — no minute — matching the
 *  mockup's compact "11 PM" style. */
export function formatHour12(hour: number): string {
  return new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: 'numeric' })
}
