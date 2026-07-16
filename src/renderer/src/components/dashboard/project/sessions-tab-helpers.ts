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

export function shortModel(model: string | null): string {
  if (!model) return '—'
  const m = model.toLowerCase()

  // Detect family first
  const isOpus = m.includes('opus')
  const isSonnet = m.includes('sonnet')
  const isHaiku = m.includes('haiku')
  const isFable = m.includes('fable')
  if (!isOpus && !isSonnet && !isHaiku && !isFable) return model

  const family = isOpus ? 'Opus' : isSonnet ? 'Sonnet' : isHaiku ? 'Haiku' : 'Fable'

  // Extract version numbers from patterns like:
  //   "claude-opus-4-7"    → "4.7"
  //   "claude-sonnet-4-6"  → "4.6"
  //   "claude-haiku-4-5"   → "4.5"
  //   "opus" / "sonnet"    → "" (alias, add "(latest)" suffix)
  //
  // Family aliases (no digits) → show with "(latest)" marker.
  // Date-stamped IDs like "claude-sonnet-4-6-20260416" → "Sonnet 4.6"
  const stripped = m
    .replace(/^claude-/, '')
    .replace(/(opus|sonnet|haiku|fable)-?/, '')
    .replace(/-\d{8}$/, '') // strip trailing date stamp (e.g. 20260416)
    .trim()

  // After stripping the family name, remaining segments are the version
  // e.g. "4-7" → "4.7"
  const versionParts = stripped.split('-').filter((p) => /^\d+$/.test(p))
  if (versionParts.length >= 2) {
    return `${family} ${versionParts.join('.')}`
  }
  if (versionParts.length === 1) {
    return `${family} ${versionParts[0]}`
  }

  // Pure alias (e.g. model = "opus", "sonnet", "haiku")
  return `${family}*`
}
