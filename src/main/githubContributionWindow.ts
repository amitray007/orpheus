import type { GithubContributionActivity, GithubContributionWindowResult } from '../shared/types'

export type GithubContributionQueryRange = Pick<
  GithubContributionWindowResult,
  'weekOffset' | 'isCurrentWeek' | 'rangeStart' | 'rangeEnd' | 'queryFrom' | 'queryTo'
>

function localDateKey(value: Date): string {
  return [
    String(value.getFullYear()).padStart(4, '0'),
    String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0')
  ].join('-')
}

export function assertGithubContributionWeekOffset(
  weekOffset: number
): asserts weekOffset is number {
  if (!Number.isSafeInteger(weekOffset) || weekOffset > 0) {
    throw new RangeError('weekOffset must be a safe integer less than or equal to zero')
  }
}

export function resolveGithubContributionRange(
  weekOffset: number,
  now: Date = new Date()
): GithubContributionQueryRange {
  assertGithubContributionWeekOffset(weekOffset)
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

export function githubContributionRangeKey(range: GithubContributionQueryRange): string {
  const completeness = range.isCurrentWeek ? 'current' : 'complete'
  return `${completeness}:${range.rangeStart}:${range.rangeEnd}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function metric(value: unknown): number | null {
  if (value === undefined || value === null) return 0
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export function parseGithubContributionActivity(
  payload: unknown
): GithubContributionActivity | null {
  if (!isRecord(payload) || !isRecord(payload.data) || !isRecord(payload.data.viewer)) return null
  const collection = payload.data.viewer.contributionsCollection
  if (!isRecord(collection)) return null

  const calendar = collection.contributionCalendar
  const totalContributions = metric(isRecord(calendar) ? calendar.totalContributions : undefined)
  const commits = metric(collection.totalCommitContributions)
  const pullRequests = metric(collection.totalPullRequestContributions)
  const issues = metric(collection.totalIssueContributions)
  const reviews = metric(collection.totalPullRequestReviewContributions)
  if (
    totalContributions === null ||
    commits === null ||
    pullRequests === null ||
    issues === null ||
    reviews === null
  ) {
    return null
  }

  return {
    totalContributions,
    commits,
    pullRequests,
    issues,
    reviews
  }
}
