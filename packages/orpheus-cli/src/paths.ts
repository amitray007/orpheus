/**
 * paths.ts — macOS data-dir and derived path resolution for the Orpheus CLI.
 *
 * APP_NAME DETECTION
 * ------------------
 * The Electron app uses a build-time define (__ORPHEUS_MODE__) to switch between
 * "Orpheus" (production) and "Orpheus Dev" (development). The CLI cannot read that
 * define, so we derive the variant from environment signals instead:
 *
 *   1. ORPHEUS_DATA_VARIANT env var (internal/testing override):
 *      - "dev"  → "Orpheus Dev"
 *      - "prod" → "Orpheus" (explicit prod override)
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
  return path.join(getUserDataDir(), 'cmd.sock')
}

/** Path to the CLI command bearer-token file. */
export function getCmdTokenPath(): string {
  return path.join(getUserDataDir(), 'cmd.token')
}
