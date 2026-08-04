import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'

// ---------------------------------------------------------------------------
// src/main/projectPathResolve.ts
//
// Path resolution for `project.add` (commandServer.ts) — the ONE place a
// path arriving over the command socket or the CLI's `project add` is
// untrusted, free-typed text rather than a value chosen from Electron's
// native `dialog.showOpenDialog` (see projects:pickAndAdd in
// src/main/ipc/projects.ts, which never needs this: the OS picker already
// hands back an absolute, real path).
//
// No existing helper does this — grepped the repo for `realpath`/`resolve(`/
// `homedir()` before writing this (per task instructions): iconPacks.ts and
// workbenchControl/pathSafety.ts both call fs.realpath, but only to check
// CONTAINMENT of an already-relative path inside a known workspace root, not
// to turn an arbitrary user-typed string (which may start with `~`, be
// relative to the CLI's cwd, or contain `..`) into an absolute path.
// packages/orpheus-cli/src/commands/project.ts's `resolveProject` and
// context.ts's `safeRealpath` both call fs.realpathSync directly on the raw
// query — neither expands a leading `~`, and both silently fall back to the
// UNRESOLVED input on any realpath failure (fine for their read-only lookup
// use case, wrong here: a path that doesn't yet resolve must be a hard
// error, not silently registered as whatever string the user typed).
//
// resolveProjectPath is intentionally split from the existence check
// (assertProjectDirectory) below: the former is pure (no fs access beyond
// os.homedir(), which is a sync in-memory read, not a disk call) and is what
// scripts/verify-command-action.ts exercises directly without touching the
// filesystem; the latter is the one function that actually stats disk.
// ---------------------------------------------------------------------------

/**
 * Expand a leading `~` (home dir) and resolve relative segments (`.`, `..`,
 * a bare relative path) against `cwd` into an absolute, lexically-normalised
 * path. Pure — does not touch the filesystem, so it can't fail on a
 * not-yet-existing path (that's assertProjectDirectory's job below).
 *
 * `~` alone or `~/rest` expands via os.homedir(); `~otheruser/...` is left
 * untouched (Node has no portable way to resolve another user's home dir
 * without shelling out, and this is a niche enough case that leaving it as a
 * literal path segment — which will then fail the existence check with a
 * clear "not a directory" error — is preferable to a wrong guess).
 */
export function resolveProjectPath(rawPath: string, cwd: string = process.cwd()): string {
  let expanded = rawPath
  if (expanded === '~') {
    expanded = os.homedir()
  } else if (expanded.startsWith('~/')) {
    expanded = nodePath.join(os.homedir(), expanded.slice(2))
  }
  return nodePath.resolve(cwd, expanded)
}

/**
 * Thrown by assertProjectDirectory when the resolved path doesn't exist or
 * isn't a directory — distinct from a generic Error only so callers could
 * special-case it later if needed; today every caller just surfaces
 * `.message` (matching every other commandServer.ts dispatch handler's
 * plain `throw new Error(...)` convention).
 */
export class ProjectDirectoryNotFoundError extends Error {}

/**
 * Verify the resolved path exists AND is a directory. Throws
 * ProjectDirectoryNotFoundError with a clear, actionable message otherwise —
 * registering a typo'd path would silently create a project (and its
 * default workspace, per addProject's own atomic insert) pointing at
 * nothing, which is far more confusing to discover later than a rejected
 * command right now.
 */
export function assertProjectDirectory(resolvedPath: string): void {
  let stat: fs.Stats
  try {
    stat = fs.statSync(resolvedPath)
  } catch {
    throw new ProjectDirectoryNotFoundError(`directory not found: ${resolvedPath}`)
  }
  if (!stat.isDirectory()) {
    throw new ProjectDirectoryNotFoundError(`not a directory: ${resolvedPath}`)
  }
}

/**
 * Everything the `project.add` dispatch handler (commandServer.ts) does
 * BEFORE calling addProject(): validate args.path's shape, resolve it
 * (tilde + relative-to-absolute), and assert the result is a real
 * directory. Extracted as its own function — rather than left inline in the
 * dispatch table — specifically so scripts/verify-project-add.ts can
 * exercise the handler's FULL validation behavior (a bad shape is rejected,
 * a good path is resolved and existence-checked) by calling real code, not
 * by grepping commandServer.ts's source text for the guard's presence. A
 * source-text grep can't tell a live guard from one that's been silently
 * neutered (e.g. wrapped in `if (false && ...)`) — this function makes that
 * class of regression an executable, not just textual, test.
 *
 * commandServer.ts's dispatch entry is a thin wrapper: call this, then pass
 * the returned path to addProject() (the one remaining step that needs
 * Electron's getDb()).
 */
export function resolveProjectAddPath(args: Record<string, unknown>, cwd?: string): string {
  if (typeof args.path !== 'string' || args.path === '') {
    throw new Error('args.path is required')
  }
  const resolved = resolveProjectPath(args.path, cwd)
  assertProjectDirectory(resolved)
  return resolved
}
