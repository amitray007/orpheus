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
// ---------------------------------------------------------------------------

import type { ProviderDescriptor } from './types'

// Hoisted so the literal exists exactly once (sonarjs/no-duplicate-string —
// 6+ descriptors below link to CLIProxyAPI's own repo as their docs URL).
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
    id: 'gemini',
    label: 'Gemini (Google)',
    authMethods: ['oauth', 'apiKey'],
    oauthLoginFlag: '-gemini-login',
    apiKeyConfigKey: 'gemini-api-key',
    docsUrl: CLIPROXYAPI_DOCS_URL
  },
  {
    id: 'kimi',
    label: 'Kimi (Moonshot)',
    authMethods: ['oauth'],
    oauthLoginFlag: '-kimi-login',
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
    id: 'openrouter',
    label: 'OpenRouter',
    authMethods: ['openaiCompatible'],
    openaiCompatible: { defaultBaseUrl: 'https://openrouter.ai/api/v1' },
    docsUrl: 'https://openrouter.ai/docs'
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    authMethods: ['openaiCompatible'],
    openaiCompatible: { defaultBaseUrl: 'http://127.0.0.1:11434/v1' },
    docsUrl: 'https://github.com/ollama/ollama'
  },
  {
    id: 'openai-compatible',
    label: 'Custom (OpenAI-compatible)',
    authMethods: ['openaiCompatible'],
    docsUrl: CLIPROXYAPI_DOCS_URL
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
