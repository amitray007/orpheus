import * as childProcess from 'node:child_process'
import { promisify } from 'node:util'
import { getUserShellPath } from './shellHelpers'
import type { GhPullRequest, GhPullRequestState } from '../shared/types'

const execFile = promisify(childProcess.execFile)

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
  prCache.set(key, { value, fetchedAt: Date.now() })
  return value
}

async function fetchPrFromGh(cwd: string, branch: string): Promise<GhPullRequest | null> {
  // Finder-launched Electron starts with a stripped PATH; getUserShellPath()
  // grabs the user's login-shell PATH so `gh` resolves the same way it does
  // in their terminal.
  let pathEnv: string
  try {
    pathEnv = await getUserShellPath()
  } catch {
    pathEnv = process.env['PATH'] ?? ''
  }

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

/** Invalidate every cache entry — used when the user opts to refresh manually. */
export function clearGithubPrCache(): void {
  prCache.clear()
}
