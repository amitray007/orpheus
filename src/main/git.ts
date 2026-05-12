import * as childProcess from 'node:child_process'

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
 * Uses `git -C <cwd>` so we don't need to chdir.
 */
export function getGitStatus(cwd: string): GitStatus | null {
  if (!cwd) return null

  // Quick check: is this a git repo?
  try {
    childProcess.execFileSync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
      encoding: 'utf-8'
    })
  } catch {
    return null
  }

  let branch: string | null = null
  try {
    const out = childProcess
      .execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1500,
        encoding: 'utf-8'
      })
      .trim()
    // Detached HEAD reports literal "HEAD"
    branch = out === 'HEAD' ? null : out
  } catch {
    /* fall through with branch null */
  }

  let insertions = 0
  let deletions = 0
  try {
    // `git diff --shortstat HEAD` — captures working-tree + staged vs HEAD.
    // Output looks like: " 2 files changed, 113 insertions(+), 0 deletions(-)"
    const out = childProcess.execFileSync(
      'git',
      ['-C', cwd, 'diff', '--shortstat', 'HEAD'],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
        encoding: 'utf-8'
      }
    )
    const insMatch = out.match(/(\d+)\s+insertion/)
    const delMatch = out.match(/(\d+)\s+deletion/)
    if (insMatch) insertions = parseInt(insMatch[1], 10)
    if (delMatch) deletions = parseInt(delMatch[1], 10)
  } catch {
    // No HEAD yet (fresh repo) or other error — leave as zero
  }

  // Also check for untracked files. If insertions/deletions are zero but there are
  // untracked files, hasChanges should still be true.
  let untrackedCount = 0
  try {
    const out = childProcess.execFileSync(
      'git',
      ['-C', cwd, 'ls-files', '--others', '--exclude-standard'],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1500,
        encoding: 'utf-8'
      }
    )
    untrackedCount = out.split('\n').filter((line) => line.length > 0).length
  } catch {
    /* swallow */
  }

  const hasChanges = insertions > 0 || deletions > 0 || untrackedCount > 0
  return { insertions, deletions, hasChanges, branch }
}
