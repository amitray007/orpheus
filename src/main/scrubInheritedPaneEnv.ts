// ---------------------------------------------------------------------------
// src/main/scrubInheritedPaneEnv.ts
//
// Deletes the wrapper-plumbing env vars an Orpheus WORKSPACE PANE exports,
// from this app process's own environment, at the earliest possible moment
// (imported from index.ts's first lines, before anything reads process.env).
//
// WHY THIS EXISTS — a real, user-visible bug, diagnosed live:
// launching Orpheus from inside an Orpheus workspace terminal (the normal
// dev loop: a shell in a workspace pane runs `bun run build:unpack` then
// `open -g "/Applications/Orpheus Dev.app"`) makes the new app process
// INHERIT that pane's env. `open -g` propagates the caller's environment —
// verified empirically with `ps eww`, not assumed. Two things then go wrong:
//
//   1. ARGV POISONING. tmuxSpawnEnv() (./tmuxHost.ts) passes
//      `{ ...process.env }` to every tmux client call, and tmux's GLOBAL
//      environment is the env of the client that spawned the server. So the
//      outer pane's ORPHEUS_CLAUDE_FLAGS becomes the variant tmux server's
//      global env, inherited by every pane of every later session unless
//      that session's own `-e` vars shadow it. buildMountEnv only emits the
//      flag vars when the composed flags are NON-EMPTY, and a fresh Codex
//      workspace composes empty flags — so nothing shadowed them, and
//      harness-common.sh's documented rollback fallback
//      (`: "${ORPHEUS_HARNESS_FLAGS:=${ORPHEUS_CLAUDE_FLAGS:-}}"`) then fed
//      the OUTER app's Claude argv to `codex`, which rejected it with
//      "unexpected argument '--permission-mode' found". The flags were never
//      composed for that workspace at all; they leaked in.
//
//   2. CROSS-VARIANT SECRET LEAK. The same inheritance carries the OUTER
//      app's ORPHEUS_CMD_TOKEN (the command-socket bearer token) and
//      ORPHEUS_SOCK/ORPHEUS_CMD_SOCK into a DIFFERENT variant's tmux server
//      global env, and therefore into every pane it hosts. tmuxHost's
//      scrubSecretEnvironment cannot reach this: it unsets only keys present
//      in the composed env map, and only at SESSION scope, never `-g`.
//
// Scrubbing at the source is the single fix for both, and it also covers the
// native (non-tmux) surface path, which inherits the app's environ the same
// way.
//
// WHY DELETING IS SAFE: every key below is plumbing a WRAPPER SCRIPT reads
// to launch one harness in one pane. None is meaningful to the app process
// itself — the app COMPOSES these values per mount (buildMountEnv) and
// passes them to tmux explicitly via `-e`, so removing them from its own
// environ cannot affect what a workspace receives. The one var deliberately
// NOT scrubbed is ORPHEUS_INVOKED_VARIANT, which the `orpheus` CLI shim sets
// from the Electron binary beside it and which paths.ts prefers over the
// ambient value — that is the cross-variant GUARD, not a leak (see
// CLAUDE.md's cross-variant guard section).
// ---------------------------------------------------------------------------

/** Wrapper-plumbing vars a workspace pane exports. Meaningful only inside a
 *  pane; inert-to-harmful in an app process that inherited them. */
export const INHERITED_PANE_ENV_KEYS: readonly string[] = [
  // Launch composition — the argv-poisoning half.
  'ORPHEUS_CLAUDE_FLAGS',
  'ORPHEUS_HARNESS_FLAGS',
  'ORPHEUS_CLAUDE_SETTINGS_JSON',
  'ORPHEUS_HARNESS_SETTINGS_JSON',
  'ORPHEUS_HARNESS_BINARY',
  // Pane identity — attributing hook/CLI calls to the OUTER workspace.
  'ORPHEUS_WORKSPACE_ID',
  // Sockets + bearer token — the cross-variant secret-leak half.
  'ORPHEUS_SOCK',
  'ORPHEUS_NOTIFY',
  'ORPHEUS_CMD_SOCK',
  'ORPHEUS_CMD_TOKEN'
]

/**
 * Removes every key in `INHERITED_PANE_ENV_KEYS` from `env`, returning the
 * names actually removed (for logging). Pure over the object it is handed so
 * it can be asserted directly rather than through process.env.
 */
export function scrubInheritedPaneEnvFrom(env: Record<string, string | undefined>): string[] {
  const removed: string[] = []
  for (const key of INHERITED_PANE_ENV_KEYS) {
    if (env[key] !== undefined) {
      delete env[key]
      removed.push(key)
    }
  }
  return removed
}

// Run on import. Deliberately at module scope, not exported-and-called: this
// must happen before any module that reads process.env is evaluated, and an
// import is the only ordering primitive that guarantees that.
const removedKeys = scrubInheritedPaneEnvFrom(process.env)
if (removedKeys.length > 0) {
  // Names only — several of these values are secrets (ORPHEUS_CMD_TOKEN).
  console.log(
    `[env] scrubbed ${removedKeys.length} inherited workspace-pane var(s): ${removedKeys.join(', ')}`
  )
}
