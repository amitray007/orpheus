import { app, BrowserWindow } from 'electron'
import { getAppUiState } from './uiState'
import type {
  ClaudeStatusSnapshot,
  ClaudeStatusComponent,
  ClaudeStatusIncident,
  ClaudeStatusIndicator,
  ClaudeStatusComponentStatus
} from '../shared/types'
import { Notification } from 'electron'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_SUMMARY_URL = 'https://status.claude.com/api/v2/summary.json'

/** Component names whose status drives the top-bar chip color */
const WATCHED_COMPONENT_NAMES = ['Claude Code', 'Claude API (api.anthropic.com)'] as const

const FETCH_TIMEOUT_MS = 8_000
const INITIAL_DELAY_MS = 10_000

/** Allowed poll intervals (seconds). */
const VALID_INTERVALS_SEC = [300, 600, 900, 1800, 3600, 7200, 10800] as const
const DEFAULT_INTERVAL_SEC = 1800

function validateIntervalSec(sec: number | undefined): number {
  if (!sec) return DEFAULT_INTERVAL_SEC
  return (VALID_INTERVALS_SEC as readonly number[]).includes(sec) ? sec : DEFAULT_INTERVAL_SEC
}

// ---------------------------------------------------------------------------
// API shape (raw JSON from status.claude.com)
// ---------------------------------------------------------------------------

interface RawComponent {
  id: string
  name: string
  status: string
  updated_at: string
}

interface RawIncident {
  id: string
  name: string
  impact: string
  status: string
  updated_at: string
}

interface RawSummary {
  status?: { indicator?: string; description?: string }
  components?: RawComponent[]
  incidents?: RawIncident[]
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

function makePlaceholderSnapshot(isFetching: boolean): ClaudeStatusSnapshot {
  return {
    indicator: 'none',
    description: 'Checking Claude APIs',
    watchedIndicator: 'none',
    components: [],
    incidents: [],
    fetchedAt: null,
    fetchOk: false,
    isFetching
  }
}

let snapshot: ClaudeStatusSnapshot = makePlaceholderSnapshot(true)
let pollTimer: NodeJS.Timeout | null = null

/**
 * Flap protection: require two consecutive samples in a new state before
 * notifying. Keyed by component ID.
 */
const pendingTransitions = new Map<string, { indicator: ClaudeStatusIndicator; count: number }>()

/**
 * Dedup key set: tracks (componentId + indicator) pairs for which a
 * notification has already fired. Reset when the component recovers.
 */
const firedKeys = new Set<string>()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function focusMainWindow(): void {
  const wins = BrowserWindow.getAllWindows()
  const win = wins[0]
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * Map a raw status string to one of our known `ClaudeStatusComponentStatus` values.
 * Unknown strings fall back to 'operational'.
 */
function toComponentStatus(raw: string): ClaudeStatusComponentStatus {
  const known: ClaudeStatusComponentStatus[] = [
    'operational',
    'degraded_performance',
    'partial_outage',
    'major_outage',
    'under_maintenance'
  ]
  return (known.find((k) => k === raw) ?? 'operational') as ClaudeStatusComponentStatus
}

/**
 * Map a raw page indicator string to our `ClaudeStatusIndicator` union.
 */
function toIndicator(raw: string | undefined): ClaudeStatusIndicator {
  const known: ClaudeStatusIndicator[] = ['none', 'minor', 'major', 'critical', 'maintenance']
  return (known.find((k) => k === raw) ?? 'none') as ClaudeStatusIndicator
}

/**
 * Derive the worst `ClaudeStatusIndicator` from a component status.
 */
function componentStatusToIndicator(status: ClaudeStatusComponentStatus): ClaudeStatusIndicator {
  switch (status) {
    case 'operational':
      return 'none'
    case 'degraded_performance':
      return 'minor'
    case 'partial_outage':
      return 'major'
    case 'major_outage':
      return 'critical'
    case 'under_maintenance':
      return 'maintenance'
    default:
      return 'none'
  }
}

/** Severity order — higher index = worse. */
const SEVERITY: ClaudeStatusIndicator[] = ['none', 'maintenance', 'minor', 'major', 'critical']

function worstIndicator(a: ClaudeStatusIndicator, b: ClaudeStatusIndicator): ClaudeStatusIndicator {
  return SEVERITY.indexOf(a) >= SEVERITY.indexOf(b) ? a : b
}

function isOperational(indicator: ClaudeStatusIndicator): boolean {
  return indicator === 'none'
}

function indicatorLabel(indicator: ClaudeStatusIndicator): string {
  switch (indicator) {
    case 'none':
      return 'Operational'
    case 'minor':
      return 'Degraded performance'
    case 'major':
      return 'Partial outage'
    case 'critical':
      return 'Major outage'
    case 'maintenance':
      return 'Under maintenance'
    default:
      return 'Unknown'
  }
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export async function fetchStatusSnapshot(): Promise<ClaudeStatusSnapshot> {
  const version = app.getVersion()
  const res = await fetch(STATUS_SUMMARY_URL, {
    headers: { 'User-Agent': `Orpheus/${version} (status check)` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }

  const data = (await res.json()) as RawSummary

  const rawComponents: RawComponent[] = data.components ?? []
  const rawIncidents: RawIncident[] = data.incidents ?? []

  const components: ClaudeStatusComponent[] = rawComponents.map((c) => ({
    id: c.id,
    name: c.name,
    status: toComponentStatus(c.status),
    updatedAt: c.updated_at,
    watched: WATCHED_COMPONENT_NAMES.some((n) => n === c.name)
  }))

  const incidents: ClaudeStatusIncident[] = rawIncidents.map((i) => ({
    id: i.id,
    name: i.name,
    impact: (i.impact as ClaudeStatusIncident['impact']) ?? 'none',
    status: (i.status as ClaudeStatusIncident['status']) ?? 'investigating',
    updatedAt: i.updated_at
  }))

  // Derive the watched indicator (worst of the two watched components)
  let watchedIndicator: ClaudeStatusIndicator = 'none'
  for (const c of components) {
    if (c.watched) {
      watchedIndicator = worstIndicator(watchedIndicator, componentStatusToIndicator(c.status))
    }
  }

  return {
    indicator: toIndicator(data.status?.indicator),
    description: data.status?.description ?? 'Status unknown',
    watchedIndicator,
    components,
    incidents,
    fetchedAt: Date.now(),
    fetchOk: true,
    isFetching: false
  }
}

// ---------------------------------------------------------------------------
// Notification logic (flap-protected, mute-aware)
// ---------------------------------------------------------------------------

function maybeNotifyTransition(
  component: ClaudeStatusComponent,
  prevSnapshot: ClaudeStatusSnapshot | null
): void {
  const state = getAppUiState()
  if (state.muteStatusNotifications) return

  const newIndicator = componentStatusToIndicator(component.status)

  // Find the previous indicator for this component
  const prevComponent = prevSnapshot?.components.find((c) => c.id === component.id)
  const prevIndicator: ClaudeStatusIndicator = prevComponent
    ? componentStatusToIndicator(prevComponent.status)
    : 'none'

  if (newIndicator === prevIndicator) {
    // No change — clear any pending transition
    pendingTransitions.delete(component.id)
    return
  }

  // Flap protection: require two consecutive samples in the new state.
  // First sample establishes the candidate (count=1, no notify). Second
  // sample in the same state commits to notifying — we compare nextCount,
  // not the pre-increment pending.count, otherwise the guard fires on the
  // third sample instead of the second.
  const pending = pendingTransitions.get(component.id)
  if (!pending || pending.indicator !== newIndicator) {
    pendingTransitions.set(component.id, { indicator: newIndicator, count: 1 })
    return
  }
  const nextCount = pending.count + 1
  pendingTransitions.set(component.id, { indicator: newIndicator, count: nextCount })
  if (nextCount < 2) return

  // Clear pending — we're committing to notify (or not)
  pendingTransitions.delete(component.id)

  const dedupKey = `${component.id}:${newIndicator}`

  if (isOperational(newIndicator)) {
    // Recovery notification — only fire if we previously fired a degraded notif
    const anyPrior = Array.from(firedKeys).some((k) => k.startsWith(`${component.id}:`))
    if (!anyPrior) return
    // Clear all prior fired keys for this component
    for (const k of Array.from(firedKeys)) {
      if (k.startsWith(`${component.id}:`)) firedKeys.delete(k)
    }
    const notif = new Notification({
      title: 'Claude is back online',
      subtitle: component.name,
      body: 'Service has recovered.',
      silent: true
    })
    notif.on('click', () => focusMainWindow())
    notif.show()
    return
  }

  // Degraded / outage — skip if already fired for this key
  if (firedKeys.has(dedupKey)) return
  firedKeys.add(dedupKey)

  const notif = new Notification({
    title: `${component.name} · ${indicatorLabel(newIndicator)}`,
    subtitle: 'Claude Status',
    body: 'See status.claude.com for details.',
    silent: false
  })
  notif.on('click', () => focusMainWindow())
  notif.show()
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

async function runPoll(): Promise<void> {
  const prevSnapshot = snapshot

  // Mark as fetching and broadcast immediately so the chip flips to the spinner
  snapshot = { ...snapshot, isFetching: true }
  broadcast('status:change', snapshot)

  try {
    const fresh = await fetchStatusSnapshot()
    snapshot = fresh

    for (const c of fresh.components) {
      if (c.watched) {
        maybeNotifyTransition(c, prevSnapshot)
      }
    }

    broadcast('status:change', snapshot)
  } catch (err) {
    console.warn('[claudeStatus] fetch failed:', err)
    snapshot = { ...prevSnapshot, fetchOk: false, isFetching: false }
    broadcast('status:change', snapshot)
  }
}

function getPollIntervalMs(): number {
  try {
    const state = getAppUiState()
    return validateIntervalSec(state.statusPollIntervalSec) * 1_000
  } catch {
    return DEFAULT_INTERVAL_SEC * 1_000
  }
}

function scheduleNextPoll(): void {
  if (pollTimer !== null) return
  const delay = getPollIntervalMs()
  pollTimer = setTimeout(() => {
    pollTimer = null
    void runPoll().then(() => {
      scheduleNextPoll()
    })
  }, delay)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getStatusSnapshot(): ClaudeStatusSnapshot {
  return snapshot
}

// Window reference isn't needed today — broadcasts go via BrowserWindow.getAllWindows()
// inside runPoll(). Kept signature parameter-less; callers in index.ts can pass
// no args once they're updated.
export function startStatusPoller(): void {
  // First fetch after a short delay to not compete with critical-path boot
  pollTimer = setTimeout(() => {
    pollTimer = null
    void runPoll().then(() => {
      scheduleNextPoll()
    })
  }, INITIAL_DELAY_MS)
}

/**
 * Called when the user changes the poll interval — cancel the existing timer
 * and reschedule with the new value. No immediate fetch (use refreshStatusNow
 * for that).
 */
export function rescheduleStatusPoll(): void {
  if (pollTimer !== null) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
  scheduleNextPoll()
}

export function stopStatusPoller(): void {
  if (pollTimer !== null) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}

/**
 * Trigger an immediate out-of-schedule fetch and return the result.
 * Reschedules the regular loop from scratch after the fetch completes.
 */
export async function refreshStatusNow(): Promise<ClaudeStatusSnapshot> {
  if (pollTimer !== null) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
  await runPoll()
  scheduleNextPoll()
  return snapshot
}
