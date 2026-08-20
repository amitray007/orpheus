// ---------------------------------------------------------------------------
// src/main/orpheusSurfaceAdapter.ts
//
// Orpheus-specific glue between the generic ghostty-surface package and
// src/main/index.ts.
//
// Exports:
//   loadOrpheusSurface()     — resolve the correct .node path and load the addon
//   composeLaunchForMount()  — compose settings -> ClaudeLaunch ONCE per mount
//   buildMountEnv()          — assemble the surfaceEnv + command for terminal:mount
//                              (accepts the same ClaudeLaunch via precomposedLaunch
//                              so a mount never composes settings twice)
//
// All Orpheus-specific imports live here; the generic packages/ghostty-surface
// package has zero knowledge of this layer.
// ---------------------------------------------------------------------------

import { app } from 'electron'
import { join } from 'path'
import { loadGhosttySurface, type GhosttySurfaceAddon } from '../../packages/ghostty-surface/index'
import { type ClaudeLaunch } from './claudeSettings'
import { getClaudeAuthEnv } from './claudeAuth'
import { shimPath } from './orpheusNotify'
import { getCachedShellPath } from './shellHelpers'
import { writeGhosttyConfigFile } from './ghosttyConfig'
import { getAppUiState } from './uiState'
import { isDev, isWorktreeBuild, isNightly } from './appMode'
import { buildManagedMcpFlagsString } from './controlPlane/managedMcpLaunch'
import type { ClaudeRuntimeBinding } from './controlPlane/runtimeLeases'
import { FLAG_DELIMITER } from '../shared/cliFlags'
import { getWorkspace } from './workspaces'
import { resolveHarness } from './harness/registry'
import { resolveAuthEnvForDescriptor } from './harness/authScope'

// Which data dir the bundled CLI should target, mirroring APP_NAME in
// appMode.ts. Resolved once at module load — the build variant is a
// compile-time constant, so there is nothing per-mount to recompute. Nightly
// is checked before isDev because nightly is NOT a dev build (isDev is false
// for it) yet still needs its own data dir rather than production's.
const DATA_VARIANT = isWorktreeBuild ? 'wt' : isNightly ? 'nightly' : isDev ? 'dev' : 'prod'

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

export type RuntimeMountLease = Readonly<{
  binding: ClaudeRuntimeBinding
  token: string | null
}>

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
  cmdServer?: { sockPath: string; token: string },
  precomposedLaunch?: ClaudeLaunch,
  runtimeLease?: RuntimeMountLease
): MountEnvResult {
  // Resolve the workspace's harness descriptor. resolveHarness() NEVER
  // throws — a missing workspace row or an unknown/stale harnessId both fall
  // back to the Claude descriptor, so this lookup can't change behavior for
  // any workspace that predates the harness_id column (all of which read
  // back as 'claude' — see workspaces.ts's row→record mapping).
  const workspace = getWorkspace(workspaceId)
  const descriptor = resolveHarness(workspace?.harnessId)

  // Compose the harness's launch payload → flags, settingsJson, base env
  // vars. Callers on the terminal:mount hot path (index.ts) AND the tmux
  // hosting path (tmuxHost.ts's hostWorkspace) already composed this once
  // via composeLaunchForMount and pass it back in via precomposedLaunch —
  // composing is a DB read (global/project/workspace harness_settings rows)
  // per call, so reusing it here halves the settings-layering work paid on
  // EVERY mount (see composeLaunchForMount's doc comment for the fuller
  // story). precomposedLaunch is ALWAYS produced by composeLaunchForMount
  // (never by claudeSettings.ts's older composeClaudeLaunch, which reads
  // the pre-cutover claude_global_settings columns and is a genuinely
  // different, stale source — see fcb579cc / 1d214b05), so it is always the
  // same function's output as the descriptor.composeLaunch fallback below
  // would produce. That equivalence held only once every real caller was
  // migrated onto composeLaunchForMount; the tmux path was the last
  // straggler still calling composeClaudeLaunch directly until it was fixed
  // to call composeLaunchForMount like every other caller.
  const launch = precomposedLaunch ?? descriptor.composeLaunch(projectId, workspaceId)

  // Auth env vars (ANTHROPIC_API_KEY, provider routing flags, etc.).
  // Merged AFTER launch.env so auth always wins on conflict.
  // NEVER log authEnv values — they contain plaintext secrets.
  // Scoped to Claude ONLY — see resolveAuthEnvForDescriptor's doc comment.
  const authEnv = resolveAuthEnvForDescriptor(descriptor.id, getClaudeAuthEnv)

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

  const managedMcpFlags = runtimeLease ? buildManagedMcpFlagsString(process.resourcesPath) : ''
  const effectiveFlags = [launch.flags, managedMcpFlags].filter(Boolean).join(FLAG_DELIMITER)

  const env: Record<string, string> = {
    ...launch.env,
    ...authEnv, // auth env wins on conflict
    // Dual-emit under BOTH the legacy ORPHEUS_CLAUDE_* names and the new
    // ORPHEUS_HARNESS_* names, with identical values. A tmux session created
    // by the PREVIOUS build is still running the OLD wrapper script, which
    // only reads ORPHEUS_CLAUDE_*; emitting only the new names would break
    // every in-flight session across an app upgrade (the wrapper isn't
    // re-run — the tmux session just keeps its original env). Keep both
    // until Phase 5, at least one release after every wrapper script reads
    // the new names exclusively. Do NOT "simplify" this to one pair.
    // ALWAYS emitted, even when empty — deliberately NOT conditional.
    // These vars must SHADOW whatever the tmux server's global environment
    // holds. That global env is the env of the client that first spawned the
    // server (tmuxSpawnEnv passes {...process.env}), so if Orpheus was itself
    // launched from inside an Orpheus workspace pane it can carry that pane's
    // ORPHEUS_CLAUDE_FLAGS. Omitting the key on an empty compose left nothing
    // to shadow it, and harness-common.sh's rollback fallback
    // (`: "${ORPHEUS_HARNESS_FLAGS:=${ORPHEUS_CLAUDE_FLAGS:-}}"`) then fed the
    // OUTER app's Claude argv to `codex` — which rejected it with
    // "unexpected argument '--permission-mode'". Emitting the empty string
    // shadows it (zsh's `:=` substitutes on empty, so BOTH names must be set,
    // which they are). scrubInheritedPaneEnv.ts fixes the leak at its source;
    // this is the belt-and-braces half, and it also protects a tmux server
    // that some OTHER client spawned.
    ORPHEUS_CLAUDE_FLAGS: effectiveFlags,
    ORPHEUS_HARNESS_FLAGS: effectiveFlags,
    ...(launch.settingsJson
      ? {
          ORPHEUS_CLAUDE_SETTINGS_JSON: launch.settingsJson,
          ORPHEUS_HARNESS_SETTINGS_JSON: launch.settingsJson
        }
      : {}),
    // Executable name the shared wrapper (resources/harness-common.sh) probes
    // for on PATH before falling back to sourcing ~/.zshrc. Sourced from the
    // resolved descriptor so a non-Claude harness's wrapper probes for its
    // OWN binary (e.g. 'codex'), not 'claude'. harness-common.sh defaults to
    // 'claude' when this is absent, so an old tmux session / old wrapper
    // build that predates this var keeps working unchanged.
    ORPHEUS_HARNESS_BINARY: descriptor.binary,
    ORPHEUS_WORKSPACE_ID: workspaceId, // always present — load-bearing for CLI guardrails
    ...(sockPath ? { ORPHEUS_SOCK: sockPath } : {}),
    ...(hooksEnabled ? { ORPHEUS_NOTIFY: shimPath() } : {}),
    ...(cachedUserPath ? { ORPHEUS_USER_PATH: cachedUserPath } : {}),
    ORPHEUS_GHOSTTY_CONFIG: ghosttyConfigPath,
    // CLI plumbing: prepend orpheusBinDir to PATH so `orpheus` resolves inside
    // every workspace terminal. The production cask also symlinks the shim
    // onto the global PATH (scripts/orpheus-cask.template.rb's `binary`
    // stanza), so plain shells / SSH sessions can reach it too — this env
    // var only covers the in-app terminal case.
    // PATH is assembled as: orpheusBinDir : cachedUserPath (if any) : existing PATH.
    // The orpheus-claude.sh wrapper already splices ORPHEUS_USER_PATH into PATH,
    // so we set ORPHEUS_BIN_DIR separately and let the wrapper prepend it.
    ORPHEUS_BIN_DIR: orpheusBinDir,
    // Data variant — tells the CLI which data dir to target (dev, wt, nightly, or prod).
    ORPHEUS_DATA_VARIANT: DATA_VARIANT,
    // Command server plumbing — injected when the server is running so the CLI
    // resolves sock/token zero-config from within a workspace terminal.
    // The CLI also falls back to reading cmd.token from disk, so this is a
    // convenience that avoids a file read on every invocation.
    ...(cmdServer ? { ORPHEUS_CMD_SOCK: cmdServer.sockPath } : {}),
    ...(cmdServer ? { ORPHEUS_CMD_TOKEN: cmdServer.token } : {})
  }

  // Phase-0: routing env injection severed here; re-lands harness-aware —
  // see multi-harness roadmap (Phase 6). Re-land site rationale, preserved:
  // the routing overlay must be applied strictly AFTER the `...authEnv`
  // spread above, because for cloud_provider 'anthropic' authEnv can itself
  // set ANTHROPIC_BASE_URL (from auth_base_url — claudeAuth.ts
  // buildAnthropicEnv), which would otherwise silently clobber the proxy URL
  // for a routed workspace and defeat routing.

  // Runtime identity is server-owned launch metadata. Merge it last so neither
  // custom Claude env nor provider-routing layers can spoof the trusted binding.
  // The main process remains authoritative: these values are hints carried to
  // the managed MCP bridge, while the bearer token resolves against the
  // process-local RuntimeLeaseRegistry.
  if (runtimeLease) {
    const { binding, token } = runtimeLease
    delete env.ORPHEUS_RUNTIME_LEASE_TOKEN
    delete env.ORPHEUS_CLAUDE_CONVERSATION_ID
    Object.assign(env, {
      ORPHEUS_RUNTIME_CONTEXT_VERSION: '1',
      ORPHEUS_RUNTIME_ID: binding.runtimeId,
      ORPHEUS_RUNTIME_KIND: binding.runtimeKind,
      ORPHEUS_SURFACE_ID: binding.surfaceId,
      ORPHEUS_PROJECT_ID: binding.projectId,
      ORPHEUS_WORKSPACE_ID: binding.workspaceId,
      ...(binding.claudeConversationId
        ? { ORPHEUS_CLAUDE_CONVERSATION_ID: binding.claudeConversationId }
        : {}),
      ...(token ? { ORPHEUS_RUNTIME_LEASE_TOKEN: token } : {})
    })
  }

  // Resolve the wrapper script path from the harness descriptor.
  // Packaged: Contents/Resources/<descriptor.wrapperScript>
  // Dev:      <repo>/resources/<descriptor.wrapperScript>
  // Phase 1 has one descriptor (Claude, wrapperScript: 'orpheus-claude.sh'),
  // so this resolves identically to the prior hardcoded path.
  const command = app.isPackaged
    ? join(process.resourcesPath, descriptor.wrapperScript)
    : join(__dirname, '../../resources', descriptor.wrapperScript)

  return { command, env, launch, authEnv }
}

// ---------------------------------------------------------------------------
// buildTmuxAttachEnv — universal tmux hosting (docs/TUI_SPEC.md D1)
//
// The desktop-surface-side counterpart to buildMountEnv above, but for the
// ATTACH path instead of the create path: resolves resources/orpheus-attach.sh
// (NOT orpheus-claude.sh) and builds its env from SCRATCH rather than calling
// buildMountEnv — deliberately NOT composeClaudeLaunch/getClaudeAuthEnv/
// runtime-lease/model-routing at all. Attaching a client to an already-running
// tmux session needs none of that (no claude flags, no settings JSON, no auth
// env, no MCP lease) — all of it was already consumed once, by hostWorkspace()
// at session-CREATION time. Passing it again here would be dead weight at
// best and a leak surface at worst (see scrubSecretEnvironment's doc comment
// in tmuxHost.ts for why this repo treats "secret reaches tmux's env storage"
// as a real risk, not a theoretical one) — this function's whole job is to
// keep the attach env minimal by construction, not by discipline.
//
// Exactly THREE categories of env reach the attach wrapper:
//   1. ORPHEUS_TMUX_SOCKET / ORPHEUS_TMUX_SESSION — the socket/session name
//      to attach to, computed ONCE via resolveTmuxSocketName()/
//      tmuxSessionName() (the same functions hostWorkspace() itself uses) and
//      passed through as env rather than recomputed in the shell script or
//      passed as literal argv strings — single source of truth in TypeScript.
//   2. ORPHEUS_USER_PATH / ORPHEUS_BIN_DIR — PATH plumbing so `tmux` itself
//      and (in the fallback-shell case) the user's own tools resolve; both
//      are non-secret paths, already on the TMUX_ENV_RETAIN_ALLOWLIST in
//      tmuxHost.ts for the same reason.
//   3. Nothing else. No ORPHEUS_CLAUDE_FLAGS, no ORPHEUS_CLAUDE_SETTINGS_JSON,
//      no auth env, no ORPHEUS_RUNTIME_* lease vars, no ORPHEUS_CMD_*.
// ---------------------------------------------------------------------------

export type TmuxAttachEnvResult = {
  /** Full path to resources/orpheus-attach.sh. */
  command: string
  /** Minimal env — socket/session name + PATH plumbing only. See doc comment above. */
  env: Record<string, string>
}

export function buildTmuxAttachEnv(socketName: string, sessionName: string): TmuxAttachEnvResult {
  const cachedUserPath = getCachedShellPath()
  const orpheusBinDir = join(process.resourcesPath, 'bin')

  const env: Record<string, string> = {
    ORPHEUS_TMUX_SOCKET: socketName,
    ORPHEUS_TMUX_SESSION: sessionName,
    ...(cachedUserPath ? { ORPHEUS_USER_PATH: cachedUserPath } : {}),
    ORPHEUS_BIN_DIR: orpheusBinDir
  }

  // Packaged: Contents/Resources/orpheus-attach.sh
  // Dev:      <repo>/resources/orpheus-attach.sh
  // Mirrors buildMountEnv's own command resolution above exactly.
  const command = app.isPackaged
    ? join(process.resourcesPath, 'orpheus-attach.sh')
    : join(__dirname, '../../resources/orpheus-attach.sh')

  return { command, env }
}

// ---------------------------------------------------------------------------
// composeLaunchForMount
//
// The terminal:mount hot path (index.ts) needs the composed ClaudeLaunch
// before spawning the surface, then again for buildMountEnv's own env
// assembly a few lines later in the same handler. Composing is a real DB
// read (global/project/workspace settings rows) on every call, so calling it
// twice per mount doubled that cost for EVERY workspace. index.ts calls this
// ONCE and threads the same ClaudeLaunch into buildMountEnv via its
// precomposedLaunch param — so a mount pays exactly one composition, never
// two. (This used to also feed the isRoutedMount routing-health gate,
// severed in Phase 0 — see multi-harness roadmap Phase 6 for the re-land.)
//
// Resolves the workspace's harness descriptor itself (mirroring
// buildMountEnv's own lookup) so the precomposed value it hands back is
// exactly what buildMountEnv's own `descriptor.composeLaunch(...)` fallback
// would have produced — today that's always the Claude descriptor (Phase 1
// has one), but keeping the two lookups in lockstep now avoids a
// precomposedLaunch/descriptor mismatch once a second harness exists.
// ---------------------------------------------------------------------------

export function composeLaunchForMount(
  projectId: string | undefined,
  workspaceId: string
): ClaudeLaunch {
  const workspace = getWorkspace(workspaceId)
  const descriptor = resolveHarness(workspace?.harnessId)
  return descriptor.composeLaunch(projectId, workspaceId)
}
