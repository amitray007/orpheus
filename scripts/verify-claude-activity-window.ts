import assert from 'node:assert/strict'
import type { ClaudeActivityWindowFile } from '../src/main/claudeActivityWindow'
import {
  assertClaudeActivityWeekOffset,
  buildClaudeActivityWindow,
  claudeActivityRangeKey,
  parseClaudeTranscriptLine,
  resolveClaudeActivityRange
} from '../src/main/claudeActivityWindow'

function file(
  date: Date,
  {
    id = date.toISOString(),
    lines = 1,
    tokens = 0,
    topLevel = true,
    modelDate
  }: {
    id?: string
    lines?: number
    tokens?: number
    topLevel?: boolean
    modelDate?: string
  } = {}
): ClaudeActivityWindowFile {
  return {
    mtimeMs: date.getTime(),
    lineCount: lines,
    tokenTotal: tokens,
    recentSession: topLevel
      ? {
          id,
          title: id,
          projectLabel: 'Orpheus',
          lastActivity: date.toISOString(),
          messageCount: lines,
          turnCount: 1,
          tokenTotal: tokens,
          durationMs: 1
        }
      : null,
    modelActivity: modelDate ? [{ date: modelDate, model: 'claude-sonnet', turns: 1, tokens }] : []
  }
}

const sunday = new Date(2026, 6, 26, 14, 30)
const currentSunday = resolveClaudeActivityRange(0, sunday)
assert.equal(currentSunday.rangeStart, '2026-07-20')
assert.equal(currentSunday.rangeEnd, '2026-07-26')
assert.equal(currentSunday.queryTo, sunday.toISOString())
assert.equal(currentSunday.isCurrentWeek, true)

const monday = new Date(2026, 6, 27, 9, 15)
const currentMonday = resolveClaudeActivityRange(0, monday)
assert.equal(currentMonday.rangeStart, '2026-07-27')
assert.equal(currentMonday.rangeEnd, '2026-08-02')
assert.equal(new Date(currentMonday.queryFrom).getHours(), 0)
assert.notEqual(claudeActivityRangeKey(currentSunday), claudeActivityRangeKey(currentMonday))

const previous = resolveClaudeActivityRange(-1, monday)
assert.equal(previous.rangeStart, '2026-07-20')
assert.equal(previous.rangeEnd, '2026-07-26')
assert.equal(new Date(previous.queryTo).getHours(), 23)
assert.equal(new Date(previous.queryTo).getMinutes(), 59)
assert.equal(new Date(previous.queryTo).getSeconds(), 59)
assert.equal(new Date(previous.queryTo).getMilliseconds(), 999)
assert.notEqual(claudeActivityRangeKey(currentSunday), claudeActivityRangeKey(previous))

const monthRollover = resolveClaudeActivityRange(-1, new Date(2026, 7, 3, 12))
assert.equal(monthRollover.rangeStart, '2026-07-27')
assert.equal(monthRollover.rangeEnd, '2026-08-02')

const yearRollover = resolveClaudeActivityRange(0, new Date(2027, 0, 1, 12))
assert.equal(yearRollover.rangeStart, '2026-12-28')
assert.equal(yearRollover.rangeEnd, '2027-01-03')

for (const invalid of [1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
  assert.throws(() => assertClaudeActivityWeekOffset(invalid), RangeError)
}

const windowFiles = [
  file(new Date(2026, 6, 20, 8), {
    id: 'monday',
    lines: 10,
    tokens: 100,
    modelDate: '2026-07-20'
  }),
  file(new Date(2026, 6, 21, 9), {
    id: 'tuesday',
    lines: 20,
    tokens: 200,
    modelDate: '2026-07-21'
  }),
  file(new Date(2026, 6, 23, 9), {
    id: 'thursday',
    lines: 30,
    tokens: 300,
    modelDate: '2026-07-23'
  }),
  file(new Date(2026, 6, 24, 10), {
    id: 'subagent',
    lines: 40,
    tokens: 400,
    topLevel: false,
    modelDate: '2026-07-24'
  }),
  file(new Date(2026, 6, 27, 8), {
    id: 'outside',
    lines: 1000,
    tokens: 1000,
    modelDate: '2026-07-27'
  }),
  file(new Date(2026, 7, 3, 8), {
    id: 'later-mtime-with-selected-model-event',
    lines: 1000,
    tokens: 500,
    modelDate: '2026-07-22'
  })
]
const activity = buildClaudeActivityWindow(windowFiles, previous, 123)
assert.equal(activity.sessions, 4)
assert.equal(activity.messages, 100)
assert.equal(activity.tokens, 1000)
assert.equal(activity.activeDays, 4)
assert.equal(activity.longestStreak, 2)
assert.equal(activity.peakHour, 9)
assert.equal(activity.recentSessions.length, 3)
assert.deepEqual(
  activity.recentSessions.map((session) => session.id),
  ['thursday', 'tuesday', 'monday']
)
assert.equal(activity.modelActivity.length, 5)
assert.deepEqual(
  activity.weeklyActivity.map((day) => day.sessions),
  [1, 1, 0, 1, 1, 0, 0]
)
assert.deepEqual(buildClaudeActivityWindow([], previous, 456), {
  ...previous,
  weeklyActivity: Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    sessions: 0,
    messages: 0
  })),
  sessions: 0,
  messages: 0,
  tokens: 0,
  peakHour: null,
  activeDays: 0,
  longestStreak: 0,
  recentSessions: [],
  modelActivity: [],
  fetchedAt: 456
})

assert.deepEqual(
  parseClaudeTranscriptLine(
    JSON.stringify({
      timestamp: '2026-07-20T08:00:00.000Z',
      cwd: '/tmp/orpheus',
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-sonnet',
        usage: {
          input_tokens: 2,
          output_tokens: 3,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 7
        }
      }
    })
  ),
  {
    timestampMs: Date.parse('2026-07-20T08:00:00.000Z'),
    cwd: '/tmp/orpheus',
    role: 'assistant',
    titleCandidate: null,
    model: 'claude-sonnet',
    tokens: 17
  }
)
assert.equal(parseClaudeTranscriptLine('{not-json'), null)
assert.equal(parseClaudeTranscriptLine(''), null)
assert.equal(
  parseClaudeTranscriptLine(
    JSON.stringify({
      type: 'user',
      message: { content: '<command-name>/clear</command-name>' }
    })
  )?.titleCandidate,
  null
)

const originalTimezone = process.env.TZ
process.env.TZ = 'America/New_York'
const springForward = resolveClaudeActivityRange(-1, new Date(2026, 2, 9, 12))
assert.equal(springForward.rangeStart, '2026-03-02')
assert.equal(springForward.rangeEnd, '2026-03-08')
assert.equal(new Date(springForward.queryFrom).getHours(), 0)
assert.equal(new Date(springForward.queryTo).getHours(), 23)
assert.equal(
  new Date(springForward.queryTo).getTime() - new Date(springForward.queryFrom).getTime(),
  167 * 60 * 60 * 1000 - 1
)
if (originalTimezone === undefined) delete process.env.TZ
else process.env.TZ = originalTimezone

console.log('claude activity window verification passed')
