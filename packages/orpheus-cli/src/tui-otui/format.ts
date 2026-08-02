/**
 * tui-otui/format.ts — small formatting helpers for the redesign's
 * right-aligned metadata column (age/activity) and detail pane.
 *
 * NEW in this redesign pass — the previous build never surfaced
 * `lastActivityAt` anywhere in the UI. Ghui's "right-aligned metadata"
 * device (docs/TUI_UI_REDESIGN.md point 5) is the reason this exists: age
 * needs a compact, single-column-width-budget rendering (`16d`, `3h`, `30s`)
 * to sit cleanly right-aligned in a narrow TextTable column.
 */

/** Compact relative age, e.g. "30s", "5m", "3h", "16d". Always <= 4 chars for
 * realistic values so it fits the narrow AGE column budget used at medium+
 * breakpoints. `null`/`undefined` (no activity recorded) renders as "-". */
export function formatAge(epochMs: number | null | undefined, nowMs: number = Date.now()): string {
  if (epochMs == null) return '-'
  const deltaMs = Math.max(0, nowMs - epochMs)
  const seconds = Math.floor(deltaMs / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

/** Fuller relative-age phrase for the wide detail pane ("30 seconds ago",
 * "16 days ago"), where there's room to spell it out. */
export function formatAgeLong(
  epochMs: number | null | undefined,
  nowMs: number = Date.now()
): string {
  if (epochMs == null) return 'no activity recorded'
  const deltaMs = Math.max(0, nowMs - epochMs)
  const seconds = Math.floor(deltaMs / 1000)
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'} ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
