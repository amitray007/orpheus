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
import type {
  GitDiffFile,
  GitDiffFileStatus,
  GitDiffResult,
  GitDiffUnchangedResult
} from '../shared/types'
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

// PERF FIX #7 (fork-storm guard): the previous implementation ran
// `Promise.all(paths.map(untrackedFileDiff))` — one `git diff --no-index`
// child process PER untracked path, all spawned in the same tick. A
// workspace with hundreds/thousands of untracked files (a fresh clone before
// the first commit, a generated-output directory, node_modules accidentally
// untracked, etc.) would fork that many git subprocesses simultaneously,
// exhausting OS process/file-descriptor limits and stalling the main
// process. `UNTRACKED_CONCURRENCY` bounds how many `git diff --no-index`
// calls are in flight at once; `MAX_UNTRACKED_FILES` mirrors files.ts's own
// MAX_ENTRIES pattern, capping the absolute number of untracked files ever
// diffed in one `getWorkingTreeDiff` call so a truly pathological untracked
// count (tens of thousands of files) can't turn into tens of thousands of
// subprocesses even at bounded concurrency. Both are silent caps (no
// `truncated` flag on the wire — `GitDiffResult` isn't extended for this,
// consistent with "behavior-identical" scope): the realistic path (a normal
// working tree) never approaches either bound, so this only ever changes
// behavior in the pathological case the fork storm was already breaking.
const UNTRACKED_CONCURRENCY = 6
const MAX_UNTRACKED_FILES = 2000

/** Runs `worker` over `items` with at most `concurrency` in flight at once,
 *  writing each result back to its ORIGINAL index — so the returned array
 *  preserves input order regardless of completion order. Order preservation
 *  matters here: `getWorkingTreeDiff`'s output feeds the renderer's
 *  `diffSignature` (a per-file `sig` combined across `files[]`), which
 *  depends on stable ordering to avoid spurious diff-pane flicker on a
 *  no-op refresh (see the `sig`/LAG-LAYER #7 doc comment above). A naive
 *  concurrency pool that pushes results in COMPLETION order would reorder
 *  files nondeterministically between ticks even when nothing changed. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let nextIndex = 0

  async function runNext(): Promise<void> {
    const i = nextIndex++
    if (i >= items.length) return
    results[i] = await worker(items[i], i)
    await runNext()
  }

  const workerCount = Math.min(concurrency, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => runNext()))
  return results
}

/** Untracked files as all-additions `GitDiffFile`s, fetched with bounded
 *  concurrency (PERF FIX #7) instead of one subprocess per file at once. */
async function untrackedDiffFiles(cwd: string): Promise<GitDiffFile[]> {
  const allPaths = await untrackedPaths(cwd)
  const paths = allPaths.slice(0, MAX_UNTRACKED_FILES)
  const results = await mapWithConcurrency(paths, UNTRACKED_CONCURRENCY, (p) =>
    untrackedFileDiff(cwd, p)
  )
  return results.filter((f): f is GitDiffFile => f !== null)
}

// PERF FIX (main-side diff no-op detection) — caches the last-emitted
// COMBINED signature (join of every file's own `sig`, same shape as the
// renderer's diffSignature in GitTab.tsx) per workspaceId, so a debounced
// live-refresh settle that produced byte-for-byte the same diff as last time
// can skip re-serializing `files[]` (a multi-MB structured-clone on a large
// diff) across IPC entirely — see GitDiffUnchangedResult's own doc comment.
//
// Keyed by workspaceId (NOT cwd) per the caller's contract (src/main/ipc/
// git.ts passes the same workspaceId it resolves cwd from) — a workspace
// switch always looks up a DIFFERENT key, so the very first fetch after a
// switch is unconditionally a cache miss (`.get` returns undefined) and
// falls through to a real fetch + full `files[]` response. This is what
// guarantees the sentinel can never mask a genuinely different workspace's
// diff as "unchanged".
//
// A plain Map (not an LRU/bounded cache): one entry per currently-known
// workspaceId, cleared implicitly by workspace archival never re-querying
// this workspaceId again — the same "small, session-bounded key space"
// property files.ts/git.ts's own per-cwd caches rely on elsewhere in this
// codebase. Module-level (not per-call) so it persists across the debounced
// refetches that are the whole point of this cache.
const lastDiffSignatureByWorkspace = new Map<string, string>()

/** Same combining scheme as GitTab.tsx's own `diffSignature` (kept in sync
 *  deliberately — both must treat an identical `files[]` as equal): join
 *  every file's own cyrb53 `sig` (already unique per path+status+patch) with
 *  a separator that can't collide with a hash value itself. */
function combinedDiffSignature(files: readonly GitDiffFile[]): string {
  return files.map((f) => f.sig).join('\x01')
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
 *
 * `workspaceId` (PERF FIX — main-side diff no-op detection) is OPTIONAL and
 * purely additive: when provided, a result identical to the last one emitted
 * for this SAME workspaceId returns the `{ unchanged: true }` sentinel
 * instead of the full `files[]` — see GitDiffUnchangedResult's own doc
 * comment for the cache-key/workspace-switch-is-always-a-miss guarantee.
 * Omitting it (or a non-repo/failure result) always returns the full
 * `GitDiffResult`, unchanged from before this fix.
 */
export async function getWorkingTreeDiff(
  cwd: string,
  workspaceId?: string
): Promise<GitDiffResult | GitDiffUnchangedResult> {
  if (!cwd) return { repo: false, files: [] }
  if (!(await isGitRepo(cwd))) return { repo: false, files: [] }

  const [tracked, untracked] = await Promise.all([trackedDiffFiles(cwd), untrackedDiffFiles(cwd)])
  const files = [...tracked, ...untracked]

  if (workspaceId !== undefined) {
    const signature = combinedDiffSignature(files)
    if (lastDiffSignatureByWorkspace.get(workspaceId) === signature) {
      return { repo: true, unchanged: true }
    }
    lastDiffSignatureByWorkspace.set(workspaceId, signature)
  }

  return { repo: true, files }
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

/** Runs a `gh` subcommand with the resolved shell PATH — same env-resolution
 *  rationale as the rest of this module's `gh` calls, factored out so the
 *  primary (`gh pr diff`) and fallback (`gh api .../files`) paths share one
 *  spawn helper instead of duplicating the `resolveGhPathEnv` + execFile
 *  boilerplate. */
async function runGhLocal(
  cwd: string,
  args: readonly string[],
  opts: { timeout: number; maxBuffer: number }
): Promise<string> {
  const pathEnv = await resolveGhPathEnv()
  const { stdout } = await execFile('gh', args as string[], {
    cwd,
    env: { ...process.env, PATH: pathEnv },
    timeout: opts.timeout,
    maxBuffer: opts.maxBuffer
  })
  return stdout
}

// ---------------------------------------------------------------------------
// Fallback #1 — GitHub REST "list PR files" API (`gh api .../pulls/<n>/files
// --paginate`). `gh pr diff` fails outright on a large PR (HTTP 406
// "PullRequest.diff too_large" — GitHub caps the combined-diff endpoint at
// 20k lines; confirmed on this repo's own PR #117, ~21k lines). The
// `pulls/{n}/files` REST endpoint has NO such combined-size cap — it's
// paginated per-file (`--paginate` transparently concatenates every page
// into one JSON array), so it's the authoritative PR diff regardless of PR
// size, sourced from GitHub itself (no local-sync/accuracy concern — unlike
// diffing local git refs, this can never disagree with what GitHub shows).
//
// Each element's own `patch` field is ALREADY a valid unified-diff hunk
// blob (`@@ ... @@` lines onward) but is missing the `diff --git a/x b/x` +
// `---`/`+++` header lines `fileFromChunk` (and `PatchDiff`) expect — so
// each is reassembled into a synthetic `diff --git` chunk here and run
// through the SAME `fileFromChunk` parser the local-diff/`gh pr diff` paths
// use, rather than hand-building `GitDiffFile`s from the API's own
// additions/deletions/status fields. That keeps exactly one code path
// responsible for turning patch text into `GitDiffFile` (status/additions/
// deletions/oversized/sig all derived identically), and means a change to
// that derivation logic doesn't need a second parallel implementation here.
// ---------------------------------------------------------------------------

const PR_FILES_API_TIMEOUT_MS = 30_000
// A --paginate'd files listing for a very large PR (96 files on #117) is
// bigger than the single `gh pr diff` maxBuffer above (each entry repeats
// blob_url/contents_url/raw_url plus the patch text) — generous headroom.
const PR_FILES_API_MAX_BUFFER = 32 * 1024 * 1024

/** Raw shape of one element of `gh api repos/:owner/:repo/pulls/<n>/files`
 *  (GitHub REST "List pull requests files"). `patch` is `undefined` for a
 *  small number of files GitHub declines to diff individually (observed on
 *  #117: a few very large generated files) — those are emitted as
 *  `oversized` `GitDiffFile`s with real additions/deletions but no patch
 *  text, same as this module's own OVERSIZED_* caps do for an in-band huge
 *  file. */
type RawGhPrFile = {
  filename: string
  status: string
  additions: number
  deletions: number
  patch?: string
  previous_filename?: string
}

/** Map the REST API's own `status` enum (`added|removed|modified|renamed|
 *  copied|changed|unchanged`) onto this module's `GitDiffFileStatus`. Treats
 *  `copied`/`changed`/`unchanged` (rare — GitHub emits these for rewrites/
 *  detected copies) as `modified`, matching how `fileFromChunk` would
 *  classify an ordinary content change with no add/delete/rename markers. */
function apiStatusToGitDiffStatus(status: string): GitDiffFileStatus {
  if (status === 'added') return 'added'
  if (status === 'removed') return 'deleted'
  if (status === 'renamed') return 'renamed'
  return 'modified'
}

/** Reassemble one REST API file entry into a synthetic `diff --git` chunk
 *  so it can flow through the SAME `fileFromChunk` parser as every other
 *  diff source in this module (see the fallback's module doc above). The
 *  `---`/`+++` lines are the only part `fileFromChunk` actually inspects
 *  beyond the `diff --git` line itself (for new/deleted-file framing it
 *  looks at `new file mode`/`deleted file mode`, which the API doesn't give
 *  us — so those are synthesized too from `status`). */
function reassembleApiFileChunk(file: RawGhPrFile): string {
  const path = file.filename
  const oldPath = file.status === 'renamed' ? (file.previous_filename ?? path) : path
  const isAdded = file.status === 'added'
  const isRemoved = file.status === 'removed'
  const header = [
    `diff --git a/${oldPath} b/${path}`,
    ...(isAdded ? ['new file mode 100644'] : []),
    ...(isRemoved ? ['deleted file mode 100644'] : []),
    `--- ${isAdded ? '/dev/null' : `a/${oldPath}`}`,
    `+++ ${isRemoved ? '/dev/null' : `b/${path}`}`
  ].join('\n')
  return file.patch ? `${header}\n${file.patch}\n` : `${header}\n`
}

/** A file entry whose `patch` is absent (GitHub declined to diff it inline
 *  — large generated files, e.g. lockfiles, on #117) can't be run through
 *  `fileFromChunk` (there are no hunk lines to classify/count), so it's
 *  built directly from the API's own additions/deletions/status, flagged
 *  `oversized` so the renderer shows the same "Large diff hidden — show
 *  anyway" placeholder it already uses for an in-band huge file — just
 *  without a patch to reveal even if the user clicks through. */
function apiFileWithoutPatch(file: RawGhPrFile): GitDiffFile {
  const path = file.filename
  const status = apiStatusToGitDiffStatus(file.status)
  const oldPath =
    file.status === 'renamed' && file.previous_filename ? file.previous_filename : undefined
  const sig = cyrb53(`${path} ${status} ${file.additions} ${file.deletions} no-patch`)
  return {
    path,
    status,
    patch: '',
    additions: file.additions,
    deletions: file.deletions,
    oldPath,
    binary: false,
    oversized: true,
    sig
  }
}

/** One REST API file entry -> one `GitDiffFile`, via the reassembled-chunk +
 *  `fileFromChunk` path when a patch is present, or the direct/oversized
 *  path when it isn't. */
function apiFileToGitDiffFile(file: RawGhPrFile): GitDiffFile {
  if (!file.patch) return apiFileWithoutPatch(file)
  return fileFromChunk(reassembleApiFileChunk(file))
}

/** Fallback #1 for `getPrDiff`: the GitHub REST "list PR files" endpoint,
 *  which — unlike `gh pr diff`'s combined-diff endpoint — has no whole-PR
 *  size cap. Returns `null` (not `[]`) on any failure so the caller can tell
 *  "fetched, PR has zero files" (impossible in practice) apart from "this
 *  path failed, try the next fallback" — never throws. */
async function fetchPrDiffViaFilesApi(
  cwd: string,
  prNumber: number
): Promise<GitDiffFile[] | null> {
  try {
    const stdout = await runGhLocal(
      cwd,
      ['api', `repos/:owner/:repo/pulls/${prNumber}/files`, '--paginate'],
      { timeout: PR_FILES_API_TIMEOUT_MS, maxBuffer: PR_FILES_API_MAX_BUFFER }
    )
    const raw = JSON.parse(stdout) as RawGhPrFile[]
    if (!Array.isArray(raw)) return null
    return raw.map(apiFileToGitDiffFile)
  } catch {
    // gh missing / unauth / network / non-JSON / over maxBuffer — let the
    // caller fall through to the next (local-diff) fallback.
    return null
  }
}

// ---------------------------------------------------------------------------
// Fallback #2 (last resort) — sync-gated local `git diff <base>...HEAD`.
// Only used when BOTH `gh pr diff` and the files-API fallback above fail
// (gh missing entirely / fully unauthenticated / no network at all). A local
// diff can only stand in for the PR's actual diff when local HEAD is
// EXACTLY the PR's head commit (`headRefOid`) — otherwise (unpushed local
// commits, a force-push/rebase upstream the local branch hasn't seen, etc.)
// the local tree and the PR's true diff can silently disagree. So this path
// is sync-gated: it verifies local `HEAD` == `headRefOid` before ever
// producing output, and returns `null` (not a possibly-wrong diff) when
// they differ.
// ---------------------------------------------------------------------------

const LOCAL_FALLBACK_MAX_BUFFER = 32 * 1024 * 1024
const LOCAL_FALLBACK_TIMEOUT_MS = 10_000

/** Resolve local `HEAD`'s full commit SHA — null on any git failure. */
async function resolveLocalHeadSha(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFile('git', ['-C', cwd, 'rev-parse', 'HEAD'], { timeout: 2000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}

/** First ref that actually resolves, in preference order: `origin/<base>`
 *  (the base as GitHub itself would diff against) first, then the bare
 *  local `<base>` branch if the remote-tracking ref isn't present locally.
 *  Read-only — `rev-parse --verify` only, no fetch. */
async function resolveBaseRef(cwd: string, baseRefName: string): Promise<string | null> {
  for (const candidate of [`origin/${baseRefName}`, baseRefName]) {
    try {
      await execFile('git', ['-C', cwd, 'rev-parse', '--verify', candidate], { timeout: 2000 })
      return candidate
    } catch {
      // Doesn't exist locally — try the next candidate.
    }
  }
  return null
}

/** Sync-gated local fallback: returns the `base...HEAD` diff ONLY when local
 *  `HEAD` exactly matches the PR's `headRefOid` (guaranteeing the local tree
 *  IS the PR's commits, not merely "close") AND a usable base ref can be
 *  resolved locally. Returns `null` — never a possibly-inaccurate diff — the
 *  moment either check fails, so the caller degrades to the empty state
 *  instead of silently rendering a diff that could disagree with GitHub's. */
async function fetchPrDiffViaLocalGit(
  cwd: string,
  baseRefName: string,
  headRefOid: string
): Promise<GitDiffFile[] | null> {
  const localHead = await resolveLocalHeadSha(cwd)
  if (!localHead || localHead !== headRefOid) return null

  const baseRef = await resolveBaseRef(cwd, baseRefName)
  if (!baseRef) return null

  try {
    const { stdout } = await execFile('git', ['-C', cwd, 'diff', `${baseRef}...HEAD`], {
      timeout: LOCAL_FALLBACK_TIMEOUT_MS,
      maxBuffer: LOCAL_FALLBACK_MAX_BUFFER
    })
    return splitPatchByFile(stdout).map(fileFromChunk)
  } catch {
    return null
  }
}

/** The PR's head commit SHA (`headRefOid`), derived from `getPrDetail`'s
 *  already-cached `commits[]` (chronological, oldest first — verified
 *  against `gh pr view --json headRefOid` on #117: `commits.at(-1).oid` is
 *  exactly `headRefOid`) rather than a separate `gh pr view --json
 *  headRefOid` call. Null when the detail has no commits (shouldn't happen
 *  for a real PR, but this whole module is total-never-throws). */
function headRefOidFromDetail(detail: { commits: { oid: string }[] }): string | null {
  return detail.commits.at(-1)?.oid ?? null
}

/**
 * PR diff for the Workbench Git tab's [Working tree | PR diff] toggle
 * (Phase 4-pre): the full `base...head` unified diff for the PR opened
 * against `cwd`'s current branch. Reuses `getPrDetail` purely to resolve the
 * PR number/base/head (it already does cwd -> branch -> PR resolution,
 * cached) rather than re-deriving branch/PR lookup here.
 *
 * Three-tier, in order:
 *  1. `gh pr diff <number>` — fast, exact, GitHub's own combined-diff
 *     endpoint. Fails outright on a large PR (HTTP 406 "too_large" — capped
 *     at 20k lines; confirmed on this repo's PR #117, ~21k lines).
 *  2. GitHub REST "list PR files" API (`gh api .../pulls/<n>/files
 *     --paginate`) — no whole-PR size cap, still authoritative (sourced
 *     from GitHub, not local git), reassembled into the same per-file patch
 *     shape as (1). This is the primary path for a large PR.
 *  3. Sync-gated local `git diff <base>...HEAD` — last resort, only when
 *     `gh` itself is unusable (missing/unauth/offline) AND local HEAD is
 *     byte-identical to the PR's `headRefOid` (never used when the local
 *     tree could disagree with GitHub's actual diff).
 *
 * Total — never throws: no cwd / no branch / no PR / gh missing / unauth /
 * network / all three tiers failing all resolve to `{ repo: <best-effort>,
 * files: [] }`. The renderer only offers PR-diff mode when it already knows
 * (via the existing PR-detection state) that a PR exists, so an empty
 * result here should be rare in practice.
 */
export async function getPrDiff(cwd: string): Promise<GitDiffResult> {
  if (!cwd) return { repo: false, files: [] }
  const repo = await isGitRepo(cwd)
  if (!repo) return { repo: false, files: [] }

  const detail = await getPrDetail(cwd)
  if (!detail) return { repo: true, files: [] }

  try {
    const stdout = await runGhLocal(cwd, ['pr', 'diff', String(detail.number)], {
      timeout: PR_DIFF_TIMEOUT_MS,
      maxBuffer: PR_DIFF_MAX_BUFFER
    })
    return { repo: true, files: splitPatchByFile(stdout).map(fileFromChunk) }
  } catch {
    // `gh pr diff` failed — most commonly HTTP 406 "too_large" on a big PR,
    // but really any gh-pr-diff failure. Fall through to the files API.
  }

  const viaApi = await fetchPrDiffViaFilesApi(cwd, detail.number)
  if (viaApi) return { repo: true, files: viaApi }

  const headRefOid = headRefOidFromDetail(detail)
  if (headRefOid) {
    const viaLocal = await fetchPrDiffViaLocalGit(cwd, detail.baseRefName, headRefOid)
    if (viaLocal) return { repo: true, files: viaLocal }
  }

  // All three tiers failed (gh missing / unauth / network down entirely, or
  // local git out of sync with the PR's head) — render nothing.
  return { repo: true, files: [] }
}
