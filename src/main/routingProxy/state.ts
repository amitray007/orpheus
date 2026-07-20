// ---------------------------------------------------------------------------
// src/main/routingProxy/state.ts
//
// Pure status-transition helpers for the managed routing-proxy state
// machine. Deliberately electron-free (no import of `electron`, `node:fs`,
// or anything with side effects) so scripts/verify-routing-proxy.ts can
// exercise the transitions directly, offline, without booting manager.ts
// (which imports `electron` via BrowserWindow and therefore cannot be
// loaded by a plain `bun run` script).
//
// Fixes the "Enable then Disable while not installed" trap-state bug: an
// `'error'` status must never be a dead end (install/retry stays reachable),
// and disabling must always land on a clean state with no lingering error.
// ---------------------------------------------------------------------------

import type { RoutingProxyStatus } from '../../shared/types'

/**
 * Is the component actually installed? This is the ONLY thing that should
 * gate whether an Install/Retry action is offered — never `status`, since
 * `status` can be `'error'` for reasons unrelated to "not installed" (e.g.
 * "started but never became reachable" while a binary IS on disk). Basing
 * the install affordance on status left `'error'` as a dead end: once a
 * failed enable attempt flipped status to 'error', the Install button
 * (rendered only for status === 'not_installed') vanished with no way back.
 */
export function isInstalled(installedVersion: string | null): boolean {
  return installedVersion !== null
}

/**
 * Can the user install or retry right now? True whenever not installed and
 * not already mid-install — regardless of status, including 'error'. This
 * is the invariant the harness asserts: the state machine must never reach
 * a state where install/retry is impossible while uninstalled.
 */
export function canInstallOrRetry(
  installedVersion: string | null,
  status: RoutingProxyStatus
): boolean {
  return !isInstalled(installedVersion) && status !== 'installing'
}

/**
 * Status to land on when the proxy is stopped/disabled. Disabling is a
 * clean, well-defined transition — it must never leave a stale 'error'
 * status/message from a prior failed enable attempt hanging around. Reflects
 * whether the binary is actually on disk so the Status card and the Install
 * button visibility (driven by isInstalled) stay coherent.
 */
export function cleanStoppedStatus(installedVersion: string | null): RoutingProxyStatus {
  return isInstalled(installedVersion) ? 'stopped' : 'not_installed'
}

/**
 * Fields to patch onto the snapshot when disabling. Always clears `error` —
 * that's the fix for "toggle OFF but status still shows Error".
 */
export function disableTransitionPatch(installedVersion: string | null): {
  status: RoutingProxyStatus
  error: null
} {
  return { status: cleanStoppedStatus(installedVersion), error: null }
}
