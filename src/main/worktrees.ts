/**
 * Git worktree operations, per-repo mutex, and slug helper.
 *
 * Mirrors Claude Code's worktree convention so Orpheus-made worktrees are
 * indistinguishable from claude-made ones.
 */

import * as childProcess from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(childProcess.execFile)

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export type WorktreeErrorKind =
  | 'NotAGitRepo'
  | 'BranchCheckedOutElsewhere'
  | 'PathOccupied'
  | 'WorktreeError'

export class WorktreeError extends Error {
  readonly kind: WorktreeErrorKind
  constructor(kind: WorktreeErrorKind, message: string) {
    super(message)
    this.name = 'WorktreeError'
    this.kind = kind
  }
}

export class NotAGitRepoError extends WorktreeError {
  constructor(cwd: string) {
    super('NotAGitRepo', `Not a git repository: ${cwd}`)
    this.name = 'NotAGitRepoError'
  }
}

export class BranchCheckedOutElsewhereError extends WorktreeError {
  readonly conflictingPath: string
  constructor(branch: string, conflictingPath: string) {
    super(
      'BranchCheckedOutElsewhere',
      `Branch '${branch}' is already checked out at '${conflictingPath}'`
    )
    this.name = 'BranchCheckedOutElsewhereError'
    this.conflictingPath = conflictingPath
  }
}

export class PathOccupiedError extends WorktreeError {
  constructor(p: string) {
    super('PathOccupied', `Worktree path already exists: ${p}`)
    this.name = 'PathOccupiedError'
  }
}

// ---------------------------------------------------------------------------
// Slug helper (§2.1)
// ---------------------------------------------------------------------------

/**
 * Convert a workspace name into a git-safe slug.
 *
 * Rules (per spec §2.1):
 *   1. NFKD normalise, strip combining diacritics
 *   2. Lowercase
 *   3. Replace any run of non-[a-z0-9] with "-"
 *   4. Trim leading/trailing "-"
 *   5. Cap at 40 chars
 *   6. If empty after all of the above → deterministic fallback "wt-<6-char-base36>"
 *      derived from sha1(input) so the same name always maps to the same slug.
 */
export function worktreeSlug(name: string): string {
  // Step 1: NFKD + strip combining marks
  const normalized = name.normalize('NFKD').replace(/[̀-ͯ]/g, '') // strip combining diacritics

  // Step 2+3: lowercase + replace non-alphanum runs
  const slugged = normalized.toLowerCase().replace(/[^a-z0-9]+/g, '-')

  // Step 4: trim dashes
  const trimmed = slugged.replace(/^-+|-+$/g, '')

  // Step 5: cap at 40
  const capped = trimmed.slice(0, 40)

  // Step 6: fallback for empty
  if (capped.length === 0) {
    const hash = crypto.createHash('sha1').update(name).digest('hex')
    // Convert first 8 hex chars to a number, then to base36, take first 6 chars
    const num = parseInt(hash.slice(0, 8), 16)
    const base36 = num.toString(36).slice(0, 6).padStart(6, '0')
    return `wt-${base36}`
  }

  return capped
}

// ---------------------------------------------------------------------------
// Per-repo async mutex
// ---------------------------------------------------------------------------

const repoLocks = new Map<string, Promise<unknown>>()

/**
 * Serialise async operations per repo root.
 *
 * Uses a Map of chained promises keyed by the resolved repoRoot path.
 * Each call appends to the chain; an error from one call does NOT prevent
 * the next caller from running.
 */
export function withRepoLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(repoRoot)
  const prev = repoLocks.get(key) ?? Promise.resolve()
  const next = prev.then(
    () => fn(),
    () => fn()
  )
  // Store a silent version so map entry errors don't surface as unhandled rejections
  repoLocks.set(
    key,
    next.then(
      () => undefined,
      () => undefined
    )
  )
  return next
}

// ---------------------------------------------------------------------------
// resolveMainWorktree
// ---------------------------------------------------------------------------

/**
 * Given any path inside a git repo, return the main worktree root (absolute).
 * Throws NotAGitRepoError if `cwd` is not inside a git repository.
 */
export async function resolveMainWorktree(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFile(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { timeout: 5000 }
    )
    // stdout is e.g. "/repo/.git\n"
    const gitCommonDir = stdout.trim()
    // The main worktree root is dirname of the .git common dir
    return path.dirname(gitCommonDir)
  } catch {
    throw new NotAGitRepoError(cwd)
  }
}

// ---------------------------------------------------------------------------
// readWorktreeBaseRef
// ---------------------------------------------------------------------------

/**
 * Read ~/.claude/settings.json and return the worktree base ref preference.
 * Returns 'head' if settings.worktree.baseRef === 'head', else 'fresh'.
 */
export async function readWorktreeBaseRef(): Promise<'fresh' | 'head'> {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
    const raw = await fs.readFile(settingsPath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const worktree = parsed['worktree'] as Record<string, unknown> | undefined
    if (worktree && worktree['baseRef'] === 'head') {
      return 'head'
    }
  } catch {
    // Missing file, parse error, or missing key → default to fresh
  }
  return 'fresh'
}

// ---------------------------------------------------------------------------
// branchExists + listWorktreePaths
// ---------------------------------------------------------------------------

/**
 * Returns true if the local branch exists in the given repo.
 */
export async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await execFile(
      'git',
      ['-C', repoRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
      { timeout: 5000 }
    )
    return true
  } catch {
    return false
  }
}

/**
 * Parse `git worktree list --porcelain` and return all worktree working-tree
 * paths (absolute), including the main worktree.
 */
export async function listWorktreePaths(repoRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execFile('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], {
      timeout: 5000
    })
    const paths: string[] = []
    for (const line of stdout.split('\n')) {
      const match = line.match(/^worktree (.+)$/)
      if (match) {
        paths.push(match[1].trim())
      }
    }
    return paths
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// ensureWorktreesGitignored
// ---------------------------------------------------------------------------

/**
 * Ensure `.claude/worktrees/` is present in <repoRoot>/.gitignore.
 * Idempotent; uses atomic write (tmp + rename).
 */
export async function ensureWorktreesGitignored(repoRoot: string): Promise<void> {
  const gitignorePath = path.join(repoRoot, '.gitignore')
  const entry = '.claude/worktrees/'

  let existing = ''
  try {
    existing = await fs.readFile(gitignorePath, 'utf8')
  } catch {
    // Missing .gitignore is fine — we'll create it
  }

  // Check for exact line match (trimmed)
  const lines = existing.split('\n')
  const alreadyPresent = lines.some((l) => l.trim() === entry)
  if (alreadyPresent) return

  // Append the entry, with a trailing newline
  const newContent =
    existing.endsWith('\n') || existing.length === 0
      ? `${existing}${entry}\n`
      : `${existing}\n${entry}\n`

  // Atomic write: write to tmp then rename
  const tmpPath = `${gitignorePath}.tmp`
  await fs.writeFile(tmpPath, newContent, 'utf8')
  await fs.rename(tmpPath, gitignorePath)
}

// ---------------------------------------------------------------------------
// createWorktree
// ---------------------------------------------------------------------------

export interface CreateWorktreeOpts {
  repoRoot: string
  slug: string
  branch: string
  mode: 'new' | 'existing'
  baseRef: 'fresh' | 'head'
}

export interface CreateWorktreeResult {
  path: string
  branch: string
}

/**
 * Create a git worktree at <repoRoot>/.claude/worktrees/<slug>.
 *
 * If that path is already registered or non-empty, appends -2, -3, … until free.
 * Calls ensureWorktreesGitignored before adding.
 *
 * Assumes the repo lock is held by the caller (Task 4).
 *
 * Throws:
 *   - BranchCheckedOutElsewhereError if mode==='existing' and branch is taken
 *   - PathOccupiedError if the resolved path is a non-empty directory that git
 *     cannot use (only surfaces if the collision logic fails, which shouldn't happen)
 */
export async function createWorktree(opts: CreateWorktreeOpts): Promise<CreateWorktreeResult> {
  const { repoRoot, slug, branch, mode, baseRef } = opts

  await ensureWorktreesGitignored(repoRoot)

  // Determine a free path
  const existingPaths = new Set(await listWorktreePaths(repoRoot))
  const baseWorktreePath = path.join(repoRoot, '.claude', 'worktrees', slug)

  let worktreePath = baseWorktreePath
  let suffix = 2
  while (existingPaths.has(worktreePath) || (await isNonEmptyDir(worktreePath))) {
    worktreePath = `${baseWorktreePath}-${suffix}`
    suffix++
  }

  if (mode === 'new') {
    // Resolve the base ref string
    let baseRefString: string
    if (baseRef === 'head') {
      baseRefString = 'HEAD'
    } else {
      // fresh → try origin/HEAD, fall back to HEAD
      try {
        await execFile('git', ['-C', repoRoot, 'rev-parse', '--verify', 'origin/HEAD'], {
          timeout: 5000
        })
        baseRefString = 'origin/HEAD'
      } catch {
        baseRefString = 'HEAD'
      }
    }

    try {
      await execFile(
        'git',
        ['-C', repoRoot, 'worktree', 'add', '-b', branch, worktreePath, baseRefString],
        { timeout: 30000 }
      )
    } catch (err) {
      throw parseWorktreeAddError(err, branch, worktreePath)
    }
  } else {
    // existing: check out an existing branch
    try {
      await execFile('git', ['-C', repoRoot, 'worktree', 'add', worktreePath, branch], {
        timeout: 30000
      })
    } catch (err) {
      throw parseWorktreeAddError(err, branch, worktreePath)
    }
  }

  return { path: worktreePath, branch }
}

// ---------------------------------------------------------------------------
// removeWorktree
// ---------------------------------------------------------------------------

export interface RemoveWorktreeOpts {
  path: string
  force: boolean
}

export interface RemoveWorktreeResult {
  removed: boolean
  wasDirty: boolean
}

/**
 * Remove a git worktree. Never deletes the branch.
 *
 * When force===false and the worktree is dirty, returns
 * { removed: false, wasDirty: true } WITHOUT throwing.
 *
 * When force===true, passes --force to git worktree remove.
 */
export async function removeWorktree(opts: RemoveWorktreeOpts): Promise<RemoveWorktreeResult> {
  const { path: worktreePath, force } = opts

  // Run from a stable cwd (parent of the worktree path)
  const cwd = path.dirname(worktreePath)

  const args = ['worktree', 'remove', worktreePath]
  if (force) args.push('--force')

  try {
    await execFile('git', ['-C', cwd, ...args], { timeout: 30000 })
    return { removed: true, wasDirty: false }
  } catch (err) {
    const stderr = getStderr(err)
    if (
      !force &&
      (stderr.includes('contains modified or untracked files') || stderr.includes('is dirty'))
    ) {
      return { removed: false, wasDirty: true }
    }
    // Re-throw other errors
    throw new WorktreeError('WorktreeError', `git worktree remove failed: ${stderr}`)
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse a git worktree add error into a typed WorktreeError.
 */
function parseWorktreeAddError(err: unknown, branch: string, worktreePath: string): WorktreeError {
  const stderr = getStderr(err)

  // "fatal: 'branch' is already used by worktree at '/some/path'"
  const alreadyUsed = stderr.match(
    /is already (?:used|checked out) by worktree at ['"]?([^'"]+)['"]?/
  )
  if (alreadyUsed) {
    return new BranchCheckedOutElsewhereError(branch, alreadyUsed[1].trim())
  }

  // "fatal: '<path>' already exists"
  if (stderr.includes('already exists')) {
    return new PathOccupiedError(worktreePath)
  }

  return new WorktreeError('WorktreeError', `git worktree add failed: ${stderr}`)
}

/**
 * Extract stderr string from a child_process error.
 */
function getStderr(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err) {
    return String((err as { stderr: unknown }).stderr)
  }
  return String(err)
}

/**
 * Returns true if `p` exists and is a non-empty directory.
 */
async function isNonEmptyDir(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p)
    if (!stat.isDirectory()) return false
    const entries = await fs.readdir(p)
    return entries.length > 0
  } catch {
    return false
  }
}
