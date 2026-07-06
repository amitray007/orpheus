import * as childProcess from 'node:child_process'
import { promisify } from 'node:util'
import { getUserShellPath } from './shellHelpers'
import type {
  GhPullRequest,
  GhPullRequestState,
  GhPullRequestDetail,
  GhLabel,
  GhReview,
  GhReviewState,
  GhReviewRequest,
  GhCommit,
  GhCheck,
  GhCheckState,
  GhGeneralComment,
  GhMilestone,
  GhReviewComment,
  GhReviewCommentThread,
  GhReviewCommentSide
} from '../shared/types'

const execFile = promisify(childProcess.execFile)

// Every cache in this module lives in the long-lived main process for the
// life of the app. TTL alone only governs FRESHNESS on read — it never frees
// memory, since an expired entry just sits there until something happens to
// read that exact key again. Long sessions with many distinct cwd/branch/PR
// keys (many worktrees, many PRs browsed over days) would otherwise grow
// these Maps monotonically forever. putWithEviction bounds each cache: every
// WRITE first prunes TTL-expired entries, then (if still over the cap) evicts
// oldest-inserted entries FIFO until back at/under the cap. Reads are
// untouched — an evicted key just re-fetches on next read, same as a TTL
// miss; eviction can never surface stale/wrong data.
const MAX_CACHE_ENTRIES = 200

function putWithEviction<V extends { fetchedAt: number }>(
  cache: Map<string, V>,
  key: string,
  value: V,
  ttlMs: number,
  maxEntries: number = MAX_CACHE_ENTRIES
): void {
  cache.set(key, value)

  const now = Date.now()
  for (const [k, entry] of cache) {
    if (now - entry.fetchedAt >= ttlMs) cache.delete(k)
  }

  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value
    if (oldestKey === undefined) break
    cache.delete(oldestKey)
  }
}

// In-memory cache keyed on `${cwd}\0${branch}`. Each entry holds the resolved
// PR (or null = "no PR for this branch") and the unix ms it was fetched.
// Hot tabs in Orpheus tend to re-render dozens of rows per second; without the
// cache we'd shell out to `gh` on every paint and saturate the CLI.
type CacheEntry = { value: GhPullRequest | null; fetchedAt: number }
const prCache = new Map<string, CacheEntry>()
const TTL_MS = 2 * 60 * 1000

// Inflight de-dup so a burst of mounts for the same (cwd, branch) only fires
// one `gh` invocation. Resolves to the eventual value once the gh call lands.
const inflight = new Map<string, Promise<GhPullRequest | null>>()

function cacheKey(cwd: string, branch: string): string {
  return `${cwd}\0${branch}`
}

/**
 * Resolve the GitHub PR opened against this branch, or null when no PR
 * exists. Returns null on every failure mode (gh missing, unauth, network,
 * non-GH remote) — the caller renders nothing and the UI degrades silently.
 */
export async function getPrForBranch(cwd: string, branch: string): Promise<GhPullRequest | null> {
  if (!cwd || !branch) return null
  const key = cacheKey(cwd, branch)
  const now = Date.now()

  const hit = prCache.get(key)
  if (hit && now - hit.fetchedAt < TTL_MS) return hit.value

  const pending = inflight.get(key)
  if (pending) return pending

  const promise = fetchPrFromGh(cwd, branch).finally(() => inflight.delete(key))
  inflight.set(key, promise)
  const value = await promise
  putWithEviction(prCache, key, { value, fetchedAt: Date.now() }, TTL_MS)
  return value
}

/**
 * Resolve the PATH to hand `gh` invocations. Finder-launched Electron starts
 * with a stripped PATH; getUserShellPath() grabs the user's login-shell PATH
 * so `gh` resolves the same way it does in their terminal. The helper
 * RESOLVES (doesn't throw) to '' on failure, so guard both the catch path
 * and the empty-resolve path — otherwise PATH would become '' even when
 * process.env.PATH is perfectly valid.
 */
async function resolveGhPathEnv(): Promise<string> {
  let shellPath = ''
  try {
    shellPath = await getUserShellPath()
  } catch {
    shellPath = ''
  }
  return shellPath || process.env['PATH'] || ''
}

async function fetchPrFromGh(cwd: string, branch: string): Promise<GhPullRequest | null> {
  const pathEnv = await resolveGhPathEnv()

  try {
    const { stdout } = await execFile(
      'gh',
      [
        'pr',
        'list',
        '--head',
        branch,
        '--state',
        'all',
        '--limit',
        '1',
        '--json',
        'number,state,isDraft,title,url,author,reviewDecision,statusCheckRollup'
      ],
      {
        cwd,
        env: { ...process.env, PATH: pathEnv },
        timeout: 4000,
        maxBuffer: 1024 * 1024
      }
    )
    const arr = JSON.parse(stdout) as Array<{
      number: number
      state: string
      isDraft: boolean
      title: string
      url: string
      author?: { login?: string } | null
      reviewDecision?: string | null
      statusCheckRollup?: Array<{ conclusion?: string | null; status?: string | null }> | null
    }>
    const raw = arr[0]
    if (!raw) return null
    return {
      number: raw.number,
      state: deriveState(raw.state, raw.isDraft),
      title: raw.title,
      url: raw.url,
      author: raw.author?.login ?? null,
      reviewDecision: normalizeReviewDecision(raw.reviewDecision),
      checks: deriveChecks(raw.statusCheckRollup)
    }
  } catch {
    // gh missing / unauth / no remote / network — render nothing.
    return null
  }
}

function deriveState(rawState: string, isDraft: boolean): GhPullRequestState {
  // gh returns state as 'OPEN' | 'CLOSED' | 'MERGED'. Drafts come back as OPEN
  // with isDraft=true, so we lift draft into its own state for the chip color.
  const s = rawState.toUpperCase()
  if (s === 'MERGED') return 'merged'
  if (s === 'CLOSED') return 'closed'
  return isDraft ? 'draft' : 'open'
}

function normalizeReviewDecision(raw: string | null | undefined): GhPullRequest['reviewDecision'] {
  if (!raw) return null
  const s = raw.toUpperCase()
  if (s === 'APPROVED') return 'approved'
  if (s === 'CHANGES_REQUESTED') return 'changes_requested'
  if (s === 'REVIEW_REQUIRED') return 'review_required'
  return null
}

function deriveChecks(
  rollup: Array<{ conclusion?: string | null; status?: string | null }> | null | undefined
): GhPullRequest['checks'] {
  if (!rollup || rollup.length === 0) return null
  let anyFailure = false
  let anyPending = false
  for (const r of rollup) {
    const status = (r.status ?? '').toUpperCase()
    const conclusion = (r.conclusion ?? '').toUpperCase()
    if (status && status !== 'COMPLETED') {
      anyPending = true
      continue
    }
    if (conclusion === 'FAILURE' || conclusion === 'TIMED_OUT' || conclusion === 'CANCELLED') {
      anyFailure = true
    }
  }
  if (anyFailure) return 'failure'
  if (anyPending) return 'pending'
  return 'success'
}

// ---------------------------------------------------------------------------
// PR detail (Workbench Git tab, Phase 3b) — richer `gh pr view <number>`
// fetch feeding the Details/Commits/Checks tabs. See
// docs/learnings/gh-pr-detail.md for the researched call/field/cache design
// this mirrors: ONE `gh pr view` call covers meta + labels + assignees +
// milestone + mergeable + commits + general comments + statusCheckRollup.
// Line-anchored review comments (Phase 4) need a separate `gh api` call and
// are intentionally NOT fetched here.
// ---------------------------------------------------------------------------

const DETAIL_FIELDS = [
  'number',
  'title',
  'body',
  'state',
  'url',
  'isDraft',
  'baseRefName',
  'headRefName',
  'author',
  'createdAt',
  'updatedAt',
  'mergeable',
  'mergeStateStatus',
  'additions',
  'deletions',
  'changedFiles',
  'labels',
  'assignees',
  'reviewRequests',
  'reviewDecision',
  'reviews',
  'milestone',
  'statusCheckRollup',
  'commits',
  'comments'
].join(',')

// Detail payloads (body + commits + comments) are much larger than the list
// view's payload — raise maxBuffer/timeout accordingly (per gh-pr-detail.md §6).
const DETAIL_TIMEOUT_MS = 10_000
const DETAIL_MAX_BUFFER = 4 * 1024 * 1024

// Cache keyed on `${cwd}\0${number}` — detail is opened deliberately (a user
// clicks into a PR), not painted continuously, so a longer TTL than the
// list-view cache is fine. Still capped so a manual refresh isn't the only
// way stale data ever clears.
type DetailCacheEntry = { value: GhPullRequestDetail | null; fetchedAt: number }
const detailCache = new Map<string, DetailCacheEntry>()
const DETAIL_TTL_MS = 5 * 60 * 1000
const detailInflight = new Map<string, Promise<GhPullRequestDetail | null>>()

function detailCacheKey(cwd: string, prNumber: number): string {
  return `${cwd}\0${prNumber}`
}

/**
 * Resolve the current branch for `cwd` via `git rev-parse --abbrev-ref HEAD`
 * — null on detached HEAD or any git failure. Deliberately NOT imported from
 * `./git` (which itself imports `getPrForBranch` from this module) — pulling
 * `getGitStatus` in here would create a `git.ts` <-> `github.ts` import
 * cycle that depcruise's no-circular rule rejects, so this module resolves
 * the branch itself with the same `git -C <cwd> rev-parse --abbrev-ref HEAD`
 * git.ts already uses.
 */
async function resolveCurrentBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFile('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeout: 1500
    })
    const out = stdout.trim()
    // Detached HEAD reports literal "HEAD"
    return out === 'HEAD' ? null : out || null
  } catch {
    return null
  }
}

/**
 * Resolve the PR opened against `cwd`'s CURRENT branch — the same
 * cwd -> branch -> PR composition `getPrDetail` below uses, but returning
 * just the list-view `GhPullRequest` shape (not the heavier detail payload).
 * Total — never throws: no cwd / no branch / no PR / gh missing / unauth /
 * network all resolve to null. Backs `github:prForWorkspace` (see
 * src/shared/ipc.ts), GitTab's fetch-on-mount fallback for the `pr` state —
 * `startGitWatch`'s one-shot `github:prChanged` push (src/main/git.ts) may
 * already have fired by the time the Git tab mounts, so this lets the
 * renderer fetch the current value directly instead of only ever waiting on
 * a push. Reuses getPrForBranch's own cache/inflight-dedup, so calling this
 * alongside the push handler never doubles up on `gh` invocations.
 */
export async function getPrForWorkspace(cwd: string | null): Promise<GhPullRequest | null> {
  if (!cwd) return null
  const branch = await resolveCurrentBranch(cwd)
  if (!branch) return null
  return getPrForBranch(cwd, branch)
}

/**
 * Fetch the rich PR detail for the PR opened against `workspaceId`'s current
 * branch. Total — never throws: no cwd / no branch / no PR / gh missing /
 * unauth / network all resolve to null so the caller can render an empty
 * state. Cached + inflight-deduped like getPrForBranch, but keyed on the
 * resolved PR number with a longer TTL (see module doc above).
 */
export async function getPrDetail(cwd: string | null): Promise<GhPullRequestDetail | null> {
  if (!cwd) return null

  const branch = await resolveCurrentBranch(cwd)
  if (!branch) return null

  const pr = await getPrForBranch(cwd, branch)
  if (!pr) return null

  const key = detailCacheKey(cwd, pr.number)
  const now = Date.now()

  const hit = detailCache.get(key)
  if (hit && now - hit.fetchedAt < DETAIL_TTL_MS) return hit.value

  const pending = detailInflight.get(key)
  if (pending) return pending

  const promise = fetchPrDetailFromGh(cwd, pr.number).finally(() => detailInflight.delete(key))
  detailInflight.set(key, promise)
  const value = await promise
  putWithEviction(detailCache, key, { value, fetchedAt: Date.now() }, DETAIL_TTL_MS)
  return value
}

// Raw gh JSON shapes (loose/untyped fields only, kept local to this module —
// normalized into the shared Gh* types before crossing into
// src/shared/types.ts, per github.ts's existing convention).
type RawGhUser = { login?: string | null } | null | undefined
type RawGhLabel = { name?: string; color?: string; description?: string | null }
type RawGhReviewRequest =
  | { login?: string; __typename?: string; name?: string }
  | { requestedReviewer?: { login?: string; name?: string; __typename?: string } }
type RawGhReview = {
  id?: string | number
  author?: RawGhUser
  state?: string
  submittedAt?: string | null
  body?: string
}
type RawGhCommitEntry = {
  oid?: string
  messageHeadline?: string
  messageBody?: string
  authoredDate?: string
  committedDate?: string
  authors?: Array<{ login?: string | null; name?: string | null }> | null
}
type RawGhCheck = {
  __typename?: string
  name?: string
  workflowName?: string | null
  status?: string | null
  conclusion?: string | null
  state?: string | null
  detailsUrl?: string | null
  targetUrl?: string | null
  startedAt?: string | null
  completedAt?: string | null
  context?: string
}
type RawGhComment = {
  id?: string
  author?: RawGhUser
  authorAssociation?: string
  body?: string
  createdAt?: string
  url?: string
  isMinimized?: boolean
}
type RawGhMilestone = { title?: string; url?: string; dueOn?: string | null } | null | undefined

type RawGhPrDetail = {
  number: number
  title: string
  body?: string | null
  state: string
  url: string
  isDraft: boolean
  baseRefName: string
  headRefName: string
  author?: RawGhUser
  createdAt: string
  updatedAt: string
  mergeable?: string | null
  mergeStateStatus?: string | null
  additions?: number
  deletions?: number
  changedFiles?: number
  labels?: RawGhLabel[] | null
  assignees?: Array<{ login?: string }> | null
  reviewRequests?: RawGhReviewRequest[] | null
  reviewDecision?: string | null
  reviews?: RawGhReview[] | null
  milestone?: RawGhMilestone
  statusCheckRollup?: RawGhCheck[] | null
  commits?: RawGhCommitEntry[] | null
  comments?: RawGhComment[] | null
}

async function fetchPrDetailFromGh(
  cwd: string,
  prNumber: number
): Promise<GhPullRequestDetail | null> {
  const pathEnv = await resolveGhPathEnv()

  try {
    const { stdout } = await execFile(
      'gh',
      ['pr', 'view', String(prNumber), '--json', DETAIL_FIELDS],
      {
        cwd,
        env: { ...process.env, PATH: pathEnv },
        timeout: DETAIL_TIMEOUT_MS,
        maxBuffer: DETAIL_MAX_BUFFER
      }
    )
    const raw = JSON.parse(stdout) as RawGhPrDetail
    return parsePrDetail(raw)
  } catch {
    // gh missing / unauth / no remote / network — render nothing.
    return null
  }
}

function parsePrDetail(raw: RawGhPrDetail): GhPullRequestDetail {
  return {
    ...parseDetailMeta(raw),
    labels: parseLabels(raw.labels),
    assignees: (raw.assignees ?? []).map((a) => a.login).filter((l): l is string => Boolean(l)),
    reviewRequests: parseReviewRequests(raw.reviewRequests),
    reviews: parseReviews(raw.reviews),
    reviewDecision: normalizeReviewDecision(raw.reviewDecision),
    milestone: parseMilestone(raw.milestone),
    commits: parseCommits(raw.commits, raw.url),
    checks: parseChecks(raw.statusCheckRollup),
    comments: { general: parseGeneralComments(raw.comments) }
  }
}

function parseDetailMeta(
  raw: RawGhPrDetail
): Omit<
  GhPullRequestDetail,
  | 'labels'
  | 'assignees'
  | 'reviewRequests'
  | 'reviews'
  | 'reviewDecision'
  | 'milestone'
  | 'commits'
  | 'checks'
  | 'comments'
> {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? '',
    state: deriveState(raw.state, raw.isDraft),
    url: raw.url,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    author: raw.author?.login ?? null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    mergeable: normalizeMergeable(raw.mergeable),
    mergeStateStatus: raw.mergeStateStatus ?? 'UNKNOWN',
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    changedFiles: raw.changedFiles ?? 0
  }
}

function normalizeMergeable(raw: string | null | undefined): GhPullRequestDetail['mergeable'] {
  const s = (raw ?? '').toUpperCase()
  if (s === 'MERGEABLE') return 'MERGEABLE'
  if (s === 'CONFLICTING') return 'CONFLICTING'
  return 'UNKNOWN'
}

function parseLabels(raw: RawGhLabel[] | null | undefined): GhLabel[] {
  if (!raw) return []
  return raw.map((l) => ({
    name: l.name ?? '',
    color: l.color ?? '',
    description: l.description ?? null
  }))
}

function parseReviewRequests(raw: RawGhReviewRequest[] | null | undefined): GhReviewRequest[] {
  if (!raw) return []
  return raw.map((r) => {
    if ('requestedReviewer' in r && r.requestedReviewer) {
      const rr = r.requestedReviewer
      return { login: rr.login ?? rr.name ?? '', isTeam: rr.__typename === 'Team' }
    }
    if ('login' in r) {
      return { login: r.login ?? r.name ?? '', isTeam: r.__typename === 'Team' }
    }
    return { login: '', isTeam: false }
  })
}

function normalizeReviewState(raw: string | undefined): GhReviewState {
  const s = (raw ?? '').toUpperCase()
  if (
    s === 'APPROVED' ||
    s === 'CHANGES_REQUESTED' ||
    s === 'COMMENTED' ||
    s === 'DISMISSED' ||
    s === 'PENDING'
  ) {
    return s
  }
  return 'COMMENTED'
}

function parseReviews(raw: RawGhReview[] | null | undefined): GhReview[] {
  if (!raw) return []
  return raw.map((r) => ({
    id: String(r.id ?? ''),
    author: r.author?.login ?? '',
    state: normalizeReviewState(r.state),
    submittedAt: r.submittedAt ?? null,
    body: r.body ?? ''
  }))
}

function parseMilestone(raw: RawGhMilestone): GhMilestone | null {
  if (!raw) return null
  return { title: raw.title ?? '', url: raw.url ?? '', dueOn: raw.dueOn ?? null }
}

function parseCommits(raw: RawGhCommitEntry[] | null | undefined, prUrl: string): GhCommit[] {
  if (!raw) return []
  // Derive the repo base URL from the PR's own url
  // (".../<owner>/<repo>/pull/<n>" -> ".../<owner>/<repo>") so each commit
  // gets a real GitHub link without a separate gh call (§5 of the research doc).
  const repoBase = prUrl.replace(/\/pull\/\d+\/?$/, '')
  return raw.map((c) => {
    const primaryAuthor = c.authors?.[0]
    return {
      oid: c.oid ?? '',
      messageHeadline: c.messageHeadline ?? '',
      messageBody: c.messageBody ?? '',
      authoredDate: c.authoredDate ?? '',
      committedDate: c.committedDate ?? '',
      authorLogin: primaryAuthor?.login ?? null,
      authorName: primaryAuthor?.name ?? primaryAuthor?.login ?? '',
      url: c.oid ? `${repoBase}/commit/${c.oid}` : ''
    }
  })
}

function normalizeCheckState(
  status: string,
  conclusion: string,
  legacyState: string
): GhCheckState {
  // CheckRun shape: status/conclusion. Legacy StatusContext shape: state only.
  if (legacyState) {
    if (legacyState === 'SUCCESS') return 'success'
    if (legacyState === 'ERROR' || legacyState === 'FAILURE') return 'failure'
    if (legacyState === 'PENDING') return 'pending'
    return 'neutral'
  }
  if (status && status !== 'COMPLETED') return 'pending'
  if (conclusion === 'SUCCESS') return 'success'
  if (conclusion === 'FAILURE' || conclusion === 'TIMED_OUT' || conclusion === 'CANCELLED') {
    return 'failure'
  }
  if (conclusion === 'ACTION_REQUIRED' || conclusion === 'STALE') return 'failure'
  if (conclusion === 'SKIPPED' || conclusion === 'NEUTRAL') return 'neutral'
  return 'neutral'
}

function parseChecks(raw: RawGhCheck[] | null | undefined): GhCheck[] {
  if (!raw) return []
  return raw.map((c) => {
    const isStatusContext = c.__typename === 'StatusContext'
    const status = (c.status ?? '').toUpperCase()
    const conclusion = (c.conclusion ?? '').toUpperCase()
    const legacyState = (c.state ?? '').toUpperCase()
    return {
      name: (isStatusContext ? c.context : c.name) ?? '',
      workflowName: c.workflowName ?? null,
      state: normalizeCheckState(status, conclusion, legacyState),
      url: c.detailsUrl ?? c.targetUrl ?? null,
      startedAt: c.startedAt ?? null,
      completedAt: c.completedAt ?? null
    }
  })
}

function parseGeneralComments(raw: RawGhComment[] | null | undefined): GhGeneralComment[] {
  if (!raw) return []
  return raw.map((c) => ({
    id: c.id ?? '',
    author: c.author?.login ?? '',
    authorAssociation: c.authorAssociation ?? '',
    body: c.body ?? '',
    createdAt: c.createdAt ?? '',
    url: c.url ?? '',
    isMinimized: c.isMinimized ?? false
  }))
}

// ---------------------------------------------------------------------------
// PR review comments (Workbench Git tab, Phase 4a) — line-anchored comments
// on the PR diff, threaded. Separate `gh api` call from prDetail above (own
// cache/TTL) — see docs/learnings/pr-comments.md for the full research this
// mirrors: the command, the field shapes, the `in_reply_to_id ?? id`
// threading rule (verified live: 0 reply-to-reply chains across 41 comments
// on PR #105), and the Pierre DiffLineAnnotation mapping the renderer builds
// from the threads this returns.
// ---------------------------------------------------------------------------

// A PR with many reviewers/threads can produce a sizeable paginated payload
// (41 comments on PR #105 already ran several KB) — same generous
// timeout/buffer class as the detail fetch above.
const REVIEW_COMMENTS_TIMEOUT_MS = 10_000
const REVIEW_COMMENTS_MAX_BUFFER = 4 * 1024 * 1024

type ReviewCommentsCacheEntry = { value: GhReviewCommentThread[] | null; fetchedAt: number }
const reviewCommentsCache = new Map<string, ReviewCommentsCacheEntry>()
const REVIEW_COMMENTS_TTL_MS = 2 * 60 * 1000
const reviewCommentsInflight = new Map<string, Promise<GhReviewCommentThread[] | null>>()

function reviewCommentsCacheKey(cwd: string, prNumber: number): string {
  return `${cwd}\0${prNumber}`
}

// Raw shape of one element from `gh api .../pulls/{n}/comments` — only the
// fields Phase 4a actually consumes (see pr-comments.md's confirmed key
// list for the full set gh returns; everything else is left off this repo's
// local raw type, per github.ts's existing convention of normalizing into
// the shared Gh* types before crossing into src/shared/types.ts).
type RawGhReviewComment = {
  id: number
  in_reply_to_id?: number | null
  path?: string
  line?: number | null
  original_line?: number | null
  side?: string
  subject_type?: string
  body?: string
  user?: { login?: string | null } | null
  created_at?: string
  html_url?: string
}

function normalizeReviewCommentSide(raw: string | undefined): GhReviewCommentSide {
  return raw === 'LEFT' ? 'LEFT' : 'RIGHT'
}

function parseRawReviewComment(raw: RawGhReviewComment): GhReviewComment {
  return {
    id: raw.id,
    inReplyToId: raw.in_reply_to_id ?? null,
    path: raw.path ?? '',
    line: raw.line ?? null,
    originalLine: raw.original_line ?? null,
    side: normalizeReviewCommentSide(raw.side),
    subjectType: raw.subject_type === 'file' ? 'file' : 'line',
    body: raw.body ?? '',
    authorLogin: raw.user?.login ?? '',
    createdAt: raw.created_at ?? '',
    htmlUrl: raw.html_url ?? ''
  }
}

/** Groups a flat list of parsed review comments into threads keyed on
 *  `in_reply_to_id ?? id` (confirmed correct against real data — see
 *  pr-comments.md: 0 reply-to-reply chains found across 41 comments, so
 *  every reply's `in_reply_to_id` points directly at its thread's root).
 *  Root-comment-first bookkeeping (`roots`) means a reply that happens to
 *  arrive before its root in `gh`'s own ordering still threads correctly —
 *  the map is keyed purely by id, not by array position. */
function groupReviewCommentsIntoThreads(
  raw: readonly RawGhReviewComment[]
): GhReviewCommentThread[] {
  const comments = raw.map(parseRawReviewComment)
  const roots = new Map<number, GhReviewComment>()
  const byRoot = new Map<number, GhReviewComment[]>()

  for (const comment of comments) {
    if (comment.inReplyToId === null) roots.set(comment.id, comment)
  }
  for (const comment of comments) {
    const rootId = comment.inReplyToId ?? comment.id
    const bucket = byRoot.get(rootId)
    if (bucket) bucket.push(comment)
    else byRoot.set(rootId, [comment])
  }

  const threads: GhReviewCommentThread[] = []
  for (const [rootId, bucket] of byRoot) {
    const root = roots.get(rootId) ?? bucket.find((c) => c.id === rootId) ?? bucket[0]
    if (!root) continue
    const sorted = [...bucket].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    )
    threads.push({
      id: rootId,
      path: root.path,
      line: root.line ?? root.originalLine,
      side: root.side,
      subjectType: root.subjectType,
      outdated: root.line === null,
      comments: sorted
    })
  }
  return threads
}

async function fetchReviewCommentsFromGh(
  cwd: string,
  prNumber: number
): Promise<GhReviewCommentThread[] | null> {
  const pathEnv = await resolveGhPathEnv()
  try {
    const { stdout } = await execFile(
      'gh',
      [
        'api',
        `repos/{owner}/{repo}/pulls/${prNumber}/comments`,
        '--paginate',
        // `--paginate` alone emits each page as its OWN top-level JSON array
        // (per `gh api --help`: "Each page is a separate JSON array"), not
        // one merged array — `--slurp` wraps every page into a single outer
        // array so a multi-page PR (>100 review comments) still parses as
        // one `JSON.parse` call instead of needing to split gh's raw stdout
        // into per-page chunks.
        '--slurp'
      ],
      {
        cwd,
        env: { ...process.env, PATH: pathEnv },
        timeout: REVIEW_COMMENTS_TIMEOUT_MS,
        maxBuffer: REVIEW_COMMENTS_MAX_BUFFER
      }
    )
    const pages = JSON.parse(stdout) as RawGhReviewComment[][]
    const raw = pages.flat()
    return groupReviewCommentsIntoThreads(raw)
  } catch {
    // gh missing / unauth / no remote / network — degrade to null; the
    // caller renders the PR diff with no annotations rather than blanking
    // the rest of the PR-diff view.
    return null
  }
}

/**
 * Fetch + thread the line-anchored PR review comments for the PR opened
 * against `workspaceId`'s current branch (Workbench Git tab, Phase 4a).
 * Resolves workspaceId -> cwd -> branch -> PR number via the SAME
 * `getPrDetail` used by `getPrDiff` (gitDiff.ts), then makes its own
 * separate `gh api .../comments` call (own cache/TTL, per
 * docs/learnings/pr-comments.md — this is deliberately NOT folded into
 * prDetail's fetch). Total — never throws: no cwd / no branch / no PR / gh
 * missing / unauth / network all resolve to null.
 */
export async function getPrReviewComments(
  cwd: string | null
): Promise<GhReviewCommentThread[] | null> {
  if (!cwd) return null

  const detail = await getPrDetail(cwd)
  if (!detail) return null

  const key = reviewCommentsCacheKey(cwd, detail.number)
  const now = Date.now()

  const hit = reviewCommentsCache.get(key)
  if (hit && now - hit.fetchedAt < REVIEW_COMMENTS_TTL_MS) return hit.value

  const pending = reviewCommentsInflight.get(key)
  if (pending) return pending

  const promise = fetchReviewCommentsFromGh(cwd, detail.number).finally(() =>
    reviewCommentsInflight.delete(key)
  )
  reviewCommentsInflight.set(key, promise)
  const value = await promise
  putWithEviction(
    reviewCommentsCache,
    key,
    { value, fetchedAt: Date.now() },
    REVIEW_COMMENTS_TTL_MS
  )
  return value
}

// ---------------------------------------------------------------------------
// PR write operations (Workbench Git tab, Phase 4c) — the FIRST write calls
// to GitHub this module makes. Everything above this point is read-only
// (`gh pr list`/`gh pr view`/`gh api ... GET`); the three functions below
// (postReviewComment / replyToReviewComment / postGeneralComment) are the
// only ones that mutate the real PR. All three:
//   - are TOTAL — never throw. `gh api`'s failure mode (auth/rate-limit/
//     network/422 validation) rejects the underlying execFile call; that
//     rejection's `.stdout` (gh writes the JSON error BODY to stdout, a short
//     one-line summary to stderr — confirmed live against a real 422) is
//     parsed for a `message`/`errors[].message` when present, falling back to
//     the raw stderr/Error.message otherwise. See extractGhErrorMessage.
//   - pass the comment BODY (arbitrary multi-line markdown — quotes,
//     backticks, `$vars`, newlines) as a single discrete execFile ARGV
//     element (`-f body=<value>`), never interpolated into a shell string —
//     execFile (not exec/spawn-with-shell) invokes the binary directly, so
//     there is no shell to interpret `$`/backticks/quotes inside that
//     argument in the first place. This was verified against a real payload
//     containing newlines + quotes + `$` + backticks before wiring the
//     renderer call sites.
//   - use `-F` (gh's TYPED field flag) for the integer `line`, and `-f`
//     (STRING field flag) for path/side/body/commit_id — matches gh's own
//     `-f`/`-F` type distinction (see `gh api --help`).
//   - invalidate the relevant cache (review-comments or detail) on success so
//     the very next read reflects the write instead of serving a stale TTL
//     hit — the renderer additionally does its own explicit refetch, but this
//     keeps the server-side cache from fighting that refetch for the next
//     `REVIEW_COMMENTS_TTL_MS`/`DETAIL_TTL_MS` window.
// ---------------------------------------------------------------------------

export type GhWriteResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** Parses `gh`'s own JSON error-body convention (GitHub's `{message,
 *  errors:[{message, field, ...}]}` shape) out of a failed call's stdout,
 *  preferring the most specific `errors[].message` over the top-level
 *  `message`. Returns null when stdout is empty/not that shape — the caller
 *  falls back to stderr/Error.message in that case. Split out of
 *  extractGhErrorMessage so that function's own branching stays under the
 *  cognitive-complexity ceiling. */
function parseGhStdoutErrorMessage(stdout: unknown): string | null {
  if (typeof stdout !== 'string' || stdout.trim().length === 0) return null
  try {
    const parsed = JSON.parse(stdout) as {
      message?: string
      errors?: Array<{ message?: string; field?: string }>
    }
    const first = parsed.errors?.find((e) => typeof e.message === 'string')?.message
    if (first) return first
    if (typeof parsed.message === 'string' && parsed.message.length > 0) return parsed.message
    return null
  } catch {
    return null
  }
}

/** Best-effort extraction of a readable message from a failed `gh api`/`gh pr`
 *  execFile call. `gh` writes the JSON error body (GitHub's own `{message,
 *  errors:[...]}` shape) to STDOUT and a one-line human summary to STDERR —
 *  confirmed live against a real 422 (`gh: Validation Failed (HTTP 422)` on
 *  stderr, the full validation-errors JSON on stdout). Prefers the parsed
 *  stdout JSON's `errors[].message`/`message` (most specific, via
 *  parseGhStdoutErrorMessage above), then falls back to stderr, then to the
 *  raw Error.message (e.g. "gh: command not found", which never touches
 *  stdout/stderr at all). */
function extractGhErrorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const withStreams = err as { stdout?: unknown; stderr?: unknown; message?: unknown }
    const fromStdout = parseGhStdoutErrorMessage(withStreams.stdout)
    if (fromStdout) return fromStdout
    if (typeof withStreams.stderr === 'string' && withStreams.stderr.trim().length > 0) {
      return withStreams.stderr.trim()
    }
    if (typeof withStreams.message === 'string' && withStreams.message.length > 0) {
      return withStreams.message
    }
  }
  return err instanceof Error ? err.message : String(err)
}

/** Resolves `cwd` -> the PR opened against its current branch -> that PR's
 *  number + head commit sha (`headRefOid`) — the two pieces of context every
 *  write below needs (the PR number for the API path, the head sha as
 *  `commit_id` for a brand-new line comment). A dedicated `gh pr view
 *  --json headRefOid` call rather than threading `headRefOid` through the
 *  existing `getPrDetail`/`GhPullRequestDetail` (whose `commits[]` already
 *  carries every commit's oid, including the head's — see gitDiff/github's
 *  own commits parsing) — kept separate so this module's one write-side
 *  resolver doesn't couple to prDetail's larger, differently-cached fetch/
 *  shape for what's ultimately one scalar field. Total: null on any failure
 *  (no cwd, no branch, no PR, gh missing/unauth/network). */
async function resolvePrWriteContext(
  cwd: string | null
): Promise<{ prNumber: number; headOid: string } | null> {
  if (!cwd) return null
  const branch = await resolveCurrentBranch(cwd)
  if (!branch) return null
  const pr = await getPrForBranch(cwd, branch)
  if (!pr) return null
  const pathEnv = await resolveGhPathEnv()
  try {
    const { stdout } = await execFile(
      'gh',
      ['pr', 'view', String(pr.number), '--json', 'headRefOid'],
      { cwd, env: { ...process.env, PATH: pathEnv }, timeout: 8000, maxBuffer: 64 * 1024 }
    )
    const parsed = JSON.parse(stdout) as { headRefOid?: string }
    if (!parsed.headRefOid) return null
    return { prNumber: pr.number, headOid: parsed.headRefOid }
  } catch {
    return null
  }
}

export type PostReviewCommentArgs = {
  workspaceId: string
  cwd: string | null
  path: string
  line: number
  side: GhReviewCommentSide
  body: string
  /** Optional explicit commit sha — when omitted, resolved server-side from
   *  the PR's current head (`resolvePrWriteContext`). The renderer passes the
   *  head sha it already has from `prDetail.commits`, but this stays
   *  resolvable server-side too so a stale/missing client-side sha degrades
   *  to "use the real current head" instead of failing outright. */
  commitId?: string
}

/** Posts a NEW line-anchored review comment (Workbench Git tab, Phase 4c —
 *  the gutter "+"/select-to-comment composer's submit). Mirrors
 *  `gh api repos/{owner}/{repo}/pulls/{n}/comments -f body=<body> -f
 *  commit_id=<sha> -f path=<path> -F line=<line> -f side=<LEFT|RIGHT>`
 *  exactly, via execFile (body passed as one argv element — see the module
 *  header above). On success, invalidates BOTH the review-comments cache
 *  (a fresh `gh api .../comments` GET would otherwise serve a stale TTL hit
 *  that doesn't yet include the just-created comment) and the detail cache
 *  (comment counts, if ever surfaced there). Total — never throws. */
export async function postReviewComment(
  args: PostReviewCommentArgs
): Promise<GhWriteResult<GhReviewComment>> {
  const { cwd, path, line, side, body } = args
  if (!cwd) return { ok: false, error: 'Workspace not found' }

  const ctx = await resolvePrWriteContext(cwd)
  if (!ctx) return { ok: false, error: 'No pull request found for this branch' }
  const commitId = args.commitId && args.commitId.length > 0 ? args.commitId : ctx.headOid

  const pathEnv = await resolveGhPathEnv()
  try {
    const { stdout } = await execFile(
      'gh',
      [
        'api',
        `repos/{owner}/{repo}/pulls/${ctx.prNumber}/comments`,
        '-f',
        `body=${body}`,
        '-f',
        `commit_id=${commitId}`,
        '-f',
        `path=${path}`,
        '-F',
        `line=${line}`,
        '-f',
        `side=${side}`
      ],
      {
        cwd,
        env: { ...process.env, PATH: pathEnv },
        timeout: REVIEW_COMMENTS_TIMEOUT_MS,
        maxBuffer: REVIEW_COMMENTS_MAX_BUFFER
      }
    )
    const raw = JSON.parse(stdout) as RawGhReviewComment
    reviewCommentsCache.delete(reviewCommentsCacheKey(cwd, ctx.prNumber))
    detailCache.delete(detailCacheKey(cwd, ctx.prNumber))
    return { ok: true, value: parseRawReviewComment(raw) }
  } catch (err) {
    return { ok: false, error: extractGhErrorMessage(err) }
  }
}

export type ReplyToReviewCommentArgs = {
  cwd: string | null
  commentId: number
  body: string
}

/** Posts a reply to an existing review-comment thread (Phase 4c — the
 *  ReviewCommentThread "Reply" affordance). Mirrors `gh api
 *  repos/{owner}/{repo}/pulls/{n}/comments/{commentId}/replies -f
 *  body=<body>` exactly. Needs the PR number for the API path (GitHub's
 *  replies endpoint is nested under the PR, not comment-id-only), resolved
 *  the same way postReviewComment does. Total — never throws; invalidates
 *  the review-comments cache on success, same reasoning as postReviewComment. */
export async function replyToReviewComment(
  args: ReplyToReviewCommentArgs
): Promise<GhWriteResult<GhReviewComment>> {
  const { cwd, commentId, body } = args
  if (!cwd) return { ok: false, error: 'Workspace not found' }

  const ctx = await resolvePrWriteContext(cwd)
  if (!ctx) return { ok: false, error: 'No pull request found for this branch' }

  const pathEnv = await resolveGhPathEnv()
  try {
    const { stdout } = await execFile(
      'gh',
      [
        'api',
        `repos/{owner}/{repo}/pulls/${ctx.prNumber}/comments/${commentId}/replies`,
        '-f',
        `body=${body}`
      ],
      {
        cwd,
        env: { ...process.env, PATH: pathEnv },
        timeout: REVIEW_COMMENTS_TIMEOUT_MS,
        maxBuffer: REVIEW_COMMENTS_MAX_BUFFER
      }
    )
    const raw = JSON.parse(stdout) as RawGhReviewComment
    reviewCommentsCache.delete(reviewCommentsCacheKey(cwd, ctx.prNumber))
    return { ok: true, value: parseRawReviewComment(raw) }
  } catch (err) {
    return { ok: false, error: extractGhErrorMessage(err) }
  }
}

export type PostGeneralCommentArgs = {
  cwd: string | null
  body: string
}

/** Posts a general (non-line-anchored) PR comment — the Details tab's
 *  "Conversation" composer (Phase 4c). Mirrors `gh pr comment <n> --body
 *  <body>` (rather than the equivalent `gh api .../issues/{n}/comments`
 *  call — `gh pr comment` is the documented, more direct CLI surface for
 *  this specific action and needs no separate owner/repo/number
 *  interpolation into a raw REST path). Total — never throws; invalidates
 *  the detail cache on success so the next `github:prDetail` fetch picks up
 *  the new comment in its timeline. */
export async function postGeneralComment(
  args: PostGeneralCommentArgs
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { cwd, body } = args
  if (!cwd) return { ok: false, error: 'Workspace not found' }

  const ctx = await resolvePrWriteContext(cwd)
  if (!ctx) return { ok: false, error: 'No pull request found for this branch' }

  const pathEnv = await resolveGhPathEnv()
  try {
    await execFile('gh', ['pr', 'comment', String(ctx.prNumber), '--body', body], {
      cwd,
      env: { ...process.env, PATH: pathEnv },
      timeout: REVIEW_COMMENTS_TIMEOUT_MS,
      maxBuffer: REVIEW_COMMENTS_MAX_BUFFER
    })
    detailCache.delete(detailCacheKey(cwd, ctx.prNumber))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: extractGhErrorMessage(err) }
  }
}
