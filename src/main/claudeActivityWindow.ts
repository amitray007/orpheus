import type {
  ClaudeActivityWindowResult,
  ClaudeModelActivityDay,
  ClaudeRecentSession,
  WeeklyActivityDay
} from '../shared/types'

export type ClaudeActivityQueryRange = Pick<
  ClaudeActivityWindowResult,
  'weekOffset' | 'isCurrentWeek' | 'rangeStart' | 'rangeEnd' | 'queryFrom' | 'queryTo'
>

export type ParsedClaudeTranscriptLine = {
  timestampMs: number | null
  cwd: string | null
  role: 'user' | 'assistant' | null
  titleCandidate: string | null
  model: string | null
  tokens: number
}

export type ClaudeActivityWindowFile = {
  mtimeMs: number
  lineCount: number
  tokenTotal: number
  recentSession: ClaudeRecentSession | null
  modelActivity: ClaudeModelActivityDay[]
}

type RawUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

function localDateKey(value: Date): string {
  return [
    String(value.getFullYear()).padStart(4, '0'),
    String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0')
  ].join('-')
}

function textFromContent(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const text = content
    .flatMap((part) => {
      if (typeof part !== 'object' || part === null) return []
      const candidate = (part as { text?: unknown }).text
      return typeof candidate === 'string' ? [candidate] : []
    })
    .join(' ')
  return text || null
}

function normalizeTitle(text: string | null): string | null {
  if (!text) return null
  const withoutLeadingLocalCommandCaveat = text.replace(
    /^\s*<local-command-caveat>[\s\S]*?<\/local-command-caveat>\s*/i,
    ''
  )
  if (
    /^\s*<(?:command-name|command-message|command-args|local-command-(?:stdout|stderr|output|caveat))>/i.test(
      withoutLeadingLocalCommandCaveat
    )
  ) {
    return null
  }
  const normalized = withoutLeadingLocalCommandCaveat.replace(/\s+/g, ' ').trim()
  if (!normalized) return null
  return normalized.length > 96 ? `${normalized.slice(0, 93)}…` : normalized
}

function sumUsageTokens(usage: RawUsage): number {
  const numberOrZero = (value: unknown): number => (typeof value === 'number' ? value : 0)
  return (
    numberOrZero(usage.input_tokens) +
    numberOrZero(usage.output_tokens) +
    numberOrZero(usage.cache_read_input_tokens) +
    numberOrZero(usage.cache_creation_input_tokens)
  )
}

export function parseClaudeTranscriptLine(line: string): ParsedClaudeTranscriptLine | null {
  if (!line) return null
  try {
    const parsed = JSON.parse(line) as {
      timestamp?: unknown
      cwd?: unknown
      type?: unknown
      message?: {
        role?: unknown
        content?: unknown
        model?: unknown
        usage?: RawUsage
      }
    }
    const timestamp =
      typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : Number.NaN
    const role =
      parsed.message?.role === 'user' || parsed.type === 'user'
        ? 'user'
        : parsed.message?.role === 'assistant' || parsed.type === 'assistant'
          ? 'assistant'
          : null
    const usage = parsed.message?.usage
    return {
      timestampMs: Number.isFinite(timestamp) ? timestamp : null,
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : null,
      role,
      titleCandidate:
        role === 'user' ? normalizeTitle(textFromContent(parsed.message?.content)) : null,
      model: typeof parsed.message?.model === 'string' ? parsed.message.model : null,
      tokens: usage && typeof usage === 'object' ? sumUsageTokens(usage) : 0
    }
  } catch {
    return null
  }
}

export function assertClaudeActivityWeekOffset(weekOffset: number): void {
  if (!Number.isSafeInteger(weekOffset) || weekOffset > 0) {
    throw new RangeError('weekOffset must be a safe integer less than or equal to zero')
  }
}

export function resolveClaudeActivityRange(
  weekOffset: number,
  now: Date = new Date()
): ClaudeActivityQueryRange {
  assertClaudeActivityWeekOffset(weekOffset)
  if (!Number.isFinite(now.getTime())) throw new RangeError('now must be a valid date')

  const start = new Date(now)
  const daysSinceMonday = (start.getDay() + 6) % 7
  start.setDate(start.getDate() - daysSinceMonday + weekOffset * 7)
  start.setHours(0, 0, 0, 0)

  const end = new Date(start)
  end.setDate(end.getDate() + 6)
  end.setHours(23, 59, 59, 999)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw new RangeError('weekOffset resolves outside the supported date range')
  }

  const isCurrentWeek = weekOffset === 0
  return {
    weekOffset,
    isCurrentWeek,
    rangeStart: localDateKey(start),
    rangeEnd: localDateKey(end),
    queryFrom: start.toISOString(),
    queryTo: (isCurrentWeek ? now : end).toISOString()
  }
}

export function claudeActivityRangeKey(range: ClaudeActivityQueryRange): string {
  const completeness = range.isCurrentWeek ? 'current' : 'complete'
  return `${completeness}:${range.rangeStart}:${range.rangeEnd}`
}

function weeklyActivity(
  files: ClaudeActivityWindowFile[],
  range: ClaudeActivityQueryRange
): WeeklyActivityDay[] {
  const sessionsByDay = new Map<string, number>()
  const messagesByDay = new Map<string, number>()
  for (const file of files) {
    const key = localDateKey(new Date(file.mtimeMs))
    sessionsByDay.set(key, (sessionsByDay.get(key) ?? 0) + 1)
    messagesByDay.set(key, (messagesByDay.get(key) ?? 0) + file.lineCount)
  }

  const start = new Date(range.queryFrom)
  return Array.from({ length: 7 }, (_, weekday) => {
    const date = new Date(start)
    date.setDate(date.getDate() + weekday)
    const key = localDateKey(date)
    return {
      weekday,
      sessions: sessionsByDay.get(key) ?? 0,
      messages: messagesByDay.get(key) ?? 0
    }
  })
}

function maxConsecutiveActiveDays(files: ClaudeActivityWindowFile[]): number {
  const activeDays = new Set(files.map((file) => localDateKey(new Date(file.mtimeMs))))
  let current = 0
  let longest = 0
  for (const day of [...activeDays].sort()) {
    const previous = new Date(`${day}T00:00:00`)
    previous.setDate(previous.getDate() - 1)
    current = activeDays.has(localDateKey(previous)) ? current + 1 : 1
    longest = Math.max(longest, current)
  }
  return longest
}

function peakHour(files: ClaudeActivityWindowFile[]): number | null {
  if (files.length === 0) return null
  const histogram = new Array<number>(24).fill(0)
  for (const file of files) histogram[new Date(file.mtimeMs).getHours()] += 1
  let peak = 0
  for (let hour = 1; hour < histogram.length; hour++) {
    if (histogram[hour] > histogram[peak]) peak = hour
  }
  return histogram[peak] > 0 ? peak : null
}

function selectedModelActivity(
  files: ClaudeActivityWindowFile[],
  range: ClaudeActivityQueryRange
): ClaudeModelActivityDay[] {
  const aggregate = new Map<string, ClaudeModelActivityDay>()
  for (const file of files) {
    for (const activity of file.modelActivity) {
      if (activity.date < range.rangeStart || activity.date > range.rangeEnd) continue
      const key = `${activity.date}\0${activity.model}`
      const existing = aggregate.get(key)
      if (existing) {
        existing.turns += activity.turns
        existing.tokens += activity.tokens
      } else {
        aggregate.set(key, { ...activity })
      }
    }
  }
  return [...aggregate.values()].sort(
    (left, right) => left.date.localeCompare(right.date) || left.model.localeCompare(right.model)
  )
}

export function buildClaudeActivityWindow(
  allFiles: ClaudeActivityWindowFile[],
  range: ClaudeActivityQueryRange,
  fetchedAt = Date.now()
): ClaudeActivityWindowResult {
  const from = new Date(range.queryFrom).getTime()
  const to = new Date(range.queryTo).getTime()
  const files = allFiles.filter((file) => file.mtimeMs >= from && file.mtimeMs <= to)
  const recentSessions = files
    .flatMap((file) => (file.recentSession ? [file.recentSession] : []))
    .sort((left, right) => Date.parse(right.lastActivity) - Date.parse(left.lastActivity))
    .slice(0, 25)

  return {
    ...range,
    weeklyActivity: weeklyActivity(files, range),
    sessions: files.length,
    messages: files.reduce((sum, file) => sum + file.lineCount, 0),
    tokens: files.reduce((sum, file) => sum + file.tokenTotal, 0),
    peakHour: peakHour(files),
    activeDays: new Set(files.map((file) => localDateKey(new Date(file.mtimeMs)))).size,
    longestStreak: maxConsecutiveActiveDays(files),
    recentSessions,
    modelActivity: selectedModelActivity(allFiles, range),
    fetchedAt
  }
}
