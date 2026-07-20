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
import { getAppUiState } from './uiState'
import { isDev } from './appMode'

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
  /**
   * The auth env layer (ANTHROPIC_API_KEY, cloud-provider routing vars, etc.)
   * merged into `env` above. Returned separately (not folded into `launch`)
   * because composeClaudeLaunch's own output must stay auth-free — callers
   * that only need settings composition (e.g. sessions.ts context sizing)
   * shouldn't have to reason about auth. The caller stores this alongside
   * `launch` in the mount snapshot so auth changes participate in dirty
   * detection. NEVER log this value — plaintext secrets.
   */
  authEnv: Record<string, string>
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
// @param cmdServer    { sockPath, token } from the running command server,
//                     undefined if the command server has not started yet.
//                     When present, ORPHEUS_CMD_SOCK and ORPHEUS_CMD_TOKEN are
//                     injected so the CLI can reach the server zero-config from
//                     inside a workspace terminal.
// ---------------------------------------------------------------------------

export function buildMountEnv(
  workspaceId: string,
  projectId: string | undefined,
  sockPath: string | undefined,
  cmdServer?: { sockPath: string; token: string }
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

  // Only inject ORPHEUS_NOTIFY (hook plumbing) when hooks integration is enabled.
  // ORPHEUS_WORKSPACE_ID is injected UNCONDITIONALLY because it is now load-bearing
  // for the CLI (spawn guardrails use parentId from context.workspaceId, self-archive
  // guard compares args.id === context.workspaceId). Gating it on hooksEnabled was a
  // bug: hooks default OFF, so ORPHEUS_WORKSPACE_ID was always absent, disabling the
  // `if (parentId != null)` cap checks and making the self-action guard always false.
  const hooksEnabled = getAppUiState().hooksIntegrationEnabled

  // Resolve the Resources/bin dir so we can prepend it to PATH.
  // Both packaged and dev builds install to an .app bundle where the Electron
  // binary lives at Contents/MacOS/<AppName> and the shim at
  // Contents/Resources/bin/orpheus.  process.resourcesPath == Contents/Resources
  // in both cases, so we always derive the bin dir from there (same as shimPath()).
  const orpheusBinDir = join(process.resourcesPath, 'bin')

  const env: Record<string, string> = {
    ...launch.env,
    ...authEnv, // auth env wins on conflict
    ...(launch.flags ? { ORPHEUS_CLAUDE_FLAGS: launch.flags } : {}),
    ...(launch.settingsJson ? { ORPHEUS_CLAUDE_SETTINGS_JSON: launch.settingsJson } : {}),
    ORPHEUS_WORKSPACE_ID: workspaceId, // always present — load-bearing for CLI guardrails
    ...(sockPath ? { ORPHEUS_SOCK: sockPath } : {}),
    ...(hooksEnabled ? { ORPHEUS_NOTIFY: shimPath() } : {}),
    ...(cachedUserPath ? { ORPHEUS_USER_PATH: cachedUserPath } : {}),
    ORPHEUS_GHOSTTY_CONFIG: ghosttyConfigPath,
    // CLI plumbing: prepend orpheusBinDir to PATH so `orpheus` resolves inside
    // every workspace terminal without a global symlink (deferred to Phase 2).
    // PATH is assembled as: orpheusBinDir : cachedUserPath (if any) : existing PATH.
    // The orpheus-claude.sh wrapper already splices ORPHEUS_USER_PATH into PATH,
    // so we set ORPHEUS_BIN_DIR separately and let the wrapper prepend it.
    ORPHEUS_BIN_DIR: orpheusBinDir,
    // Data variant — tells the CLI which data dir to target (dev or prod).
    ORPHEUS_DATA_VARIANT: isDev ? 'dev' : 'prod',
    // Command server plumbing — injected when the server is running so the CLI
    // resolves sock/token zero-config from within a workspace terminal.
    // The CLI also falls back to reading cmd.token from disk, so this is a
    // convenience that avoids a file read on every invocation.
    ...(cmdServer ? { ORPHEUS_CMD_SOCK: cmdServer.sockPath } : {}),
    ...(cmdServer ? { ORPHEUS_CMD_TOKEN: cmdServer.token } : {})
  }

  // Resolve the wrapper script path.
  // Packaged: Contents/Resources/orpheus-claude.sh
  // Dev:      <repo>/resources/orpheus-claude.sh
  const command = app.isPackaged
    ? join(process.resourcesPath, 'orpheus-claude.sh')
    : join(__dirname, '../../resources/orpheus-claude.sh')

  return { command, env, launch, authEnv }
}
