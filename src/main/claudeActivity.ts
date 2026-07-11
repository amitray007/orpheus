// ---------------------------------------------------------------------------
// src/main/claudeActivity.ts
//
// Dashboard "pulse" real-activity scanner — the counterpart to
// src/main/claudeUsage.ts, but for SESSION VOLUME rather than rate limits.
//
// `sessions:listAll` (src/main/sessions.ts) only covers Orpheus-registered
// workspace sessions, which is a tiny slice of a user's real Claude usage —
// every `claude` invocation anywhere (any terminal, any project, resumed or
// not) writes a `.jsonl` transcript under `~/.claude/projects/<encoded-cwd>/`
// regardless of whether Orpheus ever saw it. This module scans that on-disk
// store directly so the Dashboard's "Your pulse" numbers reflect the user's
// ACTUAL Claude activity, not just the fraction routed through Orpheus.
//
// GROUND TRUTH (verified against a real ~/.claude/projects tree):
//   - One `.jsonl` file == one session. The filename (minus `.jsonl`) is the
//     session id; we don't need it for the summary, just the file's stat.
//   - A session's "activity day" is the file's mtime — NOT anything parsed
//     from its content. This is deliberate: mtime is a single cheap
//     `fs.stat` per file, while parsing content to find a timestamp would
//     mean reading (and JSON-parsing every line of) 4000+ files just to
//     bucket them by day.
//   - "Messages" for a session is its LINE COUNT — one JSONL line per
//     event/message. This DOES require reading the file, so it's the one
//     expensive part of a scan, and the one thing we cache hard (below).
//   - "Tokens" for a session is the sum, across every line whose
//     `message.usage` object is present (assistant turns), of
//     input_tokens + output_tokens + cache_read_input_tokens +
//     cache_creation_input_tokens — i.e. every token actually
//     billed/consumed for that turn, cache reads and writes included. Since
//     computing this needs the same per-line read as the line count, both
//     are derived in ONE pass over the file (see readFileStats).
//
// PERFORMANCE + CACHING (the load-bearing constraint — this repo has 4000+
// transcript files today and will only grow):
//   - Enumeration (readdir + stat) is cheap even at this scale and is
//     re-done on every scan — no need to cache directory listings.
//   - Line counts + token totals are the expensive part, so both are cached
//     per file keyed by (path, mtimeMs, size): a file is only re-read when
//     its mtime OR size has changed since the last scan. The cache itself
//     is persisted to the `dashboard_cache` table (D1 infra) under
//     DASHBOARD_CACHE_KEYS.claudeActivity, alongside the rolled-up summary,
//     so a cold app restart doesn't have to re-read every file — only the
//     ones that changed (or are new) since the last successful scan.
//   - A module-level in-flight promise single-flights concurrent scans
//     (mirrors claudeUsage.ts's inflight dedup) so e.g. the initial IPC call
//     racing the boot-time poller tick doesn't do the work twice.
//
// Total contract: NEVER throws. Any unreadable file, torn read, missing
// project dir, or corrupt cache entry is skipped/ignored rather than
// propagated — a single bad transcript can't break the whole Dashboard.
// ---------------------------------------------------------------------------

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { DASHBOARD_CACHE_KEYS, readDashboardCache, writeDashboardCache } from './db/dashboardCache'
import type { ClaudeActivitySummary, WeeklyActivityDay } from '../shared/types'

const DAY_MS = 24 * 60 * 60 * 1000
const LAST_7_DAYS_MS = 7 * DAY_MS

/** Same override `claude` itself and claudeUsage.ts respect — lets a
 *  user running Claude Code out of a non-default config dir still get
 *  accurate pulse numbers. Falls back to `~/.claude`. */
function claudeConfigDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR
  return configDir ? configDir : path.join(os.homedir(), '.claude')
}

function claudeProjectsRoot(): string {
  return path.join(claudeConfigDir(), 'projects')
}

// ---------------------------------------------------------------------------
// Per-file line-count + token-total cache — keyed by absolute path,
// invalidated by (mtimeMs, size). Persisted alongside the summary so a
// restart only has to re-read files that actually changed.
// ---------------------------------------------------------------------------
type FileCacheEntry = { mtimeMs: number; size: number; lineCount: number; tokenTotal: number }
type FileCache = Record<string, FileCacheEntry>

type PersistedActivity = {
  summary: ClaudeActivitySummary
  fileCache: FileCache
}

let fileCache: FileCache = {}
let fileCacheLoaded = false

/** Lazily hydrates the in-memory file cache from disk on first use — avoids
 *  a synchronous DB read at module-load time (before the DB may even be
 *  ready). Never throws; a corrupt/missing cache just starts empty. */
function ensureFileCacheLoaded(): void {
  if (fileCacheLoaded) return
  fileCacheLoaded = true
  try {
    const cached = readDashboardCache<PersistedActivity>(DASHBOARD_CACHE_KEYS.claudeActivity)
    if (cached?.value.fileCache) fileCache = cached.value.fileCache
  } catch {
    // Total — fall through with an empty cache, equivalent to "first ever scan".
  }
}

/** Shape of the one `message.usage` field we care about — tolerant of the
 *  many other fields (server_tool_use, cache_creation, iterations, ...)
 *  Claude's own transcript format carries; we only read the four token
 *  counters that make up a turn's real token cost. */
type RawUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** Sums the four token counters for one usage object, treating any
 *  missing/non-numeric field as 0. Never throws. */
function sumUsageTokens(usage: RawUsage): number {
  const n = (v: unknown): number => (typeof v === 'number' ? v : 0)
  return (
    n(usage.input_tokens) +
    n(usage.output_tokens) +
    n(usage.cache_read_input_tokens) +
    n(usage.cache_creation_input_tokens)
  )
}

/** Extracts the token total from one JSONL line if it carries a
 *  `message.usage` object (assistant turns only) — 0 for every other line
 *  shape (user turns, tool results, meta lines, ...). Defensive: a line
 *  that isn't valid JSON, or whose shape doesn't match, contributes 0
 *  rather than throwing. */
function tokensForLine(line: string): number {
  if (!line) return 0
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed !== 'object' || parsed === null) return 0
    const message = (parsed as { message?: unknown }).message
    if (typeof message !== 'object' || message === null) return 0
    const usage = (message as { usage?: RawUsage }).usage
    if (typeof usage !== 'object' || usage === null) return 0
    return sumUsageTokens(usage)
  } catch {
    return 0
  }
}

type LineScanResult = { lineCount: number; tokenTotal: number }

/** Streams a `.jsonl` file ONCE, counting lines and summing per-line token
 *  usage in the same pass (avoids buffering the whole file, and avoids a
 *  second read just for tokens). A trailing partial line (no final
 *  newline) still counts as one more message. Returns zeros on any read
 *  failure — total, never throws. */
async function readFileStats(filePath: string): Promise<LineScanResult> {
  return new Promise((resolve) => {
    let lineCount = 0
    let tokenTotal = 0
    let carry = ''
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
    stream.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      carry += text
      let newlineIdx = carry.indexOf('\n')
      while (newlineIdx !== -1) {
        const line = carry.slice(0, newlineIdx)
        lineCount++
        tokenTotal += tokensForLine(line)
        carry = carry.slice(newlineIdx + 1)
        newlineIdx = carry.indexOf('\n')
      }
    })
    stream.on('end', () => {
      if (carry.length > 0) {
        lineCount++
        tokenTotal += tokensForLine(carry)
      }
      resolve({ lineCount, tokenTotal })
    })
    stream.on('error', () => resolve({ lineCount: 0, tokenTotal: 0 }))
  })
}

type ScannedFile = { mtimeMs: number; lineCount: number; tokenTotal: number }

/** Resolves the line count + token total for one `.jsonl` file, re-reading
 *  only when the cached (mtime, size) no longer matches the file's current
 *  stat. Mutates the shared `fileCache` in place; skipped (unreadable)
 *  files resolve to null rather than throwing. */
async function scanOneFile(filePath: string): Promise<ScannedFile | null> {
  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(filePath)
  } catch {
    return null
  }

  // `typeof cached.tokenTotal === 'number'` guards against a cache entry
  // persisted by an older version of this module (before tokenTotal
  // existed) — such an entry would have mtime/size still match but
  // tokenTotal undefined, which would silently NaN the token roll-up. A
  // stale-shaped entry falls through to a real re-read below.
  const cached = fileCache[filePath]
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size &&
    typeof cached.tokenTotal === 'number'
  ) {
    return { mtimeMs: stat.mtimeMs, lineCount: cached.lineCount, tokenTotal: cached.tokenTotal }
  }

  const { lineCount, tokenTotal } = await readFileStats(filePath)
  fileCache[filePath] = { mtimeMs: stat.mtimeMs, size: stat.size, lineCount, tokenTotal }
  return { mtimeMs: stat.mtimeMs, lineCount, tokenTotal }
}

/** Recursively collects every `.jsonl` file under `dirPath` into `out`.
 *  Needed because a session's transcript isn't always a direct child of its
 *  project dir: a top-level session lives at
 *  `<projectDir>/<sessionId>.jsonl`, but any subagents/sub-workflows it
 *  forked write their OWN transcripts nested underneath it, e.g.
 *  `<projectDir>/<sessionId>/subagents/<subSessionId>.jsonl` or even
 *  `.../subagents/workflows/<workflowId>/<subSessionId>.jsonl`. Each of
 *  those is a real, independent session by this module's own definition
 *  (one `.jsonl` == one session) — skipping them undercounts activity
 *  heavily for any multi-agent/forked-subagent workflow. Unreadable
 *  directories are skipped silently (permissions, race with deletion). */
function collectJsonlFiles(dirPath: string, out: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      collectJsonlFiles(entryPath, out)
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(entryPath)
    }
  }
}

/** Lists every `.jsonl` file across every project dir under
 *  `~/.claude/projects/`, at ANY depth (see collectJsonlFiles). Missing
 *  root, unreadable project dirs, or unreadable individual entries are all
 *  skipped silently. */
function listAllTranscriptFiles(): string[] {
  const root = claudeProjectsRoot()
  let projectDirs: string[]
  try {
    projectDirs = fs
      .readdirSync(root, { withFileTypes: true })
      .flatMap((d) => (d.isDirectory() ? [d.name] : []))
  } catch {
    return []
  }

  const files: string[] = []
  for (const dirName of projectDirs) {
    collectJsonlFiles(path.join(root, dirName), files)
  }
  return files
}

// ---------------------------------------------------------------------------
// Roll-up — turns { mtimeMs, lineCount }[] into the ClaudeActivitySummary
// shape. Mirrors the semantics of the renderer's original pulseData.helpers
// (computeWeeklyActivity / computePeakHour / computeStreaks /
// activeDaysCount) but keyed by file mtime instead of session createdAt.
// ---------------------------------------------------------------------------

/** Local calendar-day key, e.g. "2026-07-11" — same convention as the
 *  renderer's pulseData.helpers.dayKey (local getters, DST-safe). */
function dayKey(epochMs: number): string {
  const d = new Date(epochMs)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/** Trailing 7 calendar days (Mon..Sun), same ordering/anchoring as the
 *  renderer's original computeWeeklyActivity. */
function computeWeeklyActivity(files: ScannedFile[], now: number): WeeklyActivityDay[] {
  const sessionsByDay = new Map<string, number>()
  const messagesByDay = new Map<string, number>()
  for (const f of files) {
    const key = dayKey(f.mtimeMs)
    sessionsByDay.set(key, (sessionsByDay.get(key) ?? 0) + 1)
    messagesByDay.set(key, (messagesByDay.get(key) ?? 0) + f.lineCount)
  }

  const today = startOfLocalDay(new Date(now))
  const todayMonFirst = (today.getDay() + 6) % 7
  const weekStart = new Date(today)
  weekStart.setDate(weekStart.getDate() - todayMonFirst)

  const days: WeeklyActivityDay[] = []
  for (let weekday = 0; weekday < 7; weekday++) {
    const cellDate = new Date(weekStart)
    cellDate.setDate(cellDate.getDate() + weekday)
    const key = dayKey(cellDate.getTime())
    days.push({
      weekday,
      sessions: sessionsByDay.get(key) ?? 0,
      messages: messagesByDay.get(key) ?? 0
    })
  }
  return days
}

/** Local hour-of-day (0-23) with the most session-file mtimes, computed
 *  over `files` (callers pass the last-7-days subset — see file header for
 *  why that window was chosen over all-time: it matches the same trailing
 *  window the rest of the pulse tiles use, so "peak hour" reads as "this
 *  week's peak hour", not a slow-moving all-time average). Ties broken by
 *  lowest hour. Null when `files` is empty. */
function computePeakHour(files: ScannedFile[]): number | null {
  if (files.length === 0) return null
  const histogram = new Array<number>(24).fill(0)
  for (const f of files) {
    histogram[new Date(f.mtimeMs).getHours()] += 1
  }
  let peakHour = 0
  let peakCount = histogram[0]
  for (let h = 1; h < 24; h++) {
    if (histogram[h] > peakCount) {
      peakCount = histogram[h]
      peakHour = h
    }
  }
  return peakCount > 0 ? peakHour : null
}

/** Consecutive-day streak ending today or yesterday, over the FULL file
 *  set — same "alive until a full day is skipped" semantics as the
 *  renderer's original computeStreaks (see pulseData.helpers.ts), just
 *  keyed by file mtime instead of session createdAt. */
function computeCurrentStreak(files: ScannedFile[], now: number): number {
  if (files.length === 0) return 0

  const activeDays = Array.from(new Set(files.map((f) => dayKey(f.mtimeMs)))).sort()
  const today = startOfLocalDay(new Date(now))
  const mostRecentActive = new Date(activeDays[activeDays.length - 1])
  const daysSinceMostRecent = Math.round((today.getTime() - mostRecentActive.getTime()) / DAY_MS)

  if (daysSinceMostRecent > 1) return 0

  const activeSet = new Set(activeDays)
  let current = 0
  const cursor = new Date(mostRecentActive)
  while (activeSet.has(dayKey(cursor.getTime()))) {
    current += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return current
}

function rollUp(allFiles: ScannedFile[], now: number): ClaudeActivitySummary {
  const cutoff = now - LAST_7_DAYS_MS
  const last7Days = allFiles.filter((f) => f.mtimeMs >= cutoff)

  return {
    weeklyActivity: computeWeeklyActivity(allFiles, now),
    sessionsLast7Days: last7Days.length,
    messagesLast7Days: last7Days.reduce((sum, f) => sum + f.lineCount, 0),
    allTimeSessions: allFiles.length,
    allTimeMessages: allFiles.reduce((sum, f) => sum + f.lineCount, 0),
    tokensLast7Days: last7Days.reduce((sum, f) => sum + f.tokenTotal, 0),
    allTimeTokens: allFiles.reduce((sum, f) => sum + f.tokenTotal, 0),
    peakHour: computePeakHour(last7Days),
    currentStreak: computeCurrentStreak(allFiles, now),
    activeDays: new Set(last7Days.map((f) => dayKey(f.mtimeMs))).size
  }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

let inflight: Promise<ClaudeActivitySummary> | null = null

async function scanNow(): Promise<ClaudeActivitySummary> {
  ensureFileCacheLoaded()

  const paths = listAllTranscriptFiles()
  const scanned: ScannedFile[] = []
  for (const filePath of paths) {
    const result = await scanOneFile(filePath)
    if (result) scanned.push(result)
  }

  // Drop cache entries for files that no longer exist so the persisted
  // cache doesn't grow unbounded across deletions/archival over time.
  const livePaths = new Set(paths)
  for (const cachedPath of Object.keys(fileCache)) {
    if (!livePaths.has(cachedPath)) delete fileCache[cachedPath]
  }

  const summary = rollUp(scanned, Date.now())
  writeDashboardCache(DASHBOARD_CACHE_KEYS.claudeActivity, { summary, fileCache })
  return summary
}

/**
 * Scans ALL `~/.claude/projects/<encoded>/<sessionId>.jsonl` transcript
 * files and returns the
 * rolled-up ClaudeActivitySummary, persisting both the summary and the
 * per-file line-count cache to disk. Single-flighted — concurrent callers
 * (e.g. an IPC call racing the background poller) share one scan. The FIRST
 * scan in a fresh install may read many files; every scan after that only
 * re-reads files whose mtime/size actually changed. Total — never throws;
 * any per-file failure degrades that file to "skipped", not a thrown error.
 */
export async function getClaudeActivity(): Promise<ClaudeActivitySummary> {
  if (inflight) return inflight
  const promise = scanNow().finally(() => {
    inflight = null
  })
  inflight = promise
  return promise
}

/** Instant, disk-backed read of the last-persisted `getClaudeActivity()`
 *  summary (Dashboard D2 stale-while-revalidate). Never throws; null means
 *  no successful scan has ever been persisted yet. */
export function getCachedClaudeActivity(): {
  value: ClaudeActivitySummary
  fetchedAt: number
} | null {
  const cached = readDashboardCache<PersistedActivity>(DASHBOARD_CACHE_KEYS.claudeActivity)
  if (!cached) return null
  return { value: cached.value.summary, fetchedAt: cached.fetchedAt }
}
