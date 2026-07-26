import * as os from 'node:os'
import { DASHBOARD_CACHE_KEYS, readDashboardCache, writeDashboardCache } from './db/dashboardCache'
import { runGh } from './github'
import { listProjects } from './projects'
import type {
  GithubAccountSnapshot,
  GithubActivity7Day,
  GithubContributionWindowResult,
  GithubRepositorySummary,
  GithubSectionStatus,
  GithubWorkflowRunSummary
} from '../shared/types'
import {
  githubContributionRangeKey,
  parseGithubContributionActivity,
  resolveGithubContributionRange,
  type GithubContributionQueryRange
} from './githubContributionWindow'

const SNAPSHOT_TTL_MS = 2 * 60 * 1000
const CURRENT_CONTRIBUTION_TTL_MS = 2 * 60 * 1000
const HISTORICAL_CONTRIBUTION_TTL_MS = 30 * 60 * 1000
const MAX_CONTRIBUTION_CACHE_ENTRIES = 32
const GH_TIMEOUT_MS = 8_000
const GH_MAX_BUFFER = 2 * 1024 * 1024
const MAX_REPOSITORIES = 8
const MAX_WORKFLOW_REPOSITORIES = 6
const MAX_RUNS_PER_REPOSITORY = 4
const MAX_WORKFLOW_RUNS = 12

type Section<T> = { status: GithubSectionStatus; value: T }

type RawRepository = {
  full_name?: string
  description?: string | null
  html_url?: string
  updated_at?: string
  pushed_at?: string | null
  private?: boolean
  language?: string | null
  stargazers_count?: number
}

type RawWorkflowRun = {
  databaseId?: number
  workflowName?: string
  name?: string
  status?: string
  conclusion?: string | null
  event?: string
  headBranch?: string | null
  updatedAt?: string
  url?: string
}

type RawContributions = {
  data?: {
    search?: {
      issueCount?: number
    }
    user?: {
      contributionsCollection?: {
        contributionCalendar?: { totalContributions?: number }
        totalCommitContributions?: number
        totalIssueContributions?: number
        totalPullRequestContributions?: number
        totalPullRequestReviewContributions?: number
      }
    } | null
  }
}

let cached: { value: GithubAccountSnapshot; fetchedAt: number } | null = null
let inflight: Promise<GithubAccountSnapshot> | null = null
const contributionCache = new Map<
  string,
  { value: GithubContributionWindowResult; fetchedAt: number }
>()
const contributionInflight = new Map<string, Promise<GithubContributionWindowResult>>()

const CONTRIBUTION_WINDOW_QUERY =
  'query($from:DateTime!,$to:DateTime!){viewer{contributionsCollection(from:$from,to:$to){contributionCalendar{totalContributions} totalCommitContributions totalIssueContributions totalPullRequestContributions totalPullRequestReviewContributions}}}'

function contributionTtl(result: GithubContributionWindowResult): number {
  return result.isCurrentWeek ? CURRENT_CONTRIBUTION_TTL_MS : HISTORICAL_CONTRIBUTION_TTL_MS
}

function cacheContributionWindow(key: string, value: GithubContributionWindowResult): void {
  contributionCache.delete(key)
  contributionCache.set(key, { value, fetchedAt: value.fetchedAt })
  const now = Date.now()
  for (const [candidateKey, entry] of contributionCache) {
    if (now - entry.fetchedAt >= contributionTtl(entry.value)) {
      contributionCache.delete(candidateKey)
    }
  }
  while (contributionCache.size > MAX_CONTRIBUTION_CACHE_ENTRIES) {
    const oldestKey = contributionCache.keys().next().value
    if (oldestKey === undefined) break
    contributionCache.delete(oldestKey)
  }
}

function contributionResult(
  range: GithubContributionQueryRange,
  activity: GithubContributionWindowResult['activity'],
  status: GithubSectionStatus
): GithubContributionWindowResult {
  return {
    ...range,
    activity,
    status,
    fetchedAt: Date.now()
  }
}

async function fetchContributionWindow(
  range: GithubContributionQueryRange
): Promise<GithubContributionWindowResult> {
  try {
    const stdout = await runGh(
      os.homedir(),
      [
        'api',
        'graphql',
        '-f',
        `query=${CONTRIBUTION_WINDOW_QUERY}`,
        '-f',
        `from=${range.queryFrom}`,
        '-f',
        `to=${range.queryTo}`
      ],
      { timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER }
    )
    const activity = parseGithubContributionActivity(JSON.parse(stdout) as unknown)
    return activity
      ? contributionResult(range, activity, 'available')
      : contributionResult(range, null, 'unavailable')
  } catch {
    return contributionResult(range, null, 'unavailable')
  }
}

export async function getGithubContributionWindow(
  weekOffset: number,
  force = false
): Promise<GithubContributionWindowResult> {
  const range = resolveGithubContributionRange(weekOffset)
  const key = githubContributionRangeKey(range)
  const cachedWindow = contributionCache.get(key)
  if (
    !force &&
    cachedWindow &&
    Date.now() - cachedWindow.fetchedAt < contributionTtl(cachedWindow.value)
  ) {
    return cachedWindow.value
  }

  const existing = contributionInflight.get(key)
  if (existing) return existing

  const request = fetchContributionWindow(range).finally(() => {
    contributionInflight.delete(key)
  })
  contributionInflight.set(key, request)
  const value = await request
  cacheContributionWindow(key, value)
  return value
}

function classifyUnavailableReason(err: unknown): GithubAccountSnapshot['unavailableReason'] {
  const candidate = err as { code?: unknown; stderr?: unknown; message?: unknown }
  if (candidate?.code === 'ENOENT') return 'gh-not-found'
  const stderr = typeof candidate?.stderr === 'string' ? candidate.stderr : ''
  const message = typeof candidate?.message === 'string' ? candidate.message : ''
  const detail = `${stderr} ${message}`.toLowerCase()
  if (
    detail.includes('not logged') ||
    detail.includes('authentication') ||
    detail.includes('authenticate') ||
    detail.includes('gh auth login')
  ) {
    return 'not-authenticated'
  }
  return 'error'
}

async function fetchProfile(): Promise<
  { login: string; profileUrl: string } | { error: GithubAccountSnapshot['unavailableReason'] }
> {
  try {
    const stdout = await runGh(os.homedir(), ['api', 'user'], {
      timeout: GH_TIMEOUT_MS,
      maxBuffer: GH_MAX_BUFFER
    })
    const raw = JSON.parse(stdout) as { login?: string; html_url?: string }
    if (!raw.login || !raw.html_url) return { error: 'error' }
    return { login: raw.login, profileUrl: raw.html_url }
  } catch (err) {
    return { error: classifyUnavailableReason(err) }
  }
}

async function fetchRepositories(): Promise<Section<GithubRepositorySummary[]>> {
  try {
    const stdout = await runGh(
      os.homedir(),
      [
        'api',
        '--method',
        'GET',
        'user/repos',
        '-f',
        `per_page=${MAX_REPOSITORIES}`,
        '-f',
        'sort=updated',
        '-f',
        'direction=desc'
      ],
      { timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER }
    )
    const raw = JSON.parse(stdout) as RawRepository[]
    const value = raw.slice(0, MAX_REPOSITORIES).flatMap((repo) => {
      if (!repo.full_name || !repo.html_url || !repo.updated_at) return []
      return [
        {
          nameWithOwner: repo.full_name,
          description: repo.description ?? null,
          url: repo.html_url,
          updatedAt: repo.updated_at,
          pushedAt: repo.pushed_at ?? null,
          isPrivate: repo.private === true,
          primaryLanguage: repo.language ?? null,
          stargazerCount: typeof repo.stargazers_count === 'number' ? repo.stargazers_count : 0
        }
      ]
    })
    return { status: 'available', value }
  } catch {
    return { status: 'unavailable', value: [] }
  }
}

function registeredGithubRepositories(): string[] {
  try {
    const repositories = listProjects().flatMap((project) =>
      project.githubOwner && project.githubRepo
        ? [`${project.githubOwner}/${project.githubRepo}`]
        : []
    )
    return Array.from(new Set(repositories)).slice(0, MAX_WORKFLOW_REPOSITORIES)
  } catch {
    return []
  }
}

async function fetchRunsForRepository(repo: string): Promise<GithubWorkflowRunSummary[] | null> {
  try {
    const stdout = await runGh(
      os.homedir(),
      [
        'run',
        'list',
        '--repo',
        repo,
        '--limit',
        String(MAX_RUNS_PER_REPOSITORY),
        '--json',
        'databaseId,workflowName,name,status,conclusion,event,headBranch,updatedAt,url'
      ],
      { timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER }
    )
    const raw = JSON.parse(stdout) as RawWorkflowRun[]
    return raw.flatMap((run) => {
      if (typeof run.databaseId !== 'number' || !run.updatedAt || !run.url || !run.status) {
        return []
      }
      return [
        {
          id: run.databaseId,
          repo,
          workflowName: run.workflowName || run.name || 'Workflow',
          status: run.status,
          conclusion: run.conclusion ?? null,
          event: run.event ?? '',
          headBranch: run.headBranch ?? null,
          updatedAt: run.updatedAt,
          url: run.url
        }
      ]
    })
  } catch {
    return null
  }
}

async function fetchWorkflowRuns(
  repositories: string[]
): Promise<Section<GithubWorkflowRunSummary[]>> {
  if (repositories.length === 0) return { status: 'available', value: [] }
  const results = await Promise.all(repositories.map(fetchRunsForRepository))
  const value = results
    .flatMap((result) => result ?? [])
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, MAX_WORKFLOW_RUNS)
  return {
    status: results.some((result) => result === null) ? 'unavailable' : 'available',
    value
  }
}

function activityRange(now: Date): { from: string; to: string } {
  const from = new Date(now)
  from.setDate(from.getDate() - 6)
  from.setHours(0, 0, 0, 0)
  return { from: from.toISOString(), to: now.toISOString() }
}

type GithubInsightSnapshot = {
  activity: GithubActivity7Day
  reviewRequestedCount: number
}

async function fetchInsights7Day(login: string): Promise<Section<GithubInsightSnapshot | null>> {
  const range = activityRange(new Date())
  const query =
    'query($login:String!,$from:DateTime!,$to:DateTime!,$reviewQuery:String!){search(query:$reviewQuery,type:ISSUE,first:1){issueCount} user(login:$login){contributionsCollection(from:$from,to:$to){contributionCalendar{totalContributions} totalCommitContributions totalIssueContributions totalPullRequestContributions totalPullRequestReviewContributions}}}'
  try {
    const stdout = await runGh(
      os.homedir(),
      [
        'api',
        'graphql',
        '-f',
        `query=${query}`,
        '-f',
        `login=${login}`,
        '-f',
        `from=${range.from}`,
        '-f',
        `to=${range.to}`,
        '-f',
        `reviewQuery=is:pr is:open review-requested:${login}`
      ],
      { timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER }
    )
    const raw = JSON.parse(stdout) as RawContributions
    const collection = raw.data?.user?.contributionsCollection
    const reviewRequestedCount = raw.data?.search?.issueCount
    if (!collection || typeof reviewRequestedCount !== 'number') {
      return { status: 'unavailable', value: null }
    }
    return {
      status: 'available',
      value: {
        reviewRequestedCount,
        activity: {
          from: range.from,
          to: range.to,
          totalContributions: collection.contributionCalendar?.totalContributions ?? 0,
          commits: collection.totalCommitContributions ?? 0,
          pullRequests: collection.totalPullRequestContributions ?? 0,
          issues: collection.totalIssueContributions ?? 0,
          reviews: collection.totalPullRequestReviewContributions ?? 0
        }
      }
    }
  } catch {
    return { status: 'unavailable', value: null }
  }
}

async function fetchSnapshot(): Promise<GithubAccountSnapshot> {
  const fetchedAt = Date.now()
  const profile = await fetchProfile()
  if ('error' in profile) {
    return {
      availability: 'unavailable',
      unavailableReason: profile.error,
      profile: null,
      reviewRequestedCount: null,
      repositories: [],
      repositoriesStatus: 'unavailable',
      workflowRuns: [],
      workflowRunsStatus: 'unavailable',
      workflowScope: { kind: 'registered-repositories', repositories: [] },
      activity7d: null,
      activityStatus: 'unavailable',
      fetchedAt
    }
  }

  const workflowRepositories = registeredGithubRepositories()
  const [repositories, workflowRuns, activity] = await Promise.all([
    fetchRepositories(),
    fetchWorkflowRuns(workflowRepositories),
    fetchInsights7Day(profile.login)
  ])
  const degraded =
    repositories.status === 'unavailable' ||
    workflowRuns.status === 'unavailable' ||
    activity.status === 'unavailable'

  return {
    availability: degraded ? 'degraded' : 'available',
    unavailableReason: null,
    profile,
    reviewRequestedCount: activity.value?.reviewRequestedCount ?? null,
    repositories: repositories.value,
    repositoriesStatus: repositories.status,
    workflowRuns: workflowRuns.value,
    workflowRunsStatus: workflowRuns.status,
    workflowScope: {
      kind: 'registered-repositories',
      repositories: workflowRepositories
    },
    activity7d: activity.value?.activity ?? null,
    activityStatus: activity.status,
    fetchedAt
  }
}

function sameWorkflowScope(a: GithubAccountSnapshot, b: GithubAccountSnapshot): boolean {
  return (
    a.workflowScope.repositories.length === b.workflowScope.repositories.length &&
    a.workflowScope.repositories.every(
      (repository, index) => repository === b.workflowScope.repositories[index]
    )
  )
}

function snapshotForPersistence(
  previous: GithubAccountSnapshot | null,
  current: GithubAccountSnapshot
): GithubAccountSnapshot {
  if (!previous || previous.availability === 'unavailable') return current
  const keepRepositories =
    current.repositoriesStatus === 'unavailable' && previous.repositoriesStatus === 'available'
  const keepWorkflowRuns =
    current.workflowRunsStatus === 'unavailable' &&
    previous.workflowRunsStatus === 'available' &&
    sameWorkflowScope(previous, current)
  const keepActivity =
    current.activityStatus === 'unavailable' && previous.activityStatus === 'available'
  return {
    ...current,
    reviewRequestedCount: keepActivity
      ? previous.reviewRequestedCount
      : current.reviewRequestedCount,
    repositories: keepRepositories ? previous.repositories : current.repositories,
    workflowRuns: keepWorkflowRuns ? previous.workflowRuns : current.workflowRuns,
    activity7d: keepActivity ? previous.activity7d : current.activity7d
  }
}

export async function getGithubAccountSnapshot(force = false): Promise<GithubAccountSnapshot> {
  const now = Date.now()
  if (!force && cached && now - cached.fetchedAt < SNAPSHOT_TTL_MS) return cached.value
  if (inflight) return inflight

  const promise = fetchSnapshot().finally(() => {
    inflight = null
  })
  inflight = promise
  const value = await promise
  cached = { value, fetchedAt: Date.now() }
  if (value.availability !== 'unavailable') {
    const previous =
      readDashboardCache<GithubAccountSnapshot>(DASHBOARD_CACHE_KEYS.githubAccount)?.value ?? null
    writeDashboardCache(DASHBOARD_CACHE_KEYS.githubAccount, snapshotForPersistence(previous, value))
  }
  return value
}

export function getCachedGithubAccountSnapshot(): {
  value: GithubAccountSnapshot
  fetchedAt: number
} | null {
  return readDashboardCache<GithubAccountSnapshot>(DASHBOARD_CACHE_KEYS.githubAccount)
}
