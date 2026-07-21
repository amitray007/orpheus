// ---------------------------------------------------------------------------
// src/main/routingProxy/providers/registry.ts
//
// The declarative provider list. THIS is "add a provider" in this codebase:
// append one ProviderDescriptor object below. No other file needs a new
// branch — config.ts's generateRoutingProxyConfig() folds any descriptor's
// stored ProviderConfig into config.yaml purely by switching on
// authMethod/apiKeyConfigKey/openaiCompatible, never on `id`.
//
// Claude is deliberately absent — it is not a routed provider (see
// modelRouting.ts / models/sources/builtin.ts). isKnownProviderId() below
// intentionally has no Claude entry so nothing in this layer can accidentally
// treat Claude as routable.
//
// Copilot is deliberately absent per the unit spec (documented permanent-ban
// risk from OpenAI/GitHub ToS around third-party proxying) — do not add it
// here without an explicit decision to accept that risk.
//
// (model-routing unit 09-polish) Trimmed to exactly four supported
// providers — gemini/kimi/openrouter/openai-compatible were REMOVED (data
// deletion only, no code change elsewhere — see this file's own header
// paragraph on why removing a provider is data-only, same as adding one).
// All four keepers are genuinely supported by the pinned CLIProxyAPI
// v7.2.92: codex/xai/antigravity each have a real `-auth-url` management
// route (verified antigravity-auth-url is registered, so it's a routable
// provider, not just a separate harness concept), and ollama works through
// the generic openai-compatibility config block exactly like the removed
// openrouter/openai-compatible entries did.
//
// A user's EXISTING stored data for a removed provider (routing_proxy_
// providers/routing_proxy_provider_api_keys rows, aliases whose
// target_provider_id names it, persisted cliproxy-model-cache entries
// tagged with it) is deliberately left untouched in the DB — this change
// does not delete rows, it only removes the descriptor those rows would
// have matched against. getProviderDescriptor(id) now returns null for a
// removed id, and every consumer that already gates on that null (config.ts's
// renderProvidersYaml's `if (!descriptor) continue`, providers:descriptors'
// filter(d => d !== null), aliasResolve.ts's knownOnProvider guard via the
// live cliproxy cache never reporting a dead channel) already treats the
// stale row as inert rather than crashing — see verify-providers.ts's
// "unregistered provider id emits no YAML" assertion, extended by this unit
// to cover exactly this scenario explicitly.
// ---------------------------------------------------------------------------

import type { ProviderDescriptor } from './types'

// Hoisted so the literal exists exactly once (sonarjs/no-duplicate-string —
// multiple descriptors below link to CLIProxyAPI's own repo as their docs URL).
const CLIPROXYAPI_DOCS_URL = 'https://github.com/router-for-me/CLIProxyAPI'

export const PROVIDERS: ProviderDescriptor[] = [
  {
    id: 'codex',
    label: 'Codex (OpenAI)',
    authMethods: ['oauth', 'apiKey'],
    oauthLoginFlag: '-codex-login',
    apiKeyConfigKey: 'codex-api-key',
    docsUrl: CLIPROXYAPI_DOCS_URL
  },
  {
    id: 'xai',
    label: 'Grok (xAI)',
    authMethods: ['oauth', 'apiKey'],
    oauthLoginFlag: '-xai-login',
    apiKeyConfigKey: 'xai-api-key',
    docsUrl: CLIPROXYAPI_DOCS_URL
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    authMethods: ['oauth'],
    oauthLoginFlag: '-antigravity-login',
    docsUrl: CLIPROXYAPI_DOCS_URL
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    authMethods: ['openaiCompatible'],
    openaiCompatible: { defaultBaseUrl: 'http://127.0.0.1:11434/v1' },
    docsUrl: 'https://github.com/ollama/ollama'
  }
]

export function getProviderDescriptor(id: string): ProviderDescriptor | null {
  return PROVIDERS.find((p) => p.id === id) ?? null
}

/** Structural membership check — never true for 'claude' or any id absent
 *  from PROVIDERS above. Mirrors isClaudeModelId's role on the model-registry
 *  side: the one place "is this a thing we know how to route" is decided. */
export function isKnownProviderId(id: string): boolean {
  return PROVIDERS.some((p) => p.id === id)
}

export type { ProviderDescriptor, ProviderAuthMethod } from './types'
