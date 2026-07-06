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
import { cyrb53 } from '../shared/hash'
import { getPrDetail } from './github'
import { getUserShellPath } from './shellHelpers'

const execFile = promisify(childProcess.execFile)

// A combined `git diff HEAD` can be large (big rebase, generated files) — cap
// well above any realistic single-workspace diff while still bounding worst
// case. Matches the spirit of files.ts's own read caps.
const MAX_BUFFER = 32 * 1024 * 1024

// ── Per-file oversized cap (crash fix #1) ───────────────────────────────────
// Pierre adoption batch 2a: the Git diff pane (<PatchDiff>) is now wrapped in
// <Virtualizer> (GitTab.tsx's DiffContentPane), so it renders windowed
// (VirtualizedFileDiff) instead of materializing every diff line into
// shadow-DOM — a 50k-line diff now costs a few hundred DOM rows, not 50k.
// That's why this cap was raised substantially (20x) rather than removed:
// virtualization windows the DOM, but Shiki still tokenizes the WHOLE patch
// text synchronously on the main thread on first render (that's the separate
// worker-pool batch, not yet landed) — so an astronomically large single-file
// patch (a multi-MB committed lockfile/bundle) can still stall/OOM the
// renderer even though the DOM itself stays small. Line count is the primary
// signal (a minified single-line blob can still be small in line count but
// huge in bytes, so byte size is checked too) — either threshold flags the
// file `oversized`, which still gates the OversizedDiffPlaceholder as the
// ultimate safety net (see GitTab.tsx's DiffContentPane "show anyway"
// override). The patch text is still SHIPPED on the wire regardless
// (renderer gates the RENDER, not the fetch); trimming the wire payload
// itself is a separate, not-yet-needed optimization (rank 6 in the perf
// audit).
const OVERSIZED_LINE_THRESHOLD = 50_000
const OVERSIZED_BYTE_THRESHOLD = 8 * 1024 * 1024

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

/** Parse the `diff --git a/X b/Y` header line into a repo-relative path
 *  (and, for a rename, the OLD path too). Used only by the single-pass
 *  `fileFromChunk` below to interpret the FIRST line it already visits while
 *  scanning — kept as its own function purely so that parsing logic reads as
 *  a named step rather than inlined into the loop body. */
function parseDiffGitLine(line: string): { path: string; oldPath?: string } {
  const diffGitMatch = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
  const aPath = diffGitMatch?.[1]
  const bPath = diffGitMatch?.[2]
  const newPath = bPath ?? aPath ?? ''
  if (aPath && bPath && aPath !== bPath) {
    return { path: newPath, oldPath: aPath }
  }
  return { path: newPath }
}

/** PERF FIX (LAG-LAYER #8): builds one `GitDiffFile` from a single-file patch
 *  chunk (already split out of the combined `git diff HEAD`/`gh pr diff`
 *  output) in a SINGLE linear pass over its lines, instead of the previous
 *  split-then-~6-regex/count-passes-per-chunk pipeline (parsePatchPaths +
 *  parsePatchStatus + countPatchLines + isBinaryPatchChunk +
 *  isOversizedPatchChunk, each re-scanning the same chunk independently).
 *  Iterates line boundaries via `indexOf('\n', ...)` (no `.split('\n')`
 *  array allocation for the whole chunk) and accumulates every derived field
 *  — path/oldPath (from the first `diff --git` line), status (new/deleted/
 *  binary-vs-modified/renamed), additions/deletions, binary, and the
 *  oversized line-count — inline as it walks.
 *
 *  additions/deletions/status/binary are always computed from the FULL
 *  chunk before the oversized check is finalized (crash fix #1) — so the
 *  tree's "+N -M" counts and comment line-anchoring stay correct for an
 *  oversized file exactly as they are for a normal one; only the RENDERER'S
 *  decision to feed `patch` into <PatchDiff> is gated by `oversized`, not
 *  this function's own output.
 *
 *  `patch` on the returned `GitDiffFile` is the ORIGINAL `chunk` string,
 *  completely unmodified — this function only ever READS it, never slices or
 *  rebuilds it, so the emitted patch stays byte-identical to the previous
 *  implementation (still fed verbatim to PatchDiff, still hashed below).
 *  `sig` (LAG-LAYER #7) is a single cyrb53 pass over path+status+chunk,
 *  computed here (once, in main) so the renderer only ever combines
 *  already-hashed per-file signatures instead of re-hashing/re-joining full
 *  patch text itself. */
/** Mutable per-chunk accumulator `fileFromChunk`'s single-pass loop folds
 *  every line into, via `classifyLine` below — kept as its own interface
 *  purely so the accumulator's shape (and the "what does this line
 *  contribute" dispatch) reads as one named step rather than a wall of
 *  loose `let`s, which is what was pushing `fileFromChunk` itself over the
 *  cognitive-complexity ceiling. */
interface ChunkScanState {
  path: string
  oldPath: string | undefined
  sawDiffGitLine: boolean
  isNewFile: boolean
  isDeletedFile: boolean
  isBinary: boolean
  additions: number
  deletions: number
}

/** Classifies ONE line of a patch chunk, mutating `state` in place with
 *  whatever that line contributes (the `diff --git` header, a new/deleted-
 *  file marker, a binary marker, or a `+`/`-` content line). Pulled out of
 *  `fileFromChunk`'s loop body so that function's own cognitive complexity
 *  stays under the lint ceiling — this is the single-pass replacement for
 *  the previous parsePatchPaths/parsePatchStatus/countPatchLines/
 *  isBinaryPatchChunk regex passes, now dispatched per line instead of once
 *  per chunk each. */
function classifyLine(line: string, state: ChunkScanState): void {
  if (!state.sawDiffGitLine && line.startsWith('diff --git ')) {
    const parsed = parseDiffGitLine(line)
    state.path = parsed.path
    state.oldPath = parsed.oldPath
    state.sawDiffGitLine = true
    return
  }
  if (line.startsWith('new file mode')) {
    state.isNewFile = true
    return
  }
  if (line.startsWith('deleted file mode')) {
    state.isDeletedFile = true
    return
  }
  if (!state.isBinary && (/^Binary files .+ differ$/.test(line) || line === 'GIT binary patch')) {
    state.isBinary = true
    return
  }
  if (line.startsWith('+++') || line.startsWith('---')) {
    // File-header lines — excluded from the +/- content-line counts below,
    // same as the previous countPatchLines behavior.
    return
  }
  if (line.startsWith('+')) {
    state.additions++
  } else if (line.startsWith('-')) {
    state.deletions++
  }
}

function fileFromChunk(chunk: string): GitDiffFile {
  const state: ChunkScanState = {
    path: '',
    oldPath: undefined,
    sawDiffGitLine: false,
    isNewFile: false,
    isDeletedFile: false,
    isBinary: false,
    additions: 0,
    deletions: 0
  }
  let lineCount = 0
  const oversizedByBytes = chunk.length > OVERSIZED_BYTE_THRESHOLD

  let start = 0
  while (start < chunk.length) {
    let end = chunk.indexOf('\n', start)
    const isLastLine = end === -1
    if (isLastLine) end = chunk.length
    classifyLine(chunk.slice(start, end), state)
    lineCount++
    if (isLastLine) break
    start = end + 1
  }

  const { path, oldPath, isNewFile, isDeletedFile, isBinary, additions, deletions } = state
  const status: GitDiffFileStatus =
    oldPath && oldPath !== path
      ? 'renamed'
      : isNewFile
        ? 'added'
        : isDeletedFile
          ? 'deleted'
          : 'modified'
  const binary = isBinary
  const oversized = !binary && (oversizedByBytes || lineCount > OVERSIZED_LINE_THRESHOLD)
  const sig = cyrb53(`${path} ${status} ${chunk}`)
  return { path, status, patch: chunk, additions, deletions, oldPath, binary, oversized, sig }
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
