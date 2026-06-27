// ---------------------------------------------------------------------------
// Module-level stable empty maps (avoid new Map() on every render as fallback)
// ---------------------------------------------------------------------------

export const EMPTY_TITLE_MAP = new Map<string, string>()
export const EMPTY_MTIME_MAP = new Map<string, number>()

export function formatRelativeTime(epochMs: number | null, now: number): string {
  if (epochMs === null) return ''
  const ageMs = now - epochMs
  const sec = Math.floor(ageMs / 1000)
  if (sec < 60) return 'now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d`
  return `${Math.floor(day / 7)}w`
}
