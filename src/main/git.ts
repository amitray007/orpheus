import * as childProcess from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(childProcess.execFile)

export type GitStatus = {
  /** Working-tree changes vs HEAD: counted lines added */
  insertions: number
  /** Working-tree changes vs HEAD: counted lines removed */
  deletions: number
  /** True if either insertions/deletions > 0 OR there are untracked files */
  hasChanges: boolean
  /** Current branch name, e.g. "main" or "feature/x" — or null if detached HEAD */
  branch: string | null
}

/**
 * Read working-tree git status for the given cwd.
 *
 * Returns null if cwd is not inside a git repository OR if git is unavailable.
 * Errors are swallowed — git status failures shouldn't crash Orpheus.
 *
 * Uses `git -C <cwd>` so we don't need to chdir. All three git commands run
 * in parallel to avoid sequential blocking on slow repos.
 */
export async function getGitStatus(cwd: string): Promise<GitStatus | null> {
  if (!cwd) return null

  // Quick check: is this a git repo?
  try {
    await execFile('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], {
      timeout: 1500
    })
  } catch {
    return null
  }

  // Run branch, diff, and untracked queries in parallel.
  const [branchResult, diffResult, untrackedResult] = await Promise.all([
    execFile('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeout: 1500
    }).catch(() => null),
    execFile('git', ['-C', cwd, 'diff', '--shortstat', 'HEAD'], {
      timeout: 2000
    }).catch(() => null),
    execFile('git', ['-C', cwd, 'ls-files', '--others', '--exclude-standard'], {
      timeout: 1500
    }).catch(() => null)
  ])

  let branch: string | null = null
  if (branchResult) {
    const out = branchResult.stdout.trim()
    // Detached HEAD reports literal "HEAD"
    branch = out === 'HEAD' ? null : out || null
  }

  let insertions = 0
  let deletions = 0
  if (diffResult) {
    // Output looks like: " 2 files changed, 113 insertions(+), 0 deletions(-)"
    const out = diffResult.stdout
    const insMatch = out.match(/(\d+)\s+insertion/)
    const delMatch = out.match(/(\d+)\s+deletion/)
    if (insMatch) insertions = parseInt(insMatch[1], 10)
    if (delMatch) deletions = parseInt(delMatch[1], 10)
  }

  let untrackedCount = 0
  if (untrackedResult) {
    untrackedCount = untrackedResult.stdout.split('\n').filter((line) => line.length > 0).length
  }

  const hasChanges = insertions > 0 || deletions > 0 || untrackedCount > 0
  return { insertions, deletions, hasChanges, branch }
}

export type GitBranchInfo = {
  name: string
  isCurrent: boolean
  /** Last commit timestamp on this branch (epoch ms); null if unknown */
  lastCommitAt: number | null
}

export type GitCommit = {
  sha: string // short, 7 chars
  fullSha: string
  subject: string
  author: string
  authorEmail: string
  timestamp: number // epoch ms
}

export function listBranches(cwd: string): GitBranchInfo[] {
  if (!cwd) return []
  try {
    const out = childProcess.execFileSync(
      'git',
      [
        '-C',
        cwd,
        'for-each-ref',
        'refs/heads/',
        '--format=%(refname:short)%09%(committerdate:unix)%09%(HEAD)'
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2500, encoding: 'utf-8' }
    )
    const branches: GitBranchInfo[] = out
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((line) => {
        const [name, tsRaw, head] = line.split('\t')
        const ts = parseInt(tsRaw, 10)
        return {
          name: name.trim(),
          isCurrent: head?.trim() === '*',
          lastCommitAt: isNaN(ts) ? null : ts * 1000
        }
      })
    // Sort most-recently-committed first
    branches.sort((a, b) => {
      if (a.lastCommitAt === null) return 1
      if (b.lastCommitAt === null) return -1
      return b.lastCommitAt - a.lastCommitAt
    })
    return branches
  } catch {
    return []
  }
}

export function countCommits(
  cwd: string,
  opts?: {
    branch?: string
    sinceMs?: number
    untilMs?: number
    grep?: string
  }
): number {
  if (!cwd) return 0
  // `git rev-list --count` accepts the same date / grep filters as `git log`,
  // so the count tracks the listCommits view 1:1 (modulo pagination).
  const args = ['-C', cwd, 'rev-list', '--count']
  if (opts?.sinceMs !== undefined) args.push(`--since=${Math.floor(opts.sinceMs / 1000)}`)
  if (opts?.untilMs !== undefined) args.push(`--until=${Math.floor(opts.untilMs / 1000)}`)
  if (opts?.grep) args.push('-i', `--grep=${opts.grep}`)
  args.push(opts?.branch ?? 'HEAD')
  try {
    const out = childProcess.execFileSync('git', args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      encoding: 'utf-8'
    })
    const n = parseInt(out.trim(), 10)
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

export function listCommits(
  cwd: string,
  opts?: {
    branch?: string
    limit?: number
    offset?: number
    /** Unix-epoch-ms lower bound for committer date. */
    sinceMs?: number
    /** Unix-epoch-ms upper bound for committer date. */
    untilMs?: number
    /** Substring filter against commit subject (case-insensitive). */
    grep?: string
  }
): GitCommit[] {
  if (!cwd) return []
  const limit = opts?.limit ?? 25
  const offset = opts?.offset ?? 0
  const args = ['-C', cwd, 'log']
  if (opts?.branch) args.push(opts.branch)
  if (opts?.sinceMs !== undefined) {
    args.push(`--since=${Math.floor(opts.sinceMs / 1000)}`)
  }
  if (opts?.untilMs !== undefined) {
    args.push(`--until=${Math.floor(opts.untilMs / 1000)}`)
  }
  if (opts?.grep) {
    // Case-insensitive subject grep; git matches against the commit message.
    args.push('-i', `--grep=${opts.grep}`)
  }
  args.push(
    `--max-count=${limit}`,
    `--skip=${offset}`,
    '--format=%H%x09%h%x09%s%x09%an%x09%ae%x09%ct'
  )
  try {
    const out = childProcess.execFileSync('git', args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      encoding: 'utf-8'
    })
    return out
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((line) => {
        const parts = line.split('\t')
        const ts = parseInt(parts[5], 10)
        return {
          fullSha: parts[0] ?? '',
          sha: parts[1] ?? '',
          subject: parts[2] ?? '',
          author: parts[3] ?? '',
          authorEmail: parts[4] ?? '',
          timestamp: isNaN(ts) ? 0 : ts * 1000
        }
      })
  } catch {
    return []
  }
}
