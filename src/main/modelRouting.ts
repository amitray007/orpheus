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
// Proxy lifecycle/health-check/download is unit 04's job — this unit only
// needs a well-named URL constant with an env override for that unit to
// later replace with real config.
// ---------------------------------------------------------------------------

import { isClaude } from './models/registry'

/**
 * Default local translating-proxy base URL. Override via
 * ORPHEUS_ROUTING_PROXY_URL for local testing. Unit 04 (proxy lifecycle)
 * will replace this with real, possibly-dynamic config (e.g. a port picked
 * at proxy-start time) — kept as a single named constant here so that swap
 * is a one-line change.
 */
export const DEFAULT_ROUTING_PROXY_URL = 'http://127.0.0.1:18765'

export function getRoutingProxyUrl(): string {
  return process.env.ORPHEUS_ROUTING_PROXY_URL || DEFAULT_ROUTING_PROXY_URL
}

/**
 * Placeholder bearer value sent as ANTHROPIC_AUTH_TOKEN for routed
 * workspaces. The proxy (unit 04+) translates requests to a different
 * backend/credential entirely — real per-proxy credential management is out
 * of scope for this unit (no proxy manager exists yet). What matters here is
 * the MECHANISM: setting ANTHROPIC_AUTH_TOKEN (sent as `Authorization:
 * Bearer`) rather than ANTHROPIC_API_KEY, because ANTHROPIC_API_KEY triggers
 * a one-time interactive approval prompt in the Claude CLI that would hang a
 * terminal-less/headless workspace. A non-empty ANTHROPIC_AUTH_TOKEN avoids
 * that prompt regardless of whether the value itself is checked by the
 * proxy. Overridable via ORPHEUS_ROUTING_AUTH_TOKEN so unit 04 (or a user)
 * can supply a real per-proxy token once one exists.
 */
export const DEFAULT_ROUTING_AUTH_TOKEN = 'orpheus-routed'

export function getRoutingAuthToken(): string {
  return process.env.ORPHEUS_ROUTING_AUTH_TOKEN || DEFAULT_ROUTING_AUTH_TOKEN
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
