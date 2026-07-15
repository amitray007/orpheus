// ---------------------------------------------------------------------------
// src/shared/envVars.ts
//
// Env-var key validation for the "custom env vars" feature (customEnvVars).
//
// Orpheus lets users define arbitrary env var key/value pairs as global +
// project + workspace overrides. This module holds the one rule for what
// counts as a valid env var key. It is deliberately dependency-free and
// imports nothing from `main/` or `renderer/` — both the renderer (live
// validation as the user types, in CustomEnvVarsEditor) and main (final
// validation on save, in overridesStore.ts's validateCustomEnvVarsValue) need
// byte-identical behavior, and `shared-not-to-*` dependency-cruiser rules
// forbid this file reaching into a process-specific layer anyway.
// ---------------------------------------------------------------------------

/** Matches a POSIX-style shell env var name: a letter/underscore, then any
 *  number of letters/digits/underscores. */
export const ENV_VAR_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Whether `key` is a valid env var name per {@link ENV_VAR_KEY_RE}. */
export function isValidEnvVarKey(key: string): boolean {
  return ENV_VAR_KEY_RE.test(key)
}
