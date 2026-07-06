// ---------------------------------------------------------------------------
// src/main/gitDiff.ts
//
// Workbench Git tab — Phase 1 working-tree diff (docs/brainstorms/
// 2026-07-06-git-tab-requirements.md states 3/4; docs/learnings/
// pierre-libraries.md §13.4/§13.9). Produces one ready-to-render unified-diff
// patch string PER FILE, so the renderer can feed each straight into
// @pierre/diffs' <PatchDiff patch={...}> with no client-side re-parsing.
//
// SIMPLIFICATION (Phase 1, deliberate — see the requirements doc's "Phase
// 1.x nicety" note): this is a single "what's changed since HEAD" view —
// staged + unstaged changes are combined into one diff (`git diff HEAD`),
// not split into separate staged/unstaged sections. Splitting that out is a
// later refinement, not required for the working-tree-diff foundation.
//
// git.ts is shortstat-only today (GitStatus's insertions/deletions come from
// `git diff --shortstat`) — actual patch/hunk CONTENT is net-new, added here
// rather than in git.ts to keep that file's existing shortstat/log/watcher
// responsibilities unchanged.
// ---------------------------------------------------------------------------

import * as childProcess from 'node:child_process'
import { promisify } from 'node:util'
import type { GitDiffFile, GitDiffFileStatus, GitDiffResult } from '../shared/types'
import { getPrDetail } from './github'
import { getUserShellPath } from './shellHelpers'

const execFile = promisify(childProcess.execFile)

// A combined `git diff HEAD` can be large (big rebase, generated files) — cap
// well above any realistic single-workspace diff while still bounding worst
// case. Matches the spirit of files.ts's own read caps.
const MAX_BUFFER = 32 * 1024 * 1024

// `gh pr diff` on a big PR (60+ files, #117 style) is considerably larger
// than a single working-tree diff — a generous cap well above the observed
// ~14k-line/#117 case while still bounding worst case. Timeout is longer too:
// this shells out to GitHub, not just local git.
const PR_DIFF_MAX_BUFFER = 16 * 1024 * 1024
const PR_DIFF_TIMEOUT_MS = 15_000

/** True if `cwd` is inside a git working tree; swallows every failure. */
async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execFile('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], { timeout: 1500 })
    return true
  } catch {
    return false
  }
}

/**
 * Split a combined `git diff` (or `git diff --no-index`) stdout blob into
 * per-file chunks on the `diff --git ` boundary. Each returned chunk is the
 * full `diff --git a/... b/...` header line through the last hunk line for
 * that file (i.e. exactly the patch text `PatchDiff` expects), with the
 * trailing newline preserved so the last hunk line isn't truncated.
 */
function splitPatchByFile(combined: string): string[] {
  if (!combined) return []
  // Keep the delimiter attached to each chunk via a lookahead split.
  const chunks = combined.split(/(?=^diff --git )/m).filter((c) => c.trim().length > 0)
  return chunks
}

/** Parse the two `--- a/...` / `+++ b/...` header lines of one file's patch
 *  chunk into a repo-relative path (and, for a rename, the OLD path too).
 *  Falls back to parsing the `diff --git a/X b/Y` line when a file is purely
 *  added/deleted (one side is `/dev/null`). */
function parsePatchPaths(chunk: string): { path: string; oldPath?: string } {
  const diffGitMatch = /^diff --git a\/(.+) b\/(.+)$/m.exec(chunk)
  const aPath = diffGitMatch?.[1]
  const bPath = diffGitMatch?.[2]
  const newPath = bPath ?? aPath ?? ''
  if (aPath && bPath && aPath !== bPath) {
    return { path: newPath, oldPath: aPath }
  }
  return { path: newPath }
}

/** Parse a file's change status from its patch chunk's header lines. Checked
 *  in order: rename (a/b differ), new file, deleted file, else modified. */
function parsePatchStatus(
  chunk: string,
  path: string,
  oldPath: string | undefined
): GitDiffFileStatus {
  if (oldPath && oldPath !== path) return 'renamed'
  if (/^new file mode/m.test(chunk)) return 'added'
  if (/^deleted file mode/m.test(chunk)) return 'deleted'
  return 'modified'
}

/** Count added/removed content lines in a patch chunk — every `+`/`-` line
 *  inside a hunk, excluding the `+++`/`---` file-header lines themselves. */
function countPatchLines(chunk: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of chunk.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) additions++
    else if (line.startsWith('-')) deletions++
  }
  return { additions, deletions }
}

/** True when a patch chunk is a `git diff` BINARY marker rather than real
 *  text hunks — either the human-readable `Binary files a/x and b/x differ`
 *  line (the default, no `--binary`) or a `GIT binary patch` block (emitted
 *  when the caller passes `--binary`, which this module doesn't, but detected
 *  anyway for robustness/future-proofing). Additions/deletions are always 0
 *  for these — `countPatchLines` would already return {0,0} since a binary
 *  chunk has no `+`/`-` hunk lines, but callers use this flag to render
 *  "Binary" instead of a misleading "-0 +0" line count. */
function isBinaryPatchChunk(chunk: string): boolean {
  return /^Binary files .+ differ$/m.test(chunk) || /^GIT binary patch$/m.test(chunk)
}

/** Build one `GitDiffFile` from a single-file patch chunk (already split out
 *  of the combined `git diff HEAD` output). */
function fileFromChunk(chunk: string): GitDiffFile {
  const { path, oldPath } = parsePatchPaths(chunk)
  const status = parsePatchStatus(chunk, path, oldPath)
  const { additions, deletions } = countPatchLines(chunk)
  const binary = isBinaryPatchChunk(chunk)
  return { path, status, patch: chunk, additions, deletions, oldPath, binary }
}

/** Tracked changes (staged + unstaged, combined) vs HEAD, split per file. */
async function trackedDiffFiles(cwd: string): Promise<GitDiffFile[]> {
  try {
    const { stdout } = await execFile(
      'git',
      ['-C', cwd, '-c', 'core.quotePath=false', 'diff', 'HEAD'],
      { timeout: 5000, maxBuffer: MAX_BUFFER }
    )
    return splitPatchByFile(stdout).map(fileFromChunk)
  } catch {
    // Not a repo (already guarded by isGitRepo above), no HEAD yet (empty
    // repo — `git diff HEAD` fails with no commits), or git unavailable.
    return []
  }
}

/** Repo-relative untracked file paths (`git status --porcelain`'s `??`
 *  entries), used to build synthetic all-additions patches below. */
async function untrackedPaths(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFile(
      'git',
      [
        '-C',
        cwd,
        '-c',
        'core.quotePath=false',
        'status',
        '--porcelain=v1',
        '--untracked-files=all'
      ],
      { timeout: 4000, maxBuffer: MAX_BUFFER }
    )
    const paths: string[] = []
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('?? ')) continue
      paths.push(line.slice(3).trim())
    }
    return paths
  } catch {
    return []
  }
}

/** One untracked file's all-additions patch, via `git diff --no-index
 *  /dev/null <file>` (the approach the requirements brief calls out — `git
 *  diff HEAD` never shows untracked files, so each gets its own no-index
 *  diff against `/dev/null`). `--no-index` exits 1 when there IS a
 *  difference (the normal case here), which execFile treats as a rejection —
 *  so a truthy stdout on that rejection is the success path, not a real
 *  failure. Returns null for a file that vanished/became unreadable between
 *  the status scan and this call (race with an external edit), or a binary
 *  file (no meaningful text patch). */
async function untrackedFileDiff(cwd: string, relPath: string): Promise<GitDiffFile | null> {
  try {
    const { stdout } = await execFile(
      'git',
      ['-C', cwd, '-c', 'core.quotePath=false', 'diff', '--no-index', '--', '/dev/null', relPath],
      { timeout: 3000, maxBuffer: MAX_BUFFER }
    )
    return stdout ? fileFromChunk(stdout) : null
  } catch (err) {
    // --no-index exits 1 (a real diff was produced) — Node's execFile
    // surfaces that as a rejection with stdout still attached.
    const stdout = (err as { stdout?: string } | null)?.stdout
    if (typeof stdout === 'string' && stdout.length > 0) {
      const file = fileFromChunk(stdout)
      return { ...file, path: relPath, status: 'untracked' }
    }
    return null
  }
}

/** Untracked files as all-additions `GitDiffFile`s, fetched in parallel. */
async function untrackedDiffFiles(cwd: string): Promise<GitDiffFile[]> {
  const paths = await untrackedPaths(cwd)
  const results = await Promise.all(paths.map((p) => untrackedFileDiff(cwd, p)))
  return results.filter((f): f is GitDiffFile => f !== null)
}

/**
 * Working-tree diff for the Workbench Git tab: tracked changes (staged +
 * unstaged combined vs HEAD) plus untracked files, each as a ready-to-render
 * per-file patch string. Never throws — any git failure resolves to an empty
 * `files[]`.
 *
 * `repo` (Phase 2) surfaces the `isGitRepo` check that was previously only
 * used internally to short-circuit — the renderer needs it to distinguish
 * "not a git repo" from "clean tree" (both were indistinguishable `{files:
 * []}` before). `repo: false` short-circuits before any diff subprocess
 * runs, same as before.
 */
export async function getWorkingTreeDiff(cwd: string): Promise<GitDiffResult> {
  if (!cwd) return { repo: false, files: [] }
  if (!(await isGitRepo(cwd))) return { repo: false, files: [] }

  const [tracked, untracked] = await Promise.all([trackedDiffFiles(cwd), untrackedDiffFiles(cwd)])
  return { repo: true, files: [...tracked, ...untracked] }
}

// ---------------------------------------------------------------------------
// PR diff (Phase 4-pre) — `gh pr diff <n>` (base...head), reusing the SAME
// splitPatchByFile/fileFromChunk parsers above: `gh pr diff` emits the
// identical `diff --git a/... b/...` unified-patch format `git diff` does
// (verified against PR #117 — 14298 `diff --git` lines), so no new parser is
// needed. This is deliberately simpler than getWorkingTreeDiff: `gh pr diff`
// already includes every changed file in the PR (added/modified/deleted/
// renamed, binary included) in one shot — there's no working-tree-only
// concept of "untracked" files to special-case here.
// ---------------------------------------------------------------------------

/** Resolve the PATH to hand the `gh` invocation below — same rationale as
 *  github.ts's own resolveGhPathEnv (Finder-launched Electron gets a
 *  stripped PATH), duplicated locally rather than imported since github.ts
 *  doesn't export it (kept module-private there). */
async function resolveGhPathEnv(): Promise<string> {
  let shellPath = ''
  try {
    shellPath = await getUserShellPath()
  } catch {
    shellPath = ''
  }
  return shellPath || process.env['PATH'] || ''
}

/**
 * PR diff for the Workbench Git tab's [Working tree | PR diff] toggle
 * (Phase 4-pre): the full `base...head` unified diff for the PR opened
 * against `cwd`'s current branch, via `gh pr diff <number>`. Reuses
 * `getPrDetail` purely to resolve the PR number (it already does cwd ->
 * branch -> PR resolution, cached) rather than re-deriving branch/PR
 * lookup here.
 *
 * Total — never throws: no cwd / no branch / no PR / gh missing / unauth /
 * network / oversized output all resolve to `{ repo: <best-effort>, files:
 * [] }`. This is a safety net, not the primary gate — the renderer only
 * offers PR-diff mode when it already knows (via the existing PR-detection
 * state) that a PR exists, so an empty result here should be rare in
 * practice.
 */
export async function getPrDiff(cwd: string): Promise<GitDiffResult> {
  if (!cwd) return { repo: false, files: [] }
  const repo = await isGitRepo(cwd)
  if (!repo) return { repo: false, files: [] }

  const detail = await getPrDetail(cwd)
  if (!detail) return { repo: true, files: [] }

  try {
    const pathEnv = await resolveGhPathEnv()
    const { stdout } = await execFile('gh', ['pr', 'diff', String(detail.number)], {
      cwd,
      env: { ...process.env, PATH: pathEnv },
      timeout: PR_DIFF_TIMEOUT_MS,
      maxBuffer: PR_DIFF_MAX_BUFFER
    })
    return { repo: true, files: splitPatchByFile(stdout).map(fileFromChunk) }
  } catch {
    // gh missing / unauth / network / output over maxBuffer — render nothing;
    // the renderer's toggle only appears when a PR is already known to
    // exist, so this degrades to an empty PR-diff pane rather than a crash.
    return { repo: true, files: [] }
  }
}
