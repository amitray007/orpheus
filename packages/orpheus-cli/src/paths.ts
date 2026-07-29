/**
 * paths.ts — macOS data-dir and derived path resolution for the Orpheus CLI.
 *
 * APP_NAME DETECTION
 * ------------------
 * The Electron app uses a build-time define (__ORPHEUS_MODE__) to switch between
 * "Orpheus" (production), "Orpheus Dev" (development), "Orpheus WT" (worktree),
 * and "Orpheus Nightly" (nightly). The CLI cannot read that define, so we derive
 * the variant from environment signals instead:
 *
 *   1. ORPHEUS_DATA_VARIANT env var (internal/testing override):
 *      - "dev"     → "Orpheus Dev"
 *      - "wt"      → "Orpheus WT"
 *      - "nightly" → "Orpheus Nightly"
 *      - "prod"    → "Orpheus" (explicit prod override)
 *      This allows test scripts to point at the dev data dir without any --mode flag.
 *      There is deliberately NO user-facing --mode flag; variant is context-only.
 *
 *   2. Default → "Orpheus" (production data dir).
 *
 * NOTE: ORPHEUS_WORKSPACE_ID is injected into every workspace's shell environment
 * by the app (src/main/index.ts terminal:mount). A future enhancement could use it
 * to look up the workspace's variant (dev vs prod) from the socket. For now the
 * presence of ORPHEUS_WORKSPACE_ID alone doesn't reliably tell us which data dir
 * variant to use, so we leave that to ORPHEUS_DATA_VARIANT.
 */

import * as os from 'node:os'
import * as path from 'node:path'

export function resolveAppName(): string {
  const variant = process.env.ORPHEUS_DATA_VARIANT
  if (variant === 'dev') return 'Orpheus Dev'
  if (variant === 'wt') return 'Orpheus WT'
  if (variant === 'nightly') return 'Orpheus Nightly'
  // "prod" or anything else → production name
  return 'Orpheus'
}

/** Absolute path to the Orpheus user-data directory on macOS. */
export function getUserDataDir(): string {
  const appName = resolveAppName()
  return path.join(os.homedir(), 'Library', 'Application Support', appName)
}

/** Path to the SQLite database file. */
export function getSqlitePath(): string {
  return path.join(getUserDataDir(), 'orpheus.sqlite')
}

/** Path to the Unix-domain command socket (used by the CLI control protocol). */
export function getCmdSockPath(): string {
  const injectedPath = process.env.ORPHEUS_CMD_SOCK
  if (typeof injectedPath === 'string' && path.isAbsolute(injectedPath)) {
    return injectedPath
  }
  return path.join(getUserDataDir(), 'cmd.sock')
}

/**
 * Path to the CLI command bearer-token file.
 * ORPHEUS_CMD_TOKEN_FILE is an absolute-path internal/testing override,
 * symmetric with ORPHEUS_CMD_SOCK; it is not a user-facing CLI flag.
 */
export function getCmdTokenPath(): string {
  const injectedPath = process.env.ORPHEUS_CMD_TOKEN_FILE
  if (typeof injectedPath === 'string' && path.isAbsolute(injectedPath)) {
    return injectedPath
  }
  return path.join(getUserDataDir(), 'cmd.token')
}
