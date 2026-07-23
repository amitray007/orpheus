// ---------------------------------------------------------------------------
// src/main/routingProxy/paths.ts
//
// All on-disk locations for the managed CLIProxyAPI component, derived from
// app.getPath('userData') — never hardcoded, per CLAUDE.md's "no hardcoded
// paths" rule. Mirrors the layout convention of avatarCache.ts/
// ghosttyConfig.ts (a named subdirectory under userData).
//
// Layout:
//   userData/routing-proxy/
//     <version>/                 -- one dir per installed version, so a
//                                    version bump never clobbers a working
//                                    install mid-flight
//       cli-proxy-api              -- extracted binary (see BINARY_NAME)
//       config.yaml                -- generated config (see config.ts)
//     auth/                        -- shared across versions; CLIProxyAPI's
//                                    `auth-dir` (OAuth credential files),
//                                    survives a version bump
//     downloads/                   -- scratch dir for in-flight tar.gz +
//                                    checksums.txt before verify+extract
// ---------------------------------------------------------------------------

import * as path from 'node:path'
import { app } from 'electron'
import { BINARY_NAME } from './constants'

export function routingProxyRootDir(): string {
  return path.join(app.getPath('userData'), 'routing-proxy')
}

export function versionDir(version: string): string {
  return path.join(routingProxyRootDir(), version)
}

export function binaryPath(version: string): string {
  // The release archive extracts its entries at the ROOT (no nested/version
  // dir) — this was empirically verified against the real v7.2.92
  // darwin_aarch64 asset (see BINARY_NAME's doc comment in constants.ts for
  // the full verified file listing).
  return path.join(versionDir(version), BINARY_NAME)
}

export function configPath(version: string): string {
  return path.join(versionDir(version), 'config.yaml')
}

export function authDir(): string {
  return path.join(routingProxyRootDir(), 'auth')
}

export function downloadsDir(): string {
  return path.join(routingProxyRootDir(), 'downloads')
}
