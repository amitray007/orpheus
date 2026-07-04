// ---------------------------------------------------------------------------
// src/main/ipc/files.ts
//
// Workbench Files tab — main-process data sources (Stage A). Three typed IPCs
// feed @pierre/trees (a FLAT path list + per-path git-status decorations) and
// the file viewer:
//
//   files:listDir  → FilesListing      gitignore-aware flat walk of the cwd
//   files:gitStatus → GitStatusEntry[]  per-path porcelain=v1 status
//   files:readFile → FileContents       path-guarded, size-capped, UTF-8 read
//
// The workspace's cwd is resolved from `workspaceId` via the injected
// getWorkspaceCwd resolver (mirrors how index.ts owns getWorkspace). Every
// handler is total: missing cwd / non-repo / denied paths return an empty
// result rather than throwing. See docs/learnings/pierre-libraries.md §7.
// ---------------------------------------------------------------------------

import * as childProcess from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { promisify } from 'node:util'
import ignore, { type Ignore } from 'ignore'
import type {
  FileContents,
  FilesListing,
  GitFileStatusKind,
  GitStatusEntry,
  WriteFileResult
} from '../../shared/types'
import { handle } from './handle'

const execFile = promisify(childProcess.execFile)

export type FilesIpcDeps = {
  /** Resolve a workspace's cwd from its id; null when the workspace is gone. */
  getWorkspaceCwd: (workspaceId: string) => string | null
}

// ── Walk caps ──────────────────────────────────────────────────────────────
// Guardrails so a giant tree (node_modules a user didn't gitignore, a monorepo)
// can't stall the walk or flood the renderer. Hitting either sets `truncated`.
const MAX_DEPTH = 12
const MAX_ENTRIES = 5000

// ── Read caps ──────────────────────────────────────────────────────────────
const MAX_READ_BYTES = 3 * 1024 * 1024 // 3 MB — larger files are truncated.
const BINARY_SNIFF_BYTES = 8192 // scan the leading chunk for a NUL byte.

const GITIGNORE = '.gitignore'
const EMPTY_LISTING: FilesListing = { paths: [], truncated: false }

// ---------------------------------------------------------------------------
// files:listDir — flat, gitignore-aware directory walk.
// ---------------------------------------------------------------------------

type WalkState = {
  paths: string[]
  truncated: boolean
}

/**
 * Build the Ignore matcher for a directory by combining the inherited gitignore
 * text with this directory's own `.gitignore` (if any), so nested ignore files
 * stack the way git resolves them. Matcher rules are always evaluated against
 * root-relative paths, which is why patterns accumulate as text and a single
 * matcher is rebuilt per level (`ignore` matches relative to where it's tested,
 * and we always test the full repo-relative path). `.git` is always excluded.
 */
async function buildIgnore(
  absDir: string,
  inheritedText: string
): Promise<{ ig: Ignore; text: string }> {
  let text = inheritedText
  try {
    const own = await fs.readFile(nodePath.join(absDir, GITIGNORE), 'utf8')
    text = text ? `${text}\n${own}` : own
  } catch {
    // No local .gitignore — inherit as-is.
  }
  const ig = ignore().add('.git').add(text)
  return { ig, text }
}

/**
 * Recursively walk `absDir`, appending repo-relative POSIX paths to
 * `state.paths`. Directories carry a trailing slash; files do not. `.gitignore`
 * files layer per-directory. Stops (setting `state.truncated`) once the depth
 * or entry cap is hit.
 */
async function walkDir(
  absDir: string,
  relDir: string,
  depth: number,
  inheritedText: string,
  state: WalkState
): Promise<void> {
  if (state.truncated) return
  if (depth > MAX_DEPTH) {
    state.truncated = true
    return
  }

  const { ig, text } = await buildIgnore(absDir, inheritedText)

  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true })
  } catch {
    return // permission denied / vanished — skip this subtree.
  }

  for (const entry of entries) {
    if (state.paths.length >= MAX_ENTRIES) {
      state.truncated = true
      return
    }
    const name = entry.name
    const rel = relDir ? `${relDir}/${name}` : name
    const isDir = entry.isDirectory()
    // `ignore` wants a trailing slash to match dir-only rules correctly.
    if (ig.ignores(isDir ? `${rel}/` : rel)) continue

    if (isDir) {
      state.paths.push(`${rel}/`)
      await walkDir(nodePath.join(absDir, name), rel, depth + 1, text, state)
      if (state.truncated) return
    } else if (entry.isFile()) {
      state.paths.push(rel)
    }
    // Symlinks and other special entries are intentionally skipped.
  }
}

async function listDir(cwd: string): Promise<FilesListing> {
  try {
    const stat = await fs.stat(cwd)
    if (!stat.isDirectory()) return EMPTY_LISTING
  } catch {
    return EMPTY_LISTING
  }

  const state: WalkState = { paths: [], truncated: false }
  await walkDir(cwd, '', 0, '', state)
  state.paths.sort((a, b) => a.localeCompare(b))
  return { paths: state.paths, truncated: state.truncated }
}

// ---------------------------------------------------------------------------
// files:gitStatus — per-path porcelain=v1 status.
// ---------------------------------------------------------------------------

/**
 * Map a git porcelain XY status code to the GitStatusEntry enum. Order matters:
 * untracked/renamed are exact 2-char forms; the rest test either column.
 */
function mapXyToStatus(xy: string): GitFileStatusKind | null {
  if (xy === '??') return 'untracked'
  const x = xy[0]
  const y = xy[1]
  if (x === 'R' || y === 'R') return 'renamed'
  if (x === 'A' || y === 'A') return 'added'
  if (x === 'D' || y === 'D') return 'deleted'
  if (x === 'M' || y === 'M') return 'modified'
  return null
}

/**
 * Extract the repo-relative POSIX path from a porcelain=v1 line. Renames are
 * `R  old -> new`; we keep the NEW path. Quoted paths (core.quotePath) are left
 * as-is since we pass `-z`-free porcelain but disable quoting via `-c`.
 */
function parsePorcelainPath(rest: string): string {
  const arrow = rest.indexOf(' -> ')
  const path = arrow >= 0 ? rest.slice(arrow + 4) : rest
  return path.trim()
}

async function gitStatus(cwd: string): Promise<GitStatusEntry[]> {
  if (!cwd) return []
  let stdout: string
  try {
    // core.quotePath=false keeps non-ASCII paths literal (POSIX, matching
    // listDir) instead of octal-escaped.
    const result = await execFile(
      'git',
      ['-C', cwd, '-c', 'core.quotePath=false', 'status', '--porcelain=v1'],
      { timeout: 4000, maxBuffer: 16 * 1024 * 1024 }
    )
    stdout = result.stdout
  } catch {
    return [] // not a repo / git missing — empty, no throw.
  }

  const entries: GitStatusEntry[] = []
  for (const line of stdout.split('\n')) {
    if (line.length < 4) continue // need "XY " + at least one path char.
    const xy = line.slice(0, 2)
    const status = mapXyToStatus(xy)
    if (!status) continue
    const path = parsePorcelainPath(line.slice(3))
    if (path) entries.push({ path, status })
  }
  return entries
}

// ---------------------------------------------------------------------------
// files:readFile — path-guarded, size-capped, binary-aware UTF-8 read.
// ---------------------------------------------------------------------------

const EMPTY_CONTENTS: FileContents = {
  contents: '',
  name: '',
  size: 0,
  truncated: false,
  binary: false
}

/**
 * Resolve `relPath` against `cwd` and assert it stays inside the workspace.
 * Returns the absolute path, or null if it escapes (`../`, absolute path, or a
 * symlink-free lexical escape). Lexical containment is sufficient here because
 * we never follow the path through symlinks with elevated privilege — we just
 * read it — but we still reject anything that resolves outside the root.
 */
function resolveInside(cwd: string, relPath: string): string | null {
  const root = nodePath.resolve(cwd)
  const abs = nodePath.resolve(root, relPath)
  const rel = nodePath.relative(root, abs)
  // Reject an escape (`..` as a whole segment) or an absolute rel — but allow
  // legitimate names that merely start with dots (e.g. `..foo`, `.env`).
  if (rel === '' || rel === '..' || rel.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(rel))
    return null
  return abs
}

/** True if the leading chunk contains a NUL byte (binary heuristic). */
function looksBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, BINARY_SNIFF_BYTES)
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

async function readFileContents(cwd: string, relPath: string): Promise<FileContents> {
  if (!cwd || !relPath) return EMPTY_CONTENTS
  const abs = resolveInside(cwd, relPath)
  if (!abs) return EMPTY_CONTENTS // traversal escape — refuse.

  const name = nodePath.basename(abs)
  let buf: Buffer
  let size: number
  try {
    const stat = await fs.stat(abs)
    if (!stat.isFile()) return { ...EMPTY_CONTENTS, name }
    size = stat.size
    const readBytes = Math.min(size, MAX_READ_BYTES)
    const handle = await fs.open(abs, 'r')
    try {
      buf = Buffer.alloc(readBytes)
      await handle.read(buf, 0, readBytes, 0)
    } finally {
      await handle.close()
    }
  } catch {
    return { ...EMPTY_CONTENTS, name } // missing / denied — empty, no throw.
  }

  if (looksBinary(buf)) {
    return { contents: '', name, size, truncated: false, binary: true }
  }

  const truncated = size > MAX_READ_BYTES
  return { contents: buf.toString('utf8'), name, size, truncated, binary: false }
}

// ---------------------------------------------------------------------------
// files:writeFile — path-guarded UTF-8 write (Files-tab editor save).
// ---------------------------------------------------------------------------

/**
 * Write `contents` as UTF-8 to `relPath` inside `cwd`, reusing the same
 * `resolveInside` traversal guard as the read path — a `../` escape, an
 * absolute path, or the cwd root itself is refused with `{ ok: false,
 * error: 'traversal' }` and no write happens. All fs failures collapse to
 * `{ ok: false, error: 'denied' }`; the handler never throws.
 */
async function writeFileContents(
  cwd: string,
  relPath: string,
  contents: string
): Promise<WriteFileResult> {
  const abs = resolveInside(cwd, relPath)
  if (!abs) return { ok: false, error: 'traversal' }
  try {
    await fs.writeFile(abs, contents, 'utf8')
    return { ok: true }
  } catch {
    return { ok: false, error: 'denied' }
  }
}

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------

export function registerFilesIpc(deps: FilesIpcDeps): void {
  const { getWorkspaceCwd } = deps

  handle('files:listDir', (_e, { workspaceId }) => {
    const cwd = getWorkspaceCwd(workspaceId)
    return cwd ? listDir(cwd) : Promise.resolve(EMPTY_LISTING)
  })

  handle('files:gitStatus', (_e, { workspaceId }) => {
    const cwd = getWorkspaceCwd(workspaceId)
    return cwd ? gitStatus(cwd) : Promise.resolve([])
  })

  handle('files:readFile', (_e, { workspaceId, path }) => {
    const cwd = getWorkspaceCwd(workspaceId)
    return cwd ? readFileContents(cwd, path) : Promise.resolve(EMPTY_CONTENTS)
  })

  handle('files:writeFile', (_e, { workspaceId, path, contents }) => {
    const cwd = getWorkspaceCwd(workspaceId)
    if (!cwd) return Promise.resolve({ ok: false, error: 'no-workspace' } as WriteFileResult)
    return writeFileContents(cwd, path, contents)
  })
}
