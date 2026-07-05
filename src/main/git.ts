import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as nodePath from 'node:path'
import { promisify } from 'node:util'
import type { WebContents } from 'electron'
import { getWorkspace } from './workspaces'
import { PUSH_CHANNELS } from '../shared/ipc'

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
  /** Count of untracked (new) files */
  newFiles: number
  /** Count of tracked files with modifications (working tree vs HEAD) */
  modifiedFiles: number
  /** Count of deleted files (working tree vs HEAD) */
  deletedFiles: number
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

  // Run branch, diff, and porcelain queries in parallel.
  const [branchResult, diffResult, porcelainResult] = await Promise.all([
    execFile('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeout: 1500
    }).catch(() => null),
    execFile('git', ['-C', cwd, 'diff', '--shortstat', 'HEAD'], {
      timeout: 2000
    }).catch(() => null),
    execFile('git', ['-C', cwd, 'status', '--porcelain'], { timeout: 2000 }).catch(() => null)
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

  let newFiles = 0
  let modifiedFiles = 0
  let deletedFiles = 0
  if (porcelainResult) {
    for (const line of porcelainResult.stdout.split('\n')) {
      if (line.length < 2) continue
      const xy = line.slice(0, 2)
      if (xy === '??' || xy[0] === 'A' || xy[1] === 'A') {
        newFiles++
      } else if (xy.includes('D')) {
        deletedFiles++
      } else if (xy.includes('M')) {
        modifiedFiles++
      }
    }
  }

  const hasChanges =
    insertions > 0 || deletions > 0 || newFiles > 0 || modifiedFiles > 0 || deletedFiles > 0
  return { insertions, deletions, hasChanges, branch, newFiles, modifiedFiles, deletedFiles }
}

/**
 * `git init` for the Workbench Git tab's "Not a git repository" empty state
 * (Phase 2). Total — never throws: returns a discriminated result so the
 * renderer can show inline success/failure feedback instead of an unhandled
 * rejection. The caller (src/main/ipc/git.ts) is responsible for refetching
 * `git:diff` afterward — this function only runs `git init`, it doesn't
 * re-derive diff state itself.
 */
export async function gitInit(cwd: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!cwd) return { ok: false, error: 'No workspace directory' }
  try {
    await execFile('git', ['-C', cwd, 'init'], { timeout: 5000 })
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
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
  filesChanged: number
  insertions: number
  deletions: number
}

export async function listBranches(cwd: string): Promise<GitBranchInfo[]> {
  if (!cwd) return []
  try {
    const { stdout } = await execFile(
      'git',
      [
        '-C',
        cwd,
        'for-each-ref',
        'refs/heads/',
        '--format=%(refname:short)%09%(committerdate:unix)%09%(HEAD)'
      ],
      { timeout: 2500 }
    )
    const branches: GitBranchInfo[] = stdout
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

export async function countCommits(
  cwd: string,
  opts?: {
    branch?: string
    sinceMs?: number
    untilMs?: number
    grep?: string
  }
): Promise<number> {
  if (!cwd) return 0
  // `git rev-list --count` accepts the same date / grep filters as `git log`,
  // so the count tracks the listCommits view 1:1 (modulo pagination).
  const args = ['-C', cwd, 'rev-list', '--count']
  if (opts?.sinceMs !== undefined) args.push(`--since=${Math.floor(opts.sinceMs / 1000)}`)
  if (opts?.untilMs !== undefined) args.push(`--until=${Math.floor(opts.untilMs / 1000)}`)
  if (opts?.grep) args.push('-i', `--grep=${opts.grep}`)
  args.push(opts?.branch ?? 'HEAD')
  try {
    const { stdout } = await execFile('git', args, { timeout: 3000 })
    const n = parseInt(stdout.trim(), 10)
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
  // SENTINEL prefixes every commit's metadata line so the parser can
  // distinguish it from --shortstat lines that follow ("3 files changed, ...").
  // Without it, multi-line shortstat output would shred line-based splitting.
  const SENTINEL = '__ORPH_COMMIT__'
  args.push(
    '--shortstat',
    `--max-count=${limit}`,
    `--skip=${offset}`,
    `--format=${SENTINEL}%H%x09%h%x09%s%x09%an%x09%ae%x09%ct`
  )
  try {
    const out = childProcess.execFileSync('git', args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      encoding: 'utf-8'
    })
    const commits: GitCommit[] = []
    let current: GitCommit | null = null
    // shortstat: " 3 files changed, 124 insertions(+), 38 deletions(-)"
    // insertions or deletions may be absent (pure additions / pure deletions).
    const statRe =
      /(\d+)\s+files?\s+changed(?:,\s*(\d+)\s+insertions?\(\+\))?(?:,\s*(\d+)\s+deletions?\(-\))?/
    for (const raw of out.split('\n')) {
      if (raw.startsWith(SENTINEL)) {
        if (current) commits.push(current)
        const parts = raw.slice(SENTINEL.length).split('\t')
        const ts = parseInt(parts[5], 10)
        current = {
          fullSha: parts[0] ?? '',
          sha: parts[1] ?? '',
          subject: parts[2] ?? '',
          author: parts[3] ?? '',
          authorEmail: parts[4] ?? '',
          timestamp: isNaN(ts) ? 0 : ts * 1000,
          filesChanged: 0,
          insertions: 0,
          deletions: 0
        }
        continue
      }
      if (!current) continue
      const m = statRe.exec(raw)
      if (m) {
        current.filesChanged = parseInt(m[1] ?? '0', 10) || 0
        current.insertions = m[2] ? parseInt(m[2], 10) || 0 : 0
        current.deletions = m[3] ? parseInt(m[3], 10) || 0 : 0
      }
    }
    if (current) commits.push(current)
    return commits
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Git fs.watch push infrastructure
//
// Watches .git/HEAD and .git/index for a repo so that git status + PR
// updates can be pushed to the renderer instead of polled every 30s.
//
// Ref-counted by directory: multiple workspaces pointing at the same repo
// share a single pair of watchers. On branch change (HEAD changed), also
// refreshes PRs via the provided pr-refresh callback.
// ---------------------------------------------------------------------------

import { getPrForBranch } from './github'

type GitWatchEntry = {
  watchers: fs.FSWatcher[]
  refCount: number
  // workspaceId → { cwd, webContents, lastBranch }
  clients: Map<string, { cwd: string; webContents: WebContents; lastBranch: string | null }>
  debounceTimer: ReturnType<typeof setTimeout> | null
}

const gitWatchers = new Map<string, GitWatchEntry>()

// Debounce window for coalescing rapid filesystem events (index lock files
// during a commit generate 4-6 events in quick succession).
const GIT_WATCH_DEBOUNCE_MS = 350

async function refreshGitForDir(dir: string): Promise<void> {
  const entry = gitWatchers.get(dir)
  if (!entry) return
  if (entry.clients.size === 0) return

  // Re-run git status for each client workspace; detect branch changes and
  // refresh PRs if the branch flipped. Each client is independent (keyed by
  // its own workspaceId/webContents), so fan these out in parallel instead
  // of serializing one git subprocess round-trip per client.
  // also addresses PERF-5
  const clientList = Array.from(entry.clients.entries())
  await Promise.all(
    clientList.map(async ([workspaceId, client]) => {
      const { cwd, webContents, lastBranch } = client
      if (webContents.isDestroyed()) return

      let status: GitStatus | null = null
      try {
        status = await getGitStatus(cwd)
      } catch {
        // git may be unavailable or cwd may have been deleted — skip
      }

      if (!webContents.isDestroyed() && status !== null) {
        webContents.send(PUSH_CHANNELS.gitStatusChanged, { workspaceId, status })
      }

      // If branch changed, also refresh the PR
      const newBranch = status?.branch ?? null
      if (newBranch !== lastBranch) {
        client.lastBranch = newBranch
        if (newBranch) {
          getPrForBranch(cwd, newBranch)
            .then((pr) => {
              if (!webContents.isDestroyed()) {
                webContents.send(PUSH_CHANNELS.githubPrChanged, { workspaceId, pr })
              }
            })
            .catch(() => {
              /* gh unavailable — ignore */
            })
        } else if (!webContents.isDestroyed()) {
          // Detached HEAD or no branch — clear the PR chip
          webContents.send(PUSH_CHANNELS.githubPrChanged, { workspaceId, pr: null })
        }
      }
    })
  )
}

function scheduleRefresh(dir: string): void {
  const entry = gitWatchers.get(dir)
  if (!entry) return
  if (entry.debounceTimer !== null) {
    clearTimeout(entry.debounceTimer)
  }
  entry.debounceTimer = setTimeout(() => {
    if (entry.debounceTimer !== null) {
      entry.debounceTimer = null
    }
    refreshGitForDir(dir).catch(() => {
      /* swallow — non-fatal */
    })
  }, GIT_WATCH_DEBOUNCE_MS)
}

function watchGitFiles(dir: string, gitDir: string): fs.FSWatcher[] {
  const watchers: fs.FSWatcher[] = []
  // Watch HEAD (branch changes) and index (staging/commit changes)
  for (const file of ['HEAD', 'index']) {
    const filePath = nodePath.join(gitDir, file)
    try {
      const watcher = fs.watch(filePath, { persistent: false }, () => {
        scheduleRefresh(dir)
      })
      watcher.on('error', () => {
        /* file may not exist in some git states — ignore */
      })
      watchers.push(watcher)
    } catch {
      // File doesn't exist (bare repo, shallow clone, etc.) — skip
    }
  }
  return watchers
}

/**
 * Start watching a workspace's git repo for status changes.
 * On every HEAD or index change, pushes `git:statusChanged` and
 * (on branch flip) `github:prChanged` to the provided webContents.
 * An initial push fires shortly after watch starts so the renderer
 * gets current status without the 30s polling round-trip.
 *
 * Safe to call multiple times for the same cwd — ref-counted.
 *
 * The git rev-parse to locate the .git dir is now async so terminal:mount
 * returns immediately without blocking on the git subprocess. The watcher
 * is set up once the async rev-parse resolves.
 */
export function startGitWatch(workspaceId: string, cwd: string, webContents: WebContents): void {
  if (!cwd) return

  // Kick off the async rev-parse fire-and-forget — terminal:mount returns
  // immediately without waiting for git. The watcher registers once resolved.
  execFile('git', ['-C', cwd, 'rev-parse', '--git-dir'], { timeout: 1500 })
    .then(({ stdout }) => {
      // Guard: the workspace may have been archived/destroyed while the async
      // rev-parse was in flight (stopGitWatch already ran and had nothing to
      // clean up). Registering a watcher now would leak FSWatcher handles.
      if (webContents.isDestroyed()) return
      const w = getWorkspace(workspaceId)
      if (!w || w.closedAt != null) return

      const rel = stdout.trim()
      const gitDir = nodePath.isAbsolute(rel) ? rel : nodePath.join(cwd, rel)

      // Dedup key is the resolved absolute cwd (one watcher entry per cwd).
      // Distinct worktrees keep separate entries even when they share a .git dir.
      const dir = nodePath.resolve(cwd)

      let entry = gitWatchers.get(dir)
      if (!entry) {
        const watchers = watchGitFiles(dir, gitDir)
        entry = { watchers, refCount: 0, clients: new Map(), debounceTimer: null }
        gitWatchers.set(dir, entry)
      }

      // Re-mount guard: if this workspaceId is already a client, update its record
      // and re-emit the initial status push WITHOUT incrementing refCount — avoids
      // double-counting on hide→mount cycles and the resulting watcher leak.
      if (entry.clients.has(workspaceId)) {
        const existing = entry.clients.get(workspaceId)!
        entry.clients.set(workspaceId, { cwd, webContents, lastBranch: existing.lastBranch })
        getGitStatus(cwd)
          .then((status) => {
            if (!webContents.isDestroyed() && status !== null) {
              webContents.send(PUSH_CHANNELS.gitStatusChanged, { workspaceId, status })
            }
          })
          .catch(() => {
            /* git unavailable — skip */
          })
        return
      }

      entry.refCount++
      entry.clients.set(workspaceId, { cwd, webContents, lastBranch: null })

      // Emit an initial status push so the renderer gets current state without
      // waiting for the next file-change event.
      getGitStatus(cwd)
        .then((status) => {
          if (!webContents.isDestroyed() && status !== null) {
            webContents.send(PUSH_CHANNELS.gitStatusChanged, { workspaceId, status })
            const branch = status.branch
            if (branch) {
              const client = entry?.clients.get(workspaceId)
              if (client) client.lastBranch = branch
              getPrForBranch(cwd, branch)
                .then((pr) => {
                  if (!webContents.isDestroyed()) {
                    webContents.send(PUSH_CHANNELS.githubPrChanged, { workspaceId, pr })
                  }
                })
                .catch(() => {
                  /* gh unavailable */
                })
            }
          }
        })
        .catch(() => {
          /* git unavailable — skip initial push */
        })
    })
    .catch(() => {
      // Not a git repo or git unavailable — nothing to watch
    })
}

/**
 * Stop watching a workspace's git repo. Decrements the ref-count for the
 * shared watcher; closes the underlying fs.watch handles only when the last
 * subscriber is removed.
 */
export function stopGitWatch(workspaceId: string, cwd: string): void {
  if (!cwd) return
  const dir = nodePath.resolve(cwd)
  const entry = gitWatchers.get(dir)
  if (!entry) return

  // Guard: only decrement when the workspaceId was actually a registered
  // subscriber. Calling stopGitWatch twice for the same id (e.g. from both
  // terminal:destroy and workspaces:archive in the same death path) would
  // otherwise over-decrement and close the watcher for sibling workspaces.
  const removed = entry.clients.delete(workspaceId)
  if (!removed) return
  entry.refCount--

  if (entry.refCount <= 0) {
    // Last subscriber — tear down the watchers and the debounce timer.
    if (entry.debounceTimer !== null) clearTimeout(entry.debounceTimer)
    for (const w of entry.watchers) {
      try {
        w.close()
      } catch {
        /* ignore */
      }
    }
    gitWatchers.delete(dir)
  }
}

/**
 * Stop all git watchers whose webContents has been destroyed. Called on
 * window close so no orphaned watchers remain after the renderer exits.
 */
export function stopAllGitWatches(): void {
  for (const [dir, entry] of gitWatchers.entries()) {
    if (entry.debounceTimer !== null) clearTimeout(entry.debounceTimer)
    for (const w of entry.watchers) {
      try {
        w.close()
      } catch {
        /* ignore */
      }
    }
    gitWatchers.delete(dir)
  }
}
