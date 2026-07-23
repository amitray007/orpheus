// ---------------------------------------------------------------------------
// src/main/modelRouting.ts
//
// Model routing (unit 03): a workspace whose model is NOT a Claude model
// sends its traffic to a local translating proxy instead of the official
// Anthropic path. "Routed" is defined structurally as `!isClaude(model)` —
// the model registry (src/main/models/registry.ts) is the single source of
// truth for that question; this module never re-derives it.
//
// THE INVARIANT (ToS-critical, not a preference): for a Claude-model
// workspace, applyModelRouting must be a byte-for-byte no-op. Claude traffic
// must reach real api.anthropic.com via the official binary, never through a
// third-party proxy. See applyModelRouting below for how that's guaranteed,
// and src/main/orpheusSurfaceAdapter.ts buildMountEnv for the caller-side
// ordering argument (why this must run AFTER the authEnv spread).
//
// Proxy lifecycle/health-check/download is unit 04's job (src/main/routingProxy/) —
// this module stays deliberately electron-free/DB-free (per
// scripts/verify-routing.ts's own doc comment) so it can be exercised by that
// offline harness without booting Electron. That's why the real per-run auth
// token is threaded in via setRuntimeRoutingAuthToken() below (a plain
// module-level setter) rather than by importing routingProxy/manager.ts
// directly, which pulls in `electron` (BrowserWindow) transitively.
// ---------------------------------------------------------------------------

import { isClaude } from './models/registry'

/**
 * Default local translating-proxy base URL. Override via
 * ORPHEUS_ROUTING_PROXY_URL for local testing. The managed proxy
 * (src/main/routingProxy/) always runs on this same host:port — its
 * config.yaml is generated from this exact URL (see routingProxy/manager.ts).
 */
export const DEFAULT_ROUTING_PROXY_URL = 'http://127.0.0.1:18765'

export function getRoutingProxyUrl(): string {
  return process.env.ORPHEUS_ROUTING_PROXY_URL || DEFAULT_ROUTING_PROXY_URL
}

/**
 * Fallback bearer value sent as ANTHROPIC_AUTH_TOKEN when no managed proxy
 * has ever been started this run (e.g. a routed model is selected before the
 * proxy component has been enabled/installed). Real per-run tokens are
 * supplied via setRuntimeRoutingAuthToken() once the proxy starts — see
 * routingProxy/manager.ts's start(). This constant only matters for the
 * MECHANISM: a non-empty ANTHROPIC_AUTH_TOKEN (sent as `Authorization:
 * Bearer`) avoids the one-time interactive approval prompt that
 * ANTHROPIC_API_KEY triggers in the Claude CLI, which would hang a
 * terminal-less/headless workspace, regardless of whether the value itself
 * is ever checked by anything (there's nothing running to check it yet in
 * that fallback case).
 */
export const DEFAULT_ROUTING_AUTH_TOKEN = 'orpheus-routed'

// Late-bound by routingProxy/manager.ts each time the managed proxy starts —
// a fresh crypto-random token generated per run, matching what the proxy's
// own config expects. Never persisted; reset to null on proxy stop so a
// stale token from a previous run is never reused against a proxy that no
// longer recognizes it.
let runtimeAuthToken: string | null = null

export function setRuntimeRoutingAuthToken(token: string | null): void {
  runtimeAuthToken = token
}

export function getRoutingAuthToken(): string {
  return process.env.ORPHEUS_ROUTING_AUTH_TOKEN || runtimeAuthToken || DEFAULT_ROUTING_AUTH_TOKEN
}

/**
 * Pure decision: is this model routed (i.e. NOT Claude)? Thin wrapper over
 * the registry so callers never write `!isClaude(...)` inline and drift from
 * this module's definition.
 */
export function isRoutedModel(model: string): boolean {
  if (!model) return false // empty model id resolves to claude's own default
  return !isClaude(model)
}

/**
 * Compute the env overlay for model routing, given the model that will
 * launch and the env assembled so far (launch.env + authEnv already merged).
 *
 * Returns an EMPTY object for a Claude model — callers must merge this
 * result with `{ ...env, ...overlay }` (or equivalent) so that on the Claude
 * path the merge is a true no-op: no key is added, removed, or overwritten,
 * so the resulting env is byte-for-byte identical to not calling this
 * function at all.
 *
 * For a routed (non-Claude) model, returns ANTHROPIC_BASE_URL (the proxy)
 * and ANTHROPIC_MODEL (the routed model id), plus ANTHROPIC_AUTH_TOKEN
 * (sent as `Authorization: Bearer`) rather than ANTHROPIC_API_KEY — verified
 * that ANTHROPIC_API_KEY triggers a one-time interactive approval prompt
 * that would hang a terminal-less workspace. authToken may be empty (no
 * proxy auth configured yet); callers decide whether to include it.
 */
export function computeRoutingEnv(
  model: string,
  options: { proxyUrl?: string; authToken?: string } = {}
): Record<string, string> {
  if (!isRoutedModel(model)) return {}

  const proxyUrl = options.proxyUrl ?? getRoutingProxyUrl()
  const authToken = options.authToken ?? getRoutingAuthToken()
  return {
    ANTHROPIC_BASE_URL: proxyUrl,
    ANTHROPIC_MODEL: model,
    // Bearer token, not ANTHROPIC_API_KEY — see getRoutingAuthToken doc.
    ANTHROPIC_AUTH_TOKEN: authToken
  }
}

/**
 * Bug-09-polish fix: should `--fallback-model <value>` be emitted for this
 * launch? `--fallback-model` is a Claude-CLI-native concept — it tells the
 * OFFICIAL Anthropic-path client which Claude model to fall back to when the
 * primary is overloaded/unavailable. It has no meaning against a routed
 * (third-party, non-Claude) backend: the routing proxy has no notion of
 * Claude Code's built-in overload fallback, so handing it a fallback model
 * either produces `unknown provider for model <x>` (proxy has no Claude
 * backend configured) or — worse — silently continues the session on
 * whatever backend the fallback string happens to resolve to, defeating the
 * user's explicit routing choice mid-session.
 *
 * Policy: suppress the flag whenever the LAUNCH model is routed, regardless
 * of what the configured fallback string is (not just when the fallback
 * itself resolves to a Claude id). The fallback field is free text ("model
 * alias or full model ID") describing Claude's own overload behavior; a
 * routed workspace has already opted out of the Claude backend entirely, so
 * the setting simply does not apply — same reasoning as computeRoutingEnv
 * never emitting a CLAUDE_CODE_USE_* var alongside routing. A Claude launch
 * is completely unaffected: this returns true unconditionally when the
 * launch model is Claude, so composeFlagTokens's existing non-empty check is
 * the only other gate (byte-for-byte unchanged behavior for Claude
 * workspaces).
 */
export function shouldEmitFallbackModel(launchModel: string): boolean {
  return !isRoutedModel(launchModel)
}

/**
 * Is a model change "live-applicable" — can `/model <value>` typed into an
 * already-running terminal actually make the running claude process reflect
 * it, with no restart? That premise holds ONLY when old and new model are
 * BOTH Claude models (same backend, same env/base-URL/auth — just a
 * different --model argument, which is exactly what `/model` changes at
 * runtime). It does NOT hold across a Claude<->routed switch (or
 * routed<->different-routed): those need a new process with different
 * ANTHROPIC_BASE_URL/ANTHROPIC_MODEL/ANTHROPIC_AUTH_TOKEN env (see
 * computeRoutingEnv above / buildMountEnv in orpheusSurfaceAdapter.ts), which
 * no in-terminal slash command can apply.
 *
 * Used by src/main/ipc/claudeSettings.ts's dirty-suppression machinery
 * (setWorkspaceSettingAndSuppressDirty) to decide whether a footer Model-chip
 * change may suppress the resulting dirty delta, or must fall through to a
 * genuine "Restart to apply" flag. Exported here (not defined inline in that
 * IPC module) so it's a pure, electron-free function this unit's offline
 * verification harness (scripts/verify-routing.ts) can exercise directly.
 *
 * Empty string means claude's own default model, which is always Claude.
 */
export function isLiveApplicableModelChange(oldModel: string, newModel: string): boolean {
  const oldIsClaude = oldModel === '' || isClaude(oldModel)
  const newIsClaude = newModel === '' || isClaude(newModel)
  return oldIsClaude && newIsClaude
}

/**
 * Issue-3 decision: should selecting a new model trigger an AUTOMATIC
 * workspace restart (destroy + remount, same mechanism as the existing
 * "Restart to apply" chip)? Pure predicate mirrored by
 * src/renderer/src/components/dashboard/footer/DropdownChip.tsx's onSelect
 * handler for footer.modelSelect (the renderer can't import this
 * main-process module directly, so this function is the source-of-truth
 * spec that harness assertions below hold the renderer implementation to).
 *
 * Two conditions must BOTH hold:
 *   1. The switch is NOT live-applicable (isLiveApplicableModelChange is
 *      false) — a Claude->Claude switch never needs a restart at all, auto
 *      or otherwise; `/model <value>` already applies it live.
 *   2. The workspace is NOT currently busy (workspaceStatus !== 'in_progress')
 *      — destroying the surface mid-task would silently kill an in-flight
 *      agent turn. Restarting a busy workspace must be a visible, deliberate
 *      user action (the existing "Restart to apply" chip), never automatic.
 *
 * workspaceStatus accepts the raw WorkspaceStatus union (not the renderer's
 * derived WorkspaceActivityDetail) so this stays usable from any main-process
 * caller that already has a WorkspaceRecord in hand, without pulling in
 * renderer-only types.
 */
export function shouldAutoRestartForModelChange(
  oldModel: string,
  newModel: string,
  workspaceStatus: string
): boolean {
  if (isLiveApplicableModelChange(oldModel, newModel)) return false
  return workspaceStatus !== 'in_progress'
}
