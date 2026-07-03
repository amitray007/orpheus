// ---------------------------------------------------------------------------
// src/main/ipc/validate.ts
//
// IPC input-validation helpers, moved out of index.ts (STR-1) so ipc/<domain>
// modules that need path validation don't have to import index.ts (that
// would create a circular dependency). Pure functions — no state, only leaf
// imports (`node:path`, `node:os`, `./projects`).
// ---------------------------------------------------------------------------

import * as os from 'node:os'
import * as path from 'node:path'
import { listProjects } from '../projects'

/**
 * Assert that `value` is a non-empty string and an absolute filesystem path.
 * Throws on any renderer-supplied value that isn't a clean absolute path.
 */
export function assertAbsolutePath(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`IPC validation: ${label} must be a non-empty string`)
  }
  if (!path.isAbsolute(value)) {
    throw new Error(`IPC validation: ${label} must be an absolute path`)
  }
}

/**
 * Assert that `value` is an absolute path confined to a legitimate Claude
 * config root: the user's home directory (for `~/.claude/...` / `~/.claude.json`)
 * or any registered project's directory (for project-scoped settings files).
 * Used for renderer-supplied config-file paths so a compromised renderer cannot
 * redirect a write/delete/open at an arbitrary system path.
 */
export function assertManagedConfigPath(value: unknown, label: string): asserts value is string {
  assertAbsolutePath(value, label)
  const v = value
  const isUnder = (root: string): boolean => v === root || v.startsWith(root + path.sep)
  if (isUnder(os.homedir())) return
  for (const project of listProjects()) {
    if (project.path && isUnder(project.path)) return
  }
  throw new Error(
    `IPC validation: ${label} must be under the home directory or a registered project`
  )
}

const ALLOWED_EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

/**
 * Return true iff `url` is safe to pass to shell.openExternal().
 * Only http, https, and mailto are permitted — blocks file:, javascript:, etc.
 */
export function isSafeExternalUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0) return false
  try {
    const { protocol } = new URL(url)
    return ALLOWED_EXTERNAL_SCHEMES.has(protocol)
  } catch {
    return false
  }
}
