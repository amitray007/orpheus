/**
 * context.ts — project/workspace context resolution for the Orpheus CLI.
 *
 * resolveContext() determines which Orpheus project (and optionally workspace)
 * is "current" by checking these sources in priority order:
 *
 *   1. opts.project (explicit --project flag value)
 *      Matched against projects in this order:
 *        a. by id (exact UUID match)
 *        b. by name (case-sensitive exact match)
 *        c. by filesystem path (realpath-normalised to handle symlinks)
 *
 *   2. ORPHEUS_WORKSPACE_ID env var
 *      Injected by the app into every workspace shell. If present, look up
 *      the workspace to get its projectId, then use that project.
 *
 *   3. process.cwd() realpath
 *      Walk the DB project paths and check whether the real cwd matches
 *      (or is nested under) a registered project path.
 *
 *   4. No match → return a context with nulls; callers should error.
 *
 * The function depends on a narrow ContextDb interface rather than the
 * concrete better-sqlite3 implementation so this module typechecks
 * independently of packages/orpheus-cli/src/reads/db.ts (a later unit).
 *
 * EXPLICIT-PROJECT-NOT-FOUND vs NO-CONTEXT (QA fix #2)
 * ------------------------------------------------------
 * Two distinct failure modes were previously conflated: both "no --project was
 * given and cwd doesn't match any project" AND "--project <value> was given
 * but resolves to nothing" returned the exact same all-nulls ResolvedContext.
 * Callers couldn't tell them apart, so `--project zzz-nope` produced the
 * generic "not inside a project; pass --project ..." message at exit 2 — even
 * though --project WAS passed, just with a bad value.
 *
 * Fix: resolveContext() now throws a typed ProjectNotFoundError when
 * opts.project is non-empty but doesn't resolve to any project (case (a)).
 * Callers catch this explicitly and route it to printNotFoundError (exit 3,
 * "project not found: <value>") instead of the generic no-context message.
 * Case (b) — no --project, no ORPHEUS_WORKSPACE_ID, cwd doesn't match any
 * project — is unaffected: resolveContext still returns an all-nulls
 * ResolvedContext, and callers use noProjectMessage() (usage error).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

// ---------------------------------------------------------------------------
// Narrow DB interface — reads/db.ts will implement this
// ---------------------------------------------------------------------------

export interface ProjectRow {
  id: string
  path: string
  name: string
}

export interface WorkspaceRow {
  id: string
  projectId: string
}

/**
 * Narrow interface that resolveContext requires from the database layer.
 * The concrete implementation lives in packages/orpheus-cli/src/reads/db.ts.
 */
export interface ContextDb {
  getProjectById(id: string): ProjectRow | null
  getProjectByName(name: string): ProjectRow | null
  getProjectByPath(normalizedPath: string): ProjectRow | null
  /** Return all projects so cwd-prefix matching can be done in-process. */
  listProjects(): ProjectRow[]
  getWorkspaceById(id: string): WorkspaceRow | null
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface ResolvedContext {
  /** The workspace that was matched via ORPHEUS_WORKSPACE_ID (null otherwise). */
  workspaceId: string | null
  /** The matched project id, or null if no project was resolved. */
  projectId: string | null
  /** The filesystem path of the matched project, or null. */
  projectPath: string | null
  /** process.cwd() at resolution time (always present). */
  cwd: string
}

/**
 * Thrown by resolveContext() when opts.project was explicitly given (non-empty)
 * but did not match any project by id, name, or path. Distinguishes "explicit
 * --project with a bad value" (exit 3, printNotFoundError) from "no context at
 * all" (exit 2, noProjectMessage()) — see the module doc above (QA fix #2).
 */
export class ProjectNotFoundError extends Error {
  /** The raw --project value that failed to resolve. */
  readonly query: string

  constructor(query: string) {
    super(`project not found: ${query}`)
    this.name = 'ProjectNotFoundError'
    this.query = query
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve a path to its real filesystem location, tolerating errors. */
function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

/**
 * Match process.cwd() against registered project paths.
 * A project matches if its path equals cwd OR is a prefix of cwd
 * (i.e. cwd is nested inside the project root).
 *
 * Both sides are realpath-normalised so symlinks are transparent.
 * When multiple projects match (nested projects), the longest (most specific)
 * path wins.
 */
function matchByCwd(projects: ProjectRow[], cwd: string): ProjectRow | null {
  const realCwd = safeRealpath(cwd)

  let best: ProjectRow | null = null
  let bestLen = -1

  for (const p of projects) {
    const realProjectPath = safeRealpath(p.path)
    // Normalise with a trailing sep so that /foo doesn't prefix-match /foobar
    const prefix = realProjectPath.endsWith(path.sep) ? realProjectPath : realProjectPath + path.sep

    if (realCwd === realProjectPath || realCwd.startsWith(prefix)) {
      if (realProjectPath.length > bestLen) {
        best = p
        bestLen = realProjectPath.length
      }
    }
  }

  return best
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ResolveContextOpts {
  /** Value of the --project flag (id, name, or path). */
  project?: string
}

/**
 * Resolve the current Orpheus project/workspace context.
 *
 * Returns a ResolvedContext; callers should check projectId for null and
 * surface noProjectMessage() to the user in that case (usage error, exit 2).
 *
 * @throws ProjectNotFoundError if opts.project was explicitly given but did
 *   not resolve to any project — callers should catch this and surface
 *   printNotFoundError(err.message) (not-found error, exit 3) instead.
 */
export function resolveContext(opts: ResolveContextOpts, db: ContextDb): ResolvedContext {
  const cwd = process.cwd()

  // --- 1. Explicit --project flag ---
  if (opts.project != null && opts.project !== '') {
    const query = opts.project

    // (a) try by id
    let project = db.getProjectById(query)

    // (b) try by name
    if (project == null) {
      project = db.getProjectByName(query)
    }

    // (c) try by path (realpath-normalised)
    if (project == null) {
      project = db.getProjectByPath(safeRealpath(query))
    }

    if (project != null) {
      return {
        workspaceId: null,
        projectId: project.id,
        projectPath: project.path,
        cwd
      }
    }

    // Explicit flag but no match — throw a typed error so the caller can give
    // a targeted "project not found: <value>" error (exit 3) rather than the
    // generic no-context message (exit 2). See ProjectNotFoundError above.
    throw new ProjectNotFoundError(query)
  }

  // --- 2. ORPHEUS_WORKSPACE_ID env var ---
  const wsId = process.env.ORPHEUS_WORKSPACE_ID
  if (wsId != null && wsId !== '') {
    const workspace = db.getWorkspaceById(wsId)
    if (workspace != null) {
      const project = db.getProjectById(workspace.projectId)
      if (project != null) {
        return {
          workspaceId: workspace.id,
          projectId: project.id,
          projectPath: project.path,
          cwd
        }
      }
    }
    // Workspace id set but DB lookup failed — fall through to cwd matching.
  }

  // --- 3. process.cwd() prefix match ---
  const allProjects = db.listProjects()
  const matched = matchByCwd(allProjects, cwd)
  if (matched != null) {
    return {
      workspaceId: null,
      projectId: matched.id,
      projectPath: matched.path,
      cwd
    }
  }

  // --- 4. No match ---
  return { workspaceId: null, projectId: null, projectPath: null, cwd }
}

/**
 * Human-readable error message for callers when no project could be resolved.
 */
export function noProjectMessage(): string {
  return 'not inside a project; pass --project <id|name|path> or cd into a registered project'
}
