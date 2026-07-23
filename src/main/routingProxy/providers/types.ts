// ---------------------------------------------------------------------------
// src/main/routingProxy/providers/types.ts
//
// The provider descriptor shape — the DATA layer this whole unit exists to
// introduce. Every non-Claude provider CLIProxyAPI can route to (Codex,
// Grok/xAI, Antigravity, arbitrary OpenAI-compatible endpoints, ...) is
// represented as ONE ProviderDescriptor
// object in registry.ts's PROVIDERS array. Adding a new provider is adding
// one object (plus, for a built-in vendor with a dedicated CLIProxyAPI
// `<name>-api-key:` block, a small config-mapping entry — see
// apiKeyConfigKey below) — never a new branch in config.ts, the IPC layer,
// or the Settings UI.
//
// Claude is explicitly NOT represented here. Claude stays on the official
// `claude` CLI -> api.anthropic.com path (src/main/claudeSettings.ts /
// src/main/models/sources/builtin.ts) and is never routed through
// CLIProxyAPI — see modelRouting.ts's isRoutedModel/isClaude invariant. This
// module has no notion of Claude at all.
// ---------------------------------------------------------------------------

/**
 * How a provider authenticates with CLIProxyAPI:
 *   - 'oauth'            — subscription login via a CLIProxyAPI CLI login
 *                           flag (e.g. `-codex-login`) or the management API.
 *                           Connect-button UI flow is deferred to a later
 *                           unit (see oauthLoginFlag's doc comment) — this
 *                           unit only models the descriptor + read-only
 *                           connection status (GET /v0/management/auth-files).
 *   - 'apiKey'           — a plain API key, written into a dedicated
 *                           top-level `<provider>-api-key:` list in
 *                           config.yaml (e.g. `codex-api-key:`).
 *   - 'openaiCompatible' — a generic OpenAI-compatible endpoint (OpenRouter,
 *                           vLLM, any custom base-url), written into
 *                           the shared `openai-compatibility:` list. This is
 *                           THE extensibility mechanism: any new
 *                           OpenAI-compatible vendor is just another
 *                           descriptor with authMethods: ['openaiCompatible'],
 *                           no CLIProxyAPI-side or Orpheus-side code change.
 *
 * A provider may support more than one method (CLIProxyAPI's own
 * config.example.yaml documents both oauth and apiKey for several vendors);
 * the UI/config layer picks per stored ProviderConfig.authMethod.
 */
export type ProviderAuthMethod = 'oauth' | 'apiKey' | 'openaiCompatible'

/**
 * One declarative fact-sheet about a routable (non-Claude) provider. Nothing
 * in this shape is behavior — config.ts, the model source, and the Settings
 * UI all read these fields generically. See config.ts's
 * renderProviderApiKeyBlock/renderOpenAiCompatibleEntry for the only two
 * pieces of "does something with a descriptor" logic in the whole layer, and
 * note neither branches on `id` — they branch on `authMethods`/config shape.
 */
export interface ProviderDescriptor {
  /** Stable id, e.g. 'codex' | 'xai' | 'antigravity'.
   *  Used as the config-storage key and (for apiKey providers) folded into
   *  apiKeyConfigKey when one isn't explicit. */
  id: string
  /** Human-readable label for the Settings UI, e.g. "Codex (OpenAI)". */
  label: string
  /** Auth methods this provider descriptor supports, in preferred-display order. */
  authMethods: ProviderAuthMethod[]
  /** CLIProxyAPI CLI flag for the OAuth login flow, e.g. '-codex-login'.
   *  Present only when 'oauth' is in authMethods. Not invoked by this unit
   *  (the connect-button flow is deferred to unit 06) — kept here so that
   *  unit's UI has an obvious, already-typed seam to hang off. */
  oauthLoginFlag?: string
  /** Top-level config.yaml key for this provider's dedicated API-key list,
   *  e.g. 'codex-api-key'. Present only when 'apiKey' is in authMethods. */
  apiKeyConfigKey?: string
  /** Present only when 'openaiCompatible' is in authMethods. Defaults used
   *  when a stored ProviderConfig doesn't override them. */
  openaiCompatible?: {
    defaultBaseUrl?: string
  }
  /** Optional docs link surfaced in the Settings UI. */
  docsUrl?: string
}

/**
 * One model entry under a provider's api-key or openai-compatible config
 * block. Mirrors CLIProxyAPI's `models:` entry shape verbatim (see the unit
 * spec's config.example.yaml excerpt) — `name` is the upstream model id,
 * everything else is optional metadata CLIProxyAPI uses for aliasing/display/
 * capability advertisement.
 */
export interface ProviderModelEntry {
  /** Upstream model id/name as CLIProxyAPI should call it. */
  name: string
  /** Client-facing alias, e.g. "codex-latest". */
  alias?: string
  displayName?: string
  forceMapping?: boolean
  image?: boolean
  inputModalities?: string[]
  outputModalities?: string[]
  thinkingLevels?: string[]
}

/**
 * One stored API-key credential entry for a provider (there can be more than
 * one — CLIProxyAPI supports a LIST per provider, e.g. multiple OpenRouter
 * keys pooled/failed-over under the same alias).
 */
export interface ProviderApiKeyEntry {
  id: string
  apiKey: string
  prefix?: string
  baseUrl?: string
  proxyUrl?: string
  disableCooling?: boolean
  models?: ProviderModelEntry[]
  excludedModels?: string[]
}

/**
 * Persisted, per-provider configuration (unit C: storage). One row per
 * provider id. `enabled` gates whether this provider's block is emitted into
 * config.yaml at all — disabling a provider removes it from the next
 * generated config without deleting the stored keys.
 */
export interface ProviderConfig {
  providerId: string
  enabled: boolean
  authMethod: ProviderAuthMethod
  /** Used when authMethod === 'apiKey' (dedicated `<provider>-api-key:` block)
   *  OR 'openaiCompatible' (folded into that provider's api-key-entries). */
  apiKeys: ProviderApiKeyEntry[]
  /** Only meaningful when authMethod === 'openaiCompatible'. Overrides the
   *  descriptor's openaiCompatible.defaultBaseUrl when set. */
  baseUrl?: string
  /** Only meaningful when authMethod === 'openaiCompatible' — the
   *  `openai-compatibility:` entry's own `name`/`prefix` display fields. */
  displayName?: string
  prefix?: string
}
