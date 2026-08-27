// ---------------------------------------------------------------------------
// src/shared/harness/membership.ts
//
// Pure harness-id membership check, extracted from src/main/harness/
// registry.ts so it can be imported WITHOUT pulling in that module's
// electron-reaching chain (registry.ts -> claude/launch.ts ->
// claude/session.ts -> workspaces.ts -> electron's BrowserWindow).
//
// src/main/controlPlane/workspaceCapabilities.ts needs isKnownHarnessId to
// validate a caller-supplied harnessId, but it is imported (transitively,
// via boot.ts) by scripts/verify-control-plane.ts, which runs under plain
// `bun run` with NO electron stub — see that script's own header. Any
// electron-reaching import anywhere in that chain is a hard failure there.
// This mirrors the DI discipline settingsResourceService.ts already
// documents for composeHarnessLaunch: keep the pure decision here, let the
// electron-reaching module (registry.ts) be the thing that supplies data
// into it, not the thing this depends on.
//
// SINGLE SOURCE OF TRUTH: HARNESS_IDS below is NOT an independent list a
// human keeps in sync with registry.ts's HARNESSES array by hand — it is
// asserted equal to HARNESSES.map(h => h.id) by
// scripts/verify-doctor.ts (see its "membership" section), which imports
// BOTH this file and the real registry (dynamically, mocking the electron
// modules registry.ts's Claude descriptor transitively reaches — same
// technique as scripts/verify-harness-registry.ts). If a harness is ever
// added to HARNESSES without updating HARNESS_IDS, or vice versa, that
// assertion goes red. Keep the two edited together.
// ---------------------------------------------------------------------------

import type { HarnessId } from './types'

/** Every harness id HARNESSES (src/main/harness/registry.ts) currently
 *  declares a descriptor for. Data only — no descriptor shape, no
 *  composeLaunch, nothing that would need an electron-reaching import.
 *  Kept in sync with registry.ts's HARNESSES by
 *  scripts/verify-doctor.ts's assertion (see this file's header). */
export const HARNESS_IDS: readonly string[] = ['claude', 'codex-cli']

/** Structural membership check — never true for an id absent from
 *  HARNESS_IDS. `ids` defaults to HARNESS_IDS (the normal call shape for
 *  every current caller) but can be overridden, which is what makes the
 *  single-source-of-truth assertion in scripts/verify-doctor.ts possible:
 *  it calls this with the REAL HARNESSES.map(h => h.id) and compares. */
export function isKnownHarnessId(
  id: string,
  ids: readonly string[] = HARNESS_IDS
): id is HarnessId {
  return ids.includes(id)
}
