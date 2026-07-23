// ---------------------------------------------------------------------------
// Shared constants, types and pure helpers for SessionsTab
// ---------------------------------------------------------------------------

// Full sessions view shows 20 per page; compact embedding (next to workspaces
// in the project view) shows fewer rows so the panel doesn't grow the page
// out of comfortable read height.
export const PAGE_SIZE_FULL = 20
export const PAGE_SIZE_COMPACT = 10

export const DATE_RANGE_OPTIONS = [
  { value: 'd1', label: 'Last 24h' },
  { value: 'd3', label: 'Last 3 days' },
  { value: 'd7', label: 'Last 7 days' },
  { value: 'd30', label: 'Last 30 days' },
  { value: 'd90', label: 'Last 90 days' },
  { value: 'all', label: 'All time' }
] as const

export type DateRange = (typeof DATE_RANGE_OPTIONS)[number]['value']

export type SortBy = 'updatedAt' | 'createdAt' | 'title'

export function dateRangeToFrom(range: DateRange): number | undefined {
  if (range === 'all') return undefined
  const day = 24 * 60 * 60 * 1000
  if (range === 'd1') return Date.now() - 1 * day
  if (range === 'd3') return Date.now() - 3 * day
  if (range === 'd7') return Date.now() - 7 * day
  if (range === 'd30') return Date.now() - 30 * day
  if (range === 'd90') return Date.now() - 90 * day
  return undefined
}

export function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  const s = Math.floor(diff / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  return `${mo}mo ago`
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// Model label rendering moved to src/renderer/src/lib/useModelLabels.ts,
// which resolves through the registry (src/main/models/registry.ts) via IPC
// instead of parsing the model id client-side — see that file's header for
// why the renderer must not compute model facts itself.
