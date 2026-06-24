// ---------------------------------------------------------------------------
// src/main/orpheusSurfaceAdapter.ts
//
// Orpheus-specific glue between the generic ghostty-surface package and
// src/main/index.ts.
//
// Exports:
//   loadOrpheusSurface()    — resolve the correct .node path and load the addon
//   buildMountEnv()         — assemble the surfaceEnv + command for terminal:mount
//
// All Orpheus-specific imports live here; the generic packages/ghostty-surface
// package has zero knowledge of this layer.
// ---------------------------------------------------------------------------

import { app } from 'electron'
import { join } from 'path'
import { loadGhosttySurface, type GhosttySurfaceAddon } from '../../packages/ghostty-surface/index'
import { composeClaudeLaunch, type ClaudeLaunch } from './claudeSettings'
import { getClaudeAuthEnv } from './claudeAuth'
import { shimPath } from './orpheusNotify'
import { getCachedShellPath } from './shellHelpers'
import { writeGhosttyConfigFile } from './ghosttyConfig'

// ---------------------------------------------------------------------------
// loadOrpheusSurface
//
// Resolves the Orpheus-specific addon path (packaged vs dev layout) and
// delegates to the generic loadGhosttySurface factory.
//
// Caller (loadTerminalAddon in index.ts) is responsible for singleton +
// error-cache semantics — this function loads fresh every time it's called.
// ---------------------------------------------------------------------------

export function loadOrpheusSurface(): GhosttySurfaceAddon {
  const addonPath = app.isPackaged
    ? join(process.resourcesPath, 'packages/ghostty-surface/ghostty_native.node')
    : join(__dirname, '../../packages/ghostty-surface/build/Release/ghostty_native.node')

  return loadGhosttySurface({ addonPath })
}

// ---------------------------------------------------------------------------
// MountEnvResult — return type for buildMountEnv
// ---------------------------------------------------------------------------

export type MountEnvResult = {
  /** Full path to the wrapper script (orpheus-claude.sh). */
  command: string
  /** Complete env map to pass as mount opts.env — includes auth, settings, etc. */
  env: Record<string, string>
  /**
   * The raw ClaudeLaunch snapshot. Caller stores this in launchSnapshots so
   * recomputeDirty can detect settings drift after mount.
   */
  launch: ClaudeLaunch
}

// ---------------------------------------------------------------------------
// buildMountEnv
//
// Assembles the surface launch environment for a workspace mount. This is the
// Orpheus-specific env assembly block that previously lived inline in the
// terminal:mount IPC handler in index.ts.
//
// Layer order (last wins on conflict):
//   composeClaudeLaunch (settings → flags + settingsJson + base env)
//   → getClaudeAuthEnv (API key wins — NEVER logged)
//   → ORPHEUS_* vars (wrapper plumbing)
//
// @param workspaceId  The workspace being mounted.
// @param projectId    The owning project (for per-project setting overrides).
// @param sockPath     notifyServer.sockPath if the notify server is running,
//                     undefined otherwise (ORPHEUS_SOCK is omitted).
// ---------------------------------------------------------------------------

export function buildMountEnv(
  workspaceId: string,
  projectId: string | undefined,
  sockPath: string | undefined
): MountEnvResult {
  // Compose claude settings → flags, settingsJson, base env vars.
  const launch = composeClaudeLaunch(projectId, workspaceId)

  // Auth env vars (ANTHROPIC_API_KEY, provider routing flags, etc.).
  // Merged AFTER launch.env so auth always wins on conflict.
  // NEVER log authEnv values — they contain plaintext secrets.
  const authEnv = getClaudeAuthEnv()

  // User's full shell PATH captured once at app start (login+interactive shell).
  // Omitted if the promise hasn't settled yet; wrapper falls back to .zshrc.
  const cachedUserPath = getCachedShellPath()

  const ghosttyConfigPath = writeGhosttyConfigFile()

  const env: Record<string, string> = {
    ...launch.env,
    ...authEnv, // auth env wins on conflict
    ...(launch.flags ? { ORPHEUS_CLAUDE_FLAGS: launch.flags } : {}),
    ...(launch.settingsJson ? { ORPHEUS_CLAUDE_SETTINGS_JSON: launch.settingsJson } : {}),
    ORPHEUS_WORKSPACE_ID: workspaceId,
    ...(sockPath ? { ORPHEUS_SOCK: sockPath } : {}),
    ORPHEUS_NOTIFY: shimPath(),
    ...(cachedUserPath ? { ORPHEUS_USER_PATH: cachedUserPath } : {}),
    ORPHEUS_GHOSTTY_CONFIG: ghosttyConfigPath
  }

  // Resolve the wrapper script path.
  // Packaged: Contents/Resources/orpheus-claude.sh
  // Dev:      <repo>/resources/orpheus-claude.sh
  const command = app.isPackaged
    ? join(process.resourcesPath, 'orpheus-claude.sh')
    : join(__dirname, '../../resources/orpheus-claude.sh')

  return { command, env, launch }
}
