import assert from 'node:assert/strict'
import {
  assertGithubContributionWeekOffset,
  githubContributionRangeKey,
  parseGithubContributionActivity,
  resolveGithubContributionRange
} from '../src/main/githubContributionWindow'

function localDate(value: string): string {
  const parsed = new Date(value)
  return [
    String(parsed.getFullYear()).padStart(4, '0'),
    String(parsed.getMonth() + 1).padStart(2, '0'),
    String(parsed.getDate()).padStart(2, '0')
  ].join('-')
}

const sunday = new Date(2026, 6, 26, 14, 30)
const currentSunday = resolveGithubContributionRange(0, sunday)
assert.equal(currentSunday.rangeStart, '2026-07-20')
assert.equal(currentSunday.rangeEnd, '2026-07-26')
assert.equal(localDate(currentSunday.queryFrom), '2026-07-20')
assert.equal(currentSunday.queryTo, sunday.toISOString())
assert.equal(currentSunday.isCurrentWeek, true)

const monday = new Date(2026, 6, 27, 9, 15)
const currentMonday = resolveGithubContributionRange(0, monday)
assert.equal(currentMonday.rangeStart, '2026-07-27')
assert.equal(currentMonday.rangeEnd, '2026-08-02')
assert.equal(new Date(currentMonday.queryFrom).getHours(), 0)

const previous = resolveGithubContributionRange(-1, monday)
assert.equal(previous.rangeStart, '2026-07-20')
assert.equal(previous.rangeEnd, '2026-07-26')
assert.equal(new Date(previous.queryTo).getHours(), 23)
assert.equal(new Date(previous.queryTo).getMinutes(), 59)
assert.equal(new Date(previous.queryTo).getSeconds(), 59)
assert.equal(new Date(previous.queryTo).getMilliseconds(), 999)
assert.equal(previous.isCurrentWeek, false)
assert.equal(currentSunday.rangeStart, previous.rangeStart)
assert.equal(currentSunday.rangeEnd, previous.rangeEnd)
assert.notEqual(githubContributionRangeKey(currentSunday), githubContributionRangeKey(previous))

const twoWeeksAgo = resolveGithubContributionRange(-2, monday)
assert.equal(twoWeeksAgo.rangeStart, '2026-07-13')
assert.equal(twoWeeksAgo.rangeEnd, '2026-07-19')
assert.equal(
  new Date(previous.queryFrom).getTime() - new Date(twoWeeksAgo.queryFrom).getTime(),
  7 * 24 * 60 * 60 * 1000
)

const yearRollover = resolveGithubContributionRange(0, new Date(2027, 0, 1, 12))
assert.equal(yearRollover.rangeStart, '2026-12-28')
assert.equal(yearRollover.rangeEnd, '2027-01-03')

const originalTimezone = process.env.TZ
process.env.TZ = 'America/New_York'
const springForwardWeek = resolveGithubContributionRange(-1, new Date(2026, 2, 9, 12))
assert.equal(springForwardWeek.rangeStart, '2026-03-02')
assert.equal(springForwardWeek.rangeEnd, '2026-03-08')
assert.equal(new Date(springForwardWeek.queryFrom).getHours(), 0)
assert.equal(new Date(springForwardWeek.queryTo).getHours(), 23)
assert.equal(
  new Date(springForwardWeek.queryTo).getTime() - new Date(springForwardWeek.queryFrom).getTime(),
  167 * 60 * 60 * 1000 - 1
)
if (originalTimezone === undefined) delete process.env.TZ
else process.env.TZ = originalTimezone

for (const invalid of [1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
  assert.throws(() => assertGithubContributionWeekOffset(invalid), RangeError)
}

assert.deepEqual(
  parseGithubContributionActivity({
    data: {
      viewer: {
        contributionsCollection: {
          contributionCalendar: { totalContributions: 0 },
          totalCommitContributions: 0,
          totalIssueContributions: 0,
          totalPullRequestContributions: 0,
          totalPullRequestReviewContributions: 0
        }
      }
    }
  }),
  {
    totalContributions: 0,
    commits: 0,
    pullRequests: 0,
    issues: 0,
    reviews: 0
  }
)
assert.equal(parseGithubContributionActivity({ data: { viewer: null } }), null)
assert.equal(
  parseGithubContributionActivity({
    data: {
      viewer: {
        contributionsCollection: {
          contributionCalendar: { totalContributions: '0' }
        }
      }
    }
  }),
  null
)

console.log('github contribution window verification passed')
