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
 *
 * Strategy:
 *   1. Ask git for `--git-common-dir` (absolute). This is the shared .git dir
 *      shared by all worktrees, so it always points back to the main repo even
 *      when called from a linked worktree.
 *   2. If commonDir ends with "/.git", the main root is its parent (normal case).
 *   3. Otherwise (bare repo), run `--show-toplevel` from the commonDir itself.
 *      If that succeeds and is non-empty, use it; else fall back to
 *      `dirname(commonDir)`.
 *
 * We deliberately do NOT use `--show-toplevel` from the original `cwd` because
 * inside a linked worktree it returns that worktree's root, not the main repo root.
 */
export async function resolveMainWorktree(cwd: string): Promise<string> {
  let gitCommonDir: string
  try {
    const { stdout } = await execFile(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { timeout: 5000 }
    )
    gitCommonDir = stdout.trim()
  } catch {
    throw new NotAGitRepoError(cwd)
  }

  // Normal case: commonDir is /repo/.git → main root is /repo
  if (gitCommonDir.endsWith('/.git') || gitCommonDir === '.git') {
    return path.dirname(gitCommonDir)
  }

  // Bare repo or unusual layout: try --show-toplevel from the commonDir itself
  try {
    const { stdout: toplevel } = await execFile(
      'git',
      ['-C', gitCommonDir, 'rev-parse', '--show-toplevel'],
      { timeout: 5000 }
    )
    const resolved = toplevel.trim()
    if (resolved.length > 0) {
      return resolved
    }
  } catch {
    // Bare repos have no working tree; --show-toplevel fails — fall through
  }

  // Last resort: parent of the common dir
  return path.dirname(gitCommonDir)
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
// isWorktreeDirty
// ---------------------------------------------------------------------------

/**
 * Returns true if a worktree directory has uncommitted changes (modified or
 * untracked files). Treats a missing or invalid directory as NOT dirty so it
 * can be cleaned up without blocking.
 *
 * Runs `git -C <path> status --porcelain` and returns true if output is
 * non-empty.
 *
 * Fail-safe on error: only a genuinely-gone directory or a path that isn't a
 * git repo is treated as clean (removal may proceed — there's nothing there
 * to lose). Any other failure (timeout, lock contention, permission error,
 * missing git binary, corrupt repo, etc.) is treated as DIRTY so removal is
 * blocked without --force, rather than silently deleting a worktree whose
 * real state we couldn't read.
 */
export async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFile('git', ['-C', worktreePath, 'status', '--porcelain'], {
      timeout: 10000
    })
    return stdout.trim().length > 0
  } catch (err) {
    return !isGenuinelyGoneOrNotARepo(err)
  }
}

/**
 * Narrows a failed `git status` invocation to the "safe to treat as clean"
 * cases: the git binary itself is missing (Node-level ENOENT), or git ran
 * and reported the directory is gone / not a git repo. Everything else
 * (timeouts, locks, permissions, corrupt repos, ...) is NOT genuinely gone.
 */
function isGenuinelyGoneOrNotARepo(err: unknown): boolean {
  const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : undefined
  if (code === 'ENOENT') return true
  const stderr = getStderr(err)
  return /not a git repository|no such file or directory|cannot change to/i.test(stderr)
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
 *
 * Throws on git command failure so callers (e.g. createWorktree's collision
 * check) surface a corrupted-repo error rather than silently returning an
 * empty list that could allow a path collision.
 */
export async function listWorktreePaths(repoRoot: string): Promise<string[]> {
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

  // Guard against git option injection: reject empty or dash-prefixed branch names.
  if (!branch || branch.length === 0) {
    throw new WorktreeError('WorktreeError', 'Branch name must not be empty')
  }
  if (branch.startsWith('-')) {
    throw new WorktreeError(
      'WorktreeError',
      `Invalid branch name '${branch}': branch names must not start with '-'`
    )
  }

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
        ['-C', repoRoot, 'worktree', 'add', '-b', branch, '--', worktreePath, baseRefString],
        { timeout: 30000 }
      )
    } catch (err) {
      throw parseWorktreeAddError(err, branch, worktreePath)
    }
  } else {
    // existing: check out an existing branch
    try {
      await execFile('git', ['-C', repoRoot, 'worktree', 'add', '--', worktreePath, branch], {
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
  /** Optional repo root for a stable git cwd. If omitted, resolved via resolveMainWorktree. */
  repoRoot?: string
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
 *
 * Runs git from a stable cwd (repoRoot if supplied, else resolved from the
 * worktree path) so that a deleted parent directory does not cause git to
 * fail before it can process the remove command.
 *
 * Treats "not a working tree", ENOENT, and missing-dir as idempotent success
 * so an already-gone worktree never blocks archive.
 */
export async function removeWorktree(opts: RemoveWorktreeOpts): Promise<RemoveWorktreeResult> {
  const { path: worktreePath, force } = opts

  // Resolve a stable cwd (main repo root) for the git command. If the
  // worktree's parent dir was deleted, running git from that dir would throw
  // before the remove command runs. Fall back to path.dirname only if
  // resolveMainWorktree fails (e.g. repo entirely gone — in that case git
  // will emit "not a working tree" which we treat as idempotent below).
  let cwd: string
  if (opts.repoRoot) {
    cwd = opts.repoRoot
  } else {
    try {
      cwd = await resolveMainWorktree(worktreePath)
    } catch {
      // Repo root unresolvable — use dirname as best-effort fallback.
      cwd = path.dirname(worktreePath)
    }
  }

  const args = ['worktree', 'remove']
  if (force) args.push('--force')
  args.push(worktreePath)

  try {
    await execFile('git', ['-C', cwd, ...args], { timeout: 30000 })
    return { removed: true, wasDirty: false }
  } catch (err) {
    const stderr = getStderr(err)
    // Dirty worktree without force → caller decides.
    if (
      !force &&
      (stderr.includes('contains modified or untracked files') || stderr.includes('is dirty'))
    ) {
      return { removed: false, wasDirty: true }
    }
    // Already gone / not registered → idempotent success.
    if (
      stderr.includes('is not a working tree') ||
      stderr.includes('No such file or directory') ||
      (err as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return { removed: true, wasDirty: false }
    }
    // Re-throw other errors
    throw new WorktreeError('WorktreeError', `git worktree remove failed: ${stderr}`)
  }
}

// ---------------------------------------------------------------------------
// reconcileWorktree
// ---------------------------------------------------------------------------

/**
 * Structured result returned by reconcileWorktree.
 *
 * ok:true  → worktree is ready; use `path` as the mount cwd.
 * ok:false → mount must NOT proceed; show the error card with `kind` + `message`.
 */
export type ReconcileResult =
  | { ok: true; path: string; notice?: string }
  | {
      ok: false
      kind: 'checkedOutElsewhere' | 'corruptDir' | 'parentGone'
      message: string
      conflictPath?: string
    }

/**
 * Heal a worktree-backed workspace before mount.
 *
 * Runs the full state machine under the per-repo lock so concurrent mounts
 * cannot race on `git worktree add` for the same path.
 *
 * NEVER throws past its return boundary — all error branches return
 * { ok: false, … } instead of throwing, so a reconcile failure never leaves
 * the terminal surface permanently blank / un-retryable.
 *
 * State machine (spec §5):
 *   1. parent not a git repo → { ok:false, kind:'parentGone' }
 *   2. registered && dirExists → { ok:true, path }
 *   3. registered && !dirExists (stale) → prune, then recreate (step 5)
 *   4. !registered && dirExists && not a valid worktree → { ok:false, kind:'corruptDir' }
 *      (never clobber user data)
 *   5. recreate: if branch survives → createWorktree(existing); catch
 *      BranchCheckedOutElsewhere → { ok:false, kind:'checkedOutElsewhere' }.
 *      If branch gone → createWorktree(new) + notice → { ok:true, path, notice }.
 */
/**
 * Best-effort `git worktree prune`. Errors are intentionally swallowed —
 * pruning is a cleanup step and its failure must never block reconcile's
 * recreate path (states 3 and 4 both rely on this).
 */
async function pruneWorktreesQuietly(repoRoot: string): Promise<void> {
  try {
    await execFile('git', ['-C', repoRoot, 'worktree', 'prune'], { timeout: 10000 })
  } catch {
    // prune errors are non-fatal; continue to recreate
  }
}

/**
 * Shared "already checked out elsewhere / other failure" mapping used by
 * both the existing-branch and new-branch recreate attempts (state 5).
 */
function toRecreateFailure(err: unknown, branch: string): ReconcileResult & { ok: false } {
  if (err instanceof BranchCheckedOutElsewhereError) {
    return {
      ok: false,
      kind: 'checkedOutElsewhere',
      conflictPath: err.conflictingPath,
      message: `Branch '${branch}' is already checked out at '${err.conflictingPath}'`
    }
  }
  // Other createWorktree error — surface as parentGone (repo-level problem)
  return {
    ok: false,
    kind: 'parentGone',
    message: `Failed to recreate worktree: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * State 5: recreate the worktree (dir gone, or just pruned).
 * If the branch survives, reattach to it (mode:'existing'); otherwise start
 * fresh with the same branch name and attach a user-facing notice.
 */
async function recreateWorktree(
  repoRoot: string,
  cwd: string,
  worktreeBranch: string
): Promise<ReconcileResult> {
  const slug = path.basename(cwd)
  const branchSurvives = await branchExists(repoRoot, worktreeBranch)

  if (branchSurvives) {
    try {
      const result = await createWorktree({
        repoRoot,
        slug,
        branch: worktreeBranch,
        mode: 'existing',
        baseRef: 'fresh' // ignored for mode:'existing'
      })
      return { ok: true, path: result.path }
    } catch (err) {
      return toRecreateFailure(err, worktreeBranch)
    }
  } else {
    // Branch is gone — recreate fresh with the same branch name
    try {
      const result = await createWorktree({
        repoRoot,
        slug,
        branch: worktreeBranch,
        mode: 'new',
        baseRef: 'fresh'
      })
      const notice = `Original branch \`${worktreeBranch}\` no longer existed — started fresh`
      return { ok: true, path: result.path, notice }
    } catch (err) {
      return toRecreateFailure(err, worktreeBranch)
    }
  }
}

/**
 * States 2-4: given registration + dir-existence facts, either resolve
 * immediately (state 2, or state 4's corruptDir failure), prune (states 3
 * and the "stale but valid" branch of state 4), or return `undefined` to
 * signal the caller should fall through to state 5 (recreate).
 */
async function healRegisteredOrOrphanedDir(
  repoRoot: string,
  cwd: string,
  registered: boolean,
  dirExists: boolean
): Promise<ReconcileResult | undefined> {
  // ── State 2: registered && dir present → healthy ──────────────────────
  if (registered && dirExists) {
    return { ok: true, path: cwd }
  }

  // ── State 3: registered but dir missing → prune then fall through ─────
  if (registered && !dirExists) {
    await pruneWorktreesQuietly(repoRoot)
    // Fall through to recreate (state 5)
    return undefined
  }

  // ── State 4: not registered && dir exists but not a valid worktree ────
  if (!registered && dirExists) {
    const isValidWorktree = await isLinkedWorktreeDir(cwd, repoRoot)
    if (!isValidWorktree) {
      return {
        ok: false,
        kind: 'corruptDir',
        message: `A non-worktree directory already exists at ${cwd} — will not overwrite`
      }
    }
    // It IS a valid worktree dir but not registered → treat as stale,
    // prune and re-add below (git worktree prune will clean stale metadata).
    await pruneWorktreesQuietly(repoRoot)
  }

  return undefined
}

export async function reconcileWorktree(ws: {
  cwd: string
  worktreeParentCwd: string
  worktreeBranch: string
}): Promise<ReconcileResult> {
  const repoRoot = ws.worktreeParentCwd

  return withRepoLock(repoRoot, async () => {
    // ── Step 1: verify the parent is still a git repo ────────────────────
    try {
      await resolveMainWorktree(repoRoot)
    } catch {
      return {
        ok: false,
        kind: 'parentGone',
        message: `Parent repository is missing or has moved: ${repoRoot}`
      }
    }

    // ── Step 2/3: check registration and dir existence ───────────────────
    let knownPaths: string[]
    try {
      knownPaths = await listWorktreePaths(repoRoot)
    } catch {
      // If we can't list worktrees the repo may be corrupt; treat as parentGone
      return {
        ok: false,
        kind: 'parentGone',
        message: `Could not list worktrees for ${repoRoot} — repository may be corrupt`
      }
    }

    const registered = knownPaths.includes(ws.cwd)

    let dirExists: boolean
    try {
      await fs.access(ws.cwd)
      dirExists = true
    } catch {
      dirExists = false
    }

    const healed = await healRegisteredOrOrphanedDir(repoRoot, ws.cwd, registered, dirExists)
    if (healed) {
      return healed
    }

    // ── State 5: recreate (gone / after prune) ───────────────────────────
    return recreateWorktree(repoRoot, ws.cwd, ws.worktreeBranch)
  })
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if `dir` looks like a valid linked git worktree.
 *
 * A linked worktree has a `.git` FILE (not directory) whose content starts
 * with `gitdir: `. We verify this heuristic — enough to distinguish a user's
 * regular directory from a real worktree without running git commands that
 * might fail on a partially torn-down worktree.
 */
async function isLinkedWorktreeDir(dir: string, repoRoot: string): Promise<boolean> {
  const gitFilePath = path.join(dir, '.git')
  try {
    const stat = await fs.stat(gitFilePath)
    if (!stat.isFile()) return false
    const content = await fs.readFile(gitFilePath, 'utf8')
    if (!content.startsWith('gitdir: ')) return false
    // Verify the gitdir line points back into the repo's .git/worktrees dir
    const gitdirValue = content.slice('gitdir: '.length).split('\n')[0].trim()
    const resolvedGitdir = path.resolve(dir, gitdirValue)
    // The repoRoot's .git/worktrees directory
    const expectedPrefix = path.join(repoRoot, '.git', 'worktrees')
    return resolvedGitdir.startsWith(expectedPrefix)
  } catch {
    return false
  }
}

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
    return String(err.stderr)
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
