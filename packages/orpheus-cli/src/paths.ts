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
 *   1. ORPHEUS_INVOKED_VARIANT env var — set by resources/bin/orpheus itself,
 *      to the variant of the ELECTRON BINARY THAT SHIM RESOLVED (see
 *      resolveEffectiveVariant()'s doc comment below for why this is the
 *      trustworthy signal and ORPHEUS_DATA_VARIANT alone is not).
 *   2. ORPHEUS_DATA_VARIANT env var (internal/testing override, and also the
 *      var injected into every workspace-hosted terminal by
 *      src/main/orpheusSurfaceAdapter.ts — see resolveEffectiveVariant()):
 *      - "dev"     → "Orpheus Dev"
 *      - "wt"      → "Orpheus WT"
 *      - "nightly" → "Orpheus Nightly"
 *      - "prod"    → "Orpheus" (explicit prod override)
 *      This allows test scripts to point at the dev data dir without any --mode flag.
 *      There is deliberately NO user-facing --mode flag; variant is context-only.
 *
 *   3. Default → "Orpheus" (production data dir).
 *
 * NOTE: ORPHEUS_WORKSPACE_ID is injected into every workspace's shell environment
 * by the app (src/main/index.ts terminal:mount). A future enhancement could use it
 * to look up the workspace's variant (dev vs prod) from the socket. For now the
 * presence of ORPHEUS_WORKSPACE_ID alone doesn't reliably tell us which data dir
 * variant to use, so we leave that to ORPHEUS_INVOKED_VARIANT/ORPHEUS_DATA_VARIANT.
 *
 * CROSS-VARIANT TALK GUARD (why this file has resolveEffectiveVariant())
 * ------------------------------------------------------------------------
 * ORPHEUS_DATA_VARIANT (and ORPHEUS_CMD_SOCK/ORPHEUS_CMD_TOKEN_FILE) are
 * injected into EVERY workspace-hosted shell by whichever app instance owns
 * that workspace (orpheusSurfaceAdapter.ts). That's correct for a terminal
 * actually driven by that app — but if a user (or an agent) already sitting
 * in a prod-hosted workspace shell invokes a DIFFERENT variant's `orpheus`
 * binary (e.g. `"/Applications/Orpheus Dev.app/.../bin/orpheus tui"`), the
 * inherited ORPHEUS_DATA_VARIANT=prod silently wins and the Dev binary ends
 * up talking to PROD's command socket with PROD's token — cross-talk with
 * no error, just confusing behavior (this is exactly how the /subscribe 400
 * investigation on this branch got misdiagnosed as a protocol bug).
 *
 * The fix: resources/bin/orpheus sets ORPHEUS_INVOKED_VARIANT to the variant
 * IT resolved (from which Electron binary actually exists next to it — see
 * that script's ELECTRON_BIN cascade), which reflects the physically-invoked
 * binary rather than ambient shell state. resolveEffectiveVariant() prefers
 * that signal over ORPHEUS_DATA_VARIANT whenever both are present and they
 * disagree. A bare terminal/SSH session with neither var set is unaffected —
 * it falls through to the same "prod" default as before.
 */

import * as os from 'node:os'
import * as path from 'node:path'

const KNOWN_VARIANTS = ['dev', 'wt', 'nightly', 'prod'] as const
export type OrpheusVariant = (typeof KNOWN_VARIANTS)[number]

function normalizeVariant(value: string | undefined): OrpheusVariant | undefined {
  return (KNOWN_VARIANTS as readonly string[]).includes(value ?? '')
    ? (value as OrpheusVariant)
    : undefined
}

/**
 * Resolve which app variant the CLI should target, reconciling the
 * trustworthy shim-set signal (ORPHEUS_INVOKED_VARIANT) against the ambient,
 * possibly-foreign one (ORPHEUS_DATA_VARIANT) — see the file header's
 * "CROSS-VARIANT TALK GUARD" for the full story. Pure function of its
 * arguments (no direct process.env read) so it's unit-testable without env
 * mutation — resolveAppName() below is the process.env-reading wrapper used
 * at runtime.
 *
 * ORPHEUS_FORCE_CROSS_VARIANT=1 is a deliberate, distinct escape hatch (not
 * ORPHEUS_DATA_VARIANT itself) for the rare case someone genuinely wants a
 * variant's CLI talking to a different variant's server — e.g. manual
 * cross-variant testing. It must be opted into explicitly; it is never set
 * by the app or the shim.
 */
export function resolveEffectiveVariant(env: {
  invoked?: string
  ambient?: string
  forceCrossVariant?: string
}): OrpheusVariant {
  const invoked = normalizeVariant(env.invoked)
  const ambient = normalizeVariant(env.ambient)
  const forceCrossVariant = env.forceCrossVariant === '1'

  if (invoked != null) {
    // Trustworthy signal present. Let an explicit, deliberate override win
    // (the escape hatch), otherwise the invoked binary's own variant always
    // wins — silent cross-talk is exactly what this function exists to stop.
    if (forceCrossVariant && ambient != null) return ambient
    return invoked
  }

  // No trustworthy signal (e.g. a bare SSH/Terminal.app session with no
  // shim-set var) — fall back to the ambient var exactly like before this
  // guard existed, so zero-config workspace-terminal usage is unaffected.
  if (ambient != null) return ambient

  return 'prod'
}

/** process.env-reading wrapper around resolveEffectiveVariant(), shared by
 * resolveAppName() and the two override-path checks in getCmdSockPath()/
 * getCmdTokenPath() below. */
function currentEffectiveVariant(): OrpheusVariant {
  return resolveEffectiveVariant({
    invoked: process.env.ORPHEUS_INVOKED_VARIANT,
    ambient: process.env.ORPHEUS_DATA_VARIANT,
    forceCrossVariant: process.env.ORPHEUS_FORCE_CROSS_VARIANT
  })
}

/**
 * Whether ambient, non-path-shaped env overrides (currently just
 * ORPHEUS_CMD_TOKEN — a bare bearer-token string with no embedded variant to
 * cross-check the way a socket/token-file PATH has) are safe to trust as-is.
 *
 * ORPHEUS_CMD_SOCK/ORPHEUS_CMD_TOKEN are injected together, as a matched
 * pair, by orpheusSurfaceAdapter.ts (same cmdServer instance). A bare token
 * value carries no app-name to compare against an invoked variant the way
 * variantEmbeddedInPath() does for a path — so this reuses the SAME
 * invoked-vs-ambient decision resolveEffectiveVariant() already makes: if
 * ORPHEUS_INVOKED_VARIANT disagrees with ORPHEUS_DATA_VARIANT (and
 * ORPHEUS_FORCE_CROSS_VARIANT isn't set), the token half of the pair is
 * exactly as untrustworthy as the socket half, even though it can't be
 * checked directly. Callers (socket-client.ts's resolveToken()) fall back to
 * reading the invoked variant's own on-disk token file when this is false.
 */
export function ambientTokenOverrideIsTrusted(): boolean {
  const invoked = normalizeVariant(process.env.ORPHEUS_INVOKED_VARIANT)
  const ambient = normalizeVariant(process.env.ORPHEUS_DATA_VARIANT)
  if (invoked == null || ambient == null) return true // nothing to disagree with
  if (invoked === ambient) return true
  return process.env.ORPHEUS_FORCE_CROSS_VARIANT === '1'
}

function variantToAppName(variant: OrpheusVariant): string {
  if (variant === 'dev') return 'Orpheus Dev'
  if (variant === 'wt') return 'Orpheus WT'
  if (variant === 'nightly') return 'Orpheus Nightly'
  return 'Orpheus'
}

export function resolveAppName(): string {
  return variantToAppName(currentEffectiveVariant())
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

/**
 * Pure app-name → tmux socket-name mapping (`tmux -L <name>`). Mirrors
 * resolveAppName()'s variant list 1:1 — kept as a standalone pure function
 * (rather than inlined into resolveTmuxSocketName()) so it's testable without
 * touching ORPHEUS_DATA_VARIANT/env state (see scripts/verify-tui-layout.ts).
 *
 * LOAD-BEARING (see docs/TUI_SPEC.md "Environment separation"): dev/prod/wt/
 * nightly builds must never see each other's tmux sessions. Main derives the
 * same name independently from `app.getPath('userData')`'s basename, so both
 * sides agree without a shared import across the process boundary.
 */
export function tmuxSocketNameForAppName(appName: string): string {
  if (appName === 'Orpheus Dev') return 'orpheus-dev'
  if (appName === 'Orpheus WT') return 'orpheus-wt'
  if (appName === 'Orpheus Nightly') return 'orpheus-nightly'
  // "Orpheus" (production) or anything unrecognized → production socket name
  return 'orpheus'
}

/**
 * Resolve the tmux socket name (`tmux -L <name>`) for the CURRENT process's
 * app variant, derived from resolveAppName() exactly like getUserDataDir().
 */
export function resolveTmuxSocketName(): string {
  return tmuxSocketNameForAppName(resolveAppName())
}

/**
 * Extract the app-variant encoded in a `.../Application Support/<AppName>/...`
 * path, or undefined if the path doesn't contain a recognized app-support
 * segment (e.g. a custom test path with no "Application Support" component —
 * such paths are left alone, matching pre-guard behavior for test overrides
 * that intentionally point somewhere unusual).
 *
 * Used by getCmdSockPath()/getCmdTokenPath() to cross-check an explicit
 * ORPHEUS_CMD_SOCK/ORPHEUS_CMD_TOKEN_FILE override against the effective
 * variant — see the file header's "CROSS-VARIANT TALK GUARD". Pure string
 * parsing; no filesystem access.
 */
export function variantEmbeddedInPath(injectedPath: string): OrpheusVariant | undefined {
  const marker = `${path.sep}Application Support${path.sep}`
  const markerIndex = injectedPath.indexOf(marker)
  if (markerIndex === -1) return undefined
  const afterMarker = injectedPath.slice(markerIndex + marker.length)
  const appName = afterMarker.split(path.sep)[0]
  if (appName === 'Orpheus Dev') return 'dev'
  if (appName === 'Orpheus WT') return 'wt'
  if (appName === 'Orpheus Nightly') return 'nightly'
  if (appName === 'Orpheus') return 'prod'
  return undefined
}

/**
 * Given an explicit ORPHEUS_CMD_SOCK/ORPHEUS_CMD_TOKEN_FILE override path and
 * the effective variant this CLI process resolved, decide whether the
 * override is safe to use as-is. Returns the override path when it's safe
 * (no embedded variant to compare against — e.g. a test path — or its
 * embedded variant agrees with `effectiveVariant`, or ORPHEUS_FORCE_CROSS_VARIANT
 * is set), otherwise returns null so the caller falls back to the
 * variant-derived disk path instead of silently cross-talking.
 */
function resolveOverridePath(
  injectedPath: string,
  effectiveVariant: OrpheusVariant,
  forceCrossVariant: string | undefined
): string | null {
  if (forceCrossVariant === '1') return injectedPath
  const embeddedVariant = variantEmbeddedInPath(injectedPath)
  if (embeddedVariant == null || embeddedVariant === effectiveVariant) return injectedPath
  // Embedded variant disagrees with the effective one — this override was
  // very likely inherited from a DIFFERENT app instance's workspace shell
  // (see the file header). Refuse it rather than cross-talk silently; the
  // caller falls back to the effective variant's own on-disk path.
  process.stderr.write(
    `orpheus: warning: ignoring inherited socket/token path for "${embeddedVariant}" — ` +
      `this CLI is targeting "${effectiveVariant}". Set ORPHEUS_FORCE_CROSS_VARIANT=1 to override.\n`
  )
  return null
}

/** Path to the Unix-domain command socket (used by the CLI control protocol). */
export function getCmdSockPath(): string {
  const injectedPath = process.env.ORPHEUS_CMD_SOCK
  if (typeof injectedPath === 'string' && path.isAbsolute(injectedPath)) {
    const resolved = resolveOverridePath(
      injectedPath,
      currentEffectiveVariant(),
      process.env.ORPHEUS_FORCE_CROSS_VARIANT
    )
    if (resolved != null) return resolved
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
    const resolved = resolveOverridePath(
      injectedPath,
      currentEffectiveVariant(),
      process.env.ORPHEUS_FORCE_CROSS_VARIANT
    )
    if (resolved != null) return resolved
  }
  return path.join(getUserDataDir(), 'cmd.token')
}
